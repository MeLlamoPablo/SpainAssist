import {
  type BridgeResults,
  type FeedbackKind,
  FeedbackSearchResponse,
  type FeedbackSubmission,
  FeedbackSubmitResponse,
  type FeedbackVote,
  FeedbackVoteResponse,
  type Language,
  type Settings,
} from '@sa/shared';
import { BridgeError } from '../core/errors';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { scrubbableKnownValues } from '../core/secrets';
import type { PiiLib, VaultPort } from '../ports';
import { type FetchFn, HttpError, joinUrl, NetworkError, requestJson } from './http';

/** Removes personal data from text that leaves the device (feedback queries and submissions). */
function scrubOutgoing(
  pii: PiiLib,
  vault: VaultPort,
  text: string,
): { text: string; redactions: number } {
  const result = pii.scrubPii(text, { knownValues: scrubbableKnownValues(vault) });
  return { text: result.text, redactions: result.findings.length };
}

export interface FeedbackInput {
  procedure: string;
  administration?: string;
  region?: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  tags?: string[];
  urls?: string[];
}

export interface FeedbackDeps {
  feedbackServerUrl?: string;
  /** Sharing learnings is on (feature flag). Searching and rating them is always on. */
  submitEnabled: boolean;
  /**
   * The user key (see UserKey), which the server checks before it accepts a learning or a vote,
   * and which identifies the user; undefined when the provider has none (BYOK, custom endpoints).
   */
  access: () => Promise<{ apiKey: string } | undefined>;
  /**
   * Author of the learnings this app's procedure agents share ("<model id> · <reasoning level>",
   * see AgentAuthor). Set here, never from the agent's arguments.
   */
  author: () => Promise<string>;
  fetch: FetchFn;
  settings: () => Settings;
  vault: () => VaultPort;
  pii: PiiLib;
  logger: Logger;
  lang: () => Language;
  appVersion: string;
}

/**
 * Community learnings. Everything sent is scrubbed here first (regex + exact match against every
 * value in the vault; URLs lose query strings and fragments); the server scrubs again.
 */
export class FeedbackService {
  constructor(private readonly deps: FeedbackDeps) {}

  private serviceUrl(): string {
    if (!this.deps.feedbackServerUrl)
      throw new BridgeError('unavailable', 'The feedback service is not available yet.');
    return this.deps.feedbackServerUrl;
  }

  async search(params: {
    query: string;
    procedure?: string;
    limit?: number;
  }): Promise<BridgeResults['feedback.search']> {
    const vault = this.deps.vault();
    const q = scrubOutgoing(this.deps.pii, vault, params.query).text.trim();
    if (q.length < 2) return { results: [] };
    const search = new URLSearchParams({ q });
    if (params.procedure)
      search.set('procedure', scrubOutgoing(this.deps.pii, vault, params.procedure).text);
    if (params.limit) search.set('limit', String(params.limit));
    try {
      const json = await requestJson(
        this.deps.fetch,
        joinUrl(this.serviceUrl(), `/v1/feedback/search?${search}`),
      );
      const parsed = FeedbackSearchResponse.safeParse(json);
      if (!parsed.success)
        throw new BridgeError('unavailable', 'The feedback service sent an invalid response.');
      return { results: parsed.data.results };
    } catch (err) {
      throw toUnavailable(err, this.deps.logger);
    }
  }

  /** Scrubs a submission. Exported for tests and for the transparency notice. */
  scrub(
    input: FeedbackInput,
    author: string,
  ): { submission: FeedbackSubmission; redactions: number } {
    const vault = this.deps.vault();
    let redactions = 0;
    const clean = (text: string): string => {
      const r = scrubOutgoing(this.deps.pii, vault, text);
      redactions += r.redactions;
      return r.text.trim();
    };
    const urls: string[] = [];
    for (const raw of input.urls ?? []) {
      try {
        const stripped = this.deps.pii.stripUrlParams(raw);
        const url = new URL(stripped);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        if (url.username || url.password) continue;
        // Paths can carry ids too (e.g. /expediente/12345678Z): scrub them as text.
        const path = clean(decodeURIComponent(url.pathname));
        urls.push(`${url.origin}${path.startsWith('/') ? '' : '/'}${encodeURI(path)}`);
      } catch {
        // invalid URLs are dropped
      }
    }
    const submission: FeedbackSubmission = {
      procedure: clean(input.procedure),
      kind: input.kind,
      title: clean(input.title),
      body: clean(input.body),
      tags: (input.tags ?? []).map(clean).filter(Boolean),
      urls,
      appVersion: this.deps.appVersion,
      // A user's own model name could carry personal data: then it is shared as "unknown".
      author: clean(author) === author ? author : author.replace(/^.* · /, 'unknown · '),
    };
    if (input.administration) submission.administration = clean(input.administration);
    if (input.region) submission.region = clean(input.region);
    return { submission, redactions };
  }

  async submit(
    input: FeedbackInput,
  ): Promise<{ result: BridgeResults['feedback.submit']; shared?: FeedbackSubmission }> {
    if (!this.deps.submitEnabled)
      throw new BridgeError('unavailable', 'Sharing learnings is not available yet.');
    if (!this.deps.settings().shareLearnings) {
      return {
        result: {
          submitted: false,
          redactions: 0,
          reason: 'The user turned off sharing learnings with the community.',
        },
      };
    }
    // Fails only without a provider, which also means no gateway key.
    const author = await this.deps.author().catch(() => undefined);
    if (!author) return { result: { submitted: false, redactions: 0, reason: NO_KEY } };
    const { submission, redactions } = this.scrub(input, author);
    if (
      meaningful(submission.procedure).length < 3 ||
      meaningful(submission.title).length < 5 ||
      meaningful(submission.body).length < 10
    ) {
      return {
        result: {
          submitted: false,
          redactions,
          reason: 'Too little content was left after removing personal data.',
        },
      };
    }
    const headers = await this.authHeaders();
    if (!headers) return { result: { submitted: false, redactions, reason: NO_KEY } };
    try {
      const json = await requestJson(this.deps.fetch, joinUrl(this.serviceUrl(), '/v1/feedback'), {
        method: 'POST',
        headers,
        body: submission,
      });
      const parsed = FeedbackSubmitResponse.safeParse(json);
      if (!parsed.success)
        throw new BridgeError('unavailable', 'The feedback service sent an invalid response.');
      return {
        result: {
          submitted: true,
          id: parsed.data.id,
          redactions: redactions + parsed.data.redactions,
        },
        shared: submission,
      };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 400 || err.status === 422)) {
        return {
          result: {
            submitted: false,
            redactions,
            reason: `The feedback service rejected it: ${err.message}`,
          },
        };
      }
      const reason = refusal(err);
      if (reason) return { result: { submitted: false, redactions, reason } };
      throw toUnavailable(err, this.deps.logger);
    }
  }

  /** Rates a learning; like sharing, needs the feature flag and the user's sharing setting. */
  async vote(params: { id: string; vote: FeedbackVote }): Promise<BridgeResults['feedback.vote']> {
    if (!this.deps.settings().shareLearnings) {
      return {
        counted: false,
        reason: 'The user turned off sharing learnings with the community.',
      };
    }
    const headers = await this.authHeaders();
    if (!headers) return { counted: false, reason: NO_KEY };
    try {
      const json = await requestJson(
        this.deps.fetch,
        joinUrl(this.serviceUrl(), `/v1/feedback/${encodeURIComponent(params.id)}/vote`),
        { method: 'POST', headers, body: { vote: params.vote } },
      );
      const parsed = FeedbackVoteResponse.safeParse(json);
      if (!parsed.success)
        throw new BridgeError('unavailable', 'The feedback service sent an invalid response.');
      return parsed.data.counted
        ? { counted: true }
        : { counted: false, reason: 'You already gave this learning the same rating.' };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        return {
          counted: false,
          reason: 'No learning has this id. Use an id from feedback_search.',
        };
      }
      const reason = refusal(err);
      if (reason) return { counted: false, reason };
      throw toUnavailable(err, this.deps.logger);
    }
  }

  /** `Authorization` with the user key, or undefined when there is none. */
  private async authHeaders(): Promise<Record<string, string> | undefined> {
    const key = await this.deps.access().catch(() => undefined);
    return key && { authorization: `Bearer ${key.apiKey}` };
  }

  /** The exact content shared, for the transparency notice in the chat. */
  describeShared(s: FeedbackSubmission): string {
    const lang = this.deps.lang();
    const lines = [t(lang, 'feedbackShared'), '', `«${s.title}»`, s.body, ''];
    lines.push(`${t(lang, 'feedbackProcedure')}: ${s.procedure}`);
    if (s.administration) lines.push(`${t(lang, 'feedbackAdministration')}: ${s.administration}`);
    if (s.region) lines.push(`${t(lang, 'feedbackRegion')}: ${s.region}`);
    if (s.tags.length) lines.push(`${t(lang, 'feedbackTags')}: ${s.tags.join(', ')}`);
    if (s.urls.length) lines.push(`${t(lang, 'feedbackLinks')}: ${s.urls.join(' ')}`);
    return lines.join('\n');
  }
}

const NO_KEY = 'Sharing learnings needs a Spain Assist voucher or a ChatGPT connection.';

/** The server refused this user (key, credit or limits): a reason for the agent not to retry. */
function refusal(err: unknown): string | undefined {
  if (!(err instanceof HttpError)) return undefined;
  if (err.status === 401) return 'The feedback service did not accept this app’s key.';
  if (err.status === 403) return 'The user has no credit left, so sharing is paused.';
  if (err.status === 429) return 'The sharing limit for now is reached. Do not retry today.';
  return undefined;
}

/** Text without redaction placeholders ("[DNI]", "[DATO]"...). */
function meaningful(text: string): string {
  return text
    .replace(/\[[A-Z_]{2,20}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toUnavailable(err: unknown, logger: Logger): BridgeError {
  if (err instanceof BridgeError) return err;
  if (err instanceof NetworkError)
    return new BridgeError('unavailable', 'The feedback service is unreachable (offline?).');
  if (err instanceof HttpError)
    return new BridgeError('unavailable', `The feedback service failed (HTTP ${err.status}).`);
  logger.error('feedback request failed', err);
  return new BridgeError('unavailable', 'The feedback service is not available right now.');
}
