/**
 * XAdES-BES / XAdES-EPES (v1.3.2) shaped like AutoFirma's output (AOXAdESSigner + jxades):
 *  - variant from the extraParam `format` only (default "XAdES Enveloping"); the top-level
 *    AutoScript format just picks XAdES. So `sign(xml, "SHA512withRSA", "XAdES Detached", null)`
 *    yields Enveloping, exactly like AutoFirma (sedes such as REG rely on it);
 *  - Ids `Signature-<uuid>`, `Reference-<uuid>`, `Object-<uuid>` / `CONTENT-<uuid>`, and the
 *    derived `-SignedProperties`, `-KeyInfo`, `-SignatureValue`, `-QualifyingProperties`;
 *  - references: data (base64 transform for binary, c14n for XML; enveloped-signature + c14n +
 *    XPath filter for Enveloped), SignedProperties, KeyInfo; SHA-512 digests by default;
 *  - KeyInfo with the X509 chain and (RSA only) KeyValue; SigningCertificate (v1) with
 *    CertDigest and IssuerSerial; SignaturePolicyIdentifier; DataObjectFormat;
 *  - inclusive C14N, RSA PKCS#1 v1.5 or ECDSA (r||s) signatures; no whitespace between elements.
 */
import crypto from 'node:crypto';
import { DOMImplementation, XMLSerializer } from '@xmldom/xmldom';
import {
  C14nCanonicalization,
  C14nCanonicalizationWithComments,
  ExclusiveCanonicalization,
} from 'xml-crypto';
import { type DigestName, digestFromAny, type ResolvedAlgorithm, xmlDigestUri } from './algorithms';
import { formatNameJava, parseCertificate } from './certificate';
import { AfirmaError } from './errors';
import { type ExtraParams, isTrue } from './extra-params';
import type { KeySigner } from './key';
import { DEFAULT_MIME, sniffMime } from './mime';
import type { SignaturePolicy } from './policy';
import { toBase64 } from './util/base64';
import { parseXml } from './util/xml';

const NS = {
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  xades: 'http://uri.etsi.org/01903/v1.3.2#',
  xmlns: 'http://www.w3.org/2000/xmlns/',
} as const;

const XML_ALG = {
  c14n: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  c14nWithComments: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments',
  excC14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  base64: 'http://www.w3.org/2000/09/xmldsig#base64',
  enveloped: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  xpath: 'http://www.w3.org/TR/1999/REC-xpath-19991116',
  objectType: 'http://www.w3.org/2000/09/xmldsig#Object',
  signedPropertiesType: 'http://uri.etsi.org/01903#SignedProperties',
} as const;

/** Content-type OIDs AutoFirma writes in DataObjectFormat (mimetypes_oids.properties). */
const DATA_OBJECT_OIDS: Record<string, string> = {
  'application/pdf': '1.2.840.10003.5.109.1',
  'text/xml': '1.2.840.10003.5.109.10',
  'image/jpeg': '1.2.840.10003.5.109.6',
  'image/png': '1.2.840.10003.5.109.7',
  'image/gif': '1.2.840.10003.5.109.5',
  'image/tiff': '1.2.840.10003.5.109.4',
  'text/html': '1.2.840.10003.5.109.3',
  'application/octet-stream': '1.2.840.113549.1.7.1',
};

export type XadesVariant = 'XAdES Enveloping' | 'XAdES Detached' | 'XAdES Enveloped';

/** AutoFirma's variant selection: extraParams `format`, default Enveloping. */
export function xadesVariant(params: ExtraParams): XadesVariant {
  if (isTrue(params.useManifest)) {
    throw AfirmaError.unsupportedFormat('XAdES Externally Detached (useManifest)');
  }
  const f = params.format?.trim().toLowerCase();
  if (!f || f === 'xades enveloping') return 'XAdES Enveloping';
  if (f === 'xades detached') return 'XAdES Detached';
  if (f === 'xades enveloped') return 'XAdES Enveloped';
  throw AfirmaError.unsupportedFormat(params.format as string);
}

export interface XadesSignOptions {
  data: Buffer;
  algorithm: ResolvedAlgorithm;
  signer: KeySigner;
  /** Leaf first. */
  chain: Buffer[];
  /** extraParams after policy expansion. */
  params: ExtraParams;
  policy?: SignaturePolicy | null;
  signingTime?: Date;
}

// ---------------------------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------------------------

function decodeXmlText(data: Buffer): string {
  const head = data.subarray(0, 200).toString('latin1');
  const m = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head);
  const label = m ? m[1].toLowerCase() : 'utf-8';
  try {
    return new TextDecoder(label).decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}

/** The data as an XML document, or null when AutoFirma would treat it as binary. */
function parseInputXml(data: Buffer): Document | null {
  const text = decodeXmlText(data);
  // AutoFirma's secure parser rejects DOCTYPEs: such documents are signed as binary data.
  if (/<!DOCTYPE/i.test(text)) return null;
  try {
    return parseXml(text);
  } catch {
    return null;
  }
}

function inScopeNamespaces(node: Node): { prefix: string; namespaceURI: string }[] {
  const seen = new Map<string, string>();
  for (let p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) {
    const el = p as Element;
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      if (a.name === 'xmlns') {
        if (!seen.has('')) seen.set('', a.value);
      } else if (a.prefix === 'xmlns' && !seen.has(a.localName)) {
        seen.set(a.localName, a.value);
      }
    }
    if (el.prefix && el.namespaceURI && !seen.has(el.prefix)) seen.set(el.prefix, el.namespaceURI);
  }
  return [...seen]
    .filter(([prefix, uri]) => uri !== '' || prefix !== '')
    .map(([prefix, namespaceURI]) => ({ prefix, namespaceURI }));
}

/** Canonical form of `node` as it sits in its document (inherited namespaces included). */
function canonicalize(node: Node, algorithm: string = XML_ALG.c14n): string {
  if (algorithm === XML_ALG.excC14n) {
    return new ExclusiveCanonicalization().process(node as Element, {});
  }
  const canon =
    algorithm === XML_ALG.c14nWithComments
      ? new C14nCanonicalizationWithComments()
      : new C14nCanonicalization();
  return canon.process(node, { ancestorNamespaces: inScopeNamespaces(node) });
}

function digest(hash: DigestName, data: string | Buffer): string {
  return crypto.createHash(hash).update(data).digest('base64');
}

/** `yyyy-MM-ddTHH:mm:ss±hh:mm` in local time, as jxades writes SigningTime. */
function xmlDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function jwkToBase64(v: string): string {
  return Buffer.from(v, 'base64url').toString('base64');
}

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

class Builder {
  constructor(readonly doc: Document) {}

  el(
    ns: string | null,
    name: string,
    attrs: Record<string, string | undefined> = {},
    children: (Node | string | null | undefined)[] = [],
  ): Element {
    const e = ns ? this.doc.createElementNS(ns, name) : this.doc.createElement(name);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, v);
    for (const c of children) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? this.doc.createTextNode(c) : c);
    }
    return e;
  }

  ds(
    name: string,
    attrs?: Record<string, string | undefined>,
    children?: (Node | string | null | undefined)[],
  ) {
    return this.el(NS.ds, `ds:${name}`, attrs, children);
  }

  xades(
    name: string,
    attrs?: Record<string, string | undefined>,
    children?: (Node | string | null | undefined)[],
  ) {
    return this.el(NS.xades, `xades:${name}`, attrs, children);
  }
}

/** Creates an XAdES signature; returns the signed XML document (UTF-8). */
export async function createXades(opts: XadesSignOptions): Promise<Buffer> {
  const { params, algorithm, chain } = opts;
  const variant = xadesVariant(params);
  const leafDer = chain[0];
  if (!leafDer) throw AfirmaError.noCertificate();
  const refDigest: DigestName = params.referencesDigestMethod
    ? (digestFromAny(params.referencesDigestMethod) ??
      (() => {
        throw AfirmaError.invalidParameter(
          `Algoritmo de huella no soportado: ${params.referencesDigestMethod}`,
        );
      })())
    : 'sha512';
  const c14nAlg = params.canonicalizationAlgorithm?.trim() || XML_ALG.c14n;
  if (![XML_ALG.c14n, XML_ALG.c14nWithComments, XML_ALG.excC14n, 'none'].includes(c14nAlg)) {
    throw AfirmaError.invalidParameter(`Algoritmo de canonicalizacion no soportado: ${c14nAlg}`);
  }
  const dataC14n = c14nAlg === 'none' ? null : c14nAlg;
  const signedInfoC14n = c14nAlg === 'none' ? XML_ALG.c14n : c14nAlg;

  const inputXml = parseInputXml(opts.data);
  if (variant === 'XAdES Enveloped' && !inputXml) {
    throw new AfirmaError(
      'java.lang.Exception',
      'Las firmas XAdES Enveloped solo pueden realizarse sobre datos XML',
      'AF510002',
    );
  }
  const isXml = !!inputXml;
  const sniffed = sniffMime(opts.data);
  const mimeType = isXml
    ? params.mimeType && params.mimeType !== DEFAULT_MIME
      ? params.mimeType
      : 'text/xml'
    : params.mimeType || sniffed.mimeType;
  const objectOid = params.contentTypeOid || DATA_OBJECT_OIDS[mimeType];

  const uuid = () => crypto.randomUUID();
  const sigId = `Signature-${uuid()}`;
  const referenceId = `Reference-${uuid()}`;
  const signedPropsId = `${sigId}-SignedProperties`;
  const keyInfoId = `${sigId}-KeyInfo`;

  // Document skeleton per variant
  const impl = new DOMImplementation();
  let doc: Document;
  let dataNode: Element | null = null; // ds:Object or CONTENT holding the data
  let signatureParent: Element | null = null;
  let dataUri: string;
  let dataType: string | undefined;
  if (variant === 'XAdES Enveloped') {
    doc = inputXml as Document;
    signatureParent = doc.documentElement;
    const rootId = doc.documentElement.getAttribute('Id');
    dataUri = rootId ? `#${rootId}` : '';
  } else {
    doc = impl.createDocument(null, null, null) as unknown as Document;
    if (variant === 'XAdES Detached') {
      const contentId = `CONTENT-${uuid()}`;
      const root = doc.createElement('AFIRMA');
      root.setAttribute('Id', `AFIRMA-Root-${uuid()}`);
      doc.appendChild(root);
      dataNode = doc.createElement('CONTENT');
      dataNode.setAttribute('Id', contentId);
      root.appendChild(dataNode);
      signatureParent = root;
      dataUri = `#${contentId}`;
    } else {
      const objectId = `Object-${uuid()}`;
      dataNode = doc.createElementNS(NS.ds, 'ds:Object');
      dataNode.setAttribute('Id', objectId);
      dataUri = `#${objectId}`;
      dataType = XML_ALG.objectType;
    }
    if (isXml) {
      dataNode.setAttribute('MimeType', mimeType);
      if (params.encoding) dataNode.setAttribute('Encoding', params.encoding);
      dataNode.appendChild(doc.importNode((inputXml as Document).documentElement, true));
    } else {
      dataNode.setAttribute('Encoding', XML_ALG.base64);
      dataNode.setAttribute('MimeType', mimeType);
      dataNode.appendChild(doc.createTextNode(toBase64(opts.data)));
    }
  }
  const b = new Builder(doc);

  // ds:Signature
  const signature = b.ds('Signature', { Id: sigId });
  signature.setAttributeNS(NS.xmlns, 'xmlns:ds', NS.ds);

  // Data reference
  const dataTransforms: Element[] = [];
  if (variant === 'XAdES Enveloped') {
    dataTransforms.push(b.ds('Transform', { Algorithm: XML_ALG.enveloped }));
    if (dataC14n) dataTransforms.push(b.ds('Transform', { Algorithm: dataC14n }));
    if (!isTrue(params.avoidXpathExtraTransformsOnEnveloped)) {
      const xpath = b.ds('XPath', {}, ['not(ancestor-or-self::ds:Signature)']);
      xpath.setAttributeNS(NS.xmlns, 'xmlns:ds', NS.ds);
      dataTransforms.push(b.ds('Transform', { Algorithm: XML_ALG.xpath }, [xpath]));
    }
  } else if (isXml) {
    if (dataC14n) dataTransforms.push(b.ds('Transform', { Algorithm: dataC14n }));
  } else if (!isTrue(params.avoidBase64Transforms)) {
    dataTransforms.push(b.ds('Transform', { Algorithm: XML_ALG.base64 }));
  }
  const dataDigestValue = b.ds('DigestValue');
  const dataReference = b.ds('Reference', { Id: referenceId, Type: dataType, URI: dataUri }, [
    dataTransforms.length ? b.ds('Transforms', {}, dataTransforms) : null,
    b.ds('DigestMethod', { Algorithm: xmlDigestUri(refDigest) }),
    dataDigestValue,
  ]);

  const signedPropsDigestValue = b.ds('DigestValue');
  const keyInfoDigestValue = b.ds('DigestValue');
  const signedInfo = b.ds('SignedInfo', {}, [
    b.ds('CanonicalizationMethod', { Algorithm: signedInfoC14n }),
    b.ds('SignatureMethod', { Algorithm: algorithm.xmlSignatureMethod }),
    dataReference,
    b.ds(
      'Reference',
      {
        Type: params.signedPropertiesTypeUrl || XML_ALG.signedPropertiesType,
        URI: `#${signedPropsId}`,
      },
      [b.ds('DigestMethod', { Algorithm: xmlDigestUri(refDigest) }), signedPropsDigestValue],
    ),
    b.ds('Reference', { URI: `#${keyInfoId}` }, [
      b.ds('DigestMethod', { Algorithm: xmlDigestUri(refDigest) }),
      keyInfoDigestValue,
    ]),
  ]);
  const signatureValue = b.ds('SignatureValue', { Id: `${sigId}-SignatureValue` });

  // KeyInfo
  const certs = isTrue(params.includeOnlySignningCertificate) ? [leafDer] : chain;
  const keyInfoChildren: Element[] = [
    b.ds(
      'X509Data',
      {},
      certs.map((c) => b.ds('X509Certificate', {}, [toBase64(c)])),
    ),
  ];
  const publicKey = new crypto.X509Certificate(leafDer).publicKey;
  if (algorithm.keyType === 'rsa' && params.addKeyInfoKeyValue?.toLowerCase() !== 'false') {
    const jwk = publicKey.export({ format: 'jwk' });
    keyInfoChildren.push(
      b.ds('KeyValue', {}, [
        b.ds('RSAKeyValue', {}, [
          b.ds('Modulus', {}, [jwkToBase64(jwk.n as string)]),
          b.ds('Exponent', {}, [jwkToBase64(jwk.e as string)]),
        ]),
      ]),
    );
  }
  const keyInfo = b.ds('KeyInfo', { Id: keyInfoId }, keyInfoChildren);

  // QualifyingProperties
  const cert = parseCertificate(leafDer);
  const serialDecimal = BigInt(
    `0x${Buffer.from(cert.tbsCertificate.serialNumber).toString('hex') || '0'}`,
  ).toString();
  const signedSignatureProperties: Element[] = [
    b.xades('SigningTime', {}, [xmlDateTime(opts.signingTime ?? new Date())]),
    b.xades('SigningCertificate', {}, [
      b.xades('Cert', {}, [
        b.xades('CertDigest', {}, [
          b.ds('DigestMethod', { Algorithm: xmlDigestUri(refDigest) }),
          b.ds('DigestValue', {}, [digest(refDigest, leafDer)]),
        ]),
        b.xades('IssuerSerial', {}, [
          b.ds('X509IssuerName', {}, [formatNameJava(cert.tbsCertificate.issuer)]),
          b.ds('X509SerialNumber', {}, [serialDecimal]),
        ]),
      ]),
    ]),
  ];
  if (opts.policy) {
    const p = opts.policy;
    const identifier = /^urn:oid:/i.test(p.identifier) ? p.identifier : `urn:oid:${p.oid}`;
    signedSignatureProperties.push(
      b.xades('SignaturePolicyIdentifier', {}, [
        b.xades('SignaturePolicyId', {}, [
          b.xades('SigPolicyId', {}, [
            b.xades('Identifier', {}, [identifier]),
            b.xades('Description', {}, [params.policyDescription ?? null]),
          ]),
          b.xades('SigPolicyHash', {}, [
            b.ds('DigestMethod', { Algorithm: xmlDigestUri(p.hashAlgorithm) }),
            b.ds('DigestValue', {}, [p.hash.toString('base64')]),
          ]),
          p.qualifier
            ? b.xades('SigPolicyQualifiers', {}, [
                b.xades('SigPolicyQualifier', {}, [b.xades('SPURI', {}, [p.qualifier])]),
              ])
            : null,
        ]),
      ]),
    );
  }
  const place = [
    ['City', params.signatureProductionCity],
    ['StateOrProvince', params.signatureProductionProvince],
    ['PostalCode', params.signatureProductionPostalCode],
    ['CountryName', params.signatureProductionCountry],
  ].filter((x): x is [string, string] => !!x[1]);
  if (place.length) {
    signedSignatureProperties.push(
      b.xades(
        'SignatureProductionPlace',
        {},
        place.map(([k, v]) => b.xades(k, {}, [v])),
      ),
    );
  }
  const roles = params.signerClaimedRoles?.split('|').filter(Boolean) ?? [];
  if (roles.length) {
    signedSignatureProperties.push(
      b.xades('SignerRole', {}, [
        b.xades(
          'ClaimedRoles',
          {},
          roles.map((r) => b.xades('ClaimedRole', {}, [r])),
        ),
      ]),
    );
  }
  const dataObjectFormat = b.xades('DataObjectFormat', { ObjectReference: `#${referenceId}` }, [
    objectOid
      ? b.xades('ObjectIdentifier', {}, [
          b.xades('Identifier', { Qualifier: 'OIDAsURN' }, [`urn:oid:${objectOid}`]),
        ])
      : null,
    b.xades('MimeType', {}, [mimeType]),
    isXml ? null : b.xades('Encoding', {}, [XML_ALG.base64]),
  ]);
  const signedProperties = b.xades('SignedProperties', { Id: signedPropsId }, [
    b.xades('SignedSignatureProperties', {}, signedSignatureProperties),
    b.xades('SignedDataObjectProperties', {}, [dataObjectFormat]),
  ]);
  const qualifyingProperties = b.xades(
    'QualifyingProperties',
    { Id: `${sigId}-QualifyingProperties`, Target: `#${sigId}` },
    [signedProperties],
  );
  qualifyingProperties.setAttributeNS(NS.xmlns, 'xmlns:xades', params.xadesNamespace || NS.xades);

  signature.appendChild(signedInfo);
  signature.appendChild(signatureValue);
  signature.appendChild(keyInfo);
  if (variant === 'XAdES Enveloping' && dataNode) signature.appendChild(dataNode);
  signature.appendChild(b.ds('Object', {}, [qualifyingProperties]));

  if (variant === 'XAdES Enveloping') doc.appendChild(signature);
  else (signatureParent as Element).appendChild(signature);

  // Digests (the tree is final: namespaces in scope are what verifiers will see)
  let dataDigest: string;
  if (variant === 'XAdES Enveloped') {
    const copy = doc.documentElement.cloneNode(true) as Element;
    const strip = (n: Element) => {
      for (const c of Array.from(n.childNodes)) {
        if (c.nodeType !== 1) continue;
        const e = c as Element;
        if (e.namespaceURI === NS.ds && e.localName === 'Signature') n.removeChild(e);
        else strip(e);
      }
    };
    strip(copy);
    dataDigest = digest(refDigest, canonicalize(copy, dataC14n ?? XML_ALG.c14n));
  } else if (isXml) {
    dataDigest = digest(refDigest, canonicalize(dataNode as Element, dataC14n ?? XML_ALG.c14n));
  } else {
    dataDigest = digest(refDigest, opts.data);
  }
  dataDigestValue.appendChild(doc.createTextNode(dataDigest));
  signedPropsDigestValue.appendChild(
    doc.createTextNode(digest(refDigest, canonicalize(signedProperties))),
  );
  keyInfoDigestValue.appendChild(doc.createTextNode(digest(refDigest, canonicalize(keyInfo))));

  const toSign = Buffer.from(canonicalize(signedInfo, signedInfoC14n), 'utf8');
  const sig = await opts.signer.sign(toSign, algorithm, { ecdsaFormat: 'ieee-p1363' });
  signatureValue.appendChild(doc.createTextNode(sig.toString('base64')));

  const xml = new XMLSerializer().serializeToString(doc.documentElement as unknown as Node);
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>${xml}`, 'utf8');
}
