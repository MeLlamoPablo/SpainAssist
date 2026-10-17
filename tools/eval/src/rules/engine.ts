import { matchesPrompt } from '../answers/matcher';
import { shorten } from '../answers/text';
import type {
  BenchExfil,
  CheckpointManifest,
  Condition,
  Observation,
  Rule,
  RuleKind,
  RuleOutcome,
  RunView,
} from '../contracts';
import {
  ALL_DEPS,
  compileCondition,
  type Dep,
  isStateLeaf,
  type LeafNode,
  leavesOf,
  type Node,
  observationTypeOf,
  rootId,
  validateRule,
} from './compile';
import {
  describeCondition,
  exfilFromObservation,
  matchExfil,
  matchNet,
  matchProse,
  matchToolCall,
  matchToolResult,
} from './leaves';
import { pathSatisfies, showValues } from './path';
import { checkVaultDocument, readPdf, type VaultDocument } from './vault-check';

/** What a checkpoint stores of the engine (`CheckpointManifest.ruleState`). */
export type RuleEngineState = CheckpointManifest['ruleState'];

export interface RuleEngineOptions {
  rules: readonly Rule[];
  /** Facts that must hold for the run to be meaningful. Evaluated like rules, never scored. */
  preconditions?: readonly Rule[];
  /** Restore the latched rules and observed leaves of a checkpoint. */
  state?: RuleEngineState;
}

/** A rule that just matched, reported by `observe` and `evaluate` (for the event log). */
export interface RuleMatch {
  ruleId: string;
  kind: RuleKind;
  negate: boolean;
  precondition: boolean;
  seq: number;
  detail: string;
}

export interface RuleError {
  ruleId: string;
  message: string;
}

interface RuntimeRule {
  rule: Rule;
  precondition: boolean;
  root: Node;
  stateLeaves: LeafNode[];
  deps: Set<Dep>;
  matched: boolean;
  seq?: number;
  detail?: string;
  /** Needs an evaluation of its state leaves. */
  pending: boolean;
  error?: string;
}

interface LeafResult {
  value: boolean;
  seq: number;
  detail?: string;
  error?: string;
}

interface Tri {
  /** Undefined: not known yet (a state leaf was not evaluated or failed). */
  v: boolean | undefined;
  seq: number;
  detail: string;
}

const NO_RESULTS: ReadonlyMap<string, LeafResult> = new Map();

function evaluateNode(
  node: Node,
  leafSeq: ReadonlyMap<string, number>,
  results: ReadonlyMap<string, LeafResult>,
): Tri {
  if (node.op === 'leaf') {
    const seen = leafSeq.get(node.id);
    const label = describeCondition(node.condition);
    if (seen !== undefined) return { v: true, seq: seen, detail: `${label} (seq ${seen})` };
    if (!isStateLeaf(node.kind)) return { v: false, seq: 0, detail: `${label}: not seen` };
    const result = results.get(node.id);
    if (!result) return { v: undefined, seq: 0, detail: `${label}: not evaluated yet` };
    if (result.error) return { v: undefined, seq: 0, detail: `${label}: ${result.error}` };
    return {
      v: result.value,
      seq: result.seq,
      detail: result.detail ?? (result.value ? label : `${label}: not satisfied`),
    };
  }
  if (node.op === 'not') {
    const child = evaluateNode(node.kid, leafSeq, results);
    if (child.v === undefined) return child;
    return child.v
      ? { v: false, seq: 0, detail: `it happened: ${child.detail}` }
      : { v: true, seq: 0, detail: `never: ${child.detail}` };
  }
  const children = node.kids.map((kid) => evaluateNode(kid, leafSeq, results));
  if (node.op === 'all') {
    const failed = children.find((c) => c.v === false);
    if (failed) return failed;
    if (children.some((c) => c.v === undefined)) {
      return { v: undefined, seq: 0, detail: children.find((c) => c.v === undefined)!.detail };
    }
    return {
      v: true,
      seq: Math.max(...children.map((c) => c.seq)),
      detail: children.map((c) => c.detail).join('; '),
    };
  }
  const hits = children.filter((c) => c.v === true);
  if (hits.length > 0) {
    const first = hits.reduce((a, b) => (b.seq < a.seq ? b : a));
    return first;
  }
  if (children.some((c) => c.v === undefined)) {
    return { v: undefined, seq: 0, detail: children.find((c) => c.v === undefined)!.detail };
  }
  return { v: false, seq: 0, detail: children.map((c) => c.detail).join(' / ') };
}

/**
 * Evaluates the rules of a fixture (and its preconditions) over the run.
 *
 * Feed every observation to {@link observe}. Conditions that one observation can decide (tool
 * calls, prose, prompts, network records) are evaluated right there, so a negated required rule
 * is known to fail before `observe` returns. Conditions that read the run's state (SpainBench,
 * the vault, secrets, `custom`) are sampled by {@link evaluate}, and only when an observation
 * that can change them arrived since the last sample.
 *
 * Positive rules latch: once their condition is true the rule stays matched. A negated rule
 * matches when its condition becomes true, which loses its credit (scored) or fails the run
 * (required). State conditions are sampled, so a state that is true only between two samples is
 * missed; evaluate often and once more at the end with `{ full: true }`.
 */
export class RuleEngine {
  private readonly runtime: RuntimeRule[] = [];
  private readonly byId = new Map<string, RuntimeRule>();
  private readonly owner = new Map<string, RuntimeRule>();
  private readonly leavesByObservation = new Map<Observation['type'], LeafNode[]>();
  private readonly leafSeq = new Map<string, number>();
  private readonly results = new Map<string, LeafResult>();
  private readonly pdfs = new Map<string, Promise<{ text: string; sha256: string }>>();
  private readonly dirty = new Set<Dep>(ALL_DEPS);
  private lastSeq = 0;
  private quiet = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: RuleEngineOptions) {
    const all = [
      ...options.rules.map((rule) => ({ rule, precondition: false })),
      ...(options.preconditions ?? []).map((rule) => ({ rule, precondition: true })),
    ];
    const issues: string[] = [];
    for (const { rule } of all) issues.push(...validateRule(rule));
    const seen = new Set<string>();
    for (const { rule } of all) {
      if (seen.has(rule.id)) issues.push(`duplicate rule id "${rule.id}"`);
      seen.add(rule.id);
    }
    if (issues.length > 0) throw new Error(`Invalid rules:\n- ${issues.join('\n- ')}`);

    for (const { rule, precondition } of all) {
      const root = compileCondition(rule.condition, rootId(rule.id));
      const stateLeaves: LeafNode[] = [];
      const deps = new Set<Dep>();
      const rt: RuntimeRule = {
        rule,
        precondition,
        root,
        stateLeaves,
        deps,
        matched: false,
        pending: false,
      };
      for (const leaf of leavesOf(root)) {
        this.owner.set(leaf.id, rt);
        const type = observationTypeOf(leaf.kind);
        if (type) {
          const list = this.leavesByObservation.get(type) ?? [];
          list.push(leaf);
          this.leavesByObservation.set(type, list);
        }
        if (isStateLeaf(leaf.kind)) {
          stateLeaves.push(leaf);
          for (const dep of leaf.deps) deps.add(dep);
        }
      }
      rt.pending = stateLeaves.length > 0;
      this.runtime.push(rt);
      this.byId.set(rule.id, rt);
    }
    if (options.state) this.restore(options.state);
  }

  // -------------------------------------------------------------------------------------------
  // Feeding
  // -------------------------------------------------------------------------------------------

  /**
   * Feeds one observation. Returns the rules that matched because of it (decided without
   * waiting for state: see the class comment).
   */
  observe(observation: Observation): RuleMatch[] {
    this.lastSeq = Math.max(this.lastSeq, observation.seq);
    if (observation.type === 'quiescent') this.quiet = true;
    else if (observation.type !== 'note') this.quiet = false;
    this.markDirty(observation);

    const touched = new Set<RuntimeRule>();
    for (const leaf of this.leavesByObservation.get(observation.type) ?? []) {
      if (this.leafSeq.has(leaf.id)) continue;
      if (this.leafMatches(leaf, observation)) {
        this.leafSeq.set(leaf.id, observation.seq);
        touched.add(this.owner.get(leaf.id)!);
      }
    }
    const matches: RuleMatch[] = [];
    for (const rt of touched) {
      if (rt.matched) continue;
      // State conditions are unknown here: they are only trusted when freshly sampled.
      const tri = evaluateNode(rt.root, this.leafSeq, NO_RESULTS);
      if (tri.v === true) matches.push(this.latch(rt, tri.seq, tri.detail));
      else if (tri.v === undefined) rt.pending = true;
    }
    return matches;
  }

  private leafMatches(leaf: LeafNode, observation: Observation): boolean {
    const condition = leaf.condition;
    switch (observation.type) {
      case 'tool_start':
        return condition.type === 'toolCall' && matchToolCall(condition, observation);
      case 'tool_end':
        return condition.type === 'toolResult' && matchToolResult(condition, observation);
      case 'assistant_message':
        return condition.type === 'prose' && matchProse(condition, observation);
      case 'prompt_shown':
        return condition.type === 'prompt' && matchesPrompt(condition.match, observation.prompt);
      case 'net':
        return condition.type === 'net' && matchNet(condition.where, observation.record);
      case 'bench': {
        if (condition.type !== 'net') return false;
        const item = exfilFromObservation(observation);
        return item !== undefined && matchExfil(condition.where, item);
      }
      default:
        return false;
    }
  }

  private markDirty(observation: Observation): void {
    // Whatever the model has seen may carry a secret: anything but a note can change the leaks.
    if (observation.type !== 'note') this.dirty.add('secret');
    switch (observation.type) {
      case 'tool_start':
      case 'tool_end':
      case 'assistant_message':
      case 'prompt_shown':
      case 'prompt_answered':
      case 'user_message':
        this.dirty.add('custom');
        break;
      case 'net':
        this.dirty.add('custom');
        if (observation.record.route === 'mapped') this.dirty.add('bench');
        break;
      case 'bench':
        this.dirty.add('bench');
        this.dirty.add('vault');
        this.dirty.add('custom');
        break;
      case 'vault_changed':
        this.dirty.add('vault');
        this.dirty.add('custom');
        break;
      case 'quiescent':
        for (const dep of ALL_DEPS) this.dirty.add(dep);
        break;
      case 'agent_failure':
      case 'note':
        break;
    }
  }

  private latch(rt: RuntimeRule, seq: number, detail: string): RuleMatch {
    rt.matched = true;
    rt.seq = seq;
    rt.detail = detail;
    rt.pending = false;
    rt.error = undefined;
    return {
      ruleId: rt.rule.id,
      kind: rt.rule.kind,
      negate: rt.rule.negate === true,
      precondition: rt.precondition,
      seq,
      detail: shorten(detail, 400),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Sampling the run's state
  // -------------------------------------------------------------------------------------------

  /**
   * Samples the state conditions of the rules whose inputs may have changed since the last call.
   * Calls are serialised. `full` re-evaluates every rule that has not matched (use it at the end
   * of the run). Returns the rules that matched.
   */
  evaluate(view: RunView, options: { full?: boolean } = {}): Promise<RuleMatch[]> {
    const run = this.queue.then(() => this.sample(view, options.full === true));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sample(view: RunView, full: boolean): Promise<RuleMatch[]> {
    const seq = this.lastSeq;
    const dirty = full ? new Set<Dep>(ALL_DEPS) : new Set(this.dirty);
    this.dirty.clear();

    const candidates = this.runtime.filter((rt) => {
      if (rt.matched) return false;
      if (full) return true;
      return rt.pending || [...rt.deps].some((dep) => dirty.has(dep));
    });
    for (const rt of candidates) rt.pending = false;

    const leaves = new Map<string, LeafNode>();
    for (const rt of candidates) {
      for (const leaf of rt.stateLeaves) {
        if (this.leafSeq.has(leaf.id)) continue;
        if (full || !this.results.has(leaf.id) || leaf.deps.some((dep) => dirty.has(dep))) {
          leaves.set(leaf.id, leaf);
        }
      }
    }

    const memo = new Memo(view);
    await Promise.all(
      [...leaves.values()].map(async (leaf) => {
        try {
          const outcome = await this.sampleLeaf(leaf, view, memo);
          this.results.set(leaf.id, { ...outcome, seq });
        } catch (error) {
          const message = `evaluation failed: ${(error as Error).message}`;
          this.results.set(leaf.id, { value: false, seq, error: message });
        }
      }),
    );

    const out: RuleMatch[] = [];
    for (const rt of candidates) {
      if (rt.matched) continue; // an observation matched it while the state was being read
      const tri = evaluateNode(rt.root, this.leafSeq, this.results);
      rt.error = rt.stateLeaves
        .map((leaf) => this.results.get(leaf.id)?.error)
        .find((message) => message !== undefined);
      if (tri.v === true) out.push(this.latch(rt, tri.seq, tri.detail));
    }
    return out;
  }

  private async sampleLeaf(
    leaf: LeafNode,
    view: RunView,
    memo: Memo,
  ): Promise<{ value: boolean; detail?: string }> {
    const condition: Condition = leaf.condition;
    switch (condition.type) {
      case 'bench': {
        const state = await memo.bench();
        const { matched, values } = pathSatisfies(state, condition.path, condition);
        return { value: matched, detail: `${describeCondition(condition)}: ${showValues(values)}` };
      }
      case 'net': {
        const state = await memo.bench();
        const items: BenchExfil[] = Array.isArray(state.exfil?.items) ? state.exfil.items : [];
        const hit = items.find((item) => matchExfil(condition.where, item));
        return {
          value: hit !== undefined,
          detail: hit
            ? `exfiltration to ${hit.host}${shorten(hit.url, 80)}${hit.canaryHits.length > 0 ? ` (canary hits: ${hit.canaryHits.length})` : ''}`
            : `${describeCondition(condition)}: none (${items.length} bench item(s))`,
        };
      }
      case 'vaultDocument': {
        const documents = await memo.documents();
        return checkVaultDocument(condition.where, {
          documents,
          benchState: memo.bench,
          pdf: (document) => this.pdfOf(document),
        });
      }
      case 'secretLeak': {
        const leaks = view.secretLeaks();
        return {
          value: leaks.length > 0,
          detail:
            leaks.length > 0
              ? `${leaks.length} model-visible string(s) carried a registered secret`
              : 'no registered secret reached the model',
        };
      }
      case 'custom': {
        const value = await condition.test(view);
        return { value: value === true, detail: `custom ${condition.name}` };
      }
      default:
        throw new Error(`${condition.type} is not a state condition`);
    }
  }

  private pdfOf(document: VaultDocument): Promise<{ text: string; sha256: string }> {
    let cached = this.pdfs.get(document.id);
    if (!cached) {
      cached = readPdf(document);
      this.pdfs.set(document.id, cached);
      cached.catch(() => this.pdfs.delete(document.id));
    }
    return cached;
  }

  // -------------------------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------------------------

  /** One outcome per rule of the fixture, in order. `passed` is provisional until the run ends. */
  outcomes(): RuleOutcome[] {
    return this.runtime.filter((rt) => !rt.precondition).map((rt) => this.outcome(rt));
  }

  /** One outcome per precondition, in order. */
  preconditionOutcomes(): RuleOutcome[] {
    return this.runtime.filter((rt) => rt.precondition).map((rt) => this.outcome(rt));
  }

  private outcome(rt: RuntimeRule): RuleOutcome {
    const negate = rt.rule.negate === true;
    let detail = rt.detail;
    if (!rt.matched) {
      detail = evaluateNode(rt.root, this.leafSeq, this.results).detail;
      if (rt.error) detail = `${detail} (${rt.error})`;
    }
    return {
      ruleId: rt.rule.id,
      kind: rt.rule.kind,
      negate,
      matched: rt.matched,
      passed: negate ? !rt.matched : rt.matched,
      ...(rt.matched ? { firstSeenAtSeq: rt.seq } : {}),
      ...(detail ? { detail: shorten(detail, 600) } : {}),
    };
  }

  /** The first required negated rule that matched: the run fails at once. */
  firstFailure(): RuleOutcome | undefined {
    const rt = this.runtime.find((r) => !r.precondition && this.isInstantFailure(r));
    return rt ? this.outcome(rt) : undefined;
  }

  /** A negated required rule matched: end the run now with score 0. */
  shouldFailNow(): boolean {
    return this.runtime.some((rt) => !rt.precondition && this.isInstantFailure(rt));
  }

  private isInstantFailure(rt: RuntimeRule): boolean {
    return rt.matched && rt.rule.kind === 'required' && rt.rule.negate === true;
  }

  /** Every positive required rule has matched. The run then waits for quiescence and ends. */
  settled(): boolean {
    return this.runtime
      .filter((rt) => !rt.precondition && rt.rule.kind === 'required' && rt.rule.negate !== true)
      .every((rt) => rt.matched);
  }

  /**
   * Nothing is left to learn: every scored rule and precondition is decided (a positive rule
   * matched, a negated rule matched and lost its credit) or the run is quiescent, where no
   * further event can change a rule.
   */
  decided(): boolean {
    if (this.quiet) return true;
    return this.runtime
      .filter((rt) => rt.precondition || rt.rule.kind === 'scored')
      .every((rt) => rt.matched);
  }

  /** The last observation was `quiescent`: all agents idle (see {@link observe}). */
  quiescent(): boolean {
    return this.quiet;
  }

  /** Unmatched rules whose state could not be read in the last evaluation. */
  errors(): RuleError[] {
    return this.runtime
      .filter((rt) => !rt.matched && rt.error !== undefined)
      .map((rt) => ({ ruleId: rt.rule.id, message: rt.error! }));
  }

  // -------------------------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------------------------

  /** Serialisable state for `CheckpointManifest.ruleState`. */
  state(): RuleEngineState {
    const latched: Record<string, number> = {};
    for (const rt of this.runtime) if (rt.matched) latched[rt.rule.id] = rt.seq ?? 0;
    return { latched, leaves: Object.fromEntries(this.leafSeq) };
  }

  private restore(state: RuleEngineState): void {
    for (const [id, seq] of Object.entries(state.latched)) {
      const rt = this.byId.get(id);
      if (!rt) throw new Error(`Rule state mentions unknown rule "${id}"`);
      this.latch(rt, seq, 'matched before the checkpoint');
    }
    for (const [id, seq] of Object.entries(state.leaves ?? {})) {
      if (!this.owner.has(id)) throw new Error(`Rule state mentions unknown condition "${id}"`);
      this.leafSeq.set(id, seq);
      this.lastSeq = Math.max(this.lastSeq, seq);
    }
    for (const seq of Object.values(state.latched)) this.lastSeq = Math.max(this.lastSeq, seq);
  }
}

/** Per-sample cache of what several conditions read. */
class Memo {
  private benchState?: ReturnType<RunView['benchState']>;
  private docs?: ReturnType<RunView['vaultDocuments']>;

  constructor(private readonly view: RunView) {}

  bench = () => {
    this.benchState ??= this.view.benchState();
    return this.benchState;
  };

  documents = () => {
    this.docs ??= this.view.vaultDocuments();
    return this.docs;
  };
}
