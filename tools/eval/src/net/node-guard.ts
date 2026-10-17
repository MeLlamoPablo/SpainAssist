/**
 * The process-level backstop of the eval host's deny-by-default guard (egress-guard.ts). The guard
 * on `fetch` and `WebSocket` is what the model-facing code goes through; this is what makes
 * "the host reaches only the model gateway, the mock and the bridge" true for everything else in
 * the process: a library that uses `node:http`, `undici`, `node:net`, `node:tls`, `dns`, `dgram`
 * or spawns a network client, a fetch function that was captured before the guard went in.
 *
 *   sockets   `net.Socket.prototype.connect`: every TCP connection (http, https, http2, tls and
 *             undici all open theirs through it) goes to a host and port the guard allows, or the
 *             socket fails like a closed door (`ENOTFOUND` for a name, `ECONNREFUSED` for an
 *             address). Unix sockets and named pipes are refused.
 *   dns       `dns.lookup`, `dns.resolve*`, `reverse`, `lookupService` (callback, `dns.promises`
 *             and `Resolver`): only names of allowed origins and loopback resolve.
 *   udp       `dgram` `send` and `connect`: refused (the host needs no UDP).
 *   spawn     `child_process`: a network client (`curl`, `wget`, `nc`, `ssh`...), an interpreter
 *             that has no guard of its own (`node`, `python`...) or a command line (a shell's, or
 *             what `env`, `xargs`... launch) that names one is refused with `EACCES`; `fork`
 *             always is. Other programs run as usual.
 *
 * Worker threads and native addons are outside what JavaScript can intercept: nothing in the host
 * uses them, and a dependency that started to would be the thing to review.
 *
 * Plain Node: bundled into the eval host. Never print to stdout (the host's RPC channel).
 */
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import module from 'node:module';
import net, { isIP } from 'node:net';
import { isLoopbackHost, normalizeHost } from './hosts';

/** What was refused, for the log. */
export type Refusal =
  | { kind: 'connect'; host: string; port?: number; path?: string }
  | { kind: 'dns'; host: string; call: string }
  | { kind: 'udp'; host: string; port?: number }
  | { kind: 'spawn'; command: string };

export interface NodeGuardOptions {
  /** Whether a TCP connection to `host:port` may be made. `host` is as the caller wrote it. */
  mayConnect(host: string, port: number): boolean;
  /** Whether `host` may be resolved. */
  mayResolve(host: string): boolean;
  /** Called for every refusal, before the caller gets its error. */
  refused(refusal: Refusal): void;
}

/** Programs that talk to the network, or that run code with the network and no guard of ours. */
const DENIED_PROGRAMS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'tftp',
  'rsync',
  'nmap',
  'ping',
  'ping6',
  'traceroute',
  'dig',
  'nslookup',
  'host',
  'openssl',
  'node',
  'nodejs',
  'deno',
  'bun',
  'python',
  'python2',
  'python3',
  'ruby',
  'perl',
  'php',
  'lua',
  'powershell',
  'pwsh',
  'certutil',
  'bitsadmin',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'fish', 'ksh', 'csh', 'tcsh', 'cmd']);
/** Programs whose arguments are another program's command line. */
const LAUNCHERS = new Set([
  'env',
  'nice',
  'nohup',
  'xargs',
  'timeout',
  'time',
  'command',
  'exec',
  'sudo',
  'doas',
  'busybox',
  'stdbuf',
  'setsid',
  'chroot',
  'strace',
  'start',
]);

/** `/usr/bin/curl.exe` is `curl`. */
function programName(command: string): string {
  const base = command.trim().split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

/** Whether a shell command line runs one of the programs (as a word, after a separator or path). */
function namesDeniedProgram(commandLine: string): boolean {
  for (const word of commandLine.split(/[\s;|&()`$<>'"=]+/)) {
    if (DENIED_PROGRAMS.has(programName(word))) return true;
  }
  return false;
}

/** The program and its arguments of a `child_process` call, as one line for the log. */
function lineOf(command: string, args: readonly unknown[]): string {
  return [command, ...args.filter((a): a is string => typeof a === 'string')].join(' ');
}

function systemError(
  message: string,
  props: { code: string; errno: number; syscall: string } & Record<string, unknown>,
): Error {
  return Object.assign(new Error(message), props);
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

interface ConnectTarget {
  host?: string;
  port?: number;
  path?: string;
}

/** Where `socket.connect(...)` is going, whatever form it was called in. */
function connectTarget(rawArgs: readonly unknown[]): ConnectTarget {
  // Node's own callers (net.connect, tls.connect, http agents) pass `[options, callback]`,
  // already normalised, as the single argument.
  const args = Array.isArray(rawArgs[0]) ? (rawArgs[0] as unknown[]) : rawArgs;
  const first = args[0];
  if (first && typeof first === 'object') {
    const options = first as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof options.path === 'string' && options.path) return { path: options.path };
    return {
      host: typeof options.host === 'string' && options.host ? options.host : 'localhost',
      ...(options.port !== undefined ? { port: Number(options.port) } : {}),
    };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) };
  }
  // A single string that is not a port is a unix socket path or a named pipe.
  return { path: typeof first === 'string' ? first : '' };
}

function lastFunction(args: readonly unknown[]): ((...a: unknown[]) => void) | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') return args[i] as (...a: unknown[]) => void;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------------------------

const RESOLVE_CALLS = [
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
] as const;
/** Calls whose first argument is an address, not a name: there is no allowed one. */
const ADDRESS_CALLS = ['reverse', 'lookupService'] as const;
const SPAWN_CALLS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
] as const;

type AnyFunction = (...args: unknown[]) => unknown;

/**
 * Installs the guard and returns the function that puts everything back (only what is still the
 * guard's own function: someone who patched on top keeps their patch).
 */
export function installNodeGuard(options: NodeGuardOptions): () => void {
  const restores: (() => void)[] = [];
  /** `target[name] = replacement`, remembered; own symbols and properties of the original are kept. */
  const patch = (target: object, name: string, make: (original: AnyFunction) => AnyFunction) => {
    const holder = target as Record<string, unknown>;
    const original = holder[name];
    if (typeof original !== 'function') return;
    const replacement = make(original as AnyFunction);
    // What `util.promisify` looks for (`dns.lookup` has its own argument names) stays with the call.
    for (const key of Reflect.ownKeys(original)) {
      if (key === 'prototype') continue;
      const descriptor = Object.getOwnPropertyDescriptor(original, key);
      if (descriptor) Object.defineProperty(replacement, key, descriptor);
    }
    holder[name] = replacement;
    restores.push(() => {
      if (holder[name] === replacement) holder[name] = original;
    });
  };

  // --- TCP ---------------------------------------------------------------------------------
  patch(net.Socket.prototype, 'connect', (connect) => {
    return function guardedConnect(this: net.Socket, ...args: unknown[]) {
      const target = connectTarget(args);
      if (target.path !== undefined) {
        options.refused({ kind: 'connect', host: target.path, path: target.path });
        return refuseSocket(
          this,
          systemError(`connect ENOENT ${target.path}`, {
            code: 'ENOENT',
            errno: -2,
            syscall: 'connect',
            address: target.path,
          }),
        );
      }
      const host = target.host as string;
      if (target.port === undefined || options.mayConnect(host, target.port)) {
        return connect.apply(this, args);
      }
      options.refused({ kind: 'connect', host, port: target.port });
      // A number, or a name of this machine, has an answer: nothing listens there. Any other name
      // is a domain that does not exist.
      const closedDoor = isIP(normalizeHost(host)) !== 0 || isLoopbackHost(host);
      return refuseSocket(
        this,
        closedDoor
          ? systemError(`connect ECONNREFUSED ${host}:${target.port}`, {
              code: 'ECONNREFUSED',
              errno: -61,
              syscall: 'connect',
              address: host,
              port: target.port,
            })
          : systemError(`getaddrinfo ENOTFOUND ${host}`, {
              code: 'ENOTFOUND',
              errno: -3008,
              syscall: 'getaddrinfo',
              hostname: host,
            }),
      );
    };
  });

  // --- DNS ---------------------------------------------------------------------------------
  const notFound = (host: string, call: string): Error =>
    call === 'lookup'
      ? systemError(`getaddrinfo ENOTFOUND ${host}`, {
          code: 'ENOTFOUND',
          errno: -3008,
          syscall: 'getaddrinfo',
          hostname: host,
        })
      : systemError(`${call} ECONNREFUSED ${host}`, {
          code: 'ECONNREFUSED',
          errno: -61,
          syscall: call,
          hostname: host,
        });
  const mayResolve = (host: string): boolean =>
    isIP(normalizeHost(host)) !== 0 || options.mayResolve(host);

  const guardDns = (holder: object, promises: boolean) => {
    for (const call of ['lookup', ...RESOLVE_CALLS, ...ADDRESS_CALLS]) {
      patch(holder, call, (original) => {
        const byAddress = (ADDRESS_CALLS as readonly string[]).includes(call);
        return function guardedDns(this: unknown, ...args: unknown[]) {
          const host = typeof args[0] === 'string' ? args[0] : '';
          // `lookup` of an address, and `reverse` of a loopback one, never leave the machine, and
          // `lookup` of nothing is the loopback.
          const allowed = byAddress
            ? isLoopbackHost(host)
            : (call === 'lookup' && host === '') || mayResolve(host);
          if (allowed) return original.apply(this, args);
          options.refused({ kind: 'dns', host, call });
          const error = notFound(host, call);
          if (promises) return Promise.reject(error);
          const callback = lastFunction(args);
          if (callback) process.nextTick(callback, error);
          return {};
        };
      });
    }
  };
  guardDns(dns, false);
  guardDns(dns.promises, true);
  // `dns.Resolver` and `dns.promises.Resolver` keep their own methods.
  for (const [resolver, promises] of [
    [dns.Resolver.prototype, false],
    [dns.promises.Resolver.prototype, true],
  ] as const) {
    for (const call of RESOLVE_CALLS) {
      patch(resolver, call, (original) => {
        return function guardedResolve(this: unknown, ...args: unknown[]) {
          const host = typeof args[0] === 'string' ? args[0] : '';
          if (mayResolve(host)) return original.apply(this, args);
          options.refused({ kind: 'dns', host, call });
          const error = notFound(host, call);
          if (promises) return Promise.reject(error);
          const callback = lastFunction(args);
          if (callback) process.nextTick(callback, error);
          return undefined;
        };
      });
    }
  }

  // --- UDP ---------------------------------------------------------------------------------
  for (const call of ['send', 'connect'] as const) {
    patch(dgram.Socket.prototype, call, () => {
      return function guardedUdp(this: dgram.Socket, ...args: unknown[]) {
        // `send(msg, [offset, length,] port, [address,] [callback])` and `connect(port, [address,] ...)`:
        // the port is the last number that fits one, the address the string after it.
        const portIndex = args.findLastIndex(
          (a) => typeof a === 'number' && Number.isInteger(a) && a > 0 && a < 65536,
        );
        const port = portIndex >= 0 ? (args[portIndex] as number) : undefined;
        const after = portIndex >= 0 ? args[portIndex + 1] : undefined;
        const address = typeof after === 'string' ? after : undefined;
        options.refused({ kind: 'udp', host: address ?? 'unknown', ...(port ? { port } : {}) });
        const error = systemError(`${call} EACCES ${address ?? ''}`.trimEnd(), {
          code: 'EACCES',
          errno: -13,
          syscall: call,
        });
        const callback = lastFunction(args);
        if (callback) process.nextTick(callback, error);
        else process.nextTick(() => this.emit('error', error));
      };
    });
  }

  // --- Child processes ---------------------------------------------------------------------
  for (const call of SPAWN_CALLS) {
    patch(childProcess, call, (original) => {
      return function guardedSpawn(this: unknown, ...args: unknown[]) {
        const command = typeof args[0] === 'string' ? args[0] : '';
        const rest = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
        const line = lineOf(command, rest);
        // `exec` and `execSync` take a command line; `spawn` with `shell: true` too.
        const shellOption = (args.find((a) => a && typeof a === 'object' && !Array.isArray(a)) ??
          {}) as { shell?: unknown };
        const commandLine =
          call === 'exec' ||
          call === 'execSync' ||
          shellOption.shell ||
          SHELLS.has(programName(command)) ||
          LAUNCHERS.has(programName(command));
        const denied =
          call === 'fork' ||
          DENIED_PROGRAMS.has(programName(command)) ||
          (commandLine && namesDeniedProgram(line));
        if (!denied) return original.apply(this, args);
        options.refused({ kind: 'spawn', command: line });
        throw systemError(`spawn ${command} EACCES`, {
          code: 'EACCES',
          errno: -13,
          syscall: `spawn ${command}`,
          path: command,
          spawnargs: rest,
        });
      };
    });
  }

  // `import { lookup } from 'node:dns/promises'` and the like are live bindings of the builtin's
  // exports: tell the ESM loader about the new functions.
  module.syncBuiltinESMExports();
  return () => {
    for (const restore of restores.reverse()) restore();
    restores.length = 0;
    module.syncBuiltinESMExports();
  };
}

/** A socket that fails as `error` says, asynchronously, like one that could not connect. */
function refuseSocket(socket: net.Socket, error: Error): net.Socket {
  process.nextTick(() => socket.destroy(error));
  return socket;
}
