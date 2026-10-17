/**
 * `EvalNetwork`: the browser's way to SpainBench in evaluation runs. A `CertificateProxy` (the slot
 * of `BrowserServiceOptions.certificates`, normally the Go TLS sidecar) whose per-context proxy
 * maps real hostnames to the mock instead of dialling them:
 *
 *  - Chromium connects to `portal.seg-social.gob.es:443` through the proxy (CONNECT), sees a
 *    certificate it trusts for that name (one RSA key, pinned by `--ignore-certificate-errors-spki-list`,
 *    the mechanism the sidecar uses; `ignoreHTTPSErrors` would break service workers) and every
 *    web-platform behaviour (location, cookies, redirects, CSP, downloads, inline PDFs) is native.
 *  - The decrypted requests go to SpainBench's public port with the real `Host`, the contract headers
 *    of docs/EVAL.md (world, source, resource type, harness; whatever `x-spainbench-*` the page sent
 *    is dropped) and `X-Forwarded-Proto`. Cookies travel untouched both ways.
 *  - A host that is not in the table is refused like a dead domain (`ERR_NAME_NOT_RESOLVED`; an IP
 *    address, which has no DNS to fail, is refused as a closed port), and a mapped host answers on
 *    ports 80 and 443 only. `--host-resolver-rules` makes name resolution that bypasses the proxy
 *    (Chromium's own background requests) fail; it does not stop an IP literal, and nothing in
 *    Chromium's flags stops UDP: WebRTC is closed by `--webrtc-ip-handling-policy` and by the
 *    browser factory's init script (`WEBRTC_BLOCK`, run/app/browser.ts). The scoring port is never
 *    an upstream, and Playwright sends loopback through the proxy too, so it is unreachable from
 *    the page.
 *  - The proxy asks for its credentials (`credentials`, 407) like the TLS sidecar does, so only
 *    the browser the run launched uses it.
 *  - Every request, and every refusal, becomes a `NetRecord` in the `NetLog`.
 *
 * The real TLS sidecar is never in this path: it would dial the real internet.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { type AddressInfo, isIP, type Socket } from 'node:net';
import { Transform } from 'node:stream';
import tls from 'node:tls';
import type { CertificateProxy } from '@sa/browser';
import forge from 'node-forge';
import type { NetRecord } from '../contracts';
import { type HostTable, isLoopbackHost, sameLoopbackListener, splitAuthority } from './hosts';
import { bodyFields, headersToRecord, MAX_BODY_BYTES, type NetLog } from './netlog';
import {
  declaredLength,
  HEADER_HARNESS,
  HEADER_HOST,
  HEADER_RESOURCE_TYPE,
  HEADER_SOURCE,
  HEADER_WORLD,
  HOP_BY_HOP,
  isBenchHeader,
  sanitizeResponseHeaders,
  statusText,
  withDate,
} from './wire';

export interface EvalNetworkOptions {
  /** SpainBench's plain-HTTP public listener (`http://127.0.0.1:3010`): the only upstream. */
  upstream: string | URL;
  /** The scoring listener's origin: an upstream that is the same listener is refused at construction. */
  scoringOrigin: string | URL;
  /** The real hosts SpainBench serves. May grow while the run goes (collector hosts). */
  hosts: HostTable;
  /** The world requests belong to: constant for the run, or chosen per browser session. */
  world: string | ((session: string) => string);
  log: NetLog;
  /** Idle time before an upstream request is given up with a 504, in ms. Default 120 s. */
  upstreamTimeoutMs?: number;
  /** The world's clock: responses get its time as `Date`. Without one the mock's own stays. */
  clock?: () => Date;
}

/** Every name resolves to nothing but loopback, the proxy's own address. */
export const HOST_RESOLVER_RULES = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';
/** WebRTC may use no UDP that does not go through the proxy: none, since the proxy is TCP. */
export const WEBRTC_POLICY = '--webrtc-ip-handling-policy=disable_non_proxied_udp';

const NAME_NOT_RESOLVED = 'ERR_NAME_NOT_RESOLVED';
const CONNECTION_REFUSED = 'ERR_CONNECTION_REFUSED';
/** How long an idle connection of the browser stays open. */
const IDLE_TUNNEL_MS = 300_000;
/** How long a refusal explains the browser's next error (the sidecar's own value). */
const REFUSAL_TTL_MS = 30_000;
/** The only ports a mapped host answers on, like a real site. */
const SERVED_PORTS: readonly number[] = [80, 443];
/** What a client that did not authenticate to the proxy is asked for. */
const PROXY_CHALLENGE = 'Basic realm="spainassist"';

interface Tunnel {
  scheme: 'http' | 'https';
  /** `host[:port]` as a browser writes it in the Host header. */
  authority: string;
}

interface SessionProxy {
  session: string;
  outer: http.Server;
  inner: http.Server;
  port: number;
  sockets: Set<Socket>;
  tunnels: WeakMap<Socket, Tunnel>;
  refusals: Map<string, { code: string; at: number }>;
}

export class EvalNetwork implements CertificateProxy {
  /** Base64 SHA-256 of the key the browser sees for every mapped host. */
  readonly spki: string;
  readonly credentials = { username: 'sa', password: crypto.randomBytes(24).toString('base64url') };

  private readonly upstream: URL;
  private readonly hosts: HostTable;
  private readonly world: (session: string) => string;
  private readonly log: NetLog;
  private readonly upstreamTimeoutMs: number;
  private readonly clock: (() => Date) | undefined;
  private readonly keyPem: string;
  private readonly forgeKey: forge.pki.rsa.PrivateKey;
  private leaf?: { version: number; context: tls.SecureContext; pem: string };
  /** Proxies being started or listening, by browser session. */
  private readonly sessions = new Map<string, Promise<SessionProxy>>();
  /** The ones that are listening (`networkError` is synchronous). */
  private readonly opened = new Map<string, SessionProxy>();
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  private closed = false;

  constructor(options: EvalNetworkOptions) {
    const upstream = new URL(options.upstream);
    if (upstream.protocol !== 'http:' || !isLoopbackHost(upstream.hostname))
      throw new Error(`The upstream must be a plain http loopback origin (got ${upstream.origin})`);
    if (sameLoopbackListener(upstream, options.scoringOrigin))
      throw new Error('The upstream is the scoring listener: the browser must never reach it');
    this.upstream = upstream;
    this.hosts = options.hosts;
    this.world =
      typeof options.world === 'function' ? options.world : () => options.world as string;
    this.log = options.log;
    this.upstreamTimeoutMs = options.upstreamTimeoutMs ?? 120_000;
    this.clock = options.clock;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    this.forgeKey = forge.pki.privateKeyFromPem(this.keyPem) as forge.pki.rsa.PrivateKey;
    this.spki = crypto
      .createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
  }

  /**
   * Chromium switches: trust the one key that terminates TLS for every mapped host; resolve
   * nothing but loopback (the proxy's own address), so Chromium's own background requests (time,
   * Google accounts, component updates) die at name resolution; and keep WebRTC from sending UDP
   * outside the proxy (it would reach any IP literal). Chromium keeps one of each switch, so
   * nothing else may set them: `run/app/browser.ts` fails the launch when it is not so.
   */
  get launchArgs(): string[] {
    return [
      `--ignore-certificate-errors-spki-list=${this.spki}`,
      HOST_RESOLVER_RULES,
      WEBRTC_POLICY,
    ];
  }

  /** The PEM of the certificate currently presented for the mapped hosts (SAN = every host). */
  get certificatePem(): string {
    return this.leafCertificate().pem;
  }

  /** A session's own proxy (`http://127.0.0.1:<port>`). Idempotent: contexts are re-created. */
  async openSession(session: string): Promise<string> {
    if (this.closed) throw new Error('The evaluation network is closed');
    let proxy = this.sessions.get(session);
    if (!proxy) {
      proxy = this.startProxy(session);
      this.sessions.set(session, proxy);
      proxy.catch(() => this.sessions.delete(session));
    }
    return `http://127.0.0.1:${(await proxy).port}`;
  }

  /** Client certificates do not exist in evaluation runs. */
  async configure(): Promise<never> {
    throw new Error('Certificate logins are not available in evaluation runs.');
  }

  /** The browser context is gone: its proxy closes. */
  endSession(session: string): void {
    const proxy = this.sessions.get(session);
    this.sessions.delete(session);
    void proxy?.then(
      (p) => this.stopProxy(p),
      () => {},
    );
  }

  /** Why a tunnel from this session to `host:port` was refused just now, as Chromium names it. */
  networkError(session: string, hostPort: string): string | undefined {
    const proxy = this.opened.get(session);
    const refusal = proxy?.refusals.get(hostPort.toLowerCase());
    return refusal && Date.now() - refusal.at < REFUSAL_TTL_MS ? refusal.code : undefined;
  }

  /** Closes every session's proxy and open connection. The log stays open: it is the run's. */
  async close(): Promise<void> {
    this.closed = true;
    const proxies = await Promise.allSettled([...this.sessions.values()]);
    this.sessions.clear();
    await Promise.all(
      proxies.map((p) => (p.status === 'fulfilled' ? this.stopProxy(p.value) : undefined)),
    );
    this.agent.destroy();
  }

  // -------------------------------------------------------------------------------------------
  // Proxies
  // -------------------------------------------------------------------------------------------

  private async startProxy(session: string): Promise<SessionProxy> {
    const proxy: SessionProxy = {
      session,
      outer: http.createServer(),
      inner: http.createServer(),
      port: 0,
      sockets: new Set(),
      tunnels: new WeakMap(),
      refusals: new Map(),
    };
    for (const server of [proxy.outer, proxy.inner]) {
      // An agent thinks for a while between two actions: do not close idle tunnels under it.
      server.requestTimeout = 0;
      server.keepAliveTimeout = IDLE_TUNNEL_MS;
      server.headersTimeout = IDLE_TUNNEL_MS + 5_000;
    }
    // Plain `http://` requests arrive at the proxy itself, in absolute form.
    proxy.outer.on('request', (req, res) => {
      if (!this.authorized(req)) {
        res
          .writeHead(407, {
            'proxy-authenticate': PROXY_CHALLENGE,
            'content-length': '0',
            connection: 'close',
          })
          .end();
        return;
      }
      let target: URL;
      try {
        target = new URL(req.url ?? '');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
        return;
      }
      if (target.protocol !== 'http:') {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
        return;
      }
      this.forward(
        proxy,
        req,
        res,
        { scheme: 'http', authority: target.host },
        `${target.pathname}${target.search}`,
      );
    });
    // `https://` (and `ws://`) arrive as CONNECT tunnels; TLS ends here.
    // The tunnel's stream is a net.Socket.
    proxy.outer.on('connect', (req, socket, head) =>
      this.connect(proxy, req, socket as Socket, head),
    );
    // Requests inside a tunnel, already decrypted, in origin form.
    proxy.inner.on('request', (req, res) => {
      const tunnel = proxy.tunnels.get(req.socket);
      if (!tunnel) {
        res.writeHead(421).end();
        return;
      }
      this.forward(proxy, req, res, tunnel, req.url ?? '/');
    });
    for (const server of [proxy.outer, proxy.inner])
      server.on('clientError', (_err, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      proxy.outer.once('error', reject);
      proxy.outer.listen(0, '127.0.0.1', () => resolve());
    });
    proxy.port = (proxy.outer.address() as AddressInfo).port;
    this.opened.set(session, proxy);
    return proxy;
  }

  private async stopProxy(proxy: SessionProxy): Promise<void> {
    this.opened.delete(proxy.session);
    for (const socket of proxy.sockets) socket.destroy();
    proxy.sockets.clear();
    proxy.outer.closeAllConnections();
    proxy.inner.closeAllConnections();
    await Promise.all(
      [proxy.outer, proxy.inner].map(
        (server) =>
          new Promise<void>((resolve) =>
            server.listening ? server.close(() => resolve()) : resolve(),
          ),
      ),
    );
  }

  private connect(
    proxy: SessionProxy,
    req: http.IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void {
    socket.on('error', () => {});
    if (!this.authorized(req)) {
      socket.end(
        `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${PROXY_CHALLENGE}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    const { host, port } = splitAuthority(req.url ?? '');
    const targetPort = port ?? 443;
    if (!host || !this.hosts.has(host) || !SERVED_PORTS.includes(targetPort)) {
      this.refuseTunnel(proxy, req, socket, host || (req.url ?? ''), targetPort);
      return;
    }
    // A browser waits for the 200 before it sends anything: an early byte is not a browser.
    if (head.length) {
      socket.destroy();
      return;
    }
    // Like http.Server does for its own connections: a response that is written in pieces (a
    // stream, a header and its first chunk) must not wait for the browser's delayed ACKs.
    socket.setNoDelay(true);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const plain = targetPort === 80;
    let connection: Socket = socket;
    if (!plain) {
      const secure = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext: this.leafCertificate().context,
        ALPNProtocols: ['http/1.1'],
      });
      secure.on('error', () => {});
      connection = secure;
    }
    proxy.sockets.add(socket);
    proxy.sockets.add(connection);
    connection.once('close', () => {
      proxy.sockets.delete(connection);
      proxy.sockets.delete(socket);
    });
    proxy.tunnels.set(connection, {
      scheme: plain ? 'http' : 'https',
      authority: authorityOf(host, targetPort, plain ? 80 : 443),
    });
    proxy.inner.emit('connection', connection);
  }

  /** Whether the request carries the proxy's credentials (Basic), checked in constant time. */
  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers['proxy-authorization'];
    const given = typeof header === 'string' ? /^Basic\s+(\S+)$/i.exec(header)?.[1] : undefined;
    if (!given) return false;
    const expected = Buffer.from(`${this.credentials.username}:${this.credentials.password}`);
    const actual = Buffer.from(given, 'base64');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  /**
   * What Chromium reports for a refused destination: a name that is not mapped does not exist; an
   * address, this machine, or a mapped host on a port it does not serve is a closed door (a
   * number has no DNS to fail).
   */
  private refuseCode(host: string): string {
    return isIP(host) || isLoopbackHost(host) || this.hosts.has(host)
      ? CONNECTION_REFUSED
      : NAME_NOT_RESOLVED;
  }

  private refuseTunnel(
    proxy: SessionProxy,
    req: http.IncomingMessage,
    socket: Socket,
    host: string,
    port: number,
  ): void {
    const code = this.refuseCode(host);
    proxy.refusals.set(`${host}:${port}`, { code, at: Date.now() });
    this.log.append({
      channel: 'browser',
      method: 'CONNECT',
      url: `${port === 80 ? 'http' : 'https'}://${authorityOf(host, port, port === 80 ? 80 : 443)}/`,
      host,
      route: 'unmapped',
      reqHeaders: headersToRecord(withoutProxyHeaders(req.rawHeaders)),
      durationMs: 0,
      error: code,
    });
    socket.end(
      `HTTP/1.1 502 Bad Gateway\r\nX-Sa-Network-Error: ${code}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // One request
  // -------------------------------------------------------------------------------------------

  private forward(
    proxy: SessionProxy,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    tunnel: Tunnel,
    path: string,
  ): void {
    const { host } = splitAuthority(tunnel.authority);
    const seq = this.log.nextSeq();
    const t = this.log.stamp();
    const started = performance.now();
    const clientHeaders = withoutProxyHeaders(req.rawHeaders);
    const sent = headersToRecord(clientHeaders);
    const resourceType = resourceTypeOf(sent);
    const url = `${tunnel.scheme}://${tunnel.authority}${path}`;
    const method = req.method ?? 'GET';

    // The body, for the record: the first 64 KB and its size.
    let bodySize = 0;
    const kept: Buffer[] = [];
    let keptSize = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bodySize += chunk.length;
        if (keptSize < MAX_BODY_BYTES) {
          const part = chunk.subarray(0, MAX_BODY_BYTES - keptSize);
          kept.push(part);
          keptSize += part.length;
        }
        callback(null, chunk);
      },
    });

    let written = false;
    const write = (rest: Partial<NetRecord> & { route: NetRecord['route'] }) => {
      if (written) return;
      written = true;
      this.log.append({
        seq,
        t,
        channel: 'browser',
        method,
        url,
        host,
        resourceType,
        reqHeaders: sent,
        ...bodyFields(Buffer.concat(kept), bodySize),
        durationMs: Math.round(performance.now() - started),
        ...rest,
      });
    };

    const { port: requestedPort } = splitAuthority(tunnel.authority);
    const port = requestedPort ?? (tunnel.scheme === 'http' ? 80 : 443);
    if (!this.hosts.has(host) || !SERVED_PORTS.includes(port)) {
      // Plain http to a host that is not mapped (or to a port it does not serve): the sidecar's
      // convention for Chromium. The body is read first: it is part of what was attempted.
      const code = this.refuseCode(host);
      proxy.refusals.set(`${host}:${port}`, { code, at: Date.now() });
      const refuse = () => {
        write({ route: 'unmapped', error: code });
        if (res.destroyed) return;
        res.writeHead(502, {
          'x-sa-network-error': code,
          'content-type': 'text/plain; charset=utf-8',
        });
        res.end(`${code}\n`);
      };
      req.pipe(tap).resume();
      if (req.readableEnded) refuse();
      else req.once('end', refuse);
      return;
    }

    const upstreamReq = http.request({
      agent: this.agent,
      host: this.upstream.hostname.replace(/^\[|\]$/g, ''),
      port: this.upstream.port || 80,
      method,
      path,
      headers: this.upstreamHeaders(proxy.session, clientHeaders, tunnel, resourceType),
    });
    upstreamReq.setTimeout(this.upstreamTimeoutMs, () =>
      upstreamReq.destroy(new Error('upstream timeout')),
    );
    let answered = false;
    upstreamReq.once('response', (upstreamRes) => {
      answered = true;
      const { headers: sanitized, bench } = sanitizeResponseHeaders(upstreamRes.rawHeaders, {
        mock: this.upstream,
        realOrigin: `${tunnel.scheme}://${tunnel.authority}`,
      });
      const headers = withDate(sanitized, this.clock);
      const status = upstreamRes.statusCode ?? 502;
      const text = statusText(status);
      if (text) res.writeHead(status, text, headers.flat());
      else res.writeHead(status, headers.flat());
      upstreamRes.on('error', () => res.destroy());
      upstreamRes.pipe(res);
      // Written as soon as the answer is known (and the request body was read, which a server may
      // answer before), not when the page is done with the body: a download may never end.
      const record = () =>
        write({
          route: 'mapped',
          status,
          ...(bench ? { bench } : {}),
          ...declaredLength(upstreamRes.headers),
        });
      if (req.readableEnded) record();
      else {
        req.once('end', record);
        res.once('close', record);
      }
    });
    upstreamReq.on('error', (err: NodeJS.ErrnoException) => {
      if (answered) return; // a failure of the body shows to the browser as a broken response
      write({ route: 'mapped', error: `${err.code ?? err.name}: ${err.message}` });
      if (res.destroyed) return;
      if (!res.headersSent)
        res.writeHead(502, {
          'x-sa-network-error': CONNECTION_REFUSED,
          'content-type': 'text/plain; charset=utf-8',
        });
      res.end();
    });
    // The browser gave up (a navigation was cancelled...) before the mock answered.
    res.once('close', () => {
      if (!answered) upstreamReq.destroy();
    });
    req.pipe(tap).pipe(upstreamReq);
  }

  private upstreamHeaders(
    session: string,
    clientHeaders: readonly string[],
    tunnel: Tunnel,
    resourceType: string,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headersToRecord(clientHeaders))) {
      if (name === 'host' || isBenchHeader(name)) continue;
      out[name] = value;
    }
    out.host = tunnel.authority;
    out[HEADER_HOST] = tunnel.authority;
    out[HEADER_WORLD] = this.world(session);
    out[HEADER_SOURCE] = 'browser';
    out[HEADER_RESOURCE_TYPE] = resourceType;
    out[HEADER_HARNESS] = '1';
    out['x-forwarded-proto'] = tunnel.scheme;
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // TLS
  // -------------------------------------------------------------------------------------------

  /** A self-signed leaf with this network's key whose SAN lists every mapped host (rebuilt when the table changes). */
  private leafCertificate(): { context: tls.SecureContext; pem: string } {
    const version = this.hosts.version;
    if (this.leaf?.version === version) return this.leaf;
    const publicKey = forge.pki.setRsaPublicKey(this.forgeKey.n, this.forgeKey.e);
    const cert = forge.pki.createCertificate();
    cert.publicKey = publicKey;
    cert.serialNumber = randomSerialHex();
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const subject = [{ name: 'commonName', value: 'localhost' }];
    cert.setSubject(subject);
    cert.setIssuer(subject);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: this.hosts.patterns().map((value) => ({ type: 2, value })),
      },
    ]);
    cert.sign(this.forgeKey, forge.md.sha256.create());
    const pem = forge.pki.certificateToPem(cert);
    this.leaf = { version, pem, context: tls.createSecureContext({ key: this.keyPem, cert: pem }) };
    return this.leaf;
  }
}

/** A positive serial without a leading zero byte (OpenSSL rejects a DER integer that has one). */
function randomSerialHex(): string {
  const bytes = crypto.randomBytes(16);
  bytes[0] = ((bytes[0] as number) & 0x7f) | 0x10;
  return bytes.toString('hex');
}

function authorityOf(host: string, port: number, defaultPort: number): string {
  return port === defaultPort ? host : `${host}:${port}`;
}

/** The raw request headers without what is addressed to the proxy itself. */
function withoutProxyHeaders(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = (raw[i] as string).toLowerCase();
    if (name.startsWith('proxy-') || HOP_BY_HOP.has(name)) continue;
    out.push(raw[i] as string, raw[i + 1] as string);
  }
  return out;
}

const DEST_TO_RESOURCE_TYPE: Record<string, string> = {
  document: 'document',
  iframe: 'subdocument',
  frame: 'subdocument',
  fencedframe: 'subdocument',
  image: 'image',
  style: 'stylesheet',
  script: 'script',
  font: 'font',
  audio: 'media',
  video: 'media',
  track: 'media',
  manifest: 'manifest',
  worker: 'other',
  sharedworker: 'other',
  serviceworker: 'other',
  object: 'other',
  embed: 'other',
  report: 'other',
  xslt: 'other',
};

/**
 * Playwright's resource type of a request, as far as the proxy can tell from what Chromium sends:
 * `Sec-Fetch-Dest` (frames are `subdocument`, since SpainBench counts both as navigations), and for
 * scripted requests (`empty`) `xhr` or `fetch`.
 */
export function resourceTypeOf(headers: Record<string, string>): string {
  const dest = headers['sec-fetch-dest'];
  if (dest === 'empty') return headers['x-requested-with'] === 'XMLHttpRequest' ? 'xhr' : 'fetch';
  if (dest) return DEST_TO_RESOURCE_TYPE[dest] ?? 'other';
  // Plain http carries no Sec-Fetch-* headers: navigations are the requests that ask for a page.
  if (headers['upgrade-insecure-requests'] === '1' && /^text\/html/i.test(headers.accept ?? ''))
    return 'document';
  return 'other';
}
