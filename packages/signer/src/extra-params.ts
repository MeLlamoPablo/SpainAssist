/**
 * AutoScript "extraParams": a `java.util.Properties` text (`key=value` lines). AutoFirma parses
 * it with `Properties.load` and, for triphase calls, re-serializes it with `Properties.store`.
 */

export type ExtraParams = Record<string, string>;

const WHITESPACE = new Set([' ', '\t', '\f']);

function endsWithOddBackslashes(line: string): boolean {
  let n = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

function skipLeadingWhitespace(line: string): string {
  let i = 0;
  while (i < line.length && WHITESPACE.has(line[i])) i++;
  return line.slice(i);
}

/** `Properties.loadConvert`: \uXXXX, \t \n \r \f, and "\x" -> "x". */
function unescapeProperty(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i === s.length - 1) {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === 'u') {
      const hex = s.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Malformed \\uxxxx encoding');
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 4;
    } else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === 'n') out += '\n';
    else if (n === 'f') out += '\f';
    else out += n;
  }
  return out;
}

/**
 * Parses AutoScript extraParams like `java.util.Properties.load`: natural lines separated by
 * `\n`, `\r` or `\r\n`; `#`/`!` comments; `key=value`, `key:value` or `key value`; a trailing
 * backslash continues the line; escapes (`\n`, `\t`, `\uXXXX`, `\=`...). Later keys win.
 * Malformed escapes are kept literally instead of failing.
 */
export function parseExtraParams(params: string | null | undefined): ExtraParams {
  const out: ExtraParams = {};
  if (params == null) return out;
  const lines = String(params).split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = skipLeadingWhitespace(lines[i]);
    if (line === '' || line[0] === '#' || line[0] === '!') continue;
    while (endsWithOddBackslashes(line)) {
      line = line.slice(0, -1);
      if (i + 1 >= lines.length) break;
      line += skipLeadingWhitespace(lines[++i]);
    }

    let keyLen = 0;
    let valueStart = line.length;
    let hasSep = false;
    let precedingBackslash = false;
    while (keyLen < line.length) {
      const c = line[keyLen];
      if ((c === '=' || c === ':') && !precedingBackslash) {
        valueStart = keyLen + 1;
        hasSep = true;
        break;
      }
      if (WHITESPACE.has(c) && !precedingBackslash) {
        valueStart = keyLen + 1;
        break;
      }
      precedingBackslash = c === '\\' ? !precedingBackslash : false;
      keyLen++;
    }
    while (valueStart < line.length) {
      const c = line[valueStart];
      if (!WHITESPACE.has(c)) {
        if (!hasSep && (c === '=' || c === ':')) hasSep = true;
        else break;
      }
      valueStart++;
    }
    const rawKey = line.slice(0, keyLen);
    const rawValue = line.slice(valueStart);
    let key: string;
    let value: string;
    try {
      key = unescapeProperty(rawKey);
      value = unescapeProperty(rawValue);
    } catch {
      key = rawKey;
      value = rawValue;
    }
    out[key] = value;
  }
  return out;
}

/** `Properties.saveConvert` (store(Writer): no \uXXXX escaping, UTF-8 output). */
function escapeProperty(s: string, isKey: boolean): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = c.charCodeAt(0);
    if (code > 61 && code < 127) {
      out += c === '\\' ? '\\\\' : c;
      continue;
    }
    switch (c) {
      case ' ':
        out += i === 0 || isKey ? '\\ ' : ' ';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\f':
        out += '\\f';
        break;
      case '=':
      case ':':
      case '#':
      case '!':
        out += `\\${c}`;
        break;
      default:
        out += c;
    }
  }
  return out;
}

/**
 * Serializes like AutoFirma's `AOUtil.properties2Base64` before Base64: `Properties.store(writer,
 * "")` in UTF-8 (an empty comment line, a date comment line, then `key=value` lines).
 */
export function storeExtraParams(params: ExtraParams, now: Date = new Date()): string {
  let out = `#\n#${now.toString()}\n`;
  for (const [k, v] of Object.entries(params))
    out += `${escapeProperty(k, true)}=${escapeProperty(v, false)}\n`;
  return out;
}

/** `Boolean.parseBoolean` semantics. Keys stay case-sensitive, as in AutoFirma. */
export function isTrue(value: string | undefined): boolean {
  return value != null && value.trim().toLowerCase() === 'true';
}
