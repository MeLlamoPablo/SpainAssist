import './helpers/no-network';
import { generateKeyPairSync } from 'node:crypto';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import forge from 'node-forge';
import { afterEach, describe, expect, it } from 'vitest';
import { createMeter } from '../../src/llm/meter';
import { chatBody, post, userMessage } from './helpers/meter-env';
import { makeHome } from './helpers/tmp-home';

/** A self-signed certificate for 127.0.0.1 (the real gateway is HTTPS; the tests stay on loopback). */
function selfSigned(): { key: string; cert: string } {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicPem);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 3_600_000);
  cert.validity.notAfter = new Date(Date.now() + 3_600_000);
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  cert.sign(forge.pki.privateKeyFromPem(privatePem), forge.md.sha256.create());
  return { key: privatePem, cert: forge.pki.certificateToPem(cert) };
}

describe('meter proxy: HTTPS upstream', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  async function startUpstream(seen: { host?: string; path?: string; auth?: string }[]) {
    const { key, cert } = selfSigned();
    server = createHttpsServer({ key, cert }, (req, res) => {
      seen.push({ host: req.headers.host, path: req.url, auth: req.headers.authorization });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-litellm-response-cost': '0.002',
        });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hola por TLS' }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return { cert, url: `https://127.0.0.1:${(server!.address() as AddressInfo).port}/v1` };
  }

  it('forwards over TLS with the production path and the upstream host, trusting only the given CA', async () => {
    const seen: { host?: string; path?: string; auth?: string }[] = [];
    const { cert, url } = await startUpstream(seen);
    const t = makeHome();
    const meter = await createMeter({
      home: t.home,
      upstreams: { voucher: url },
      upstreamCa: cert,
    });
    try {
      const run = meter.openRun({ runId: 'tls', provider: 'voucher' });
      const res = await post(run, 'procedure-1', chatBody([userMessage('hola')]));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('hola por TLS');
      expect(seen).toEqual([
        {
          host: new URL(url).host,
          path: '/v1/chat/completions',
          auth: expect.stringMatching(/^Bearer /),
        },
      ]);
      expect(run.usage()).toMatchObject({
        requests: 1,
        inputTokens: 10,
        outputTokens: 3,
        costUsd: 0.002,
      });
    } finally {
      await meter.close();
      t.cleanup();
    }
  });

  it('does not skip certificate verification: an untrusted upstream is a 502', async () => {
    const seen: { host?: string; path?: string; auth?: string }[] = [];
    const { url } = await startUpstream(seen);
    const t = makeHome();
    const meter = await createMeter({ home: t.home, upstreams: { voucher: url } });
    try {
      const run = meter.openRun({ runId: 'tls', provider: 'voucher' });
      const res = await post(run, 'procedure-1', chatBody([userMessage('hola')]));
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
        /SELF_SIGNED|CERT|UNABLE/,
      );
      expect(seen).toEqual([]);
      expect(run.usage().costUsd).toBe(0);
    } finally {
      await meter.close();
      t.cleanup();
    }
  });
});
