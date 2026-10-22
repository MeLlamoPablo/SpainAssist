import { createPublicKey, sign as cryptoSign, verify } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AfirmaCall, AfirmaHandlerContext, ExternalSigningKey } from '@sa/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAlgorithm } from '../src/algorithms';
import { afirmaHandler } from '../src/handler';
import { keyObjectSigner } from '../src/key';
import { parseTriphaseData, parseXmlBatch, xmlBatchSign } from '../src/triphase';
import { rsaIdentity } from './helpers/pki';

const BATCH = `<?xml version="1.0" encoding="UTF-8"?>
<signbatch stoponerror="true" algorithm="SHA256withRSA">
  <singlesign Id="tx-1">
    <datasource>RURDMkQ2NDQ4MUUwNDBB</datasource>
    <format>CAdES</format>
    <suboperation>sign</suboperation>
    <extraparams>bW9kZT1pbXBsaWNpdAo=</extraparams>
    <signsaver><class>es.example.SignSaverFile</class><config/></signsaver>
  </singlesign>
  <singlesign Id="tx-2">
    <datasource>T1RSTw==</datasource>
    <format>CAdES</format>
    <suboperation>sign</suboperation>
  </singlesign>
</signbatch>`;

const PRE: Record<string, Buffer> = {
  'tx-1': Buffer.from('signed attributes 1'),
  'tx-2': Buffer.from('signed attributes 2'),
};

type Mode = 'ok' | 'base64' | 'presign-failed' | 'post-error' | 'err';

interface Seen {
  path: string;
  body: string;
  cookie?: string;
}

let mode: Mode = 'ok';
const seen: Seen[] = [];
const id = rsaIdentity();
let pk1Valid = false;
let base = '';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  seen.push({ path: req.url ?? '', body, cookie: req.headers.cookie });
  const params = new URLSearchParams(body);
  if (mode === 'err') {
    res.end('ERR-12: Error en el servidor de lotes');
    return;
  }
  if (req.url?.startsWith('/BatchPresigner')) {
    if (mode === 'presign-failed') {
      res.end('<signs><signresult id="tx-1" result="ERROR_PRE" description="Sin datos"/></signs>');
      return;
    }
    res.setHeader('Set-Cookie', 'NODE=a; HttpOnly');
    const xml = `<xml><firmas format="CAdES">${Object.entries(PRE)
      .map(
        ([k, v]) =>
          `<firma Id="${k}"><param n="PRE">${v.toString('base64')}</param><param n="CACHE">c-${k}</param></firma>`,
      )
      .join('')}</firmas></xml>`;
    res.end(mode === 'base64' ? Buffer.from(xml).toString('base64') : xml);
    return;
  }
  const tri = parseTriphaseData(Buffer.from(params.get('tridata') ?? '', 'base64url').toString());
  pk1Valid = tri.signs.every(
    (s) =>
      s.params.get('CACHE') === `c-${s.id}` &&
      !s.params.has('PRE') &&
      verify(
        'sha256',
        PRE[s.id] as Buffer,
        createPublicKey(id.privateKey),
        Buffer.from(s.params.get('PK1') ?? '', 'base64'),
      ),
  );
  res.setHeader('Content-Type', 'text/xml');
  res.end(
    mode === 'post-error'
      ? '<signs><signresult id="tx-1" result="DONE_AND_SAVED" description=""/><signresult id="tx-2" result="ERROR_POST" description="No se pudo guardar"/></signs>'
      : '<signs><signresult id="tx-1" result="DONE_AND_SAVED" description=""/><signresult id="tx-2" result="DONE_AND_SAVED" description=""/></signs>',
  );
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  mode = 'ok';
  seen.length = 0;
  pk1Valid = false;
});

function options() {
  return {
    batch: Buffer.from(BATCH),
    preUrl: `${base}/BatchPresigner/service/ABC`,
    postUrl: `${base}/BatchPostsigner/service/ABC`,
    algorithm: resolveAlgorithm('SHA256withRSA', id.keyType),
    signer: keyObjectSigner(id.privateKey, id.keyType),
    chain: id.chain,
  };
}

describe('XML batch (signBatch) client', () => {
  it('reads the batch document', () => {
    expect(parseXmlBatch(BATCH)).toEqual({
      algorithm: 'SHA256withRSA',
      stopOnError: true,
      signs: [
        { id: 'tx-1', format: 'CAdES', suboperation: 'sign', dataSize: 15 },
        { id: 'tx-2', format: 'CAdES', suboperation: 'sign', dataSize: 4 },
      ],
    });
    expect(() => parseXmlBatch('<signbatch algorithm="SHA256withRSA"/>')).toThrow(/vacio/);
    expect(() => parseXmlBatch('<lote/>')).toThrow(/signbatch/);
    expect(() => parseXmlBatch('<signbatch><singlesign Id="1"/></signbatch>')).toThrow(/algoritmo/);
  });

  it('presigns, signs every PRE and postsigns with the same cookies, like BatchSigner', async () => {
    const result = await xmlBatchSign(options());
    expect(result.results).toEqual([
      { id: 'tx-1', result: 'DONE_AND_SAVED' },
      { id: 'tx-2', result: 'DONE_AND_SAVED' },
    ]);
    expect(result.log).toBe(
      '<signs><signresult id="tx-1" result="DONE_AND_SAVED" description=""/><signresult id="tx-2" result="DONE_AND_SAVED" description=""/></signs>',
    );
    expect(pk1Valid).toBe(true);
    expect(seen.map((s) => s.path)).toEqual([
      '/BatchPresigner/service/ABC',
      '/BatchPostsigner/service/ABC',
    ]);
    const [pre, post] = seen.map((s) => new URLSearchParams(s.body));
    expect([...pre!.keys()]).toEqual(['xml', 'certs']);
    expect([...post!.keys()]).toEqual(['xml', 'certs', 'tridata']);
    expect(Buffer.from(pre!.get('xml') ?? '', 'base64url').toString()).toBe(BATCH);
    // The chain is ';'-separated URL-safe Base64, leaf first.
    expect(
      pre!
        .get('certs')
        ?.split(';')
        .map((c) => Buffer.from(c, 'base64url')),
    ).toEqual(id.chain);
    expect(seen[1]?.cookie).toBe('NODE=a');
  });

  it('accepts a Base64 presign reply and ends at a presign result log', async () => {
    mode = 'base64';
    expect((await xmlBatchSign(options())).results).toHaveLength(2);
    mode = 'presign-failed';
    seen.length = 0;
    const failed = await xmlBatchSign(options());
    expect(failed.results).toEqual([{ id: 'tx-1', result: 'ERROR_PRE', description: 'Sin datos' }]);
    expect(seen).toHaveLength(1);
  });

  it('turns ERR- replies into AutoFirma errors', async () => {
    mode = 'err';
    await expect(xmlBatchSign(options())).rejects.toMatchObject({
      message: expect.stringContaining('ERR-12'),
    });
  });
});

describe('XML batch (signBatch) in the handler', () => {
  function signBatchCall(batch = BATCH, algorithm?: string): AfirmaCall {
    const xml = algorithm ? batch.replace('SHA256withRSA', algorithm) : batch;
    return {
      method: 'signBatch',
      args: [
        Buffer.from(xml).toString('base64'),
        `${base}/BatchPresigner`,
        `${base}/BatchPostsigner`,
        'mode=implicit\n',
      ],
      origin: 'https://sede.example.es',
      url: 'https://sede.example.es/acceso',
    };
  }

  function p12Context(): AfirmaHandlerContext {
    return {
      procedureId: 'test',
      approveSignature: vi.fn(async () => ({
        kind: 'p12' as const,
        credentialId: 'cert',
        p12: id.p12,
        passphrase: id.passphrase,
      })),
      report: vi.fn(),
    };
  }

  it('asks once for the whole batch and gives the page the Base64 result log and certificate', async () => {
    const ctx = p12Context();
    const reply = await afirmaHandler(signBatchCall(), ctx);
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    const [log, cert] = reply.callbackArgs as [string, string];
    expect(Buffer.from(log, 'base64').toString()).toContain(
      '<signresult id="tx-2" result="DONE_AND_SAVED" description=""/>',
    );
    expect(cert).toBe(id.certDer.toString('base64'));
    expect(ctx.approveSignature).toHaveBeenCalledOnce();
    expect(ctx.approveSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'signBatch',
        format: 'CAdES',
        algorithm: 'SHA256withRSA',
        origin: 'https://sede.example.es',
        signatures: 2,
        verifiable: false,
        documents: [],
        description: expect.stringContaining('Firmar un lote de 2 documentos en formato CAdES.'),
      }),
    );
    expect(ctx.report).toHaveBeenCalledWith({
      status: 'signed',
      format: 'lote',
      origin: 'https://sede.example.es',
    });
  });

  it('signs with an external key (the DNI in the phone) and releases it once', async () => {
    const released: boolean[] = [];
    const digests: string[] = [];
    const key: ExternalSigningKey = {
      kind: 'external',
      credentialId: 'dnie',
      certificates: id.chain,
      sign: async (data, digest, binding) => {
        digests.push(`${digest}:${binding ? 'bound' : 'unbound'}`);
        return cryptoSign(digest, data, id.privateKey);
      },
      release: (ok) => released.push(ok),
    };
    const ctx: AfirmaHandlerContext = {
      procedureId: 'test',
      approveSignature: vi.fn(async () => key),
      report: vi.fn(),
    };
    const reply = await afirmaHandler(signBatchCall(), ctx);
    expect(reply.ok).toBe(true);
    expect(pk1Valid).toBe(true);
    expect(digests).toEqual(['sha256:unbound', 'sha256:unbound']);
    expect(released).toEqual([true]);
  });

  it('reports signatures the servers did not complete as failed, with the reason', async () => {
    mode = 'post-error';
    const ctx = p12Context();
    const reply = await afirmaHandler(signBatchCall(), ctx);
    expect(reply.ok).toBe(true);
    expect(ctx.report).toHaveBeenCalledWith({
      status: 'failed',
      format: 'lote',
      origin: 'https://sede.example.es',
      message: 'El servidor del sitio no completó 1 de 2 firmas (ERROR_POST: No se pudo guardar)',
    });
  });

  it('rejects bad batches and algorithms before asking, and server errors after', async () => {
    const ctx = p12Context();
    expect(await afirmaHandler(signBatchCall('<nope/>'), ctx)).toMatchObject({ ok: false });
    expect(await afirmaHandler(signBatchCall(BATCH, 'SHA256withDSA'), ctx)).toMatchObject({
      ok: false,
    });
    expect(
      await afirmaHandler(
        { ...signBatchCall(), args: [Buffer.from(BATCH).toString('base64')] },
        ctx,
      ),
    ).toMatchObject({ ok: false, errorMessage: expect.stringContaining('servicios de firma') });
    expect(ctx.approveSignature).not.toHaveBeenCalled();

    mode = 'err';
    const failed = await afirmaHandler(signBatchCall(), ctx);
    expect(failed).toMatchObject({ ok: false, errorMessage: expect.stringContaining('ERR-12') });
    expect(ctx.report).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', format: 'lote' }),
    );
  });
});
