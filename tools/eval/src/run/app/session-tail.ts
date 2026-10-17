/**
 * Follows the pi session file of one agent: the lossless record of what it did, written by its
 * host process one line per entry. A file lives as long as the agent's profile, across restarts of
 * its host, so one tail serves them all; what the file held when the tail started belongs to
 * the run before (a restored profile) and is skipped, and an entry seen once is never delivered
 * again (pi rewrites the whole file on some operations).
 */
import { readFileSync } from 'node:fs';
import { followJsonl, type JsonlFollower } from './jsonl-follow';

function entryIds(file: string): Set<string> {
  const ids = new Set<string>();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return ids;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id;
      if (typeof id === 'string') ids.add(id);
    } catch {
      // a line cut by a crash
    }
  }
  return ids;
}

export class SessionTail {
  private readonly follower: JsonlFollower;

  constructor(file: string, onEntry: (entry: unknown) => void) {
    const seen = entryIds(file);
    this.follower = followJsonl(
      file,
      (entry) => {
        const id = (entry as { id?: unknown } | null)?.id;
        if (typeof id === 'string') {
          if (seen.has(id)) return;
          seen.add(id);
        }
        onEntry(entry);
      },
      { fromEnd: true },
    );
  }

  drain(): Promise<void> {
    return this.follower.drain();
  }

  stop(): Promise<void> {
    return this.follower.stop();
  }
}
