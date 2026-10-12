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
  };
}

/** Files of one procedure: procedures/<id>/... */
export interface ProcedurePaths {
  dir: string;
  procedureFile: string;
  /** Activity log of the procedure's agent (ChatItem[]). */
  transcriptFile: string;
  /** pi session file (JSONL), resumed when the agent restarts. */
  sessionFile: string;
  mediaDir: string;
  /** Working directory of the agent process (empty, app-owned). */
  workDir: string;
}

export function procedurePaths(proceduresDir: string, id: string): ProcedurePaths {
  const dir = join(proceduresDir, id);
  return {
    dir,
    procedureFile: join(dir, 'procedure.json'),
    transcriptFile: join(dir, 'transcript.json'),
    sessionFile: join(dir, 'session.jsonl'),
    mediaDir: join(dir, 'media'),
    workDir: join(dir, 'work'),
  };
}

/** Files of the assistant: assistant/... */
export function assistantPaths(assistantDir: string) {
  return {
    dir: assistantDir,
    transcriptFile: join(assistantDir, 'transcript.json'),
    sessionFile: join(assistantDir, 'session.jsonl'),
    workDir: join(assistantDir, 'work'),
  };
}
