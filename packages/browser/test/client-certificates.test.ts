import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { Sidecar, SidecarError, type SidecarHash, type SidecarIdentity } from '@sa/sidecar';
import { buildSidecar } from '@sa/sidecar/build';
import { openP12 } from '@sa/signer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestService, page, sendHtml, startServer, type TestServer } from './helpers';
import { fixtureCert, makePki, type TestPki } from './pki';

/*
 * A local HTTPS server that, like the Cl@ve gateway, *optionally* asks for a client certificate
 * during the handshake and shows its own error page ("003002") when none is presented. The
 * browser reaches it through the real TLS sidecar.
 */
let pki: TestPki;
let server: TestServer;
let sidecar: Sidecar;
let t: ReturnType<typeof createTestService>;
const signatures: string[] = [];

beforeAll(async () => {
  pki = makePki('PRUEBA RSA - 99999999R');
  server = await startServer(
    {
      '/login': (req, res) => {
        const socket = req.socket as TLSSocket;
        if (socket.authorized) {
          const cn = socket.getPeerCertificate().subject?.CN;
          sendHtml(res, page(`<h1>Bienvenido, ${cn}</h1>`, 'Sede'), {
            'set-cookie': 'cert_session=ok; Path=/; Secure',
          });
        } else {
          sendHtml(
            res,
            page(
              '<h1>Error</h1><p>003002 - Authentication Failed (no se ha presentado certificado)</p>',
            ),
          );
        }
      },
      '/state': (_req, res) =>
        sendHtml(
          res,
          page(
            `<script>localStorage.setItem('ls', 'hola'); sessionStorage.setItem('ss', 'mundo');</script><p>ok</p>`,
          ),
          { 'set-cookie': 'sid=abc123; Path=/; Secure' },
        ),
      '/show-state': (req, res) =>
        sendHtml(
          res,
          page(
            `<p>Cookies: ${req.headers.cookie ?? ''}</p><p id=s></p>
             <script>document.getElementById('s').textContent = 'LS: ' + localStorage.getItem('ls') + ' SS: ' + sessionStorage.getItem('ss')</script>`,
          ),
        ),
    },
    {
      https: {
        key: pki.server.key,
        cert: pki.server.cert,
        ca: [pki.caPem, fixtureCert('client-ca.pem').toString()],
        requestCert: true,
        rejectUnauthorized: false,
      },
    },
  );
  sidecar = await Sidecar.start({
    binaryPath: await buildSidecar({
      outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sidecar-')),
    }),
    // The sidecar verifies the test server against the test CA.
    roots: [pki.caPem],
    onEvent: (e) => {
      if (e.event === 'handshake' && e.signed) signatures.push(e.identity);
    },
  });
  // Tunnelled (not intercepted) requests: Chromium checks the self-signed test server itself.
  t = createTestService({ ignoreHTTPSErrors: true, certificates: sidecar });
}, 120_000);

afterAll(async () => {
  await t?.cleanup();
  await sidecar?.close();
  await server?.close();
});

function p12Identity(id: string, p12: Buffer, passphrase: string): SidecarIdentity {
  const opened = openP12(p12, passphrase);
  return { id, chain: opened.chainDer, key: opened.privateKey };
}

const DIGEST_INFO: Record<SidecarHash, string> = {
  'SHA-1': '3021300906052b0e03021a05000414',
  'SHA-256': '3031300d060960864801650304020105000420',
  'SHA-384': '3041300d060960864801650304020205000430',
  'SHA-512': '3051300d060960864801650304020305000440',
};

/** The DNI in the phone: signs digests with PKCS#1 v1.5, maybe after the user declines. */
function phoneIdentity(id: string, opts: { decline?: boolean } = {}): SidecarIdentity {
  const opened = openP12(pki.client.p12Aes, pki.client.passphrase);
  return {
    id,
    chain: opened.chainDer,
    key: {
      prepare: async () => {
        if (opts.decline) throw new SidecarError('declined', 'the user said no');
      },
      sign: async (digest, hash) =>
        crypto.privateEncrypt(
          { key: opened.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
          Buffer.concat([Buffer.from(DIGEST_INFO[hash], 'hex'), digest]),
        ),
    },
  };
}

describe('client certificates through the sidecar', () => {
  it('presents the certificate only after useClientCertificate, keeping cookies and storage', async () => {
    await t.service.open('cert', `${server.origin}/state`);
    let obs = await t.service.open('cert', `${server.origin}/login`);
    expect(obs.snapshot).toContain('003002');
    // The sidecar answered the request with no certificate: Chromium showed no picker.
    expect(obs.notes.join('\n')).toContain('asked for a client certificate and none was presented');
    expect(obs.notes.join('\n')).toContain(`with origins ["${server.origin}"]`);

    await t.service.useClientCertificate('cert', {
      origins: [server.origin],
      identity: p12Identity('p12', pki.client.p12Aes, pki.client.passphrase),
    });
    obs = await t.service.open('cert', `${server.origin}/login`);
    expect(obs.snapshot).toContain('Bienvenido, PRUEBA RSA - 99999999R');

    // Same context: nothing was lost.
    obs = await t.service.open('cert', `${server.origin}/show-state`);
    expect(obs.snapshot).toContain('sid=abc123');
    expect(obs.snapshot).toContain('cert_session=ok');
    expect(obs.snapshot).toContain('LS: hola SS: mundo');

    await t.service.useClientCertificate('cert', null);
    obs = await t.service.open('cert', `${server.origin}/login`);
    expect(obs.snapshot).toContain('003002');
  });

  it('logs in with EC and legacy (RC2-40) .p12 files', async () => {
    for (const [file, cn] of [
      ['ec-legacy.p12', 'PRUEBA EC - 00000000T'],
      ['ec-modern.p12', 'PRUEBA EC - 00000000T'],
      ['rsa-legacy.p12', 'PRUEBA RSA LEGACY - 00000001R'],
    ] as const) {
      const id = `cert-${file}`;
      // Before the browser context exists.
      await t.service.useClientCertificate(id, {
        origins: [server.origin],
        identity: p12Identity(file, fixtureCert(file), 'test'),
      });
      const obs = await t.service.open(id, `${server.origin}/login`);
      expect(obs.snapshot).toContain(`Bienvenido, ${cn}`);
    }
  });

  it('presents certificates only to the listed origins', async () => {
    await t.service.useClientCertificate('cert-other', {
      origins: ['https://localhost:1'],
      identity: p12Identity('p12', pki.client.p12Aes, pki.client.passphrase),
    });
    const obs = await t.service.open('cert-other', `${server.origin}/login`);
    expect(obs.snapshot).toContain('003002');
  });

  it('logs in with a remote key (the DNI in the phone), one signature per connection', async () => {
    signatures.length = 0;
    await t.service.useClientCertificate('dnie', {
      origins: [server.origin],
      identity: phoneIdentity('dnie-1'),
    });
    let obs = await t.service.open('dnie', `${server.origin}/login`);
    expect(obs.snapshot).toContain('Bienvenido, PRUEBA RSA - 99999999R');
    obs = await t.service.open('dnie', `${server.origin}/show-state`);
    expect(obs.snapshot).toContain('cert_session=ok');
    expect(signatures.filter((s) => s === 'dnie-1')).toHaveLength(1);
  });

  it('tells the agent when the user declines the login', async () => {
    await t.service.useClientCertificate('dnie-no', {
      origins: [server.origin],
      identity: phoneIdentity('dnie-2', { decline: true }),
    });
    const obs = await t.service.open('dnie-no', `${server.origin}/login`);
    expect(obs.snapshot).toContain('No se ha aprobado');
    expect(obs.notes.join('\n')).toMatch(/did not approve the certificate login to localhost/);
  });

  it('refuses certificate logins without the sidecar', async () => {
    const plain = createTestService({ ignoreHTTPSErrors: true, certificates: undefined });
    try {
      await expect(
        plain.service.useClientCertificate('x', {
          origins: [server.origin],
          identity: p12Identity('p12', pki.client.p12Aes, pki.client.passphrase),
        }),
      ).rejects.toMatchObject({ code: 'certificate' });
    } finally {
      await plain.cleanup();
    }
  });
});
