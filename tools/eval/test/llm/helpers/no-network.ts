import dns from 'node:dns';
import net from 'node:net';

/**
 * Deny-by-default network guard for the offline tests of the llm part. Import it first in every
 * test file: from then on a connection to anything but the loopback interface throws before a
 * packet is sent (TCP through `net`, which `http`, `https`, `tls` and undici all use; DNS lookups
 * of names other than `localhost`; `fetch` with a clear message). A test that reaches for a real
 * host fails loudly instead of contacting it.
 */

export class NetworkGuardError extends Error {
  constructor(target: string) {
    super(`Network guard: refusing to reach ${target}; offline tests may only use 127.0.0.1`);
    this.name = 'NetworkGuardError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function targetOf(rawArgs: unknown[]): { host?: string; port?: number; path?: string } {
  // Node passes `[options, callback]` pre-normalized as the single argument of internal calls.
  const args = Array.isArray(rawArgs[0]) ? (rawArgs[0] as unknown[]) : rawArgs;
  const first = args[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const options = first as { host?: string; port?: number | string; path?: string };
    return {
      host: options.host ?? 'localhost',
      ...(options.port !== undefined ? { port: Number(options.port) } : {}),
      ...(options.path ? { path: options.path } : {}),
    };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) };
  }
  // A single string is a unix socket path.
  return { path: typeof first === 'string' ? first : undefined } as { path?: string };
}

declare global {
  // eslint-disable-next-line no-var
  var __saNetworkGuardInstalled: boolean | undefined;
}

function installNetworkGuard(): void {
  if (globalThis.__saNetworkGuardInstalled) return;
  globalThis.__saNetworkGuardInstalled = true;

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const target = targetOf(args);
    if (!target.path && target.host && !isLoopbackHost(target.host)) {
      throw new NetworkGuardError(`${target.host}:${target.port ?? ''}`);
    }
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  const lookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname: string, ...rest: unknown[]) {
    if (!isLoopbackHost(hostname)) throw new NetworkGuardError(hostname);
    return (lookup as (...a: unknown[]) => unknown).call(dns, hostname, ...rest);
  } as typeof dns.lookup;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (!isLoopbackHost(url.hostname)) throw new NetworkGuardError(url.host);
    return realFetch(input, init);
  }) as typeof fetch;
}

installNetworkGuard();
