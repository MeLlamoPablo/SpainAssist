import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@sa/shared';
import { ensurePrivateDir } from '../core/fs';
import type { FrameDecision } from './decider';

/** Production never writes scan artifacts; remove debug files left by earlier versions. */
export async function prepareScanStorage(directory: string, development: boolean) {
  if (!development) await rm(directory, { recursive: true, force: true });
  return development ? directory : undefined;
}

/** Separate from chat and general logs. No provider credentials, headers or raw errors. */
export class ScanTranscript {
  private imageCount = 0;
  constructor(private readonly directory?: string) {}

  async initialize(model: string, provider: string, reasoning: ThinkingLevel = 'off') {
    if (!this.directory) return;
    await ensurePrivateDir(this.directory);
    await this.append({
      type: 'session',
      model,
      provider,
      reasoning,
      timestamp: Date.now(),
    });
  }
  private async append(entry: unknown) {
    if (!this.directory) return;
    await appendFile(join(this.directory, 'session.jsonl'), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
  }
  async record(message: Message) {
    if (!this.directory) return;
    const entry = structuredClone(message);
    if (entry.role !== 'system' && Array.isArray(entry.content)) {
      for (const content of entry.content) {
        if (content.type !== 'image') continue;
        const file = `frame-${String(++this.imageCount).padStart(4, '0')}.jpg`;
        await writeFile(join(this.directory, file), Buffer.from(content.data, 'base64'), {
          mode: 0o600,
          flag: 'wx',
        });
        Object.assign(content, { data: undefined, file });
      }
    }
    await this.append({ type: 'message', message: entry });
  }
  async decision(image: string, reason: string, decision: FrameDecision) {
    if (!this.directory) return;
    const file = `gate-${String(++this.imageCount).padStart(4, '0')}.jpg`;
    await writeFile(join(this.directory, file), Buffer.from(image.split(',')[1]!, 'base64'), {
      mode: 0o600,
      flag: 'wx',
    });
    await this.append({ type: 'frame_decision', file, reason, ...decision });
  }
  async end(status: 'complete' | 'cancelled' | 'error') {
    await this.append({ type: 'end', status, timestamp: Date.now() });
  }
}
