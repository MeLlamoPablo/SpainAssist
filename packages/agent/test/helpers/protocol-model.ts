/**
 * An explicit-state model of the codemode workflow protocol (docs/codemode.md, "Formal
 * verification"): main's WorkflowService and the agent hosts' WorkflowEngine as transition rules,
 * over one workflow
 *
 *   read procedure → memo "a" (a search) → ui "q" (the user answers) → memo "b" (a submission,
 *   the effect that must not repeat) → update procedure → end
 *
 * run by two agent processes (the one that started it and one that could take it over), with
 * the user acting on the interface, and bounded faults: a process crash, an app restart, a run
 * that dies without telling main (a "zombie"), and someone else changing the procedure.
 *
 * `rules` switches the two protocol fixes the model checker motivated: hosts look for workflows
 * to resume while they run (not only when they start), and main ends runs that stopped polling.
 */

export interface Rules {
  /** Hosts resume waiting workflows periodically, not only at startup. */
  periodicResume: boolean;
  /** Main treats a run that stopped polling as ended. */
  staleRuns: boolean;
}

export const FIXED: Rules = { periodicResume: true, staleRuns: true };
export const ORIGINAL: Rules = { periodicResume: false, staleRuns: false };

type Status = 'none' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'interrupted';
const PROGRAM = ['read', 'memo:a', 'ui:q', 'memo:b', 'update', 'end'] as const;

interface HostRun {
  id: number;
  pc: number;
  /** effect: the memo's function ran, its value is not stored yet. */
  phase: 'idle' | 'effect' | 'waitUi';
  readVersion: number | null;
}

interface Agent {
  alive: boolean;
  /** The process just started and has not looked for workflows to resume yet. */
  booting: boolean;
  run: HostRun | null;
}

export interface State {
  status: Status;
  memo: string[];
  ui: 'none' | 'open' | 'closed';
  /** main's live run: its id and the agent it belongs to. */
  live: { id: number; agent: number } | null;
  /** The user's events queued for the live run (saturating at 2). */
  runEvents: number;
  /** Events while no run is live (saturating at 2). */
  detached: number;
  version: number;
  agents: [Agent, Agent];
  // Ledger for the properties.
  exec: Record<string, number>;
  faultsDuringEffect: Record<string, number>;
  reopened: boolean;
  updatesApplied: number;
  overwrote: boolean;
  // Fault budgets and counters.
  crashes: number;
  restarts: number;
  zombies: number;
  bumps: number;
  nextRun: number;
}

export interface Transition {
  label: string;
  fault: boolean;
  next: State;
}

function initial(): State {
  return {
    status: 'none',
    memo: [],
    ui: 'none',
    live: null,
    runEvents: 0,
    detached: 0,
    version: 0,
    agents: [
      { alive: true, booting: false, run: null },
      { alive: false, booting: false, run: null },
    ],
    exec: { a: 0, b: 0 },
    faultsDuringEffect: { a: 0, b: 0 },
    reopened: false,
    updatesApplied: 0,
    overwrote: false,
    crashes: 0,
    restarts: 0,
    zombies: 0,
    bumps: 0,
    nextRun: 1,
  };
}

const clone = (s: State): State => structuredClone(s);
const sat = (n: number) => Math.min(2, n);

/** main: `WorkflowService.begin` from agent `i` (the agent's tool call or its resume). */
function begin(s: State, i: number, resume: boolean): State | null {
  const n = clone(s);
  if (n.live) {
    const owner = n.agents[n.live.agent];
    // A live run whose agent's process is alive is never taken over.
    if (owner?.alive) return null;
    n.live = null;
    n.runEvents = 0;
  }
  const id = n.nextRun++;
  n.live = { id, agent: i };
  // Events the user caused while no run was live go to this run (begin moves them).
  n.runEvents = sat(n.runEvents + n.detached);
  n.detached = 0;
  n.status = n.ui === 'open' ? 'waiting' : 'running';
  const agent = n.agents[i] as Agent;
  agent.run = { id, pc: 0, phase: 'idle', readVersion: null };
  if (resume) agent.booting = false;
  return n;
}

/** main: `detachAgent` when agent `i`'s process ends. */
function processGone(n: State, i: number): void {
  const agent = n.agents[i] as Agent;
  const run = agent.run;
  if (run?.phase === 'effect') {
    const key = (PROGRAM[run.pc] as string).split(':')[1] as string;
    n.faultsDuringEffect[key] = (n.faultsDuringEffect[key] ?? 0) + 1;
  }
  agent.alive = false;
  agent.booting = false;
  agent.run = null;
  if (n.live?.agent === i) {
    n.live = null;
    n.runEvents = 0;
    if (n.status === 'running') n.status = 'interrupted';
  }
}

function hostRunIsLive(s: State, i: number): boolean {
  const run = s.agents[i]?.run;
  return !!run && s.live?.id === run.id;
}

export function transitions(
  s: State,
  rules: Rules,
  bounds = { crashes: 1, restarts: 1, zombies: 1, bumps: 1 },
): Transition[] {
  const out: Transition[] = [];
  const push = (label: string, next: State | null, fault = false) => {
    if (next) out.push({ label, fault, next });
  };
  const terminal = s.status === 'succeeded' || s.status === 'failed';

  for (const i of [0, 1]) {
    const agent = s.agents[i] as Agent;
    // The coordinator or the user's event wakes the agent (AgentManager.wake/send).
    if (!agent.alive) {
      const n = clone(s);
      (n.agents[i] as Agent).alive = true;
      (n.agents[i] as Agent).booting = true;
      push(`wake ${i}`, n);
      continue;
    }
    // The agent's model starts (or re-runs) the workflow with its codemode tool. Agent 1 only
    // takes over a workflow that stopped.
    if (
      !agent.run &&
      !terminal &&
      (i === 0 ? s.status === 'none' || s.status === 'interrupted' : s.status === 'interrupted')
    ) {
      push(`codemode ${i}`, begin(s, i, false));
    }
    // The host resumes waiting workflows (engine.resumeAll): at startup, and periodically.
    if (
      !agent.run &&
      s.status === 'waiting' &&
      !s.live &&
      (agent.booting || rules.periodicResume)
    ) {
      push(`resume ${i}`, begin(s, i, true));
    }
    if (agent.booting && !(s.status === 'waiting' && !s.live)) {
      const n = clone(s);
      (n.agents[i] as Agent).booting = false;
      push(`boot-done ${i}`, n);
    }

    const run = agent.run;
    if (run && hostRunIsLive(s, i)) {
      const op = PROGRAM[run.pc] as string;
      const n = clone(s);
      const r = (n.agents[i] as Agent).run as HostRun;
      if (op === 'read') {
        r.readVersion = n.version;
        r.pc++;
        push(`read ${i}`, n);
      } else if (op.startsWith('memo:')) {
        const key = op.slice(5);
        if (r.phase === 'effect') {
          // Stored before the workflow continues (`workflow.memo` resolves after the write).
          n.memo = [...new Set([...n.memo, key])].sort();
          r.phase = 'idle';
          r.pc++;
          push(`persist ${key} ${i}`, n);
        } else if (n.memo.includes(key)) {
          r.pc++;
          push(`replay ${key} ${i}`, n);
        } else {
          n.exec[key] = (n.exec[key] ?? 0) + 1;
          r.phase = 'effect';
          push(`effect ${key} ${i}`, n);
        }
      } else if (op.startsWith('ui:')) {
        if (n.ui === 'closed') {
          r.pc++;
          push(`replay-ui ${i}`, n);
        } else if (r.phase !== 'waitUi') {
          n.ui = 'open';
          n.status = 'waiting';
          r.phase = 'waitUi';
          push(`open-ui ${i}`, n);
        } else if (n.runEvents > 0) {
          // The poll delivers the event, the handler closes the interface.
          n.runEvents = 0;
          n.ui = 'closed';
          n.status = 'running';
          r.phase = 'idle';
          r.pc++;
          push(`dispatch ${i}`, n);
        }
      } else if (op === 'update') {
        if (r.readVersion === n.version) {
          n.version++;
          n.updatesApplied++;
          r.pc++;
          push(`update ${i}`, n);
        } else {
          // `conflict`: the workflow fails and the agent re-reads (never overwrites).
          n.status = 'failed';
          n.live = null;
          (n.agents[i] as Agent).run = null;
          push(`conflict ${i}`, n);
        }
      } else if (op === 'end') {
        n.status = 'succeeded';
        if (n.ui === 'open') n.ui = 'closed';
        n.live = null;
        n.runEvents = 0;
        (n.agents[i] as Agent).run = null;
        push(`end ${i}`, n);
      }
    }

    // Faults.
    if (s.crashes < bounds.crashes) {
      const n = clone(s);
      n.crashes++;
      processGone(n, i);
      push(`crash ${i}`, n, true);
    }
    if (run && s.zombies < bounds.zombies) {
      // The run dies in the host and its `workflow.end` never reaches main.
      const n = clone(s);
      n.zombies++;
      const r = (n.agents[i] as Agent).run as HostRun;
      if (r.phase === 'effect') {
        const key = (PROGRAM[r.pc] as string).split(':')[1] as string;
        n.faultsDuringEffect[key] = (n.faultsDuringEffect[key] ?? 0) + 1;
      }
      (n.agents[i] as Agent).run = null;
      push(`zombie ${i}`, n, true);
    }
  }

  // The user acts on the open interface (renderer → main's userEvent).
  if (s.ui === 'open') {
    const n = clone(s);
    if (n.live) n.runEvents = sat(n.runEvents + 1);
    else n.detached = sat(n.detached + 1);
    push('act', n);
  }

  // main notices a run that stopped polling (`staleRuns`): only zombies stop polling.
  if (rules.staleRuns && s.live) {
    const owner = s.agents[s.live.agent] as Agent;
    if (owner.run?.id !== s.live.id) {
      const n = clone(s);
      n.live = null;
      n.detached = sat(n.detached + n.runEvents);
      n.runEvents = 0;
      if (n.status === 'running') n.status = 'interrupted';
      push('stale', n);
    }
  }

  if (s.restarts < bounds.restarts) {
    // The app quits and starts again: processes and memory go, records stay.
    const n = clone(s);
    n.restarts++;
    for (const i of [0, 1]) if (n.agents[i]?.alive) processGone(n, i);
    n.detached = 0;
    if (n.status === 'running') n.status = 'interrupted';
    push('restart', n, true);
  }
  if (s.bumps < bounds.bumps) {
    const n = clone(s);
    n.bumps++;
    n.version++;
    push('someone-else-updates', n, true);
  }
  return out;
}

interface Violation {
  property: string;
  trace: string[];
}

export interface CheckResult {
  states: number;
  transitions: number;
  violations: Violation[];
}

/** Safety properties, checked on every reachable state. */
function safety(s: State): string | null {
  // Exactly once, modulo a fault while the effect ran: a stored value is never recomputed.
  for (const key of ['a', 'b'])
    if ((s.exec[key] ?? 0) > 1 + (s.faultsDuringEffect[key] ?? 0))
      return `memo "${key}" ran again after its value was stored`;
  if (s.reopened) return 'a closed interface opened again';
  const runs = s.agents.filter(
    (a, i) => a.run && s.live?.id === a.run.id && hostRunIsLive(s, i),
  ).length;
  if (runs > 1) return 'two live runs of one workflow';
  if ((s.status === 'succeeded' || s.status === 'failed') && s.ui === 'open')
    return 'a finished workflow still shows its interface';
  if (s.status === 'waiting' && s.ui !== 'open')
    return 'waiting for the user with nothing on screen';
  return null;
}

function key(s: State): string {
  return JSON.stringify(s);
}

/**
 * Explores every reachable state (BFS) and checks safety on each, then liveness on the graph:
 * from every state, without any further fault, (1) an open interface can be answered and the
 * workflow continue, and (2) the workflow can reach an end. Returns violations with traces.
 */
export function check(rules: Rules, bounds?: Parameters<typeof transitions>[2]): CheckResult {
  const start = initial();
  const index = new Map<string, number>([[key(start), 0]]);
  const states: State[] = [start];
  const parent: { from: number; label: string }[] = [{ from: -1, label: 'start' }];
  const edges: { to: number; fault: boolean }[][] = [];
  const violations: Violation[] = [];
  /** The first (shortest, BFS) counterexample of each property. */
  const report = (property: string, at: number) => {
    if (!violations.some((v) => v.property === property))
      violations.push({ property, trace: trace(at) });
  };
  let transitionsCount = 0;
  const trace = (i: number): string[] => {
    const out: string[] = [];
    for (let at = i; at > 0; at = parent[at]?.from ?? -1) out.unshift(parent[at]?.label ?? '?');
    return out;
  };
  for (let i = 0; i < states.length; i++) {
    const s = states[i] as State;
    const problem = safety(s);
    if (problem) report(problem, i);
    const out: { to: number; fault: boolean }[] = [];
    for (const t of transitions(s, rules, bounds)) {
      transitionsCount++;
      if (s.ui === 'closed' && t.next.ui === 'open') t.next.reopened = true;
      const k = key(t.next);
      let to = index.get(k);
      if (to === undefined) {
        to = states.length;
        index.set(k, to);
        states.push(t.next);
        parent.push({ from: i, label: t.label });
      }
      out.push({ to, fault: t.fault });
    }
    edges.push(out);
  }

  // Liveness: backward reachability over fault-free edges.
  const canReach = (goal: (s: State) => boolean): boolean[] => {
    const reach = states.map(goal);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < states.length; i++) {
        if (reach[i]) continue;
        if ((edges[i] ?? []).some((e) => !e.fault && reach[e.to])) {
          reach[i] = true;
          changed = true;
        }
      }
    }
    return reach;
  };
  const answered = canReach((s) => s.ui === 'closed');
  const ends = canReach((s) => s.status === 'succeeded' || s.status === 'failed');
  for (let i = 0; i < states.length; i++) {
    const s = states[i] as State;
    if (!ends[i]) report('the workflow can never end', i);
    if (s.ui === 'open' && !answered[i])
      report('the user can never get the open interface answered (stuck)', i);
  }
  return { states: states.length, transitions: transitionsCount, violations };
}
