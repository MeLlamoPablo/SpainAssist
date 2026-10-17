/**
 * The developer's home folder in a run's outputs. Stack traces, the hosts' configs and pi's
 * session files carry absolute paths (`/Users/<name>/...`), which name the person who ran the
 * eval. The run folder keeps them as `~`: a substitution of the outputs only. The home folder is
 * no secret of the run (the leak check never looks for it), and the live files the app and the
 * hosts read keep their real paths.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

/** The text files a run writes; anything else (a PDF, the sealed vault) is left as it is. */
const TEXT_FILES = new Set(['.json', '.jsonl', '.log', '.md', '.txt']);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `text` with `home` (as written, or JSON-escaped) replaced by `~` where a path segment ends. */
export function maskHome(text: string, home: string = homedir()): string {
  // A home of `/` or `C:\` would match every path.
  if (home.replace(/[\\/]+$/, '').length < 4) return text;
  const spellings = [...new Set([home, JSON.stringify(home).slice(1, -1)])];
  let out = text;
  for (const spelling of spellings) {
    out = out.replace(new RegExp(`${escapeRegExp(spelling)}(?![\\w.-])`, 'g'), '~');
  }
  return out;
}

/** Rewrites the text files under `dir` (recursively) with the home folder masked. */
export async function maskHomeInTree(dir: string, home: string = homedir()): Promise<void> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await maskHomeInTree(path, home);
    } else if (entry.isFile() && TEXT_FILES.has(extname(entry.name))) {
      const text = await readFile(path, 'utf8');
      const masked = maskHome(text, home);
      if (masked !== text) await writeFile(path, masked, { mode: 0o600 });
    }
  }
}
