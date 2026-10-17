/** Strict XML parsing with @xmldom/xmldom (no network access, no DTD processing). */
import { DOMParser } from '@xmldom/xmldom';

class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

export function parseXml(text: string): Document {
  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (msg: unknown) => errors.push(String(msg)),
      fatalError: (msg: unknown) => errors.push(String(msg)),
    },
  }).parseFromString(text, 'text/xml') as unknown as Document;
  if (errors.length || !doc?.documentElement) {
    throw new XmlParseError(errors[0] ?? 'Empty XML document');
  }
  return doc;
}

export function elementChildren(node: Node): Element[] {
  const out: Element[] = [];
  for (let n = node.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as Element);
  }
  return out;
}
