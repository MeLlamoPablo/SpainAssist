import type {
  AgentKind,
  BenchDownload,
  BenchWorldState,
  NetRecord,
  Observation,
  PendingPrompt,
  RunView,
} from '../../../src/contracts';

/** Observation fields the helpers fill in. */
type Draft<T> = T extends unknown ? Omit<T, 'seq' | 't'> : never;
export type ObservationDraft = Draft<Observation>;

export function emptyBench(overrides: Partial<BenchWorldState> = {}): BenchWorldState {
  return {
    id: 'run-test',
    sites: {},
    downloads: [],
    wrongTurns: { count: 0, items: [] },
    exfil: { count: 0, items: [] },
    plantsServed: [],
    counters: { seq: 0, requests: 0 },
    ...overrides,
  };
}

export function segSocialState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authenticated: false,
    loginMethod: null,
    document: null,
    failedLogins: 0,
    cookieConsent: null,
    filter: null,
    downloads: [],
    ...overrides,
  };
}

export function download(
  csv: string,
  overrides: { record?: Record<string, unknown>; sha256?: string; site?: string } = {},
): BenchDownload {
  return {
    site: overrides.site ?? 'seg-social-es',
    filename: 'vida_laboral.pdf',
    contentType: 'application/pdf',
    bytes: 1000,
    sha256: overrides.sha256 ?? 'f'.repeat(64),
    at: '2026-10-16T10:00:00.000Z',
    record: {
      report: 'completa',
      filter: null,
      employers: ['A', 'B'],
      totalDays: 3851,
      csv,
      ...overrides.record,
    },
  };
}

export interface FakeDocument {
  id: string;
  name: string;
  mimeType: string;
  source?: string;
  procedureId?: string;
  bytes: Uint8Array;
  /** The next reads fail with this many errors before succeeding. */
  failReads?: number;
}

/** An in-memory run: the observation list plus the state the rules read, with call counters. */
export class FakeRun {
  readonly list: Observation[] = [];
  bench: BenchWorldState = emptyBench();
  documents: FakeDocument[] = [];
  leaks: string[] = [];
  benchCalls = 0;
  documentCalls = 0;
  reads = 0;
  secretCalls = 0;
  benchError?: Error;
  private seq = 0;

  push(draft: ObservationDraft): Observation {
    const observation = { ...draft, seq: ++this.seq, t: '2026-10-16T10:00:00.000Z' } as Observation;
    this.list.push(observation);
    return observation;
  }

  get lastSeq(): number {
    return this.seq;
  }

  view(): RunView {
    return {
      observations: () => this.list,
      benchState: async () => {
        this.benchCalls++;
        if (this.benchError) throw this.benchError;
        return structuredClone(this.bench);
      },
      vaultDocuments: async () => {
        this.documentCalls++;
        return this.documents.map((doc) => ({
          id: doc.id,
          name: doc.name,
          mimeType: doc.mimeType,
          source: doc.source,
          procedureId: doc.procedureId,
          read: async () => {
            this.reads++;
            if (doc.failReads) {
              doc.failReads--;
              throw new Error('vault is locked');
            }
            return doc.bytes;
          },
        }));
      },
      secretLeaks: () => {
        this.secretCalls++;
        return this.leaks;
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Observation drafts
// ---------------------------------------------------------------------------------------------

export const toolStart = (
  agent: AgentKind,
  tool: string,
  args: unknown = {},
  toolCallId = `${tool}-1`,
): ObservationDraft => ({ type: 'tool_start', agent, tool, args, toolCallId });

export const toolEnd = (
  agent: AgentKind,
  tool: string,
  text = 'ok',
  isError = false,
  toolCallId = `${tool}-1`,
): ObservationDraft => ({ type: 'tool_end', agent, tool, text, isError, toolCallId });

export const say = (agent: AgentKind, text: string): ObservationDraft => ({
  type: 'assistant_message',
  agent,
  text,
});

export function prompt(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    itemId: 'item-1',
    agent: 'procedure',
    procedureId: 'p_1',
    kind: 'form',
    title: 'Pregunta',
    ...overrides,
  };
}

export const promptShown = (overrides: Partial<PendingPrompt> = {}): ObservationDraft => ({
  type: 'prompt_shown',
  prompt: prompt(overrides),
});

export function netRecord(overrides: Partial<NetRecord> = {}): NetRecord {
  return {
    seq: 1,
    t: '2026-10-16T10:00:00.000Z',
    worldId: 'run-test',
    channel: 'browser',
    method: 'GET',
    url: 'https://portal.seg-social.gob.es/',
    host: 'portal.seg-social.gob.es',
    route: 'mapped',
    reqHeaders: {},
    durationMs: 5,
    ...overrides,
  };
}

export const net = (overrides: Partial<NetRecord> = {}): ObservationDraft => ({
  type: 'net',
  record: netRecord(overrides),
});

export const benchEvent = (
  what: 'wrong_turn' | 'exfil' | 'download' | 'submission',
  data: unknown = {},
): ObservationDraft => ({ type: 'bench', what, data });
