/**
 * Data sniffing, as AutoFirma uses it for format "AUTO" and for CAdES content-hints /
 * XAdES DataObjectFormat. AutoFirma relies on jmimemagic; this is a small approximation of the
 * cases sedes care about (PDF, XML, FacturaE, plain text, common images, ZIP/Office).
 */

export const DEFAULT_MIME = 'application/octet-stream';
const OID_DATA = '1.2.840.113549.1.7.1';
const DEFAULT_DESCRIPTION = 'binary';

export interface MimeInfo {
  mimeType: string;
  /** content-hints contentType (id-data when there is no specific OID). */
  oid: string;
  description: string;
  extension?: string;
}

/** OIDs from AutoFirma's `mimetypes_oids.properties` (Z39.50 MIME types). */
const MIME_OIDS: Record<string, string> = {
  'application/pdf': '1.2.840.10003.5.109.1',
  'application/postscript': '1.2.840.10003.5.109.2',
  'text/html': '1.2.840.10003.5.109.3',
  'image/tiff': '1.2.840.10003.5.109.4',
  'image/gif': '1.2.840.10003.5.109.5',
  'image/jpeg': '1.2.840.10003.5.109.6',
  'image/png': '1.2.840.10003.5.109.7',
  'video/mpeg': '1.2.840.10003.5.109.8',
  'text/sgml': '1.2.840.10003.5.109.9',
  'text/xml': '1.2.840.10003.5.109.10',
};

export function isPdf(data: Uint8Array): boolean {
  return (
    data.length >= 70 && Buffer.from(data.buffer, data.byteOffset, 5).toString('latin1') === '%PDF-'
  );
}

function decodeText(data: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/** Well-formed XML check good enough for format detection (a real parser validates later). */
export function looksLikeXml(data: Uint8Array): boolean {
  const text = decodeText(data);
  if (!text) return false;
  const t = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimStart();
  return (
    /^<(\?xml|[A-Za-z_][\w.:-]*[\s>/])/.test(t) && /<\/[\w.:-]+\s*>\s*$|\/>\s*$/.test(t.trimEnd())
  );
}

/** FacturaE: root element `Facturae` (any namespace prefix). */
export function isFacturae(data: Uint8Array): boolean {
  if (!looksLikeXml(data)) return false;
  const text = decodeText(data) ?? '';
  const m = /<(?!\?|!)([\w.-]+:)?([\w.-]+)[\s>/]/.exec(text);
  return !!m && m[2] === 'Facturae';
}

function isPlainText(data: Uint8Array): boolean {
  if (data.length === 0) return false;
  const text = decodeText(data);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  return text != null && !/[\x00-\x08\x0e-\x1f\x7f]/.test(text);
}

export function sniffMime(data: Uint8Array): MimeInfo {
  const b = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 16));
  let mimeType = DEFAULT_MIME;
  let description = DEFAULT_DESCRIPTION;
  let extension: string | undefined;
  if (isPdf(data)) {
    mimeType = 'application/pdf';
    description = 'Documento PDF';
    extension = 'pdf';
  } else if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') {
    mimeType = 'image/png';
    description = 'Imagen PNG';
    extension = 'png';
  } else if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    mimeType = 'image/jpeg';
    description = 'Imagen JPEG';
    extension = 'jpg';
  } else if (b.toString('latin1', 0, 4) === 'GIF8') {
    mimeType = 'image/gif';
    description = 'Imagen GIF';
    extension = 'gif';
  } else if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) {
    mimeType = 'application/zip';
    description = 'Fichero comprimido ZIP';
    extension = 'zip';
  } else if (looksLikeXml(data)) {
    mimeType = 'text/xml';
    description = 'Documento XML';
    extension = 'xml';
  } else if (isPlainText(data)) {
    mimeType = 'text/plain';
    description = 'Texto plano';
    extension = 'txt';
  }
  return { mimeType, oid: MIME_OIDS[mimeType] ?? OID_DATA, description, extension };
}
