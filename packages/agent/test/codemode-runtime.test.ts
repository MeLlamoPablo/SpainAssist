import { UI_FAILED } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { HostOpError } from '../src/codemode/workflow-run';
import { findNode, handlerOf, MemoryStore, startRun, until } from './helpers/codemode';

describe('codemode runtime', () => {
  it('runs a module and returns main’s value as JSON', async () => {
    const { done, calls } = startRun(`
      export async function main(api) {
        const answer = await api.search({ mode: 'fast', prompt: '¿Modelo 100?' });
        console.log('got', answer.echo);
        return { answer, n: [1, 2, 3].map((x) => x * 2) };
      }
    `);
    const outcome = await done;
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(JSON.parse(outcome.value ?? '')).toEqual({
      answer: { echo: 'search', args: { mode: 'fast', prompt: '¿Modelo 100?' } },
      n: [2, 4, 6],
    });
    expect(outcome.logs).toEqual(['got search']);
    expect(calls).toEqual([{ op: 'search', args: { mode: 'fast', prompt: '¿Modelo 100?' } }]);
  });

  it('reports syntax errors with the line', async () => {
    const outcome = await startRun('export async function main(api) {\n  return (\n}').done;
    expect(outcome).toMatchObject({ status: 'failed', code: 'syntax' });
    if (outcome.status === 'failed') expect(outcome.error).toMatch(/SyntaxError/);
  });

  it('passes host errors to the workflow as CodemodeError with code and effect', async () => {
    const outcome = await startRun(
      `export async function main(api) {
        try { await api.vault.read(); } catch (e) {
          return { name: e.name, code: e.code, effect: e.effect, op: e.op, retryable: e.retryable, message: e.message };
        }
      }`,
      {
        call: async () => {
          throw new HostOpError('policy_denied', 'No.', 'not_started', false);
        },
      },
    ).done;
    expect(outcome.status).toBe('succeeded');
    if (outcome.status === 'succeeded')
      expect(JSON.parse(outcome.value ?? '')).toEqual({
        name: 'CodemodeError',
        code: 'policy_denied',
        effect: 'not_started',
        op: 'vault.read',
        retryable: false,
        message: 'No.',
      });
  });

  it('memoizes by key: a resumed run reuses stored values and skips the work', async () => {
    const source = `export async function main(api) {
      const offices = await api.state.memo('offices', () => api.search('oficinas'));
      const again = await api.state.memo('offices', () => { throw new Error('never'); });
      return { offices, same: JSON.stringify(offices) === JSON.stringify(again) };
    }`;
    const first = startRun(source);
    const one = await first.done;
    expect(one.status).toBe('succeeded');
    expect(first.calls.map((c) => c.op)).toEqual(['search']);
    expect(first.store.state.memo.offices).toBeDefined();

    const second = startRun(source, { store: first.store });
    const two = await second.done;
    expect(second.calls).toEqual([]);
    expect(two.status === 'succeeded' && two.value).toEqual(
      one.status === 'succeeded' && one.value,
    );
  });

  it('dedupes concurrent memo calls and keeps Promise.all replay-safe', async () => {
    let n = 0;
    const source = `export async function main(api) {
      const [a, b, c] = await Promise.all([
        api.state.memo('x', () => api.search('x')),
        api.state.memo('x', () => api.search('x')),
        api.state.memo('y', () => api.search('y')),
      ]);
      return [a.n, b.n, c.n];
    }`;
    const first = startRun(source, { call: async () => ({ n: ++n }) });
    const one = await first.done;
    expect(one.status === 'succeeded' && JSON.parse(one.value ?? '')).toEqual([1, 1, 2]);
    // Completion order changes on replay (y first); keys, not positions, decide.
    const second = startRun(source, { store: first.store, call: async () => ({ n: ++n }) });
    const two = await second.done;
    expect(two.status === 'succeeded' && JSON.parse(two.value ?? '')).toEqual([1, 1, 2]);
    expect(n).toBe(2);
  });

  it('refuses values that would not survive a restart', async () => {
    const outcome = await startRun(`export async function main(api) {
      await api.state.memo('bad', async () => ({ f: () => 1 }));
    }`).done;
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toMatch(/JSON-serializable/);
  });

  it('presents an interface, re-renders on state changes and resolves on close', async () => {
    const started = startRun(`
      import { Form, TextField, Actions, Button } from '@spainassist/ui';
      function Income({ api }) {
        const [income, setIncome] = api.ui.useDurableState('income', '');
        return (
          <Form title="¿Cuánto ganaste en 2026?">
            <TextField label="Ingresos" value={income} onChange={setIncome} />
            <Actions>
              <Button type="primary" disabled={!income} onClick={() => api.ui.close({ income: Number(income) })}>Seguir</Button>
            </Actions>
          </Form>
        );
      }
      export async function main(api) {
        const answer = await api.ui.present('income', () => <Income api={api} />);
        return answer;
      }
    `);
    const { run, store } = started;
    await until(() => store.trees.has('income'));
    let tree = store.trees.get('income');
    const button = findNode(tree?.tree, 'Button', 'Seguir');
    expect(button?.props.disabled).toBe(true);
    expect(run.openUis()).toEqual(['income']);

    const field = findNode(tree?.tree, 'TextField');
    expect(
      run.dispatch('income', {
        handler: handlerOf(field, 'onChange'),
        rev: tree?.rev ?? 0,
        value: '21000',
      }),
    ).toBe('ok');
    await until(() => (store.trees.get('income')?.rev ?? 0) > (tree?.rev ?? 0));
    tree = store.trees.get('income');
    expect(findNode(tree?.tree, 'TextField')?.props.value).toBe('21000');
    expect(findNode(tree?.tree, 'Button', 'Seguir')?.props.disabled).toBe(false);
    expect(store.state.ui.income?.durable).toEqual({ income: '21000' });

    run.dispatch('income', {
      handler: handlerOf(findNode(tree?.tree, 'Button', 'Seguir'), 'onClick'),
      rev: tree?.rev ?? 0,
    });
    const outcome = await started.done;
    expect(outcome.status === 'succeeded' && JSON.parse(outcome.value ?? '')).toEqual({
      income: 21000,
    });
    expect(store.state.ui.income).toEqual({ status: 'closed', result: { income: 21000 } });
  });

  it('lets the render function given to present call hooks itself', async () => {
    const started = startRun(`
      import { Form, TextField, Button } from '@spainassist/ui';
      export async function main(api) {
        return api.ui.present('code', () => {
          const [code, setCode] = api.ui.useDurableState('code', '');
          return (
            <Form title="Código">
              <TextField label="Código" value={code} onChange={setCode} />
              <Button onClick={() => api.ui.close({ code })}>Seguir</Button>
            </Form>
          );
        });
      }
    `);
    const { run, store } = started;
    await until(() => store.trees.has('code'));
    let tree = store.trees.get('code');
    run.dispatch('code', {
      handler: handlerOf(findNode(tree?.tree, 'TextField'), 'onChange'),
      rev: tree?.rev ?? 0,
      value: 'X7K2',
    });
    await until(() => (store.trees.get('code')?.rev ?? 0) > (tree?.rev ?? 0));
    tree = store.trees.get('code');
    run.dispatch('code', {
      handler: handlerOf(findNode(tree?.tree, 'Button', 'Seguir'), 'onClick'),
      rev: tree?.rev ?? 0,
    });
    const outcome = await started.done;
    expect(outcome.status === 'succeeded' && JSON.parse(outcome.value ?? '')).toEqual({
      code: 'X7K2',
    });
  });

  it('logs the note the user left on an action, even when the workflow drops it', async () => {
    const outcome = await startRun(
      `export async function main(api) {
        const r = await api.user.requestAction({ kind: 'captcha', title: 'Escribe el código', message: 'Mira la imagen' });
        return { captcha: r.done };
      }`,
      { call: async () => ({ done: false, note: 'X7K2' }) },
    ).done;
    expect(outcome.status === 'succeeded' && JSON.parse(outcome.value ?? '')).toEqual({
      captcha: false,
    });
    expect(outcome.logs).toEqual(['[user] On "Escribe el código" the user noted: X7K2']);
  });

  it('resumes an open interface after a restart with its durable state, and reuses closed ones', async () => {
    const source = `
      import { Form, Choice, Button } from '@spainassist/ui';
      function Pick({ api, k }) {
        const [v, setV] = api.ui.useDurableState('v', 'a');
        return <Form><Choice options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} value={v} onChange={setV} /><Button onClick={() => api.ui.close(k + ':' + v)}>OK</Button></Form>;
      }
      export async function main(api) {
        const first = await api.ui.present('first', () => <Pick api={api} k="first" />);
        const second = await api.ui.present('second', () => <Pick api={api} k="second" />);
        return [first, second];
      }`;
    const one = startRun(source);
    await until(() => one.store.trees.has('first'));
    const t1 = one.store.trees.get('first');
    one.run.dispatch('first', {
      handler: handlerOf(findNode(t1?.tree, 'Button'), 'onClick'),
      rev: t1?.rev ?? 0,
    });
    await until(() => one.store.trees.has('second'));
    const t2 = one.store.trees.get('second');
    one.run.dispatch('second', {
      handler: handlerOf(findNode(t2?.tree, 'Choice'), 'onChange'),
      rev: t2?.rev ?? 0,
      value: 'b',
    });
    await until(() => one.store.state.ui.second?.durable?.v === 'b');
    // The app quits while "second" is open.
    one.run.cancel('App quit');
    expect((await one.done).status).toBe('cancelled');

    const restored = new MemoryStore();
    restored.state = one.store.snapshot();
    const two = startRun(source, { store: restored });
    await until(() => restored.trees.has('second'));
    const t3 = restored.trees.get('second');
    expect(findNode(t3?.tree, 'Choice')?.props.value).toBe('b');
    expect(restored.log).not.toContain('open first');
    two.run.dispatch('second', {
      handler: handlerOf(findNode(t3?.tree, 'Button'), 'onClick'),
      rev: t3?.rev ?? 0,
    });
    const outcome = await two.done;
    expect(outcome.status === 'succeeded' && JSON.parse(outcome.value ?? '')).toEqual([
      'first:a',
      'second:b',
    ]);
  });

  it('refuses an interface that shows nothing, at the line that presented it', async () => {
    const started = startRun(`
      export async function main(api) {
        await api.ui.present('empty', () => null);
      }`);
    const outcome = await started.done;
    expect(started.store.trees.has('empty')).toBe(false);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toMatch(/showed nothing/);
  });

  it('fails the workflow when a handler throws, so the agent sees the bug', async () => {
    const started = startRun(`
      import { Button } from '@spainassist/ui';
      export async function main(api) {
        await api.ui.present('x', () => <Button onClick={() => { throw new Error('boom'); }}>Go</Button>);
      }`);
    await until(() => started.store.trees.has('x'));
    const t = started.store.trees.get('x');
    started.run.dispatch('x', {
      handler: handlerOf(findNode(t?.tree, 'Button'), 'onClick'),
      rev: t?.rev ?? 0,
    });
    const outcome = await started.done;
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toMatch(/boom/);
  });

  it('throws at the line that presented an interface the app could not draw', async () => {
    const started = startRun(`
      import { Button } from '@spainassist/ui';
      export async function main(api) {
        try {
          await api.ui.present('x', () => <Button onClick={() => {}}>Go</Button>);
        } catch (e) {
          return { code: e.code, message: e.message };
        }
      }`);
    await until(() => started.store.trees.has('x'));
    expect(
      started.run.dispatch('x', {
        handler: UI_FAILED,
        rev: started.store.trees.get('x')?.rev ?? 0,
        value: 'The interface "x" could not be shown: boom',
      }),
    ).toBe('ok');
    const outcome = await started.done;
    expect(outcome.status === 'succeeded' && JSON.parse(outcome.value ?? '')).toEqual({
      code: 'bad_request',
      message: 'The interface "x" could not be shown: boom',
    });
  });

  it('points an uncaught failure of an interface at the line that presented it', async () => {
    const started = startRun(
      [
        "import { Button } from '@spainassist/ui';",
        'export async function main(api) {',
        "  await api.ui.present('x', () => <Button onClick={() => {}}>Go</Button>);",
        '}',
      ].join('\n'),
    );
    await until(() => started.store.trees.has('x'));
    started.run.dispatch('x', { handler: UI_FAILED, rev: 1, value: 'could not be shown' });
    const outcome = await started.done;
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toMatch(
        /^CodemodeError \[bad_request in ui.present\]: could not be shown/,
      );
      expect(outcome.error).toMatch(/workflow\.js:3/);
    }
  });

  it('draws components and hooks a module forgot to import', async () => {
    const started = startRun(`
      export async function main(api) {
        return api.ui.present('code', () => {
          const [code] = useDurableState('code', 'X7K2');
          return (
            <Form title="Código">
              <Button onClick={() => api.ui.close({ code })}>Seguir</Button>
            </Form>
          );
        });
      }
    `);
    const { run, store } = started;
    await until(() => store.trees.has('code'));
    const tree = store.trees.get('code');
    run.dispatch('code', {
      handler: handlerOf(findNode(tree?.tree, 'Button', 'Seguir'), 'onClick'),
      rev: tree?.rev ?? 0,
    });
    const outcome = await started.done;
    expect(outcome.status === 'succeeded' && JSON.parse(outcome.value ?? '')).toEqual({
      code: 'X7K2',
    });
  });

  it('rejects unknown components with the list of real ones', async () => {
    const outcome = await startRun(`
      export async function main(api) {
        await api.ui.present('x', () => __sa_h('Marquee', null, 'hi'));
      }`).done;
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed')
      expect(outcome.error).toMatch(/Unknown component "Marquee".*TextField/);
  });

  it('stops endless loops between waits', async () => {
    const outcome = await startRun('export async function main() { for (;;) {} }', {
      limits: { sliceMs: 200 },
    }).done;
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toMatch(/endless loop/);
  });

  it('stops an async loop that restarts itself whenever it is interrupted', async () => {
    // Each interruption only rejects the current async function; its catch starts it again in
    // the same batch of jobs, which then never ended and froze the agent's process for good.
    const outcome = await startRun(
      `export async function main() {
        function loop() { return (async () => { for (;;) await null; })().catch(loop); }
        loop();
        await new Promise(() => {});
      }`,
      { limits: { sliceMs: 200 } },
    ).done;
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toMatch(/endless loop/);
  });

  it('fails the run, not the process, when workflow code breaks what the kernel calls', async () => {
    // Workflow code shares the kernel's realm: here dispatch's own lookup throws a Promise.
    const started = startRun(`export async function main() {
      const get = Map.prototype.get;
      Map.prototype.get = function (k) {
        if (k === 'boom') throw new Promise(() => {});
        return get.call(this, k);
      };
      await new Promise(() => {});
    }`);
    await new Promise((r) => setTimeout(r, 50));
    expect(started.run.dispatch('boom', { handler: 'h', rev: 0 })).toBe('closed');
    expect(await started.done).toMatchObject({ status: 'failed', code: 'handler' });
  });

  it('fails the run, not the process, when a host result no longer fits its memory', async () => {
    const outcome = await startRun(
      `export async function main(api) {
        const keep = [];
        try { for (;;) keep.push('x'.repeat(1 << 20) + keep.length); } catch {}
        const big = await api.search('x');
        return big.length + keep.length;
      }`,
      { call: async () => 'y'.repeat(400_000) },
    ).done;
    expect(outcome.status).toBe('failed');
  });

  it('parallelize settles every task with a concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const outcome = await startRun(
      `export async function main(api) {
        const tasks = [1, 2, 3, 4, 5, 6].map((n) => () => api.search('q' + n));
        tasks.push(Promise.reject(new Error('nope')));
        const results = await api.parallelize(tasks, { concurrency: 2 });
        return results.map((r) => r.status);
      }`,
      {
        call: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
          return 'ok';
        },
      },
    ).done;
    expect(outcome.status === 'succeeded' && JSON.parse(outcome.value ?? '')).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'rejected',
    ]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('builds Playwright-shaped locators and sends them as data', async () => {
    const started = startRun(
      `export async function main(api) {
        const page = await api.browser.currentPage();
        await page.goto('https://sede.example.gob.es');
        await page.getByRole('combobox', { name: 'Oficina' }).selectOption('Madrid');
        const n = await page.locator('table.citas').getByRole('row').filter({ hasText: 'Libre' }).count();
        await page.ref('e12').click();
        await page.fillFromVault(page.getByLabel('NIF'), 'nif');
        return n;
      }`,
      { procedures: ['p_1'], call: async (op) => (op === 'browser.count' ? 3 : {}) },
    );
    const outcome = await started.done;
    expect(outcome.status === 'succeeded' && outcome.value).toBe('3');
    expect(started.calls).toEqual([
      {
        op: 'browser.goto',
        args: { procedureId: 'p_1', url: 'https://sede.example.gob.es', newTab: false },
      },
      {
        op: 'browser.selectOption',
        args: {
          procedureId: 'p_1',
          target: [['getByRole', 'combobox', { name: 'Oficina' }]],
          values: ['Madrid'],
        },
      },
      {
        op: 'browser.count',
        args: {
          procedureId: 'p_1',
          target: [
            ['locator', 'table.citas', null],
            ['getByRole', 'row', null],
            ['filter', { hasText: 'Libre' }],
          ],
        },
      },
      {
        op: 'browser.click',
        args: { procedureId: 'p_1', target: [['ref', 'e12']], options: null },
      },
      {
        op: 'browser.fillFromVault',
        args: {
          procedureId: 'p_1',
          target: [['getByLabel', 'NIF', null]],
          key: 'nif',
          submit: false,
        },
      },
    ]);
  });

  it('sends page.evaluate functions as they were written, ?. and ?? included', async () => {
    const started = startRun(
      `export async function main(api) {
        const page = await api.browser.currentPage();
        return page.evaluate(() => document.querySelector('h1')?.textContent ?? '');
      }`,
      { procedures: ['p_1'], call: async () => 'ok' },
    );
    expect((await started.done).status).toBe('succeeded');
    expect(JSON.stringify(started.calls)).toContain(
      "document.querySelector('h1')?.textContent ?? ''",
    );
  });

  it('has one snapshot: ariaSnapshot() says to use page.snapshot() and reaches no host', async () => {
    const started = startRun(
      `export async function main(api) {
        const page = await api.browser.currentPage();
        const errors = [];
        for (const look of [() => page.ariaSnapshot(), () => page.getByRole('table').ariaSnapshot()]) {
          try { await look(); } catch (e) { errors.push(e.code + ': ' + e.message); }
        }
        return errors;
      }`,
      { procedures: ['p_1'] },
    );
    const outcome = await started.done;
    expect(outcome.status).toBe('succeeded');
    const errors = JSON.parse(outcome.status === 'succeeded' ? (outcome.value ?? '[]') : '[]');
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error).toMatch(/^bad_request: .*use page\.snapshot\(\)/);
    expect(started.calls).toEqual([]);
  });

  it('gives agents the browser, and no agents of their own', async () => {
    const agent = await startRun(
      `export async function main(api) {
        try { api.agents.start({}); } catch (e) { return [e.code, typeof api.browser.currentPage, typeof api.classify, 'subagents' in api]; }
      }`,
    ).done;
    expect(agent.status === 'succeeded' && JSON.parse(agent.value ?? '')).toEqual([
      'policy_denied',
      'function',
      'function',
      false,
    ]);
  });

  it('names what api, pages and locators have when code uses what they lack', async () => {
    const outcome = await startRun(
      `export async function main(api) {
        const page = await api.browser.currentPage();
        const errors = [];
        for (const f of [() => api.setContext({}), () => page.evaluateAll(() => 1), () => page.getByText('x').frobnicate()]) {
          try { f(); } catch (e) { errors.push(e.message); }
        }
        return errors;
      }`,
      { procedures: ['p_1'] },
    ).done;
    expect(outcome.status).toBe('succeeded');
    const errors: string[] = outcome.status === 'succeeded' ? JSON.parse(outcome.value ?? '') : [];
    expect(errors[0]).toMatch(/^api\.setContext does not exist\. api has: .*procedures/);
    expect(errors[1]).toMatch(/^page\.evaluateAll does not exist\. page has: .*evaluate/);
    expect(errors[2]).toMatch(
      /^locator\.frobnicate does not exist\. locator has: .*pressSequentially/,
    );
  });

  it('has URL and URLSearchParams, and api.memo for api.state.memo', async () => {
    const outcome = await startRun(
      `export async function main(api) {
        const base = 'https://www.citapreviadnie.es/citaPreviaDni/SeleccionCita.action?oficina=x';
        const day = new URL('SeleccionCita.action?oficina=x&fecha=2026-10-19', base);
        const up = new URL('../inicio.html#arriba', base);
        const q = new URLSearchParams('a=1&b=dos%20tres');
        q.set('c', 'ñ');
        return [day.searchParams.get('fecha'), day.origin, up.href, q.get('b'), q.toString(), await api.memo('k', () => 7)];
      }`,
    ).done;
    expect(outcome.status === 'succeeded' && JSON.parse(outcome.value ?? '')).toEqual([
      '2026-10-19',
      'https://www.citapreviadnie.es',
      'https://www.citapreviadnie.es/inicio.html#arriba',
      'dos tres',
      'a=1&b=dos%20tres&c=%C3%B1',
      7,
    ]);
  });

  it('cancel aborts pending host operations', async () => {
    let aborted = false;
    const started = startRun('export async function main(api) { await api.search("slow"); }', {
      call: (_op, _args, { signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    });
    await until(() => started.calls.length === 1);
    started.run.cancel('User changed plans');
    expect(await started.done).toMatchObject({ status: 'cancelled', reason: 'User changed plans' });
    expect(aborted).toBe(true);
  });
});
