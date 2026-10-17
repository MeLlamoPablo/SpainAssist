import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeterUsage } from '../../../src/contracts';
import {
  Ledger,
  type MeterEvent,
  type MeterHandle,
  type MeterRun,
  type MeterRunSummary,
  type OpenRunOptions,
} from '../../../src/llm';
import { emptyMeterUsage } from '../../../src/scoring';

/** One meter run whose usage and events the test controls. */
export class FakeMeterRun implements MeterRun {
  readonly token = '0123456789abcdef0123456789abcdef';
  readonly runId: string;
  readonly provider: MeterRun['provider'];
  readonly cache: MeterRun['cache'];
  closed = false;
  closeCalls = 0;
  /** Requests being answered right now (they finish after a close and still count). */
  inflight = 0;
  /** Model calls that arrived after the run was closed: the meter would refuse them. */
  refused = 0;
  private totals: MeterUsage;
  private readonly listeners = new Set<(event: MeterEvent) => void>();

  constructor(
    readonly options: OpenRunOptions,
    private readonly fakeUrl: string,
  ) {
    this.runId = options.runId;
    this.provider = options.provider;
    this.cache = options.cache ?? 'off';
    this.totals = { ...emptyMeterUsage(), ...options.baseline };
  }

  agentBaseUrl(agentKey: string): string {
    return `${this.fakeUrl}/r/${this.token}/a/${agentKey}/v1`;
  }

  usage(): MeterUsage {
    return { ...this.totals };
  }

  agentUsage(): MeterUsage {
    return this.usage();
  }

  agentKeys(): string[] {
    return ['assistant'];
  }

  /** The secrets the run registered for the request scan. */
  readonly secrets: string[] = [];

  addSecret(value: string): void {
    this.secrets.push(value);
  }

  summary(): MeterRunSummary {
    return {
      runId: this.runId,
      provider: this.provider,
      cache: this.cache,
      usage: this.usage(),
      replayedCostUsd: 0,
      apiEquivalentUsd: 0,
      rejects: {},
      agents: {},
      inflight: this.inflight,
    };
  }

  on(listener: (event: MeterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): MeterRunSummary {
    this.closeCalls++;
    this.closed = true;
    return this.summary();
  }

  // ---- test controls ----------------------------------------------------------------------

  emit(event: MeterEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** One model request of `agent`. Returns false when the run is closed (the meter refuses it). */
  record(agent: string, costUsd: number, tokens = { input: 100, output: 20 }): boolean {
    if (this.closed) {
      this.refused++;
      return false;
    }
    this.totals = {
      ...this.totals,
      requests: this.totals.requests + 1,
      inputTokens: this.totals.inputTokens + tokens.input,
      outputTokens: this.totals.outputTokens + tokens.output,
      costUsd: this.totals.costUsd + costUsd,
    };
    this.emit({
      type: 'usage',
      runId: this.runId,
      agent,
      request: {
        agent,
        kind: 'forward',
        status: 200,
        usage: {
          prompt: tokens.input,
          completion: tokens.output,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
        },
        costUsd,
        aborted: false,
        ms: 1,
      },
      agentUsage: this.usage(),
      runUsage: this.usage(),
    });
    return true;
  }

  /** An in-flight request finishes, even after the run was closed. */
  finish(costUsd: number): void {
    this.inflight--;
    this.totals = {
      ...this.totals,
      requests: this.totals.requests + 1,
      costUsd: this.totals.costUsd + costUsd,
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

/** A meter handle that opens `FakeMeterRun`s and has a real ledger in a temporary folder. */
export class FakeMeter implements MeterHandle {
  readonly url = 'http://127.0.0.1:41003';
  readonly home = mkdtempSync(join(tmpdir(), 'sa-fake-meter-'));
  readonly ledger = new Ledger(join(this.home, 'ledger'));
  readonly runs: FakeMeterRun[] = [];
  openError: Error | undefined;

  openRun(options: OpenRunOptions): FakeMeterRun {
    if (this.openError) throw this.openError;
    const run = new FakeMeterRun(options, this.url);
    this.runs.push(run);
    return run;
  }

  agentBaseUrl(runToken: string, agentKey: string): string {
    return `${this.url}/r/${runToken}/a/${agentKey}/v1`;
  }

  keyRemainingUsd(): number | undefined {
    return undefined;
  }

  async close(): Promise<void> {}

  get last(): FakeMeterRun {
    const run = this.runs.at(-1);
    if (!run) throw new Error('no meter run was opened');
    return run;
  }
}
