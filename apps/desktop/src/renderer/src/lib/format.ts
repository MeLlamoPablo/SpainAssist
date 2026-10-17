import {
  differenceInCalendarDays,
  format,
  formatDistanceToNowStrict,
  isValid,
  parseISO,
} from 'date-fns';
import { enGB, es } from 'date-fns/locale';
import { type Lang, LOCALE } from '../i18n';

const DATE_LOCALE = { es, en: enGB } as const;

function toDate(value: string | Date): Date | null {
  const d = typeof value === 'string' ? parseISO(value) : value;
  return isValid(d) ? d : null;
}

/** Dollar value of one credit. The backend counts in USD; the user only sees credits. */
const USD_PER_CREDIT = 0.01;

/** Symbol shown after a credit amount. */
const CREDIT_SYMBOL = '✦';

/** USD 2.64 → "264 ✦". Rounds down, so the user never sees more credits than they have. */
export function formatCredits(amountUsd: number, lang: Lang): string {
  return `${formatCreditCount(amountUsd, lang)}\u00a0${CREDIT_SYMBOL}`;
}

/** USD 2.64 → "264": the credit amount without the symbol. */
export function formatCreditCount(amountUsd: number, lang: Lang): string {
  // The epsilon absorbs float error (0.29 / 0.01 = 28.999…).
  const credits = Math.max(0, Math.floor(amountUsd / USD_PER_CREDIT + 1e-6));
  return new Intl.NumberFormat(LOCALE[lang]).format(credits);
}

/** "14 nov 2026" / "14 Nov 2026". */
export function formatDate(value: string | Date, lang: Lang): string {
  const d = toDate(value);
  return d ? format(d, 'd MMM yyyy', { locale: DATE_LOCALE[lang] }) : String(value);
}

/** "14 de noviembre de 2026" / "14 November 2026". */
export function formatLongDate(value: string | Date, lang: Lang): string {
  const d = toDate(value);
  if (!d) return String(value);
  return format(d, lang === 'es' ? "d 'de' MMMM 'de' yyyy" : 'd MMMM yyyy', {
    locale: DATE_LOCALE[lang],
  });
}

/** "hace 5 minutos" / "5 minutes ago"; "ahora" for < 45 s. */
export function formatRelative(value: string | Date, lang: Lang): string {
  const d = toDate(value);
  if (!d) return '';
  if (Math.abs(Date.now() - d.getTime()) < 45_000) return lang === 'es' ? 'ahora' : 'just now';
  return formatDistanceToNowStrict(d, { addSuffix: true, locale: DATE_LOCALE[lang] });
}

/** Day separators: "Hoy · 3 oct", "Ayer · 2 oct", "lunes · 28 sept", "14 jun 2025". */
export function formatDay(
  value: string | Date,
  lang: Lang,
  words: { today: string; yesterday: string },
  now: Date = new Date(),
): string {
  const d = toDate(value);
  if (!d) return '';
  const locale = DATE_LOCALE[lang];
  const short = format(d, 'd MMM', { locale });
  const days = differenceInCalendarDays(now, d);
  if (days === 0) return `${words.today} · ${short}`;
  if (days === 1) return `${words.yesterday} · ${short}`;
  if (days > 1 && days < 7) return `${format(d, 'EEEE', { locale })} · ${short}`;
  return d.getFullYear() === now.getFullYear() ? short : format(d, 'd MMM yyyy', { locale });
}

export function daysUntil(value: string | Date): number | null {
  const d = toDate(value);
  return d ? differenceInCalendarDays(d, new Date()) : null;
}

export function formatBytes(bytes: number, lang: Lang): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const n = new Intl.NumberFormat(LOCALE[lang], {
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value);
  return `${n} ${units[unit]}`;
}

/** Host without "www.", for compact labels. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Only http(s) URLs may leave the app. */
export function safeExternalUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
