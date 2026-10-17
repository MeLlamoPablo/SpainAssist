import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { writePrivateJson } from './home';
import type { UpstreamError } from './sse';

/**
 * A ChatGPT plan's usage limit (HTTP 429 `usage_limit_reached`, with `resets_at`) is shared by
 * every eval process on the machine: the first one to see it writes `ledger/codex-cooldown.json`,
 * and every meter then answers Codex requests locally with the same 429 until the window resets,
 * so nothing keeps hammering OpenAI.
 */

const USAGE_LIMIT = /usage_limit|usage_not_included/i;
/** When the limit carries no reset time. */
const DEFAULT_COOLDOWN_MS = 30 * 60_000;

const CooldownFile = z.object({
  untilMs: z.number(),
  planType: z.string().optional(),
  observedAt: z.string(),
  /** The file could not be read: a limit is assumed from the time it was last written. */
  broken: z.literal(true).optional(),
});
export type CodexCooldown = z.infer<typeof CooldownFile>;

/** Whether an upstream answer is a usage-limit signal. */
export function isUsageLimit(error: UpstreamError | undefined): boolean {
  return !!error && USAGE_LIMIT.test(`${error.type ?? ''} ${error.code ?? ''}`);
}

export function cooldownFromError(error: UpstreamError, nowMs: number): CodexCooldown {
  const untilMs =
    error.resetsAt !== undefined
      ? error.resetsAt * 1000
      : error.resetsInSeconds !== undefined
        ? nowMs + error.resetsInSeconds * 1000
        : nowMs + DEFAULT_COOLDOWN_MS;
  return {
    untilMs: Math.max(untilMs, nowMs + 1000),
    ...(error.planType ? { planType: error.planType } : {}),
    observedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * The active cooldown, or undefined when there is none (no file, or it has passed). A file that
 * exists but cannot be read or understood does not mean "no limit": the meter would keep sending
 * requests into a usage limit. It counts as a limit seen when the file was last written, for the
 * default cooldown, so a broken file blocks for a while and then stops mattering.
 */
export function readCooldown(path: string, nowMs: number): CodexCooldown | undefined {
  let writtenMs: number;
  try {
    writtenMs = statSync(path).mtimeMs;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
  try {
    const parsed = CooldownFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (parsed.success) return parsed.data.untilMs > nowMs ? parsed.data : undefined;
  } catch {
    // Unreadable or not JSON: treated like an invalid file.
  }
  const untilMs = writtenMs + DEFAULT_COOLDOWN_MS;
  return untilMs > nowMs
    ? { untilMs, observedAt: new Date(writtenMs).toISOString(), broken: true }
    : undefined;
}

export function writeCooldown(path: string, cooldown: CodexCooldown): void {
  writePrivateJson(path, cooldown);
}
