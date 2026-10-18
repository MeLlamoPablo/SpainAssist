import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseExtraParams } from '../src/extra-params';
import { matchingCertificates, readCertificateFilters } from '../src/filters';
import { createDnieCard, rsaIdentity } from './helpers/pki';

const card = createDnieCard();
const expiredCard = createDnieCard({ expired: true });
const fnmt = rsaIdentity();
/** The DNIe's certificates in the order the signer offers them: FIRMA, then AUTENTICACIÓN. */
const dnie = [card.firma.certDer, card.autenticacion.certDer];

function serialOf(der: Buffer): string {
  return new crypto.X509Certificate(der).serialNumber;
}

/** Indexes of `certificates` that pass the filters in `params` (null: no filters). */
function match(params: string, certificates: Buffer[] = dnie, now?: Date): number[] | null {
  const filters = readCertificateFilters(parseExtraParams(params));
  return filters ? matchingCertificates(filters, certificates, now) : null;
}

describe('AutoFirma certificate filters', () => {
  it('reads nothing without filters', () => {
    expect(match('mode=implicit')).toBeNull();
    expect(match('filters=')).toBeNull();
  });

  it('tells FIRMA from AUTENTICACIÓN', () => {
    expect(match('filters=authcert:')).toEqual([1]);
    expect(match('filters=signingcert:')).toEqual([0]);
    expect(match('filters=dnie:')).toEqual([0]);
    expect(match('filters=dnie:', [fnmt.certDer])).toEqual([]);
    // A software certificate with both usages is a signing certificate.
    expect(match('filters=signingcert:', [fnmt.certDer])).toEqual([0]);
    expect(match('filters=authcert:', [fnmt.certDer])).toEqual([]);
  });

  it('checks key usages one by one', () => {
    expect(match('filters=keyusage.digitalsignature:true')).toEqual([1]);
    expect(match('filters=keyusage.nonrepudiation:true')).toEqual([0]);
    expect(match('filters=keyusage.digitalsignature:true;keyusage.nonrepudiation:false')).toEqual([
      1,
    ]);
    expect(match('filters=keyusage.keyencipherment:true')).toEqual([]);
    expect(match('filters=keyusage.keyencipherment:true', [fnmt.certDer])).toEqual([0]);
    // Neither true nor false: not checked.
    expect(match('filters=keyusage.digitalsignature:null')).toBeNull();
  });

  it('ANDs within filters= and ORs the numbered groups', () => {
    expect(match('filters=authcert:;dnie:')).toEqual([]);
    expect(match('filters.1=authcert:;dnie:\nfilters.2=keyusage.nonrepudiation:true')).toEqual([0]);
    expect(match('filters.1=authcert:\nfilters.2=dnie:')).toEqual([0, 1]);
    // filters= wins over the groups; filter= is the same as filters=.
    expect(match('filters=authcert:\nfilters.1=dnie:')).toEqual([1]);
    expect(match('filter=authcert:')).toEqual([1]);
  });

  it('matches serial numbers, thumbprints and encoded certificates', () => {
    const authSerial = serialOf(card.autenticacion.certDer);
    const firmaSerial = serialOf(card.firma.certDer);
    // ssl:/qualified: the FIRMA paired with the certificate that has the serial.
    expect(match(`filters=ssl:${authSerial}`)).toEqual([0]);
    expect(match(`filters=qualified:${firmaSerial.toLowerCase()}`)).toEqual([0]);
    expect(match('filters=ssl:0123456789ABCDEF')).toEqual([]);
    const sha1 = crypto.createHash('sha1').update(card.autenticacion.certDer).digest('hex');
    expect(match(`filters=thumbprint:SHA1:${sha1.toUpperCase()}`)).toEqual([1]);
    const sha256 = crypto.createHash('sha256').update(card.firma.certDer).digest('hex');
    expect(match(`filters=thumbprint:SHA-256:${sha256}`)).toEqual([0]);
    expect(match('filters=thumbprint:WHIRLPOOL:00')).toEqual([]);
    expect(match(`filters=encodedcert:${card.firma.certDer.toString('base64')}`)).toEqual([0]);
  });

  it('matches subjects and issuers by text and by RFC 2254 expressions', () => {
    expect(match('filters=subject.contains:(autenticación)')).toEqual([1]);
    expect(match('filters=issuer.contains:ac dnie')).toEqual([0, 1]);
    expect(match('filters=issuer.contains:FNMT')).toEqual([]);
    expect(match('filters=subject.rfc2254:(cn=*FIRMA*)')).toEqual([0]);
    expect(match('filters=subject.rfc2254:(&(serialNumber=12345678Z)(!(cn=*FIRMA*)))')).toEqual([
      1,
    ]);
    expect(
      match('filters=issuer.rfc2254:(|(ou=DNIE)(o=FNMT-RCM))', [...dnie, fnmt.certDer]),
    ).toEqual([0, 1]);
    expect(match('filters=issuer.rfc2254.recurse:(OU=DNIE)')).toEqual([0, 1]);
    expect(match('filters=subject.rfc2254:(cn=*FIRMA*)', [fnmt.certDer])).toEqual([]);
  });

  it('checks expiry, policies, SSCD and pseudonyms', () => {
    const expired = [expiredCard.firma.certDer, expiredCard.autenticacion.certDer];
    expect(match('filters=nonexpired:', expired)).toEqual([]);
    expect(match('filters=nonexpired:true;signingcert:', dnie)).toEqual([0]);
    // With filters, expired certificates are not hidden unless nonexpired: is given.
    expect(match('filters=signingcert:', expired)).toEqual([0]);
    expect(match('filters=policyid:2.16.724.1.2.2.2.4,1.2.3.4')).toEqual([1]);
    expect(match('filters=sscd:')).toEqual([0]);
    expect(match('filters=pseudonym:only')).toEqual([]);
    expect(match('filters=pseudonym:andothers')).toBeNull();
  });

  it('ignores filters it does not know, with a warning', () => {
    const warn = vi.fn();
    const filters = readCertificateFilters(
      parseExtraParams('filters=whatever:1;authcert:;disableopeningexternalstores:'),
      { warn },
    );
    expect(filters && matchingCertificates(filters, dnie)).toEqual([1]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'AutoFirma: certificate filter ignored',
      expect.objectContaining({ filter: 'whatever' }),
    );
    // Only unknown filters: every certificate passes.
    expect(match('filters=whatever:1')).toBeNull();
    expect(match('filters.1=authcert:\nfilters.2=whatever:')).toBeNull();
    expect(match('filters=subject.rfc2254:(cn=unclosed')).toBeNull();
  });
});
