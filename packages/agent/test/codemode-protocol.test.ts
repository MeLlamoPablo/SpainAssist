/**
 * Formal verification of the codemode workflow protocol (docs/codemode.md): bounded explicit-
 * state model checking of main's and the hosts' rules (helpers/protocol-model.ts), then a
 * randomized check of the same properties on the real runtime.
 */
import { describe, expect, it } from 'vitest';
import { findNode, handlerOf, MemoryStore, startRun, until } from './helpers/codemode';
import { check, FIXED, ORIGINAL } from './helpers/protocol-model';

describe('the workflow protocol (model checking)', () => {
  it('keeps every property in every reachable state, with crashes, restarts, lost runs and concurrent updates', () => {
    const result = check(FIXED, { crashes: 2, restarts: 1, zombies: 1, bumps: 1 });
    expect(result.violations).toEqual([]);
    // The size of what was checked (reported in docs/codemode.md).
    expect(result.states).toBeGreaterThan(100_000);
  });

  it('finds the stuck workflow of the original rules: a run lost by its host and never resumed', () => {
    const result = check(ORIGINAL);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toEqual({
      property: 'the workflow can never end',
      trace: ['codemode 0', 'zombie 0'],
    });
    // Waiting for the user, the same loss leaves the interface unanswerable.
    const stuckUi = result.violations.find((v) => v.property.includes('open interface'));
    expect(stuckUi?.trace).toContain('zombie 0');
  });
});

/** A small deterministic PRNG, so a failing case can be replayed from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random workflow: groups of memoized steps run in parallel (Promise.all) with random host
 * latencies, interfaces between groups. Every memoized function counts its executions in a host
 * ledger; the run is cancelled ("the app quits") at a random point and resumed from what the
 * store kept, until it ends.
 */
function program(random: () => number): { source: string; keys: string[]; uis: string[] } {
  const groups = 1 + Math.floor(random() * 3);
  const keys: string[] = [];
  const uis: string[] = [];
  const lines: string[] = [];
  for (let g = 0; g < groups; g++) {
    const size = 1 + Math.floor(random() * 3);
    const group: string[] = [];
    for (let i = 0; i < size; i++) {
      const key = `k${g}_${i}`;
      keys.push(key);
      group.push(`api.state.memo('${key}', () => api.search('${key}'))`);
    }
    lines.push(`  out.push(...(await Promise.all([${group.join(', ')}])));`);
    if (random() < 0.6) {
      const ui = `q${g}`;
      uis.push(ui);
      lines.push(
        `  out.push(await api.ui.present('${ui}', () => <Button onClick={() => api.ui.close('${ui}-answer')}>OK</Button>));`,
      );
    }
  }
  return {
    source: `import { Button } from '@spainassist/ui';\nexport async function main(api) {\n  const out = [];\n${lines.join('\n')}\n  return out;\n}`,
    keys,
    uis,
  };
}

describe('the runtime under random crashes (property)', () => {
  it('never recomputes a stored value, never asks an answered question again, and ends with the same result as a run without crashes', async () => {
    const CASES = 60;
    for (let seed = 1; seed <= CASES; seed++) {
      const random = rng(seed);
      const { source, keys, uis } = program(random);
      const executions = new Map<string, number>();
      const shown = new Map<string, number>();
      const store = new MemoryStore();
      let outcome: Awaited<ReturnType<typeof startRun>['done']> | undefined;
      let restarts = 0;
      while (!outcome) {
        const started = startRun(source, {
          store,
          call: async (_op, args) => {
            const key = (args as { prompt: string }).prompt;
            executions.set(key, (executions.get(key) ?? 0) + 1);
            await new Promise((r) => setTimeout(r, Math.floor(random() * 4)));
            return `value-of-${key}`;
          },
        });
        const crashAfter =
          random() < 0.5 && restarts < 4 ? Math.floor(random() * 6) : Number.POSITIVE_INFINITY;
        let steps = 0;
        for (;;) {
          const settled = await Promise.race([
            started.done,
            new Promise<null>((r) => setTimeout(() => r(null), 3)),
          ]);
          if (settled) {
            outcome = settled;
            break;
          }
          const open = started.run.openUis();
          for (const key of open) {
            const tree = started.store.trees.get(key);
            if (!tree) continue;
            shown.set(key, (shown.get(key) ?? 0) + 1);
            if (steps >= crashAfter) break;
            started.run.dispatch(key, {
              handler: handlerOf(findNode(tree.tree, 'Button'), 'onClick'),
              rev: tree.rev,
            });
            await until(
              () =>
                !started.run.openUis().includes(key) ||
                started.store.state.ui[key]?.status === 'closed',
            );
          }
          if (++steps >= crashAfter) {
            started.run.cancel('The app quit');
            await started.done;
            restarts++;
            break;
          }
        }
      }
      expect(outcome.status, `seed ${seed}`).toBe('succeeded');
      if (outcome.status !== 'succeeded') continue;
      const expected = keys.reduce<string[]>((acc, key) => {
        acc.push(`value-of-${key}`);
        const group = key.split('_')[0]?.slice(1);
        const last = keys.filter((k) => k.startsWith(`k${group}_`)).at(-1);
        if (key === last && uis.includes(`q${group}`)) acc.push(`q${group}-answer`);
        return acc;
      }, []);
      expect(JSON.parse(outcome.value ?? '[]'), `seed ${seed}`).toEqual(expected);
      for (const key of keys) {
        // At most once per run that was interrupted while the value was not stored yet.
        expect(executions.get(key) ?? 0, `seed ${seed} key ${key}`).toBeGreaterThanOrEqual(1);
        expect(executions.get(key) ?? 0, `seed ${seed} key ${key}`).toBeLessThanOrEqual(
          1 + restarts,
        );
        expect(store.state.memo[key], `seed ${seed} key ${key}`).toEqual({
          value: `value-of-${key}`,
        });
      }
      // Answered questions come from the store on every later run: never shown again.
      for (const ui of uis)
        expect(store.state.ui[ui], `seed ${seed} ui ${ui}`).toEqual({
          status: 'closed',
          result: `${ui}-answer`,
        });
    }
  }, 120_000);
});
