// Turns a GitHub push webhook into the smallest request that Coolify's manual GitHub endpoint
// (`POST /webhooks/source/github/events/manual`, `manual()` in Coolify's
// app/Http/Controllers/Webhook/Github.php, checked against 4.3.24) still deploys from. Nothing
// from GitHub's request reaches Coolify as is: we check GitHub's signature, read the five things
// Coolify uses (branch, repository, commit, changed files, whether to skip the deploy), and send
// a new JSON body with a new signature and only the headers Coolify reads.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface IngesterConfig {
  /** The secret GitHub signs deliveries with; Coolify checks the same one. */
  secret: string;
  /** owner/name: the only repository we forward pushes of. */
  repository: string;
}

export interface IncomingWebhook {
  /** X-GitHub-Event */
  event: string | undefined;
  /** X-Hub-Signature-256 */
  signature: string | undefined;
  /** Content-Type */
  contentType: string | undefined;
  body: Buffer;
}

export type Outcome =
  | { kind: 'forward'; body: string; signature: string }
  | { kind: 'reply'; status: number; message: string };

/** The fields Coolify reads from a push (and nothing else). */
interface ForwardedPush {
  ref: string;
  after: string;
  repository: { full_name: string };
  commits: { message: string; added: string[]; removed: string[]; modified: string[] }[];
}

// GitHub lists at most 2048 commits in a push, and each commit's files are capped too.
const MAX_COMMITS = 2048;
const MAX_FILES = 50_000;
const MAX_PATH_LENGTH = 4096;

const BRANCH_REF = /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we reject.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function sign(secret: string, body: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function signatureMatches(secret: string, header: string | undefined, body: Buffer): boolean {
  const match = header === undefined ? null : SIGNATURE.exec(header);
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(Buffer.from(match[1]!, 'hex'), expected);
}

/** Coolify's DetectsSkipDeployCommits::shouldSkipDeploy: every non-empty message has a marker. */
function shouldSkipDeploy(messages: string[]): boolean {
  const filled = messages.filter((m) => m.trim() !== '');
  return (
    filled.length > 0 &&
    filled.every((m) => {
      const lower = m.toLowerCase();
      return lower.includes('[skip cd]') || lower.includes('[skip ci]');
    })
  );
}

const reply = (status: number, message: string): Outcome => ({ kind: 'reply', status, message });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

/** Reads a push payload into what Coolify needs, or explains why it can't. */
function readPush(
  payload: unknown,
  repository: string,
): { push: ForwardedPush } | { push: null; status: number; message: string } {
  const invalid = (message: string) => ({ push: null, status: 400, message });
  if (!isRecord(payload)) return invalid('Payload is not an object');

  const fullName = isRecord(payload.repository) ? payload.repository.full_name : undefined;
  if (typeof fullName !== 'string' || fullName.toLowerCase() !== repository.toLowerCase()) {
    return { push: null, status: 422, message: 'Unexpected repository' };
  }
  if (payload.deleted === true) return { push: null, status: 200, message: 'Branch deleted' };

  const { ref, after, commits } = payload;
  if (typeof ref !== 'string' || !BRANCH_REF.test(ref)) {
    return { push: null, status: 200, message: 'Not a branch push' };
  }
  if (typeof after !== 'string' || !COMMIT_SHA.test(after)) return invalid('Invalid commit');
  if (!Array.isArray(commits) || commits.length > MAX_COMMITS) return invalid('Invalid commits');

  const files = new Set<string>();
  const messages: string[] = [];
  for (const commit of commits) {
    if (!isRecord(commit) || typeof commit.message !== 'string') return invalid('Invalid commit');
    messages.push(commit.message);
    for (const list of [commit.added, commit.removed, commit.modified]) {
      if (!Array.isArray(list) || !list.every(isPath)) return invalid('Invalid file list');
      for (const path of list) files.add(path);
    }
    if (files.size > MAX_FILES) return invalid('Too many files');
  }

  return {
    push: {
      ref,
      after,
      repository: { full_name: repository },
      // Coolify only unions the files of every commit and checks the messages for [skip ci], so
      // one commit carries both: every changed file, and a marker instead of the messages.
      commits:
        commits.length === 0
          ? []
          : [
              {
                message: shouldSkipDeploy(messages) ? '[skip ci]' : '',
                added: [],
                removed: [],
                modified: [...files],
              },
            ],
    },
  };
}

export function ingest(config: IngesterConfig, webhook: IncomingWebhook): Outcome {
  if (!signatureMatches(config.secret, webhook.signature, webhook.body)) {
    return reply(401, 'Invalid signature');
  }
  if (webhook.event === 'ping') return reply(200, 'pong');
  if (webhook.event !== 'push') return reply(200, 'Ignored: only push events deploy');
  if (webhook.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return reply(415, 'Expected application/json');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(webhook.body.toString('utf8'));
  } catch {
    return reply(400, 'Invalid JSON');
  }
  const result = readPush(payload, config.repository);
  if (result.push === null) return reply(result.status, result.message);

  const body = JSON.stringify(result.push);
  return { kind: 'forward', body, signature: sign(config.secret, body) };
}
