/**
 * Real answers from the TSAs we use (DigiCert, Sectigo qualified, Izenpe), captured on
 * 2026-11-18 with their chains, OCSP responses and CRLs: our checks must accept what these
 * services actually send. Offline: a stub serves the captured files.
 */
import fs from 'node:fs';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { describe, expect, it } from 'vitest';
import { collectValidationData } from '../src/revocation';
import { verifyTimestampToken } from '../src/tsp';
import './helpers/trust-services';

const ROOT = new URL('./fixtures/tsa/', import.meta.url);

function ab(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function pemCertificates(pem: string): Buffer[] {
  return [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map(
    (m) => Buffer.from(m[1].replace(/\s+/g, ''), 'base64'),
  );
}

interface Fixture {
  url: string;
  genTime: string;
  urls: Record<string, Record<string, string>>;
}

describe.each(['digicert', 'sectigo-qualified', 'izenpe'])('%s', (name) => {
  const dir = new URL(`${name}/`, ROOT);
  const read = (file: string) => fs.readFileSync(new URL(file, dir));
  const fixture = JSON.parse(read('fixture.json').toString()) as Fixture;
  const request = pkijs.TimeStampReq.fromBER(ab(read('req-0.tsq')));
  // The token exactly as sent: TimeStampResp ::= SEQUENCE { status, timeStampToken }.
  const response = asn1js.fromBER(read('resp-0.tsr')).result as asn1js.Sequence;
  const token = Buffer.from(response.valueBlock.value[1].valueBeforeDecodeView);
  const hash = Buffer.from(request.messageImprint.hashedMessage.valueBlock.valueHexView);
  const nonce = request.nonce ? Buffer.from(request.nonce.valueBlock.valueHexView) : undefined;

  it('accepts its timestamp token', () => {
    const stamp = verifyTimestampToken(token, 'sha256', hash, nonce);
    // fixture.json has the time of the last of three requests; this is the first.
    const apart = Math.abs(stamp.genTime.getTime() - new Date(fixture.genTime).getTime());
    expect(apart).toBeLessThan(60_000);
    expect(stamp.certificates.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses it for other data', () => {
    expect(() => verifyTimestampToken(token, 'sha256', Buffer.alloc(32), nonce)).toThrow(
      'other data',
    );
  });

  it('finds revocation data for its whole chain', async () => {
    const stamp = verifyTimestampToken(token, 'sha256', hash, nonce);
    const files = Object.entries(fixture.urls);
    // Serve the captured answers; OCSP by the serial number asked for.
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const entry = files.find(([u]) => u === url)?.[1];
      if (!entry) return new Response('not captured', { status: 404 });
      if (entry['*']) return new Response(new Uint8Array(read(entry['*'])));
      const asked = pkijs.OCSPRequest.fromBER(ab(Buffer.from(init?.body as Uint8Array)));
      const serial = Buffer.from(
        asked.tbsRequest.requestList[0].reqCert.serialNumber.valueBlock.valueHexView,
      );
      for (const file of Object.values(entry)) {
        const ocsp = pkijs.OCSPResponse.fromBER(ab(read(file)));
        const basic = pkijs.BasicOCSPResponse.fromBER(
          ab(Buffer.from(ocsp.responseBytes?.response.valueBlock.valueHexView ?? [])),
        );
        const answered = Buffer.from(
          basic.tbsResponseData.responses[0].certID.serialNumber.valueBlock.valueHexView,
        );
        if (answered.equals(serial)) return new Response(new Uint8Array(read(file)));
      }
      return new Response('no answer', { status: 404 });
    }) as typeof fetch;

    const result = await collectValidationData(
      [stamp.tsaCertificate],
      [...pemCertificates(read('chain.pem').toString()), ...stamp.certificates],
      { fetch: fetchStub, now: stamp.genTime },
    );
    expect({
      missing: result.missing,
      revoked: result.revoked,
      incomplete: result.incomplete,
    }).toEqual({ missing: [], revoked: [], incomplete: [] });
    expect(result.ocsps.length + result.crls.length).toBeGreaterThanOrEqual(2);
  });
});
