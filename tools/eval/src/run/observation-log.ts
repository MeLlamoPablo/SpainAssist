import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Observation, ObservationInput, ObservationSink } from '../contracts';

export interface ObservationLogOptions {
  /** `events.jsonl`: every observation is appended (mode 0600) before listeners see it. */
  file?: string;
  /** The first `seq` handed out is `startSeq + 1` (a resumed run continues the old numbering). */
  startSeq?: number;
  now?: () => Date;
  /** Masks typed secrets in the text written to the file (never in what listeners receive). */
  scrub?: (text: string) => string;
  /** Called when a write fails: the log keeps working in memory and the run decides what to do. */
  onError?: (error: Error) => void;
}

/**
 * The one sequencer of a run. Every emitter (the app's observers, the network followers, the
 * bench event stream, the user simulator) pushes here, so `seq` is a single total order that rules,
 * checkpoints and the report can point at. Listeners run synchronously in push order; a listener
 * that throws does not stop the others or the push.
 */
export class ObservationLog implements ObservationSink {
  private readonly items: Observation[] = [];
  private readonly listeners = new Set<(observation: Observation) => void>();
  private readonly now: () => Date;
  private fd: number | undefined;
  private seq: number;
  private writeError: Error | undefined;

  constructor(private readonly options: ObservationLogOptions = {}) {
    this.seq = options.startSeq ?? 0;
    this.now = options.now ?? (() => new Date());
    if (options.file) {
      mkdirSync(dirname(options.file), { recursive: true });
      this.fd = openSync(options.file, 'a', 0o600);
    }
  }

  push(input: ObservationInput): Observation {
    const observation = { ...input, seq: ++this.seq, t: this.now().toISOString() } as Observation;
    this.items.push(observation);
    this.write(observation);
    for (const listener of [...this.listeners]) {
      try {
        listener(observation);
      } catch (error) {
        this.fail(error);
      }
    }
    return observation;
  }

  all(): readonly Observation[] {
    return this.items;
  }

  /** The observations after `seq`, oldest first. */
  since(seq: number): Observation[] {
    return this.items.filter((o) => o.seq > seq);
  }

  get lastSeq(): number {
    return this.seq;
  }

  on(listener: (observation: Observation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The first write failure, if any (the run reports it; the log never throws from `push`). */
  get failure(): Error | undefined {
    return this.writeError;
  }

  close(): void {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
  }

  private write(observation: Observation): void {
    if (this.fd === undefined) return;
    try {
      const line = JSON.stringify(observation, replacer);
      appendFileSync(this.fd, `${this.options.scrub ? this.options.scrub(line) : line}\n`);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.writeError ??= err;
    this.options.onError?.(err);
  }
}

/** RegExp and Uint8Array do not survive `JSON.stringify`: keep them readable in the log. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  return value;
}
