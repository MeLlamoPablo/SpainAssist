import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveAlgorithm } from '../src/algorithms';
import { parseExtraParams } from '../src/extra-params';
import { keyObjectSigner } from '../src/key';
import { expandPolicy, FIRMA_AGE, readPolicy } from '../src/policy';
import { createXades, xadesVariant } from '../src/xades';
import { ecIdentity, rsaIdentity, type TestIdentity } from './helpers/pki';
import { all, DS, first, parse, XADES, xmlCryptoVerify, xmldsigVerify } from './helpers/xml';

const FORM_XML = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<sol:Solicitud xmlns:sol="urn:sede:solicitud" Id="sol-1"><sol:Nombre>JUAN ESPAÑOL</sol:Nombre><sol:Motivo>Prueba &amp; firma</sol:Motivo></sol:Solicitud>',
);
const DEFAULT_NS_XML = Buffer.from(
  '<Registro xmlns="urn:reg:v1"><Asunto>Instancia</Asunto><Texto>Hola</Texto></Registro>',
);
// xmldom alone parses this as XML (just the XMP element): the text around it must make it binary
const PDF_LIKE = Buffer.concat([
  Buffer.from('%PDF-1.7\n<x:xmpmeta xmlns:x="adobe:ns:meta/"/>\n'),
  Buffer.from('c4e2a10f0099fe7d8b5e13f2d0c7a4910b6e8f2955d1e0b37a1c9d40f8e265b7', 'hex'),
]);

async function sign(
  id: TestIdentity,
  data: Buffer,
  params: string | null,
  algorithm = 'SHA512withRSA',
) {
  const expanded = expandPolicy(parseExtraParams(params), 'XAdES', data.length);
  return createXades({
    data,
    algorithm: resolveAlgorithm(algorithm, id.keyType),
    signer: keyObjectSigner(id.privateKey, id.keyType),
    chain: id.chain,
    params: expanded,
    policy: readPolicy(expanded),
    signingTime: new Date('2026-10-03T10:00:00Z'),
  });
}

describe('XAdES variant selection (AutoFirma quirk)', () => {
  it('reads the variant only from extraParams.format, default Enveloping', async () => {
    expect(xadesVariant({})).toBe('XAdES Enveloping');
    expect(xadesVariant({ format: 'XAdES Detached' })).toBe('XAdES Detached');
    expect(xadesVariant({ format: 'xades enveloped' })).toBe('XAdES Enveloped');
    // FirmaAGE switches to Detached unless Enveloped was asked
    expect(xadesVariant(expandPolicy({ expPolicy: 'FirmaAGE' }, 'XAdES', 10))).toBe(
      'XAdES Detached',
    );
    expect(() => xadesVariant({ format: 'XAdES Externally Detached' })).toThrow();
  });
});

describe('XAdES', () => {
  for (const make of [rsaIdentity, ecIdentity]) {
    const label = make === rsaIdentity ? 'RSA' : 'EC';

    it(`${label}: Enveloping over XML has AutoFirma's structure and verifies`, async () => {
      const id = make();
      const out = await sign(id, FORM_XML, null);
      expect(await xmldsigVerify(out)).toBe(true);
      if (id.keyType === 'rsa') expect(xmlCryptoVerify(out, id.certDer)).toBe(true);
      const doc = parse(out);
      const sig = doc.documentElement;
      expect(sig.localName).toBe('Signature');
      expect(sig.namespaceURI).toBe(DS);
      expect(sig.getAttribute('Id')).toMatch(/^Signature-[0-9a-f-]{36}$/);
      const sigId = sig.getAttribute('Id');
      const refs = all(first(sig, DS, 'SignedInfo'), DS, 'Reference');
      expect(refs).toHaveLength(3);
      expect(refs[0].getAttribute('Id')).toMatch(/^Reference-/);
      expect(refs[0].getAttribute('Type')).toBe('http://www.w3.org/2000/09/xmldsig#Object');
      expect(refs[0].getAttribute('URI')).toMatch(/^#Object-/);
      expect(refs[1].getAttribute('URI')).toBe(`#${sigId}-SignedProperties`);
      expect(refs[1].getAttribute('Type')).toBe('http://uri.etsi.org/01903#SignedProperties');
      expect(refs[2].getAttribute('URI')).toBe(`#${sigId}-KeyInfo`);
      expect(first(refs[0], DS, 'DigestMethod').getAttribute('Algorithm')).toBe(
        'http://www.w3.org/2001/04/xmlenc#sha512',
      );
      expect(first(sig, DS, 'SignatureMethod').getAttribute('Algorithm')).toBe(
        id.keyType === 'rsa'
          ? 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512'
          : 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512',
      );
      // the XML data is embedded as a node, not base64
      const objects = all(sig, DS, 'Object');
      expect(objects[0].getAttribute('MimeType')).toBe('text/xml');
      expect(objects[0].getElementsByTagNameNS('urn:sede:solicitud', 'Solicitud')).toHaveLength(1);
      // KeyValue only for RSA
      expect(all(sig, DS, 'KeyValue')).toHaveLength(id.keyType === 'rsa' ? 1 : 0);
      expect(all(sig, DS, 'X509Certificate')).toHaveLength(2);
      // SigningCertificate (v1) with CertDigest + Java-style IssuerSerial
      const cert = first(sig, XADES, 'Cert');
      expect(first(cert, DS, 'DigestValue').textContent).toBe(
        crypto.createHash('sha512').update(id.certDer).digest('base64'),
      );
      expect(first(cert, DS, 'X509IssuerName').textContent).toContain('C=ES');
      expect(first(cert, DS, 'X509SerialNumber').textContent).toBe(
        BigInt(`0x${new crypto.X509Certificate(id.certDer).serialNumber}`).toString(),
      );
      const dof = first(sig, XADES, 'DataObjectFormat');
      expect(dof.getAttribute('ObjectReference')).toBe(`#${refs[0].getAttribute('Id')}`);
      expect(first(dof, XADES, 'Identifier').textContent).toBe('urn:oid:1.2.840.10003.5.109.10');
      expect(all(dof, XADES, 'Encoding')).toHaveLength(0);
    });

    it(`${label}: Enveloping over binary data uses the base64 transform`, async () => {
      const id = make();
      const out = await sign(id, PDF_LIKE, null, 'SHA256');
      expect(await xmldsigVerify(out)).toBe(true);
      const sig = parse(out).documentElement;
      const ref = all(first(sig, DS, 'SignedInfo'), DS, 'Reference')[0];
      expect(first(ref, DS, 'Transform').getAttribute('Algorithm')).toBe(
        'http://www.w3.org/2000/09/xmldsig#base64',
      );
      const dataObject = all(sig, DS, 'Object')[0];
      expect(dataObject.getAttribute('Encoding')).toBe('http://www.w3.org/2000/09/xmldsig#base64');
      expect(dataObject.getAttribute('MimeType')).toBe('application/pdf');
      expect(Buffer.from(dataObject.textContent ?? '', 'base64').equals(PDF_LIKE)).toBe(true);
      expect(first(sig, XADES, 'Encoding').textContent).toBe(
        'http://www.w3.org/2000/09/xmldsig#base64',
      );
    });

    it(`${label}: Detached (<AFIRMA><CONTENT>) with the AGE policy (FirmaAGE)`, async () => {
      const id = make();
      const out = await sign(id, FORM_XML, 'expPolicy=FirmaAGE');
      expect(await xmldsigVerify(out)).toBe(true);
      if (id.keyType === 'rsa') expect(xmlCryptoVerify(out, id.certDer)).toBe(true);
      const doc = parse(out);
      expect(doc.documentElement.nodeName).toBe('AFIRMA');
      expect(doc.documentElement.getAttribute('Id')).toMatch(/^AFIRMA-Root-/);
      const content = doc.documentElement.firstChild as Element;
      expect(content.nodeName).toBe('CONTENT');
      expect(content.getAttribute('Id')).toMatch(/^CONTENT-/);
      const policy = first(doc, XADES, 'SignaturePolicyIdentifier');
      expect(first(policy, XADES, 'Identifier').textContent).toBe(`urn:oid:${FIRMA_AGE.oid}`);
      expect(first(policy, DS, 'DigestValue').textContent).toBe(FIRMA_AGE.hash);
      expect(first(policy, DS, 'DigestMethod').getAttribute('Algorithm')).toBe(
        'http://www.w3.org/2000/09/xmldsig#sha1',
      );
      expect(first(policy, XADES, 'SPURI').textContent).toBe(FIRMA_AGE.qualifier);
    });

    it(`${label}: Enveloped keeps the host document and namespaces`, async () => {
      const id = make();
      for (const input of [FORM_XML, DEFAULT_NS_XML]) {
        const out = await sign(id, input, 'format=XAdES Enveloped');
        expect(await xmldsigVerify(out)).toBe(true);
        const doc = parse(out);
        const root = doc.documentElement;
        expect((root.lastChild as Element | null)?.localName).toBe('Signature');
        const ref = all(first(root, DS, 'SignedInfo'), DS, 'Reference')[0];
        expect(ref.getAttribute('URI')).toBe(input === FORM_XML ? '#sol-1' : '');
        const transforms = all(ref, DS, 'Transform').map((t) => t.getAttribute('Algorithm'));
        expect(transforms).toEqual([
          'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
          'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
          'http://www.w3.org/TR/1999/REC-xpath-19991116',
        ]);
      }
    });
  }

  it('signs XML with a DOCTYPE as binary data, like AutoFirma', async () => {
    const id = rsaIdentity();
    const withDoctype = Buffer.from('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>');
    const out = await sign(id, withDoctype, null);
    expect(await xmldsigVerify(out)).toBe(true);
    expect(all(parse(out), DS, 'Object')[0].getAttribute('Encoding')).toBe(
      'http://www.w3.org/2000/09/xmldsig#base64',
    );
    await expect(sign(id, withDoctype, 'format=XAdES Enveloped')).rejects.toThrow(/solo pueden/);
  });

  it('signs data with text outside the root element as binary data, like AutoFirma', async () => {
    const id = rsaIdentity();
    for (const text of ['<a>b</a> fin', '<?xml version="1.0"?>\nNota: <a>b</a>']) {
      const out = await sign(id, Buffer.from(text), null);
      expect(all(parse(out), DS, 'Object')[0].getAttribute('Encoding')).toBe(
        'http://www.w3.org/2000/09/xmldsig#base64',
      );
    }
    // whitespace, comments and processing instructions around the root are still XML
    const out = await sign(id, Buffer.from('\n<!-- c --><?pi x?>\n<a>b</a>\n<!-- fin -->\n'), null);
    expect(all(parse(out), DS, 'Object')[0].getAttribute('MimeType')).toBe('text/xml');
  });

  it('honours referencesDigestMethod and signer roles / production place', async () => {
    const id = rsaIdentity();
    const out = await sign(
      id,
      FORM_XML,
      'referencesDigestMethod=http://www.w3.org/2001/04/xmlenc#sha256\nsignerClaimedRoles=Solicitante|Representante\nsignatureProductionCity=Madrid',
      'SHA256',
    );
    expect(await xmldsigVerify(out)).toBe(true);
    const doc = parse(out);
    expect(first(doc, DS, 'DigestMethod').getAttribute('Algorithm')).toBe(
      'http://www.w3.org/2001/04/xmlenc#sha256',
    );
    expect(all(doc, XADES, 'ClaimedRole').map((r) => r.textContent)).toEqual([
      'Solicitante',
      'Representante',
    ]);
    expect(first(doc, XADES, 'City').textContent).toBe('Madrid');
  });

  it('detects tampering', async () => {
    const id = rsaIdentity();
    const out = (await sign(id, FORM_XML, 'format=XAdES Detached')).toString();
    await expect(
      xmldsigVerify(out.replace('Prueba &amp; firma', 'Prueba &amp; FIRMA')),
    ).rejects.toThrow('Invalid digest');
  });
});
