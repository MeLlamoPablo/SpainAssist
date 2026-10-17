/** Independent XMLDSig verifiers for tests: xmldsigjs (WebCrypto) and xml-crypto. */
import crypto from 'node:crypto';
import * as xmldom from '@xmldom/xmldom';
import { setNodeDependencies } from 'xml-core';
import { SignedXml as XmlCryptoSignedXml } from 'xml-crypto';
import * as xmldsig from 'xmldsigjs';
import * as xpath from 'xpath';

setNodeDependencies({
  DOMParser: xmldom.DOMParser,
  XMLSerializer: xmldom.XMLSerializer,
  DOMImplementation: xmldom.DOMImplementation,
  xpath,
});
xmldsig.Application.setEngine('NodeJS', crypto.webcrypto as unknown as Crypto);

export const DS = 'http://www.w3.org/2000/09/xmldsig#';
export const XADES = 'http://uri.etsi.org/01903/v1.3.2#';

export function parse(xml: string | Buffer): Document {
  return new xmldom.DOMParser().parseFromString(xml.toString(), 'text/xml') as unknown as Document;
}

function signatureElement(doc: Document): Element {
  const sigs = doc.getElementsByTagNameNS(DS, 'Signature');
  if (!sigs[0]) throw new Error('no ds:Signature');
  return sigs[0];
}

/** xmldsigjs: verifies every reference and the signature value with the KeyInfo certificate. */
export async function xmldsigVerify(xml: string | Buffer): Promise<boolean> {
  const doc = xmldsig.Parse(xml.toString());
  const signed = new xmldsig.SignedXml(doc);
  signed.LoadXml(signatureElement(doc as unknown as Document) as unknown as Element);
  return signed.Verify();
}

/** xml-crypto (RSA + c14n transforms only). */
export function xmlCryptoVerify(xml: string | Buffer, certDer: Buffer): boolean {
  const text = xml.toString();
  const doc = parse(text);
  const pem = `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64')}\n-----END CERTIFICATE-----\n`;
  const sig = new XmlCryptoSignedXml({ publicCert: pem });
  sig.loadSignature(signatureElement(doc) as unknown as Node);
  return sig.checkSignature(text);
}

export function first(node: Document | Element, ns: string, name: string): Element {
  const el = (node as Element).getElementsByTagNameNS(ns, name)[0];
  if (!el) throw new Error(`missing ${name}`);
  return el;
}

export function all(node: Document | Element, ns: string, name: string): Element[] {
  return Array.from((node as Element).getElementsByTagNameNS(ns, name));
}
