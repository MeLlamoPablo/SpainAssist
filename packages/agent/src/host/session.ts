import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, parse, resolve } from 'node:path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ResearchUsage } from '../research/chatgpt-research';

/**
 * Make sure the session file and its directory are private (0600 / 0700) before pi touches
 * them: session files hold the whole transcript, including personal data and screenshots.
 * A missing file is created empty; pi then writes a fresh session header into it.
 */
export function prepareSessionFile(sessionFile: string): string {
  const file = resolve(sessionFile);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isSharedDirectory(dir)) chmodPrivate(dir, 0o700);
  if (!existsSync(file)) {
    closeSync(openSync(file, 'a', 0o600));
  }
  chmodPrivate(file, 0o600);
  return file;
}

/**
 * Record the model and thinking level a resumed session now runs with. pi uses the ones the host
 * passes in, but writes `model_change`/`thinking_level_change` only for new sessions, so after the
 * user switches provider (say, ChatGPT to a voucher) the file would still name the old model.
 * Appends only what differs from the branch's latest entries; new sessions already match.
 */
export function recordSessionSelection(
  sessionManager: Pick<
    SessionManager,
    'getBranch' | 'appendModelChange' | 'appendThinkingLevelChange'
  >,
  selection: { model: { provider: string; id: string } | undefined; thinkingLevel: string },
): void {
  const branch = sessionManager.getBranch();
  const lastModel = branch.findLast((entry) => entry.type === 'model_change');
  const lastThinking = branch.findLast((entry) => entry.type === 'thinking_level_change');
  const { model, thinkingLevel } = selection;
  if (model && (lastModel?.provider !== model.provider || lastModel.modelId !== model.id)) {
    sessionManager.appendModelChange(model.provider, model.id);
  }
  if (lastThinking?.thinkingLevel !== thinkingLevel) {
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }
}

/** Kind of the pi `usage` entry of a web research request (see recordResearchUsage). */
const RESEARCH_USAGE_KIND = 'web_research';

/**
 * Record what a web research request spent (ChatGPT research is a separate Responses request,
 * outside the agent's own messages) as a pi `usage` entry in the agent's session file, next to
 * its assistant messages: pi's session stats count it, and one script can sum an agent's spend.
 * The note holds the rest as `key=value` pairs. Returns them, with the token counts, for a log line.
 */
export function recordResearchUsage(
  sessionManager: Pick<SessionManager, 'appendUsage'>,
  research: ResearchUsage,
): string {
  const note = [
    `mode=${research.mode}`,
    `thinking=${research.thinkingLevel}`,
    `searches=${research.searches}`,
    `durationMs=${research.durationMs}`,
    `stop=${research.stopReason}`,
  ].join(' ');
  sessionManager.appendUsage(
    RESEARCH_USAGE_KIND,
    research.provider,
    research.model,
    research.usage,
    note,
  );
  const { input, cacheRead, output, reasoning, cost } = research.usage;
  return `${research.provider}/${research.model} ${note} input=${input} cacheRead=${cacheRead} output=${output} reasoning=${reasoning ?? 0} cost=${cost.total.toFixed(4)}`;
}

/** Never tighten directories other programs rely on (home, temp, filesystem root). */
function isSharedDirectory(dir: string): boolean {
  const real = safeRealpath(dir);
  return [homedir(), tmpdir(), parse(real).root].some((shared) => safeRealpath(shared) === real);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function chmodPrivate(path: string, mode: number): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, mode);
  } catch {
    // Not fatal (e.g. a directory we don't own); the process umask still protects new files.
  }
}
