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
import { createDnieCard, ecIdentity, rsaIdentity, type TestIdentity } from './helpers/pki';
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

  describe('external keys (the DNI in the phone)', () => {
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

describe('certificate filters (filters=, filters.N=, filter=)', () => {
  const card = createDnieCard();
  const firma = card.firma.certDer;
  const autenticacion = card.autenticacion.certDer;

  /** The DNI as the desktop hands it over: FIRMA's chain, and AUTENTICACIÓN when the phone sent it. */
  function dnie(other: Buffer | null = autenticacion) {
    const released: [boolean, string | undefined][] = [];
    const signed: Buffer[] = [];
    const key: ExternalSigningKey = {
      kind: 'external',
      credentialId: 'dnie',
      certificates: [firma, card.caDer],
      ...(other ? { otherCertificates: [other] } : {}),
      sign: async (data, digest) => {
        signed.push(Buffer.from(data));
        return cryptoSign(digest, data, card.firma.privateKey);
      },
      release: (ok, refusal) => released.push([ok, refusal]),
    };
    const ctx: AfirmaHandlerContext = {
      procedureId: 'test',
      approveSignature: vi.fn(async () => key),
      report: vi.fn(),
    };
    return { ctx, released, signed };
  }
  const select = (params: string | null): AfirmaCall => ({
    method: 'selectCertificate',
    args: [params],
    origin: 'https://sede.example.gob.es',
    url: 'https://sede.example.gob.es/login',
  });

  it('selectCertificate gives FIRMA without filters, AUTENTICACIÓN for authcert:', async () => {
    const plain = dnie();
    expect(await afirmaHandler(select(null), plain.ctx)).toEqual({
      ok: true,
      callbackArgs: [firma.toString('base64')],
    });
    expect(plain.released).toEqual([[true, undefined]]);

    const auth = dnie();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const reply = await createAfirmaHandler({ logger })(select('filters=authcert:'), auth.ctx);
    expect(reply).toEqual({ ok: true, callbackArgs: [autenticacion.toString('base64')] });
    expect(auth.released).toEqual([[true, undefined]]);
    expect(logger.info).toHaveBeenCalledWith(
      'AutoFirma: certificate filters',
      expect.objectContaining({ host: 'sede.example.gob.es', filters: 'authcert' }),
    );
    // A digitalSignature without nonRepudiation key usage asks for AUTENTICACIÓN too.
    const usage = dnie();
    expect(
      await afirmaHandler(
        select('filters=keyusage.digitalsignature:true;keyusage.nonrepudiation:false'),
        usage.ctx,
      ),
    ).toEqual({ ok: true, callbackArgs: [autenticacion.toString('base64')] });
  });

  it('keeps FIRMA when the filters let both certificates through', async () => {
    for (const params of ['filters=issuer.contains:DNIE', 'filters.1=authcert:\nfilters.2=dnie:']) {
      const both = dnie();
      expect(await afirmaHandler(select(params), both.ctx)).toEqual({
        ok: true,
        callbackArgs: [firma.toString('base64')],
      });
    }
  });

  it('answers "no certificate" when none of the credential\'s certificates matches', async () => {
    const none = dnie();
    const reply = await afirmaHandler(select('filters=issuer.contains:FNMT'), none.ctx);
    expect(reply).toMatchObject({
      ok: false,
      errorType: 'java.lang.Exception',
      errorMessage: 'No se encontraron certificados con los que firmar',
      errorCode: 'AF501001',
    });
    expect(none.released).toEqual([[false, 'no_match']]);
    expect(none.ctx.report).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    // An older phone sends only FIRMA: authcert: finds nothing.
    const old = dnie(null);
    expect(await afirmaHandler(select('filters=authcert:'), old.ctx)).toMatchObject({
      ok: false,
      errorCode: 'AF501001',
    });
    expect(old.released).toEqual([[false, 'no_match']]);
  });

  it('refuses a signature whose filters accept only AUTENTICACIÓN, without signing', async () => {
    const auth = dnie();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const reply = await createAfirmaHandler({ logger })(
      call('CAdES', 'mode=implicit\nfilters=authcert:'),
      auth.ctx,
    );
    expect(reply).toMatchObject({
      ok: false,
      errorType: 'java.lang.Exception',
      errorCode: 'AF501001',
    });
    if (reply.ok) return;
    expect(reply.errorMessage).toContain('certificado de autenticacion');
    expect(auth.signed).toEqual([]);
    expect(auth.released).toEqual([[false, 'authentication_only']]);
    expect(logger.warn).toHaveBeenCalledWith(
      'AutoFirma: the certificate filters refuse the approved certificate',
      expect.objectContaining({ refusal: 'authentication_only' }),
    );

    // A batch's certFilters too.
    const batch = dnie();
    const batchReply = await afirmaHandler(
      {
        ...call(),
        method: 'signBatchProcess',
        args: [
          false,
          null,
          null,
          'filters=authcert:',
          {
            algorithm: 'SHA256withRSA',
            format: 'CAdES',
            singlesigns: [{ id: '1', datareference: DATA.toString('base64') }],
          },
          true,
        ],
      },
      batch.ctx,
    );
    expect(batchReply).toMatchObject({ ok: false, errorCode: 'AF501001' });
    expect(batch.signed).toEqual([]);
    expect(batch.released).toEqual([[false, 'authentication_only']]);
  });

  it('signs with FIRMA when it passes, even if AUTENTICACIÓN passes too', async () => {
    const both = dnie();
    const reply = await afirmaHandler(call('CAdES', 'filters=issuer.contains:DNIE'), both.ctx);
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.callbackArgs[1]).toBe(firma.toString('base64'));
    expect(both.signed).toHaveLength(1);
    expect(both.released).toEqual([[true, undefined]]);
  });

  it('applies the same filters to a software certificate', async () => {
    const id = rsaIdentity();
    const ctx = context(id);
    expect(await afirmaHandler(call('CAdES', 'filters=dnie:'), ctx)).toMatchObject({
      ok: false,
      errorMessage: 'No se encontraron certificados con los que firmar',
      errorCode: 'AF501001',
    });
    expect(await afirmaHandler(select('filters=authcert:'), ctx)).toMatchObject({
      ok: false,
      errorCode: 'AF501001',
    });
    const ok = await afirmaHandler(call('CAdES', 'filters=signingcert:;nonexpired:'), ctx);
    expect(ok.ok).toBe(true);
    expect(await afirmaHandler(select('filters=issuer.contains:FNMT'), ctx)).toEqual({
      ok: true,
      callbackArgs: [id.certDer.toString('base64')],
    });
  });

  it('ignores filters it does not know', async () => {
    const unknown = dnie();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const reply = await createAfirmaHandler({ logger })(
      call('CAdES', 'filters=newfilter:x'),
      unknown.ctx,
    );
    expect(reply.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'AutoFirma: certificate filter ignored',
      expect.objectContaining({ filter: 'newfilter' }),
    );
  });
});
