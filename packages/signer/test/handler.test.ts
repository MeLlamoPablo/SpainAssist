import { createHash, createPublicKey, sign as cryptoSign, verify } from 'node:crypto';
import type {
  AfirmaCall,
  AfirmaHandlerContext,
  ExternalSigningKey,
  SignatureBinding,
} from '@sa/shared';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { CANCELLED_TYPE } from '../src/errors';
import { afirmaHandler, createAfirmaHandler } from '../src/handler';
import { ecIdentity, rsaIdentity, type TestIdentity } from './helpers/pki';
import { pkijsVerify } from './helpers/verify';

const DATA = Buffer.from('Local test document');
function call(format = 'CAdES', params: string | null = 'mode=implicit'): AfirmaCall {
  return {
    method: 'sign',
    args: [DATA.toString('base64'), 'SHA256withRSA', format, params],
    origin: 'https://mock.invalid',
    url: 'https://mock.invalid/sign',
  };
}
function context(id: TestIdentity): AfirmaHandlerContext {
  return {
    procedureId: 'test',
    approveSignature: vi.fn(async () => ({
      kind: 'p12' as const,
      credentialId: 'test',
      p12: id.p12,
      passphrase: id.passphrase,
    })),
    report: vi.fn(),
  };
}

describe('AutoFirma handler', () => {
  for (const make of [rsaIdentity, ecIdentity]) {
    it(`${make.name}: approved CMS and NONE signatures verify, summary binds the input`, async () => {
      const id = make();
      const ctx = context(id);
      const reply = await afirmaHandler(call(), ctx);
      expect(reply.ok).toBe(true);
      if (!reply.ok) throw new Error(reply.errorMessage);
      expect(await pkijsVerify(Buffer.from(String(reply.callbackArgs[0]), 'base64'))).toBe(true);
      expect(reply.callbackArgs[1]).toBe(id.certDer.toString('base64'));
      expect(ctx.approveSignature).toHaveBeenCalledWith(
        expect.objectContaining({
          dataSize: DATA.length,
          dataSha256: createHash('sha256').update(DATA).digest('hex'),
        }),
      );
      expect(ctx.report).toHaveBeenCalledWith(expect.objectContaining({ status: 'signed' }));
      const raw = await afirmaHandler(call('NONE'), ctx);
      expect(raw.ok).toBe(true);
      if (raw.ok)
        expect(
          verify(
            'sha256',
            DATA,
            createPublicKey(id.privateKey),
            Buffer.from(String(raw.callbackArgs[0]), 'base64'),
          ),
        ).toBe(true);
    });
  }
  it('cancellation signs nothing, reports rejected, and never invokes fetch', async () => {
    const ctx = context(rsaIdentity());
    ctx.approveSignature = vi.fn(async () => null);
    ctx.fetch = vi.fn();
    const reply = await afirmaHandler(call('CAdEStri', 'serverUrl=http://127.0.0.1:1'), ctx);
    expect(reply).toMatchObject({ ok: false, errorType: CANCELLED_TYPE });
    expect(ctx.fetch).not.toHaveBeenCalled();
    expect(ctx.report).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
  });
  it('rejects unsupported formats and malformed calls', async () => {
    const ctx = context(rsaIdentity());
    expect(await afirmaHandler(call('bogus'), ctx)).toMatchObject({ ok: false });
    expect(ctx.approveSignature).not.toHaveBeenCalled();
    expect(await afirmaHandler({ ...call(), args: [{}] }, ctx)).toMatchObject({ ok: false });
  });
  it('routes a plain CAdES request with serverUrl through triphase', async () => {
    const ctx = context(rsaIdentity());
    ctx.fetch = vi.fn(async () => new Response('ERR-1: fake failure'));
    const result = await afirmaHandler(call('CAdES', 'serverUrl=http://127.0.0.1:1'), ctx);
    expect(result.ok).toBe(false);
    expect(ctx.fetch).toHaveBeenCalledOnce();
  });
  it('selects certificates and supports a native file picker', async () => {
    const id = rsaIdentity();
    const ctx = context(id);
    const selected = await afirmaHandler(
      { ...call(), method: 'selectCertificate', args: [null] },
      ctx,
    );
    expect(selected).toEqual({ ok: true, callbackArgs: [id.certDer.toString('base64')] });
    const handler = createAfirmaHandler({
      pickFiles: async () => [{ name: 'test.txt', data: DATA }],
    });
    const c = call();
    c.args[0] = null;
    const signed = await handler(c, ctx);
    expect(signed.ok).toBe(true);
    if (signed.ok)
      expect(JSON.parse(String(signed.callbackArgs[2]))).toEqual({ filename: 'test.txt' });
  });

  describe('external keys (the DNIe in the phone)', () => {
    function external(id: TestIdentity, fail = false) {
      const bindings: (SignatureBinding | undefined)[] = [];
      const released: boolean[] = [];
      const key: ExternalSigningKey = {
        kind: 'external',
        credentialId: 'dnie',
        certificates: id.chain,
        sign: async (data, digest, binding) => {
          bindings.push(binding);
          if (fail) throw new Error('card removed');
          return cryptoSign(digest, data, id.privateKey);
        },
        release: (ok) => released.push(ok),
      };
      const ctx: AfirmaHandlerContext = {
        procedureId: 'test',
        approveSignature: vi.fn(async () => key),
        report: vi.fn(),
      };
      return { ctx, bindings, released };
    }

    it('signs CAdES with a cms binding to the approved document and releases once', async () => {
      const id = rsaIdentity();
      const { ctx, bindings, released } = external(id);
      const reply = await afirmaHandler(call(), ctx);
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(await pkijsVerify(Buffer.from(String(reply.callbackArgs[0]), 'base64'))).toBe(true);
      expect(bindings).toEqual([{ kind: 'cms', document: 0 }]);
      expect(released).toEqual([true]);
      expect(ctx.approveSignature).toHaveBeenCalledWith(
        expect.objectContaining({
          verifiable: true,
          documents: [expect.objectContaining({ mimeType: 'text/plain', data: DATA })],
        }),
      );
    });

    it('gives PAdES a binding whose update and byte range cover the signed PDF', async () => {
      const id = rsaIdentity();
      const { ctx, bindings } = external(id);
      const doc = await PDFDocument.create();
      doc.addPage();
      const pdf = Buffer.from(await doc.save());
      const reply = await afirmaHandler(
        { ...call(), args: [pdf.toString('base64'), 'SHA256withRSA', 'PAdES', null] },
        ctx,
      );
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      const signed = Buffer.from(String(reply.callbackArgs[0]), 'base64');
      const binding = bindings[0];
      if (binding?.kind !== 'pades') throw new Error('expected a pades binding');
      const prepared = Buffer.concat([pdf, Buffer.from(binding.update)]);
      expect(prepared.length).toBe(signed.length);
      const [a, b, c, d] = binding.byteRange;
      expect(a).toBe(0);
      expect(c + d).toBe(prepared.length);
      // Outside the /Contents gap, the signed PDF is exactly what the phone was told.
      expect(prepared.subarray(0, b)).toEqual(signed.subarray(0, b));
      expect(prepared.subarray(c)).toEqual(signed.subarray(c));
      expect(/^<0+>$/.test(prepared.subarray(b, c).toString('latin1'))).toBe(true);
    });

    it('marks XAdES and triphase as not verifiable, and releases with false on failure', async () => {
      const id = rsaIdentity();
      const xml = external(id);
      const reply = await afirmaHandler(
        {
          ...call(),
          args: [Buffer.from('<a>hola</a>').toString('base64'), 'SHA256', 'XAdES', null],
        },
        xml.ctx,
      );
      expect(reply.ok).toBe(true);
      expect(xml.bindings).toEqual([undefined]);
      expect(xml.ctx.approveSignature).toHaveBeenCalledWith(
        expect.objectContaining({ verifiable: false }),
      );

      const broken = external(id, true);
      const failed = await afirmaHandler(call(), broken.ctx);
      expect(failed.ok).toBe(false);
      expect(broken.released).toEqual([false]);
      expect(broken.ctx.report).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    });

    it('rejects an unsupported algorithm before asking the phone to approve', async () => {
      const { ctx, released } = external(rsaIdentity());
      const single = { ...call(), args: [DATA.toString('base64'), 'MD5withRSA', 'CAdES', null] };
      expect(await afirmaHandler(single, ctx)).toMatchObject({ ok: false });
      const batch: AfirmaCall = {
        ...call(),
        method: 'signBatchProcess',
        args: [
          false,
          null,
          null,
          null,
          {
            algorithm: 'SHA256withDSA',
            format: 'CAdES',
            singlesigns: [{ id: '1', datareference: DATA.toString('base64') }],
          },
          true,
        ],
      };
      expect(await afirmaHandler(batch, ctx)).toMatchObject({ ok: false });
      expect(ctx.approveSignature).not.toHaveBeenCalled();
      expect(released).toEqual([]);
    });
  });
});
