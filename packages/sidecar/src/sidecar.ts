/**
 * The Node side of sa-sidecar (`../go`): starts the binary, configures sessions, and answers its
 * calls for remote keys (the DNIe in the phone). Protocol: `go/protocol.go`.
 *
 * One sidecar serves every browser context. `openSession(session)` gives a context its own proxy
 * port; every request on it needs `credentials` (the per-launch password, answered by the
 * browser). `configure(session, hosts, identity)` turns on a client certificate for those hosts of
 * that context only. Other traffic is a TCP tunnel, so Chromium checks those sites itself.
 *
 * The password and the key Chromium trusts (`launchArgs`) are made here, so a crashed sidecar
 * restarts with the same key and reopens each session on its port: the browser only notices the
 * connections that were open.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import crypto, { KeyObject } from 'node:crypto';
import readline from 'node:readline';
import { z } from 'zod';

export type SidecarHash = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

/** The language of the sidecar's error pages: the app's (`@sa/shared`'s Language). */
export type SidecarLanguage = 'es' | 'en';

/** A failure with a code the sidecar shows the browser (`go/errors.go`): "declined", "unavailable"... */
export class SidecarError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SidecarError';
  }
}

/** A key outside the app: the DNIe in the paired phone. RSA PKCS#1 v1.5 only. */
export interface RemoteKey {
  /**
   * Before each new upstream connection. Resolves once `sign` can answer quickly (the user may
   * approve on the phone first); rejects with a SidecarError to fail the request.
   */
  prepare(host: string, signal: AbortSignal): Promise<void>;
  /** PKCS#1 v1.5 signature over `digest` (already hashed with `hash`). */
  sign(digest: Buffer, hash: SidecarHash, host: string, signal: AbortSignal): Promise<Buffer>;
}

export interface SidecarIdentity {
  /** Names the certificate in calls and logs (the vault credential id). */
  id: string;
  /** DER certificates, leaf first. */
  chain: Uint8Array[];
  /** A key the sidecar keeps in memory (a .p12's), or a remote one. */
  key: KeyObject | RemoteKey;
  /** Upstream connections per host (default 2 for remote keys, 6 otherwise). */
  maxConns?: number;
}

export type SidecarEvent =
  | {
      event: 'handshake';
      session: string;
      identity: string;
      host: string;
      resumed: boolean;
      signed: boolean;
    }
  | {
      event: 'upstream_error';
      session: string;
      identity: string;
      host: string;
      code: string;
      message: string;
    };

export interface SidecarLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
}

export interface SidecarOptions {
  binaryPath: string;
  /** DEVELOPMENT/TESTS ONLY: don't verify upstream certificates (the mock sede's). */
  insecureUpstream?: boolean;
  /** Tests: trust only these CAs upstream (PEM). Default: the platform's verifier. */
  roots?: string[];
  /** The language of the error pages the browser shows (default "es"). See `setLanguage`. */
  language?: SidecarLanguage;
  logger?: SidecarLogger;
  onEvent?(event: SidecarEvent): void;
}

const FromSidecar = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), spki: z.string() }),
  z.object({
    type: z.literal('ack'),
    id: z.number().int(),
    port: z.number().int().positive().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('call'),
    id: z.number().int(),
    method: z.enum(['prepare', 'sign']),
    session: z.string(),
    identity: z.string(),
    host: z.string(),
    hash: z.enum(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']).optional(),
    digest: z.string().optional(),
  }),
  z.object({ type: z.literal('cancel'), id: z.number().int() }),
  z.object({
    type: z.literal('event'),
    event: z.enum(['handshake', 'upstream_error', 'tunnel_error']),
    session: z.string(),
    identity: z.string().optional(),
    host: z.string(),
    resumed: z.boolean().optional(),
    signed: z.boolean().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('log'), level: z.string(), message: z.string() }),
]);
type FromSidecar = z.infer<typeof FromSidecar>;
type Call = Extract<FromSidecar, { type: 'call' }>;

interface SessionState {
  port?: number;
  opening?: Promise<number>;
  hosts: string[];
  identity: SidecarIdentity | null;
}

const ACK_TIMEOUT_MS = 10_000;
const MAX_RESTARTS = 5;
/** How long a failed tunnel explains the browser's next error. */
const NETWORK_ERROR_TTL_MS = 30_000;

export class Sidecar {
  private readonly password = crypto.randomBytes(24).toString('base64url');
  /** Base64 SHA-256 of the key the browser sees for intercepted hosts. */
  readonly spki: string;
  private readonly key: KeyObject;
  private language: SidecarLanguage;
  private child?: ChildProcess;
  private ready: Promise<void> = Promise.resolve();
  private onReady?: (spki: string) => void;
  private closed = false;
  private restarts: number[] = [];
  private nextAck = 0;
  private readonly acks = new Map<number, (ack: { port?: number; error?: string }) => void>();
  private readonly calls = new Map<number, AbortController>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly networkErrors = new Map<string, { code: string; at: number }>();

  private constructor(private readonly options: SidecarOptions) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    this.language = options.language ?? 'es';
    this.spki = crypto
      .createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
  }

  /** Starts the binary. Rejects when it is missing or can't start. */
  static async start(options: SidecarOptions): Promise<Sidecar> {
    const sidecar = new Sidecar(options);
    try {
      await sidecar.launch();
    } catch (error) {
      await sidecar.close();
      throw error;
    }
    return sidecar;
  }

  /** Chromium switches: trust the sidecar's key (only intercepted hosts present it). */
  get launchArgs(): string[] {
    return [`--ignore-certificate-errors-spki-list=${this.spki}`];
  }

  /** What the browser answers when a session's port asks for proxy authentication. */
  get credentials(): { username: string; password: string } {
    return { username: 'sa', password: this.password };
  }

  /** A session's own proxy (`http://127.0.0.1:<port>`), opened on first use. */
  async openSession(session: string): Promise<string> {
    let state = this.sessions.get(session);
    if (!state) {
      state = { hosts: [], identity: null };
      this.sessions.set(session, state);
    }
    if (!state.port) {
      state.opening ??= this.send(session, state).finally(() => {
        if (state) state.opening = undefined;
      });
      state.port = await state.opening;
    }
    return `http://127.0.0.1:${state.port}`;
  }

  /**
   * Presents `identity` to `hosts` ("host" or "host:port") for this session's connections, or
   * turns certificates off with `null`. Open connections to those hosts are closed, so the next
   * request uses the new setting.
   */
  async configure(
    session: string,
    hosts: readonly string[],
    identity: SidecarIdentity | null,
  ): Promise<void> {
    await this.openSession(session);
    const state = this.sessions.get(session);
    if (!state) throw new SidecarError('unavailable', 'the session was ended');
    state.hosts = identity ? [...hosts] : [];
    state.identity = identity && hosts.length ? identity : null;
    await this.send(session, state);
  }

  /** The app's language changed: later error pages use it (it survives restarts too). */
  setLanguage(language: SidecarLanguage): void {
    if (language === this.language) return;
    this.language = language;
    this.write({ type: 'language', language });
  }

  /** The browser context is gone: its port closes. */
  endSession(session: string): void {
    this.sessions.delete(session);
    this.write({ type: 'end', session });
  }

  /**
   * Why a tunnel from this session to `host` ("host:port") failed just now, as Chromium names it
   * (ERR_CONNECTION_REFUSED...). Chromium itself only sees a failed tunnel.
   */
  networkError(session: string, host: string): string | undefined {
    const entry = this.networkErrors.get(`${session} ${host}`);
    return entry && Date.now() - entry.at < NETWORK_ERROR_TTL_MS ? entry.code : undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    for (const controller of this.calls.values()) controller.abort();
    this.calls.clear();
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill(), 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin?.end(); // the sidecar exits when stdin closes
    });
  }

  private launch(): Promise<void> {
    const child = spawn(this.options.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      this.onReady = (spki) => {
        if (spki === this.spki) resolve();
        else reject(new Error('sa-sidecar reported another key'));
      };
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`sa-sidecar exited (${code})`)));
    });
    // Unhandled until someone awaits it.
    this.ready.catch(() => {});
    child.stdin?.on('error', () => {}); // EPIPE after a crash: handled by 'exit'
    readline.createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line));
    readline
      .createInterface({ input: child.stderr! })
      .on('line', (line) => this.options.logger?.warn('sidecar', { message: line.slice(0, 300) }));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    this.write({
      type: 'config',
      password: this.password,
      key: this.key.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      ...(this.options.insecureUpstream ? { insecureUpstream: true } : {}),
      ...(this.options.roots?.length ? { roots: this.options.roots } : {}),
      language: this.language,
    });
    return this.ready;
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    for (const done of this.acks.values()) done({ error: 'the sidecar stopped' });
    this.acks.clear();
    for (const controller of this.calls.values()) controller.abort();
    this.calls.clear();
    if (this.closed) return;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60_000);
    this.options.logger?.warn('sidecar stopped', { code, signal, restarts: this.restarts.length });
    if (this.restarts.length >= MAX_RESTARTS) return;
    this.restarts.push(now);
    this.launch().then(
      () => {
        // Same ports: the browser contexts keep their proxy settings.
        for (const [session, state] of this.sessions)
          if (state.port) void this.send(session, state).catch(() => {});
      },
      (err) => this.options.logger?.warn('sidecar restart failed', { error: String(err) }),
    );
  }

  /** Sends a session's state; resolves with its port. */
  private async send(session: string, state: SessionState): Promise<number> {
    await this.ready;
    const id = ++this.nextAck;
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => done({ error: 'no answer from the sidecar' }), ACK_TIMEOUT_MS);
      const done = (ack: { port?: number; error?: string }) => {
        clearTimeout(timer);
        this.acks.delete(id);
        if (ack.error) reject(new SidecarError('unavailable', ack.error));
        else if (!ack.port) reject(new SidecarError('unavailable', 'no port'));
        else resolve(ack.port);
      };
      this.acks.set(id, done);
      const sent = this.write({
        type: 'session',
        id,
        session,
        ...(state.port ? { listen: `127.0.0.1:${state.port}` } : {}),
        hosts: state.hosts,
        ...(state.identity ? { identity: spec(state.identity) } : {}),
      });
      if (!sent) done({ error: 'the sidecar is not running' });
    });
  }

  private onLine(line: string): void {
    let message: FromSidecar;
    try {
      message = FromSidecar.parse(JSON.parse(line));
    } catch {
      this.options.logger?.warn('sidecar: unreadable message');
      return;
    }
    switch (message.type) {
      case 'ready':
        this.onReady?.(message.spki);
        return;
      case 'ack':
        this.acks.get(message.id)?.({ port: message.port, error: message.error || undefined });
        return;
      case 'call':
        void this.answer(message);
        return;
      case 'cancel':
        this.calls.get(message.id)?.abort();
        return;
      case 'event':
        this.onSidecarEvent(message);
        return;
      case 'log':
        this.options.logger?.[message.level === 'info' ? 'info' : 'warn']('sidecar', {
          message: message.message.slice(0, 300),
        });
        return;
    }
  }

  private onSidecarEvent(message: Extract<FromSidecar, { type: 'event' }>): void {
    if (message.event === 'tunnel_error') {
      if (this.networkErrors.size > 200) this.networkErrors.clear();
      this.networkErrors.set(`${message.session} ${message.host}`, {
        code: message.code ?? 'ERR_CONNECTION_FAILED',
        at: Date.now(),
      });
    } else if (message.event === 'handshake') {
      this.options.onEvent?.({
        event: 'handshake',
        session: message.session,
        identity: message.identity ?? '',
        host: message.host,
        resumed: !!message.resumed,
        signed: !!message.signed,
      });
    } else {
      this.options.onEvent?.({
        event: 'upstream_error',
        session: message.session,
        identity: message.identity ?? '',
        host: message.host,
        code: message.code ?? 'failed',
        message: message.message ?? '',
      });
    }
  }

  private async answer(call: Call): Promise<void> {
    const controller = new AbortController();
    this.calls.set(call.id, controller);
    try {
      const identity = this.sessions.get(call.session)?.identity;
      if (!identity || identity.id !== call.identity || identity.key instanceof KeyObject)
        throw new SidecarError('unavailable', 'the certificate is no longer enabled');
      if (call.method === 'prepare') {
        await identity.key.prepare(call.host, controller.signal);
        this.write({ type: 'reply', id: call.id });
      } else {
        if (!call.digest || !call.hash) throw new SidecarError('failed', 'bad sign call');
        const signature = await identity.key.sign(
          Buffer.from(call.digest, 'base64'),
          call.hash,
          call.host,
          controller.signal,
        );
        this.write({ type: 'reply', id: call.id, signature: signature.toString('base64') });
      }
    } catch (err) {
      if (controller.signal.aborted) return; // the sidecar gave up on it
      this.write({
        type: 'reply',
        id: call.id,
        error: err instanceof SidecarError ? err.code : 'failed',
        message: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    } finally {
      this.calls.delete(call.id);
    }
  }

  private write(message: object): boolean {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return false;
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }
}

function spec(identity: SidecarIdentity) {
  return {
    id: identity.id,
    chain: identity.chain.map((der) => Buffer.from(der).toString('base64')),
    ...(identity.key instanceof KeyObject
      ? { key: identity.key.export({ type: 'pkcs8', format: 'der' }).toString('base64') }
      : {}),
    ...(identity.maxConns ? { maxConns: identity.maxConns } : {}),
  };
}
