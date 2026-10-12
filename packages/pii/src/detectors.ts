/**
 * Pattern detectors: regex candidates + checksum validation + context words. Each detector
 * appends raw spans (offsets into the original text); overlaps are merged later.
 */
import type { PiiType, Span } from './types';
import {
  compact,
  IBAN_LENGTHS,
  isLuhn,
  isValidCcc,
  isValidCif,
  isValidDni,
  isValidKlmNif,
  isValidNie,
  isValidNuss,
} from './validators';

const R = String.raw;
const WORD_CHARS = R`\p{L}\p{N}\p{M}`;
/** Unicode-aware word boundaries (no letter/digit on that side). */
const BL = R`(?<![${WORD_CHARS}])`;
const BR = R`(?![${WORD_CHARS}])`;
const IS_WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

type Out = Span[];

const push = (out: Out, type: PiiType, start: number, end: number) => {
  if (end > start) out.push({ type, start, end });
};

/** Text around [start, end) excluding the span itself, for context-word checks. */
const around = (text: string, start: number, end: number, before = 60, after = 30) =>
  `${text.slice(Math.max(0, start - before), start)} ${text.slice(end, end + after)}`;

interface Rule {
  type: PiiType;
  re: RegExp;
  /** Capture group holding the value (the regex needs the `d` flag). Default: whole match. */
  group?: number;
  validate?: (value: string, text: string, start: number, end: number) => boolean;
  /** Required context words around the value (the value itself is excluded). */
  context?: RegExp;
}

function runRule(rule: Rule, text: string, out: Out): void {
  for (const m of text.matchAll(rule.re)) {
    let start = m.index;
    let end = start + m[0].length;
    if (rule.group !== undefined) {
      const idx = m.indices?.[rule.group];
      if (!idx) continue;
      [start, end] = idx;
    }
    const value = text.slice(start, end);
    if (rule.validate && !rule.validate(value, text, start, end)) continue;
    if (rule.context && !rule.context.test(around(text, start, end))) continue;
    push(out, rule.type, start, end);
  }
}

// --- identifiers with checksums -----------------------------------------------------------------

const DNI_LIKE = R`\d{1,2}(?:[ .]?\d{3}){2}`;
/** "nº", "n.º", "n°", "núm.", "número". */
const NUM = R`(?:n\.?\s?[º°ª]\.?|no\.|n[uú]m(?:ero)?\.?)`;
const VEHICLE_CONTEXT =
  /matr[ií]cula|coche|veh[ií]culo|moto|ciclomotor|placa|itv|dgt|turismo|furgoneta|cami[oó]n|remolque|transferencia|multa|sanci[oó]n|aparca|gr[uú]a|permiso de circulaci[oó]n|ficha t[eé]cnica|ivtm|impuesto de circulaci[oó]n/i;

const RULES: Rule[] = [
  {
    // 12345678Z, 12.345.678-Z, 12 345 678 Z (checksum-validated)
    type: 'dni',
    re: new RegExp(R`${BL}${DNI_LIKE}[ .\-]?[A-Z]${BR}`, 'giu'),
    validate: (v) => {
      // "1.234.567 a 2.000.000" is a range, not a DNI: a lone lowercase vowel/"y" is a word.
      if (/\s[aeiouy]$/.test(v)) return false;
      return isValidDni(compact(v).padStart(9, '0'));
    },
  },
  {
    // DNI explicitly labelled, even without (or with a wrong) control letter
    type: 'dni',
    re: new RegExp(
      R`(?<![\p{L}])(?:dni|nif|d\.n\.i\.?|n\.i\.f\.?|documento\s+nacional\s+de\s+identidad)\s*${NUM}?\s*[:#]?\s*(${DNI_LIKE}(?:[ .\-]?[A-Z])?)${BR}`,
      'giud',
    ),
    group: 1,
  },
  {
    // NIE: X1234567L, Y-1234567-X (checksum-validated)
    type: 'nie',
    re: new RegExp(R`${BL}[XYZ][ .\-]?0?\d(?:[ .]?\d{3}){2}[ .\-]?[A-Z]${BR}`, 'giu'),
    validate: (v) => isValidNie(v),
  },
  {
    // NIE / TIE explicitly labelled (letter optional / not validated)
    type: 'nie',
    re: new RegExp(
      R`(?<![\p{L}])(?:nie|tie|n\.i\.e\.?)\s*${NUM}?\s*[:#]?\s*([XYZ][ .\-]?0?\d(?:[ .]?\d{3}){2}(?:[ .\-]?[A-Z])?)${BR}`,
      'giud',
    ),
    group: 1,
  },
  {
    // NIF K/L/M (DNI-style checksum)
    type: 'dni',
    re: new RegExp(R`${BL}[KLM][ .\-]?\d{7}[ .\-]?[A-Z]${BR}`, 'gu'),
    validate: (v) => isValidKlmNif(v),
  },
  {
    // CIF (company NIF): B12345674, Q-2826000-H
    type: 'cif',
    re: new RegExp(R`${BL}[ABCDEFGHJNPQRSUVW][ .\-]?\d{2}[ .]?\d{5}[ .\-]?[0-9A-J]${BR}`, 'gu'),
    validate: (v) => isValidCif(v),
  },
  {
    // CCC: 20 digits with optional separators (2100 0418 45 0200051332)
    type: 'ccc',
    re: new RegExp(R`${BL}\d{4}(?:[ \-]?\d){16}${BR}`, 'gu'),
    validate: (v) => isValidCcc(v),
  },
  {
    // NUSS / NAF: 28 12345678 40, 28/12345678/40 (checksum-validated)
    type: 'nuss',
    re: new RegExp(R`${BL}\d{2}(?:[ /.\-]?\d){10}${BR}`, 'gu'),
    validate: (v) => isValidNuss(v),
  },
  {
    // NUSS explicitly labelled (not validated)
    type: 'nuss',
    re: new RegExp(
      R`(?<![\p{L}])(?:nuss|naf|${NUM}\s*(?:de\s+)?(?:la\s+)?(?:afiliaci[oó]n|seguridad\s+social)|n[uú]mero\s+de\s+(?:la\s+)?(?:afiliaci[oó]n|seguridad\s+social)|afiliaci[oó]n(?:\s+a\s+la\s+seguridad\s+social)?)\s*[:#]?\s*(\d{2}[ /.\-]?\d{6,8}[ /.\-]?\d{2})${BR}`,
      'giud',
    ),
    group: 1,
  },
  {
    // Spanish passport / foreign passport numbers, only next to "pasaporte"
    type: 'passport',
    re: new RegExp(
      R`(?<![\p{L}])(?:pasaporte|passport)(?:\s+(?:${NUM}|number))?[^\n.;]{0,15}?${BL}([A-Z0-9]{6,10})${BR}`,
      'giud',
    ),
    group: 1,
    validate: (v) => (v.match(/\d/g)?.length ?? 0) >= 4,
  },
  {
    // DNI/TIE support number (IDESP), only next to "soporte"/"IDESP"
    type: 'dni',
    re: new RegExp(
      R`(?<![\p{L}])(?:soporte|idesp)[^\n.;]{0,25}?${BL}([A-Z]{1,3}\d{6,8})${BR}`,
      'giud',
    ),
    group: 1,
  },
  {
    // Referencia catastral, urban (7+2+4+1+4+2) and rustic (5+1+12+2), optionally grouped
    type: 'cadastral_ref',
    re: new RegExp(
      R`${BL}(?:\d{7}\s?[A-Z]{2}\d{4}[A-Z]\s?\d{4}\s?[A-Z]{2}|\d{5}[A-Z]\d{12}[A-Z]{2})${BR}`,
      'gu',
    ),
  },
  {
    // 14-character parcel reference, only with "catastr…" nearby
    type: 'cadastral_ref',
    re: new RegExp(R`${BL}\d{7}\s?[A-Z]{2}\d{4}[A-Z]${BR}`, 'gu'),
    context: /catastr/i,
  },
  {
    // Email addresses (not "user:pass@host" inside a URL authority: that is url_params)
    type: 'email',
    re: new RegExp(
      R`${BL}[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}\-]+(?:\.[\p{L}\p{N}\-]+)*\.\p{L}{2,}${BR}`,
      'gu',
    ),
    validate: (_v, text, start) =>
      !/:\/\/[^\s/]*$/.test(text.slice(Math.max(0, start - 200), start)),
  },
  {
    // Obfuscated emails: "nombre arroba dominio punto es", "user (at) mail [dot] com"
    type: 'email',
    re: new RegExp(
      R`${BL}[\p{L}\p{N}._%+\-]+\s*(?:\(at\)|\[at\]|\{at\}|\s+arroba\s+)\s*[\p{L}\p{N}\-]+(?:(?:\.|\s*\(dot\)\s*|\s*\[dot\]\s*|\s+punto\s+)[\p{L}\p{N}\-]+)+${BR}`,
      'giu',
    ),
  },
  {
    // Vehicle plates, current format (1234 BCD), only in vehicle context
    type: 'plate',
    re: new RegExp(R`${BL}\d{4}[ \-]?[BCDFGHJKLMNPRSTVWXYZ]{3}${BR}`, 'giu'),
    context: VEHICLE_CONTEXT,
  },
  {
    // Provincial format (M-1234-AB), upper-case only, in vehicle context
    type: 'plate',
    re: new RegExp(
      R`${BL}(?:A|AB|AL|AV|B|BA|BI|BU|C|CA|CC|CE|CO|CR|CS|CU|GC|GE|GI|GR|GU|H|HU|IB|J|L|LE|LO|LU|M|MA|ML|MU|NA|O|OR|OU|P|PM|PO|S|SA|SE|SG|SO|SS|T|TE|TF|TO|V|VA|VI|Z|ZA)[ \-]?\d{4}[ \-]?[A-Z]{1,2}${BR}`,
      'gu',
    ),
    context: VEHICLE_CONTEXT,
  },
  {
    // IPv4
    type: 'ip',
    re: new RegExp(
      R`(?<![\p{L}\p{N}\p{M}.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\p{L}\p{N}\p{M}]|\.\d)`,
      'gu',
    ),
    validate: (_v, text, start) =>
      !/(?:versi[oó]n|version|v\.?)\s*$/i.test(text.slice(Math.max(0, start - 12), start)),
  },
  {
    // IPv6 (full or compressed); times like 10:30:00 are excluded by the validator
    type: 'ip',
    re: new RegExp(R`${BL}(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}${BR}`, 'giu'),
    validate: (v) => {
      const groups = v.split(':');
      const compressed = v.includes('::');
      if (!compressed && groups.length !== 8) return false;
      if (compressed && v.indexOf('::') !== v.lastIndexOf('::')) return false;
      return groups.filter(Boolean).length >= 2 && (compressed || /[a-f]/i.test(v));
    },
  },
];

// --- IBAN: country-specific length, so trailing tokens never break the checksum ---------------

const IBAN_START = new RegExp(R`${BL}([A-Z]{2})(\d{2})(?=[ \-]?[A-Z0-9])`, 'giu');

function detectIban(text: string, out: Out): void {
  for (const m of text.matchAll(IBAN_START)) {
    const country = m[1]!.toUpperCase();
    const length = IBAN_LENGTHS[country];
    if (!length) continue;
    let chars = country + m[2];
    let i = m.index + m[0].length;
    while (chars.length < length && i < text.length) {
      const ch = text[i]!;
      if (/[A-Z0-9]/i.test(ch)) {
        chars += ch.toUpperCase();
        i++;
      } else if ((ch === ' ' || ch === '-') && /[A-Z0-9]/i.test(text[i + 1] ?? '')) {
        i++;
      } else break;
    }
    if (chars.length !== length || IS_WORD_CHAR.test(text[i] ?? '')) continue;
    if (mod97(chars.slice(4) + chars.slice(0, 4)) === 1) push(out, 'iban', m.index, i);
  }
}

function mod97(alnum: string): number {
  let rem = 0;
  for (const ch of alnum) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem;
}

// --- payment cards: Luhn + issuer prefix, trying group boundaries -------------------------------

const CARD = new RegExp(R`${BL}[2-6]\d{3}(?:[ \-]?\d){9,15}${BR}`, 'gu');

function detectCards(text: string, out: Out): void {
  for (const m of text.matchAll(CARD)) {
    const groups = m[0].split(/[ -]/);
    // Longest prefix of whole groups with 13-19 digits that passes Luhn ("4111 1111 1111 1111 123").
    for (let n = groups.length; n >= 1; n--) {
      const digits = groups.slice(0, n).join('');
      if (digits.length < 13) break;
      if (digits.length <= 19 && isLuhn(digits)) {
        const len = groups.slice(0, n).join(' ').length;
        push(out, 'card', m.index, m.index + len);
        break;
      }
    }
  }
}

// --- phones -----------------------------------------------------------------------------------

const ES_PHONE = new RegExp(
  R`${BL}(?:(?:\+|00)\s?34[ .\-]?|\(\s?(?:\+|00)?34\s?\)\s?)?` +
    R`(?:\d{9}|\d{3}[ .\-]\d{3}[ .\-]\d{3}|\d{3}[ .\-]\d{2}[ .\-]\d{2}[ .\-]\d{2}|\d{2}[ .\-]\d{3}[ .\-]\d{2}[ .\-]\d{2}|\d{3}[ .\-]\d{6}|\d{2}[ .\-]\d{7})${BR}`,
  'gu',
);
const INTL_PHONE = new RegExp(
  R`(?<![\p{L}\p{N}\p{M}.,])(?:\+|00)(?!34)[1-9]\d{0,2}(?:[ .\-]?\(?\d{1,4}\)?){2,6}${BR}`,
  'gu',
);
/** Spanish personal numbers: mobiles 6xx / 71x-74x, geographic 8[1-8]x / 9[1-8]x (not 800/900/901/902/905). */
const ES_SUBSCRIBER = /^(?:6\d|7[1-4]|8[1-8]|9[1-8])\d{7}$/;
const PHONE_CONTEXT =
  /tel[eé]fono|tel\.|tlf|tfno|m[oó]vil|celular|llam|whats|sms|fijo|contacto|n[uú]mero/i;

function detectPhones(text: string, out: Out): void {
  for (const m of text.matchAll(ES_PHONE)) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    const hasPrefix = /^[(+]|^00/.test(raw);
    let digits = raw.replace(/\D/g, '');
    if (hasPrefix) digits = digits.replace(/^(?:00)?34/, '');
    if (!ES_SUBSCRIBER.test(digits)) continue;
    const after = text.slice(end, end + 8);
    const before = text.slice(Math.max(0, start - 3), start);
    if (/^\s?(?:€|euros?\b|eur\b|%)/i.test(after) || /[€$]\s?$/.test(before)) continue;
    // "600.000.000" looks like an amount: require phone context or an international prefix.
    if (
      !hasPrefix &&
      /^\d{3}\.\d{3}\.\d{3}$/.test(raw) &&
      !PHONE_CONTEXT.test(around(text, start, end))
    )
      continue;
    push(out, 'phone', start, end);
  }
  for (const m of text.matchAll(INTL_PHONE)) {
    const digits = m[0].replace(/^00/, '').replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15)
      push(out, 'phone', m.index, m.index + m[0].length);
  }
}

// --- URLs: query strings, fragments, session ids and credentials ------------------------------

const URL_RE = new RegExp(
  R`(?:\bhttps?:\/\/|\bwww\.|${BL}(?:[\p{L}\p{N}\-]+\.)+\p{L}{2,}(?=\/[^\s]*[?#]))[^\s<>"'\x60{}|\\^]+`,
  'giu',
);

/** Finds URLs in text and returns their spans, without trailing punctuation. */
export function findUrls(text: string): { start: number; end: number }[] {
  const urls: { start: number; end: number }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    // Drop trailing punctuation and unbalanced closing brackets.
    for (;;) {
      const last = url.at(-1);
      if (!last) break;
      if (/[.,;:!?'"»]/.test(last)) url = url.slice(0, -1);
      else if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0))
        url = url.slice(0, -1);
      else if (last === ']' && !url.includes('[')) url = url.slice(0, -1);
      else break;
    }
    urls.push({ start: m.index, end: m.index + url.length });
  }
  return urls;
}

/** Offset where a URL's parameters start (query, fragment or ;jsessionid), or -1. */
export function urlParamsOffset(url: string): number {
  const q = url.search(/[?#]|;jsessionid=/i);
  return q;
}

function detectUrlParams(text: string, out: Out): void {
  for (const { start, end } of findUrls(text)) {
    const url = text.slice(start, end);
    const userinfo = /^(?:https?:\/\/)([^/@\s]+@)/i.exec(url);
    if (userinfo) {
      const s = start + url.indexOf(userinfo[1]!);
      push(out, 'url_params', s, s + userinfo[1]!.length);
    }
    const q = urlParamsOffset(url);
    if (q >= 0) push(out, 'url_params', start + q, end);
  }
}

// --- street addresses -------------------------------------------------------------------------

/** Abbreviations used only for streets: the street name may be lower-case. */
const STREET_ABBR = R`c\/(?!c(?![\p{L}]))|c\.\/|avda\.?|avd\.|av\.|p[º°]\.?|pza\.|ctra\.|urb\.|trav\.|pje\.|pso\.|cl\.`;
/** Full words: the street name must be capitalised ("en la calle duró 2 horas" is not an address). */
const STREET_WORD = R`calle|avenida|paseo|plaza|plazuela|glorieta|ronda|traves[ií]a|camino|carretera|urbanizaci[oó]n|carrer|r[uú]a|rambla|bulevar|callej[oó]n|pasaje|avinguda|passeig|pla[cç]a|alameda|cuesta|costanilla|v[ií]a|barrio|pol[ií]gono|kalea|etorbidea`;

const STREET_KEYWORD = new RegExp(R`${BL}(?:(${STREET_ABBR})|(${STREET_WORD})${BR})`, 'giu');

const PARTICLES = R`(?:de|del|la|las|los|el|y|i|do|da|dos|das|de\s+la|de\s+los|de\s+las)`;
const CAP_WORD = R`(?:(?:Sta|Sto|Gral|Dr|Dra|Ntra|Sr|Sra|Pdte|Hnos)\.|\p{Lu}[\p{L}'’\-]*)`;
const CAP_NAME = new RegExp(
  R`\s*(?:(?:${PARTICLES}\s+|[dl]['’]))?(?:${CAP_WORD}|\d{1,2}\s+de\s+\p{Lu}\p{L}*)(?:\s+(?:${PARTICLES}\s+)*(?:[dl]['’])?${CAP_WORD}|[dl]['’]${CAP_WORD}){0,5}`,
  'uy',
);
const NUMBER = R`\s*,?\s*(?:n\.?\s?[º°o]\.?|n[uú]m\.?|n[uú]mero)?\s*(?:\d{1,4}(?:[a-z]|\s?bis)?|s\/n)(?![\p{L}\p{N}])`;
const DETAIL = R`(?:\s*[,\-]?\s*(?:(?:piso|planta|pl\.)\s*\d{1,2}\s*[º°ª]?(?:\s*[a-z](?![\p{L}\p{N}]))?|\d{1,2}\s*[º°ª]\s*-?\s*(?:[a-z](?![\p{L}\p{N}])|izq(?:uierda|da)?\.?|dcha\.?|derecha|dch\.?|centro|ctro\.?|int(?:erior)?\.?|ext(?:erior)?\.?)?|\d{1,2}\s*(?:izq(?:uierda|da)?\.?|dcha\.?|derecha)|(?:puerta|pta\.?|letra|esc(?:alera)?\.?|portal|bloque|blq\.?|casa|nave|local|apto\.?|apartamento)\s*[a-z0-9]{1,3}(?![\p{L}\p{N}])|(?:bajo|bj\.?|entresuelo|entlo\.?|[aá]tico|sobre[aá]tico|principal|pral\.?)(?:\s*[a-z](?![\p{L}\p{N}]))?(?![\p{L}])|(?:izq(?:uierda|da)?\.?|dcha\.?|derecha)(?![\p{L}])|km\.?\s*\d{1,3}(?:[.,]\d{1,3})?))*`;
const NUMBER_AND_DETAILS = new RegExp(`${NUMBER}${DETAIL}`, 'iuy');
const LOOSE_NAME_AND_NUMBER = new RegExp(
  R`\s*[\p{L}ºª'’.\-]+(?:\s+[\p{L}ºª'’.\-]+){0,5}?${NUMBER}${DETAIL}`,
  'iuy',
);
const ADDRESS_LABEL = new RegExp(
  R`(?<![\p{L}])(?:domicilio(?:\s+(?:fiscal|habitual|actual|social|a\s+efectos\s+de\s+notificaciones))?|direcci[oó]n\s+(?:postal|de\s+residencia|completa|del\s+domicilio))\s*:\s*([^\n;]{3,80}?)(?=\s*(?:[\n;]|\.(?:\s|$)|$))`,
  'giud',
);

function detectAddresses(text: string, out: Out): void {
  for (const m of text.matchAll(STREET_KEYWORD)) {
    const from = m.index + m[0].length;
    let end = -1;
    if (m[1]) {
      LOOSE_NAME_AND_NUMBER.lastIndex = from;
      if (LOOSE_NAME_AND_NUMBER.exec(text)) end = LOOSE_NAME_AND_NUMBER.lastIndex;
    } else {
      CAP_NAME.lastIndex = from;
      if (CAP_NAME.exec(text)) {
        NUMBER_AND_DETAILS.lastIndex = CAP_NAME.lastIndex;
        if (NUMBER_AND_DETAILS.exec(text)) end = NUMBER_AND_DETAILS.lastIndex;
      }
    }
    if (end > 0) push(out, 'address', m.index, trimEnd(text, m.index, end));
  }
  runRule({ type: 'address', re: ADDRESS_LABEL, group: 1 }, text, out);
}

const trimEnd = (text: string, start: number, end: number) => {
  let e = end;
  while (e > start && /[\s,-]/.test(text[e - 1]!)) e--;
  return e;
};

// --- postal codes: only in an address context -----------------------------------------------

const POSTAL = new RegExp(R`${BL}(?:0[1-9]|[1-4]\d|5[0-2])\d{3}${BR}`, 'gu');
const POSTAL_LABEL =
  /(?:c\.?\s?p\.?|c[oó]d(?:igo|\.)?\s*postal|postal\s+code|zip(?:\s+code)?)\s*[:.]?\s*$/i;
const ADDRESS_WORDS =
  /c\/|\b(?:calle|avda|avenida|paseo|piso|portal|domicilio|direcci[oó]n postal|vivo en|resido en|urbanizaci[oó]n|carrer|r[uú]a)\b/i;

function detectPostalCodes(text: string, out: Out, addresses: Span[]): void {
  for (const m of text.matchAll(POSTAL)) {
    const start = m.index;
    const end = start + m[0].length;
    const label = POSTAL_LABEL.test(text.slice(Math.max(0, start - 20), start));
    const nearAddress = addresses.some((a) => a.end <= start && start - a.end <= 25);
    if (label || nearAddress || ADDRESS_WORDS.test(around(text, start, end))) {
      push(out, 'postal_code', start, end);
    }
  }
}

// --- dates of birth: only next to birth words ------------------------------------------------

const MONTHS =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const DATE = R`\d{1,2}\s?[\/.\-]\s?\d{1,2}\s?[\/.\-]\s?(?:\d{4}|\d{2})|\d{1,2}\s+de\s+(?:${MONTHS})(?:\s+(?:de|del)\s+\d{4})?|\d{4}-\d{2}-\d{2}|(?:19|20)\d{2}`;
const DOB = new RegExp(
  R`(?<![\p{L}])(fecha\s+de\s+nacimiento|f\.\s?(?:de\s)?nac(?:imiento)?\.?|fec\.\s?nac\.?|nacid[oa]s?|naci[oó]|nac[ií]|nacimiento|date\s+of\s+birth|born|dob|d\.o\.b\.?|cumplea[ñn]os)(?![\p{L}])[^\n.;]{0,25}?(?<![\p{N}])(${DATE})(?![\p{N}])`,
  'giud',
);
/** "certificado de nacimiento el 15/09/2026" is about a document, not a birth date. */
const NOT_A_BIRTH =
  /(?:certificado|partida|inscripci[oó]n|registro|acta|prestaci[oó]n|permiso|baja|subsidio|ayuda|deducci[oó]n|cheque|licencia)\s+(?:de|del|por)\s+(?:la\s+|el\s+)?$/i;

function detectBirthDates(text: string, out: Out): void {
  for (const m of text.matchAll(DOB)) {
    const keyword = m[1]!.toLowerCase();
    if (
      keyword === 'nacimiento' &&
      NOT_A_BIRTH.test(text.slice(Math.max(0, m.index - 40), m.index))
    )
      continue;
    const idx = m.indices?.[2];
    if (idx) push(out, 'date_of_birth', idx[0], idx[1]);
  }
}

// --- case / receipt / appointment numbers ------------------------------------------------------

const CASE_KEYWORD = R`(?:${NUM}\s*(?:de\s+)?)?(?:expediente|expte?\.|registro(?:\s+de\s+entrada)?|justificante|localizador|referencia|ref\.|c[oó]digo\s+(?:de\s+)?(?:solicitud|cita|seguimiento|verificaci[oó]n|referencia|reserva|localizador)|c[oó]digo\s+seguro\s+de\s+verificaci[oó]n|csv|n[uú]mero\s+de\s+(?:solicitud|cita|expediente|registro|referencia|justificante|recibo|seguimiento|reserva|liquidaci[oó]n|autoliquidaci[oó]n)|nrc|solicitud)`;
const CASE_NUMBER = new RegExp(
  R`(?<![\p{L}])${CASE_KEYWORD}(?:\s+(?:de|del)\s+(?:la\s+|su\s+|mi\s+|tu\s+)?(?:cita|solicitud|reserva|expediente|registro|pago|tasa|liquidaci[oó]n))?\s*${NUM}?\s*[:#]?\s*([A-Z0-9](?:[A-Z0-9]|[\/.\-](?=[A-Z0-9])){4,40})(?![\p{L}\p{N}])`,
  'giud',
);

function isCaseId(v: string): boolean {
  const digits = v.match(/\d/g)?.length ?? 0;
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(v)) return false; // a date
  if (/^[A-Z]{2,6}-[A-Z]-\d{4}-\d+$/i.test(v)) return false; // official journal id (BOE-A-2015-10565)
  return digits >= 3 || (digits >= 1 && v.length >= 8);
}

// --- names in explicit context -----------------------------------------------------------------

const NAME_TRIGGER = new RegExp(
  R`(?<![\p{L}])(?:me\s+llamo|mi\s+nombre\s+es|nombre(?:\s+y\s+apellidos|\s+completo)?\s*:|apellidos\s*:|a\s+nombre\s+de|titular\s*:|solicitante\s*:|interesad[oa]\s*:|sr\.|sra\.|srta\.|se[ñn]or(?:a|ita)?|do[ñn]a|don|dña\.|dª|(d\.))(?=\s)`,
  'giu',
);
const NAME_WORD = R`(?:\p{Lu}[\p{Ll}\p{Lu}'’\-]+|\p{Lu}\.)`;
const NAME = new RegExp(
  R`\s+(${NAME_WORD}(?:\s+(?:(?:de|del|la|las|los|y|i|da|do|dos|das|van|von|di|le)\s+)*${NAME_WORD}){0,4})`,
  'uyd',
);
const ROLE_WORDS = new Set(
  (
    'director directora alcalde alcaldesa ministro ministra juez jueza magistrado magistrada fiscal ' +
    'secretario secretaria presidente presidenta delegado delegada subdelegado subdelegada ' +
    'registrador registradora notario notaria funcionario funcionaria inspector inspectora concejal ' +
    'concejala consejero consejera defensor defensora rector rectora decano decana jefe jefa agente ' +
    'policía guardia comisario comisaria abogado abogada procurador procuradora gestor gestora ' +
    'doctor doctora dr dra administrador administradora interventor interventora tesorero tesorera'
  ).split(' '),
);

function detectNames(text: string, out: Out): void {
  for (const m of text.matchAll(NAME_TRIGGER)) {
    NAME.lastIndex = m.index + m[0].length;
    const n = NAME.exec(text);
    const idx = n?.indices?.[1];
    if (!n || !idx) continue;
    const words = n[1]!.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w));
    if (ROLE_WORDS.has(words[0]!.toLowerCase().replace(/\.$/, ''))) continue;
    if (m[1] && words.length < 2) continue; // "D." needs a full name ("apartado D. Requisitos")
    push(out, 'name', idx[0], idx[1]);
  }
}

/** Runs every pattern detector. */
export function detectPatterns(text: string): Span[] {
  const out: Span[] = [];
  for (const rule of RULES) runRule(rule, text, out);
  detectIban(text, out);
  detectCards(text, out);
  detectPhones(text, out);
  detectUrlParams(text, out);
  const addresses: Span[] = [];
  detectAddresses(text, addresses);
  out.push(...addresses);
  detectPostalCodes(text, out, addresses);
  detectBirthDates(text, out);
  runRule({ type: 'case_number', re: CASE_NUMBER, group: 1, validate: isCaseId }, text, out);
  detectNames(text, out);
  return out;
}
