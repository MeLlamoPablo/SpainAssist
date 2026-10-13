import { DEFAULT_PLACEHOLDERS, detectPii, scrubPii, stripUrlParams } from '@sa/pii';
import { FeedbackAuthor, type FeedbackEdit, type FeedbackSubmission } from '@sa/shared';
import type { NewFeedback } from './repo';

/** Reject a submission when more than this share of its title or body is personal data. */
export const MAX_PII_SHARE = 0.3;

export interface ScrubbedSubmission {
  feedback: NewFeedback;
  /** Redactions applied here, on top of the client's own scrubbing. */
  redactions: number;
  /** Largest share (0-1) of redacted characters in the title or body, client placeholders included. */
  piiShare: number;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Placeholders the client (or we) may already have inserted: "[DNI]", "[DATO PERSONAL]"… */
const PLACEHOLDER = new RegExp(
  Object.values(DEFAULT_PLACEHOLDERS).filter(Boolean).map(escapeRegExp).join('|'),
  'g',
);

const HAS_PLACEHOLDER = new RegExp(PLACEHOLDER.source, 'i');

const placeholderChars = (text: string) =>
  [...text.matchAll(PLACEHOLDER)].reduce((n, m) => n + m[0].length, 0);

/**
 * Defense in depth: the app already scrubbed the submission with the user's known values; here
 * we re-run the pattern detectors on every text field, strip URL parameters and drop URLs,
 * tags or an author that still carry personal data.
 */
export function scrubSubmission(
  sub: FeedbackEdit & Partial<Pick<FeedbackSubmission, 'appVersion'>>,
): ScrubbedSubmission {
  let redactions = 0;
  let piiShare = 0;

  const text = (value: string, measure = false): string => {
    const { text: out, findings } = scrubPii(value);
    redactions += findings.length;
    if (measure && value.length > 0) {
      const removed = findings.reduce((n, f) => n + (f.end - f.start), 0);
      const share = (removed + placeholderChars(value)) / value.length;
      piiShare = Math.max(piiShare, share);
    }
    return out;
  };
  const optional = (value: string | undefined) => {
    if (value === undefined) return undefined;
    return text(value).trim() || undefined;
  };

  const tags: string[] = [];
  for (const raw of sub.tags) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!tag) continue;
    if (detectPii(tag).length > 0 || HAS_PLACEHOLDER.test(tag)) {
      redactions++;
      continue;
    }
    if (!tags.includes(tag)) tags.push(tag);
  }

  const urls: string[] = [];
  for (const raw of sub.urls) {
    const url = stripUrlParams(raw);
    if (url !== raw.trim()) redactions++;
    // A URL whose path still carries personal data (e.g. /usuarios/12345678Z) is dropped.
    if (detectPii(url).length > 0 || !isHttpUrl(url)) {
      redactions++;
      continue;
    }
    if (!urls.includes(url)) urls.push(url);
  }

  const appVersion =
    sub.appVersion && /^[\w.+\- ]{1,40}$/.test(sub.appVersion) ? sub.appVersion : undefined;

  // Submissions only validate agent authors; the admin API may also set "human". An author
  // carrying personal data is dropped.
  let author: string | undefined;
  if (sub.author !== undefined) {
    if (FeedbackAuthor.safeParse(sub.author).success && detectPii(sub.author).length === 0) {
      author = sub.author;
    } else redactions++;
  }

  const feedback: NewFeedback = {
    procedure: text(sub.procedure),
    administration: optional(sub.administration),
    region: optional(sub.region),
    kind: sub.kind,
    title: text(sub.title, true),
    body: text(sub.body, true),
    tags,
    urls,
    appVersion,
    author,
  };
  return { feedback, redactions, piiShare };
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'https:' || protocol === 'http:';
}
