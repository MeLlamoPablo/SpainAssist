import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** App-owned storage paths, plus private scratch space under the OS temporary directory. */
export interface AppPaths {
  userData: string;
  settingsFile: string;
  /** Small app-internal state (device id for ChatGPT sign-in...). */
  stateFile: string;
  vaultDir: string;
  /** The assistant (orchestrator): transcript.json, session.jsonl (pi), work/ (its cwd). */
  assistantDir: string;
  proceduresDir: string;
  logsDir: string;
  /** Development only: one directory per document scan (`scanner/transcript.ts`). */
  scanTranscriptsDir: string;
  /** Private scratch space: documents opened with the OS, etc. Cleared at startup. */
  tmpDir: string;
  /** Browser downloads: staging, then temporary downloads until the agent saves them to the vault. */
  downloadsDir: string;
  /** Chrome's CRLSet, unpacked (`crlset/store.ts`). */
  crlSetDir: string;
}

export function createAppPaths(userData: string, tempRoot = tmpdir()): AppPaths {
  const profile = createHash('sha256').update(resolve(userData)).digest('hex').slice(0, 24);
  return {
    userData,
    settingsFile: join(userData, 'settings.json'),
    stateFile: join(userData, 'state.json'),
    vaultDir: join(userData, 'vault'),
    assistantDir: join(userData, 'assistant'),
    proceduresDir: join(userData, 'procedures'),
    logsDir: join(userData, 'logs'),
    scanTranscriptsDir: join(userData, 'scanner', 'conversations'),
    tmpDir: join(tempRoot, `SpainAssistant-${profile}`),
    downloadsDir: join(userData, 'downloads'),
    crlSetDir: join(userData, 'crlset'),
  };
}

/** Files of one procedure: procedures/<id>/... */
export interface ProcedurePaths {
  dir: string;
  procedureFile: string;
  /** The procedure's questions to the user and notices (ChatItem[]). */
  transcriptFile: string;
  mediaDir: string;
}

export function procedurePaths(proceduresDir: string, id: string): ProcedurePaths {
  const dir = join(proceduresDir, id);
  return {
    dir,
    procedureFile: join(dir, 'procedure.json'),
    transcriptFile: join(dir, 'transcript.json'),
    mediaDir: join(dir, 'media'),
  };
}

/**
 * The version of the chat's agent. The chat the user sees (transcript.json) is one for every
 * version; the model's context (its pi session) is not: a new version starts fresh, so an agent
 * never reads back tool calls of tools it no longer has.
 *   1: the classic assistant (`session.jsonl`, no longer read).
 *   2: the coordinator, which only delegates with plain tools (docs/codemode.md).
 */
export const CHAT_VERSION = 2;

/** Files of the assistant: assistant/... */
export function assistantPaths(assistantDir: string) {
  return {
    dir: assistantDir,
    transcriptFile: join(assistantDir, 'transcript.json'),
    /** The pi session of a version of the chat's agent (`CHAT_VERSION`). */
    sessionFile: (version: number) =>
      join(assistantDir, version === 1 ? 'session.jsonl' : `session-v${version}.jsonl`),
    workDir: join(assistantDir, 'work'),
  };
}
