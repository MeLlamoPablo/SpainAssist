import { createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { resolveAlgorithm } from '../src/algorithms';
import { keyObjectSigner } from '../src/key';
import { parseTriphaseData, triphaseSign } from '../src/triphase';
import { ecIdentity, rsaIdentity } from './helpers/pki';

describe('triphase offline protocol', () => {
  for (const make of [rsaIdentity, ecIdentity]) {
    it(`${make.name}: pre/post over local HTTP, cookie affinity and cryptographic PK1 verification`, async () => {
      const id = make();
      const pre = Buffer.from('server prepared signed attributes');
      const result = Buffer.from('server assembled signature');
      const seen: string[] = [];
      let verified = false;
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const params = new URLSearchParams(Buffer.concat(chunks).toString());
        seen.push(params.get('op') ?? '');
        if (params.get('op') === 'pre') {
          res.setHeader('Set-Cookie', 'SESSION=local; HttpOnly');
          res.end(
            Buffer.from(
              `<xml><firmas format="CAdES"><firma Id="1"><param n="PRE">${pre.toString('base64')}</param><param n="NEED_PRE">true</param></firma></firmas></xml>`,
            ).toString('base64url'),
          );
        } else {
          const xml = Buffer.from(params.get('session') ?? '', 'base64url').toString();
          const data = parseTriphaseData(xml);
          const pk1 = Buffer.from(data.signs[0].params.get('PK1') ?? '', 'base64');
          verified =
            verify('sha256', pre, createPublicKey(id.privateKey), pk1) &&
            req.headers.cookie === 'SESSION=local';
          res.end(`OK NEWID=${result.toString('base64url')}`);
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('server address');
        const signature = await triphaseSign({
          serverUrl: `http://127.0.0.1:${address.port}/triphase`,
          cop: 'sign',
          format: 'CAdES',
          algorithm: resolveAlgorithm('SHA256', id.keyType),
          data: Buffer.from('document'),
          extraParams: {},
          signer: keyObjectSigner(id.privateKey, id.keyType),
          chain: id.chain,
        });
        expect(signature).toEqual(result);
        expect(verified).toBe(true);
        expect(seen).toEqual(['pre', 'post']);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }
});
