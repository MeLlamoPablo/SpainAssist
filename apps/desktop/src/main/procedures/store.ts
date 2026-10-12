import { readFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { ChatItem, Procedure } from '@sa/shared';
import { type ProcedurePaths, procedurePaths } from '../app/paths';
import { DebouncedWriter, ensurePrivateDir, readJsonFile, writeFileAtomic } from '../core/fs';
import type { Logger } from '../core/logger';
import { isSafeId } from '../core/util';

/**
 * On-disk layout of procedures (all private: dirs 0700, files 0600):
 *   procedures/<id>/procedure.json   Procedure
 *   procedures/<id>/transcript.json  ChatItem[]
 *   procedures/<id>/session.jsonl    pi session (written by the agent host)
 *   procedures/<id>/media/           screenshots shown in the UI
 *   procedures/<id>/work/            agent cwd (empty)
 * Writes are atomic and debounced per file.
 */
export class ProcedureStore {
  private readonly writer: DebouncedWriter;

  constructor(
    private readonly root: string,
    private readonly logger: Logger,
    debounceMs = 250,
  ) {
    this.writer = new DebouncedWriter(debounceMs, (key, err) =>
      logger.error(`write failed: ${key}`, err),
    );
  }

  paths(id: string): ProcedurePaths {
    if (!isSafeId(id)) throw new Error(`Invalid procedure id`);
    return procedurePaths(this.root, id);
  }

  async loadAll(): Promise<Procedure[]> {
    await ensurePrivateDir(this.root);
    const entries = await readdir(this.root, { withFileTypes: true });
    const out: Procedure[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      try {
        const raw = await readJsonFile(this.paths(entry.name).procedureFile);
        if (raw === undefined) continue;
        const parsed = Procedure.safeParse(raw);
        if (parsed.success && parsed.data.id === entry.name) out.push(parsed.data);
        else this.logger.warn(`skipping invalid procedure ${entry.name}`);
      } catch (err) {
        this.logger.warn(`skipping unreadable procedure ${entry.name}`, err);
      }
    }
    return out;
  }

  /** Creates the directories and writes procedure.json + an empty transcript right away. */
  async create(procedure: Procedure): Promise<void> {
    const p = this.paths(procedure.id);
    await ensurePrivateDir(p.dir);
    await ensurePrivateDir(p.mediaDir);
    await ensurePrivateDir(p.workDir);
    await writeFileAtomic(p.procedureFile, JSON.stringify(procedure, null, 2));
    await writeFileAtomic(p.transcriptFile, '[]');
  }

  saveProcedure(procedure: Procedure): void {
    const file = this.paths(procedure.id).procedureFile;
    const json = JSON.stringify(procedure, null, 2);
    this.writer.schedule(`${procedure.id}/procedure`, () => writeFileAtomic(file, json));
  }

  /** `items` is serialized when the write runs, so later mutations are included. */
  saveTranscript(id: string, items: () => ChatItem[]): void {
    const file = this.paths(id).transcriptFile;
    this.writer.schedule(`${id}/transcript`, () => writeFileAtomic(file, JSON.stringify(items())));
  }

  /** Synchronous read (transcripts are small; screenshots live in media/). */
  loadTranscriptSync(id: string): ChatItem[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.paths(id).transcriptFile, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        this.logger.warn(`transcript of ${id} unreadable`, err);
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const items: ChatItem[] = [];
    for (const value of raw) {
      const parsed = ChatItem.safeParse(value);
      if (parsed.success) items.push(parsed.data);
    }
    return items;
  }

  async delete(id: string): Promise<void> {
    await this.writer.cancel(`${id}/`);
    await rm(this.paths(id).dir, { recursive: true, force: true });
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  /** Deletes every procedure (wipe). */
  async deleteAll(): Promise<void> {
    await this.writer.cancel('');
    await rm(this.root, { recursive: true, force: true });
    await ensurePrivateDir(this.root);
  }
}
