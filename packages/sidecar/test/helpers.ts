import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import forge from 'node-forge';
import { buildSidecar } from '../src/build';
import type { Sidecar, SidecarHash } from '../src/sidecar';

let built: Promise<string> | undefined;

/** Builds the binary once per test run, into a temporary directory. */
export function sidecarBinary(): Promise<string> {
  built ??= buildSidecar({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sidecar-')) });
  return built;
}

// --- Certificates -----------------------------------------------------------------------------

interface Issued {
  certDer: Buffer;
  certPem: string;
  key: crypto.KeyObject;
}

function issue(opts: {
  cn: string;
  key: crypto.KeyObject;
  issuer?: { cert: forge.pki.Certificate; key: crypto.KeyObject };
  ca?: boolean;
  ip?: string;
}): { cert: forge.pki.Certificate } & Issued {
  const cert = forge.pki.createCertificate();
  const publicPem = crypto.createPublicKey(opts.key).export({ type: 'spki', format: 'pem' });
  cert.publicKey = forge.pki.publicKeyFromPem(publicPem.toString());
  // Even-length hex with a small first byte: a positive DER INTEGER, as Go requires.
  cert.serialNumber = `01${crypto.randomBytes(15).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 3600_000);
  cert.validity.notAfter = new Date(Date.now() + 86400_000);
  const subject = [{ name: 'commonName', value: opts.cn }];
  cert.setSubject(subject);
  cert.setIssuer(opts.issuer ? opts.issuer.cert.subject.attributes : subject);
  const extensions: object[] = [{ name: 'basicConstraints', cA: !!opts.ca }];
  if (opts.ip) extensions.push({ name: 'subjectAltName', altNames: [{ type: 7, ip: opts.ip }] });
  cert.setExtensions(extensions);
  const signer = opts.issuer?.key ?? opts.key;
  const signerPem = signer.export({ type: 'pkcs1', format: 'pem' }).toString();
  cert.sign(forge.pki.privateKeyFromPem(signerPem), forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const certDer = Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
    'binary',
  );
  return { cert, certDer, certPem, key: opts.key };
}

const rsa = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

export interface TestPki {
  caPem: string;
  server: Issued;
  /** RSA client certificate: plays the DNIe (remote key) or a .p12 (local key). */
  client: Issued;
}

export function makePki(): TestPki {
  const caKey = rsa();
  const ca = issue({ cn: 'Test CA', key: caKey, ca: true });
  const issuer = { cert: ca.cert, key: caKey };
  return {
    caPem: ca.certPem,
    server: issue({ cn: '127.0.0.1', key: rsa(), issuer, ip: '127.0.0.1' }),
    client: issue({ cn: 'PRUEBA DNIE', key: rsa(), issuer }),
  };
}

/** PKCS#1 v1.5 over a digest, as the card does it (DigestInfo + padding). */
const DIGEST_INFO: Record<SidecarHash, string> = {
  'SHA-1': '3021300906052b0e03021a05000414',
  'SHA-256': '3031300d060960864801650304020105000420',
  'SHA-384': '3041300d060960864801650304020205000430',
  'SHA-512': '3051300d060960864801650304020305000440',
};

export function signDigest(key: crypto.KeyObject, hash: SidecarHash, digest: Buffer): Buffer {
  return crypto.privateEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.concat([Buffer.from(DIGEST_INFO[hash], 'hex'), digest]),
  );
}

// --- A site that asks for a client certificate (unless requestCert is false) -------------------

export interface Site {
  url: string;
  hostPort: string;
  close(): Promise<void>;
}

export async function startSite(
  pki: TestPki,
  { requestCert = true }: { requestCert?: boolean } = {},
): Promise<Site> {
  const server = https.createServer(
    {
      key: pki.server.key.export({ type: 'pkcs8', format: 'pem' }),
      cert: pki.server.certPem,
      requestCert,
      rejectUnauthorized: false,
      ca: [pki.caPem],
      maxVersion: 'TLSv1.2',
    },
    (req, res) => {
      const socket = req.socket as tls.TLSSocket;
      const peer = socket.getPeerCertificate();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ cn: peer?.subject?.CN ?? null, authorized: socket.authorized }));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}`,
    hostPort: `127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface ProxiedResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Base64 SHA-256 of the SPKI the client was shown. */
  spki: string;
}

/** A GET through the sidecar, as one browser context (`session`) would make it. */
export async function getThrough(
  sidecar: Sidecar,
  session: string,
  url: string,
): Promise<ProxiedResponse> {
  const target = new URL(url);
  const server = await sidecar.openSession(session);
  const { username, password } = sidecar.credentials;
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: Number(new URL(server).port),
      method: 'CONNECT',
      path: target.host,
      headers: { 'proxy-authorization': `Basic ${auth}` },
    });
    req.on('connect', (res, sock) =>
      res.statusCode === 200 ? resolve(sock) : reject(new Error(`CONNECT ${res.statusCode}`)),
    );
    req.on('error', reject);
    req.end();
  });
  const secure = tls.connect({ socket, rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => {
    secure.once('secureConnect', resolve);
    secure.once('error', reject);
  });
  const peer = secure.getPeerX509Certificate();
  const spki = crypto
    .createHash('sha256')
    .update(peer?.publicKey.export({ type: 'spki', format: 'der' }) ?? Buffer.alloc(0))
    .digest('base64');
  return new Promise((resolve, reject) => {
    // Plain `http` over the TLS socket we made: `https` would open its own connection.
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: { host: target.host },
        createConnection: () => secure,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          secure.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, spki });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export function spkiOf(certDer: Buffer): string {
  return crypto
    .createHash('sha256')
    .update(new crypto.X509Certificate(certDer).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
}
