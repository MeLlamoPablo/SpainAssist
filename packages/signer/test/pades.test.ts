import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { resolveAlgorithm } from '../src/algorithms';
import { keyObjectSigner } from '../src/key';
import { createPades } from '../src/pades';
import { ecIdentity, rsaIdentity } from './helpers/pki';
import { pkijsVerify } from './helpers/verify';

describe('PAdES incremental signing', () => {
  for (const make of [rsaIdentity, ecIdentity]) {
    for (const useObjectStreams of [false, true]) {
      it(`${make.name}, object streams ${useObjectStreams}: verifies detached CMS over PDF ByteRange`, async () => {
        const id = make();
        const doc = await PDFDocument.create();
        doc.addPage();
        const pdf = Buffer.from(await doc.save({ useObjectStreams }));
        const signed = await createPades({
          pdf,
          algorithm: resolveAlgorithm('SHA256', id.keyType),
          signer: keyObjectSigner(id.privateKey, id.keyType),
          chain: id.chain,
          params: {},
        });
        expect(signed.subarray(0, pdf.length)).toEqual(pdf);
        const text = signed.toString('latin1');
        const match = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
        expect(match).not.toBeNull();
        const [a, b, c, d] = match!.slice(1).map(Number);
        expect(a).toBe(0);
        expect(c + d).toBe(signed.length);
        const digestData = Buffer.concat([signed.subarray(a, a + b), signed.subarray(c, c + d)]);
        const hex = signed.subarray(b + 1, c - 1).toString('ascii');
        const cms = Buffer.from(hex, 'hex');
        // ASN.1 DER's top-level length excludes reserved zero padding.
        const count = cms[1] & 0x7f;
        const length = cms[1] < 128 ? cms[1] + 2 : cms.readUIntBE(2, count) + count + 2;
        expect(await pkijsVerify(cms.subarray(0, length), 0, digestData)).toBe(true);
        expect((await PDFDocument.load(signed)).getPageCount()).toBe(1);
        expect(text).toContain('/ETSI.CAdES.detached');
      });
    }
  }
});
