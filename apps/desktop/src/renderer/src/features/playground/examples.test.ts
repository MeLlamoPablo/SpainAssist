import {
  ChatItem,
  ConfirmKind,
  NextAction,
  type PromptItem,
  UI_COMPONENTS,
  type UiElement,
  type UiNode,
  UserActionKind,
} from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { appointmentExample, examplePromptItems, playgroundExamples } from './examples';
import { PlaygroundRun, type RunView } from './runner';
import { playgroundWorkflows } from './workflows';

const EMPTY = { memo: {}, ui: {} };

/** Starts a workflow with a host that approves every question. */
function start(source: string, lang: 'es' | 'en' = 'es') {
  let view: RunView | undefined;
  const asked: PromptItem[] = [];
  const run = new PlaygroundRun('wf-test', source, EMPTY, {
    lang,
    delayMs: 0,
    ask: (item, onAnswer) => {
      asked.push(item);
      queueMicrotask(() =>
        onAnswer({
          ...item,
          status: 'answered',
          response: { kind: 'confirm', approved: true },
        }),
      );
      return () => {};
    },
    onChange: (v) => {
      view = v;
    },
  });
  run.start();
  return { run, asked, view: () => view };
}

async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function nodes(tree: UiNode): UiElement[] {
  if (typeof tree === 'string') return [];
  return [tree, ...tree.children.flatMap(nodes)];
}

function handler(tree: UiNode, type: string, prop: string): string {
  const node = nodes(tree).find((n) => n.type === type);
  const value = node?.props[prop] as { $handler: string } | undefined;
  if (!value) throw new Error(`No ${type}.${prop} in the tree`);
  return value.$handler;
}

describe('agent playground', () => {
  for (const language of ['es', 'en'] as const) {
    it(`has valid, unique examples of every question codemode raises in ${language}`, () => {
      const examples = playgroundExamples(language);
      expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length);
      for (const example of examples)
        if (example.item) expect(ChatItem.safeParse(example.item).success, example.id).toBe(true);
      const prompts = examplePromptItems(language).map((i) => i.prompt);
      const confirmations = prompts.flatMap((p) => (p.kind === 'confirm' ? [p.confirmKind] : []));
      const actions = prompts.flatMap((p) => (p.kind === 'user_action' ? [p.actionKind] : []));
      const credentials = prompts.flatMap((p) => (p.kind === 'credential' ? [p.credential] : []));
      expect([...new Set(confirmations)].sort()).toEqual([...ConfirmKind.options].sort());
      expect([...new Set(actions)].sort()).toEqual([...UserActionKind.options].sort());
      // What api.user.requestCredential takes.
      expect([...new Set(credentials)].sort()).toEqual(['clave_permanente', 'dnie']);
      expect(prompts.some((p) => p.kind === 'phone_call')).toBe(true);
      expect(prompts.some((p) => p.kind === 'dnie_signature')).toBe(true);
      expect(prompts.some((p) => p.kind === 'form' && p.fields[0]?.type === 'secret')).toBe(true);
      const t = (es: string, en: string) => (language === 'es' ? es : en);
      expect(NextAction.safeParse(appointmentExample(t)).success).toBe(true);
    });

    it(`runs every workflow to its first interface, covering every component, in ${language}`, async () => {
      const seen = new Set<string>();
      for (const workflow of playgroundWorkflows(language)) {
        const { run, view } = start(workflow.source, language);
        const ready = await until(() => {
          const v = view();
          return v && v.status !== 'running' && v;
        }, workflow.id);
        if (workflow.id === 'rechazada') {
          expect(ready.status).toBe('failed');
          expect(ready.error).toMatch(/bad_request.*Links must be https/s);
          continue;
        }
        expect(ready.status, `${workflow.id}: ${ready.error}`).toBe('waiting_user');
        for (const ui of ready.ui) for (const node of nodes(ui.tree ?? '')) seen.add(node.type);
        run.stop();
      }
      expect([...seen].sort()).toEqual([...UI_COMPONENTS].sort());
    });
  }

  it('books the DNI appointment end to end, through two interfaces and an approval', async () => {
    const source = playgroundWorkflows('es').find((w) => w.id === 'cita-dni')?.source ?? '';
    const { run, view, asked } = start(source);
    const first = await until(() => view()?.ui[0], 'the first interface');
    run.uiEvent('where-and-when', {
      handler: handler(first.tree ?? '', 'Map', 'onChange'),
      rev: first.rev,
      value: 'centro',
    });
    const chosen = await until(() => {
      const ui = view()?.ui[0];
      return ui && ui.rev > first.rev && ui;
    }, 'the office in the tree');
    run.uiEvent('where-and-when', {
      handler: handler(chosen.tree ?? '', 'Button', 'onClick'),
      rev: chosen.rev,
    });
    const slots = await until(() => view()?.ui.find((u) => u.key === 'slot'), 'the slots');
    const appointment = nodes(slots.tree ?? '').find((n) => n.type === 'Appointment');
    const slot = (appointment?.props.slots as string[] | undefined)?.[0] ?? '';
    run.uiEvent('slot', {
      handler: handler(slots.tree ?? '', 'Appointment', 'onChange'),
      rev: slots.rev,
      value: slot,
    });
    const picked = await until(() => {
      const ui = view()?.ui.find((u) => u.key === 'slot');
      return ui && ui.rev > slots.rev && ui;
    }, 'the slot in the tree');
    run.uiEvent('slot', {
      handler: handler(picked.tree ?? '', 'Button', 'onClick'),
      rev: picked.rev,
    });
    const done = await until(() => {
      const v = view();
      return v && (v.status === 'succeeded' || v.status === 'failed') && v;
    }, 'the end');
    expect(done.error).toBeUndefined();
    expect(JSON.parse(done.result ?? '{}')).toEqual({
      booked: true,
      office: 'Comisaría Sevilla-Centro',
      slot,
    });
    expect(asked.map((i) => i.prompt.kind)).toEqual(['confirm']);
    expect(Object.keys(done.state.memo)).toEqual(['slots']);
    expect(done.agentStatus).toBe('Reservando la cita…');
    // The procedure it updated, as the user's list shows it.
    expect(done.procedures.map((p) => [p.id, p.version, p.nextAction?.appointment])).toEqual([
      [
        'p_renovar-dni',
        2,
        { address: 'Comisaría Sevilla-Centro, Plaza de ejemplo 3, Sevilla', startsAt: slot },
      ],
    ]);
  });

  it('saves what the user typed in fields with a vaultKey when the interface closes, however it closes', async () => {
    const source = playgroundWorkflows('es').find((w) => w.id === 'datos')?.source ?? '';
    const saved: unknown[] = [];
    let view: RunView | undefined;
    const run = new PlaygroundRun('wf-datos', source, EMPTY, {
      lang: 'es',
      delayMs: 0,
      ask: () => () => {},
      saveAnswers: async (answers) => {
        saved.push(...answers);
      },
      onChange: (v) => {
        view = v;
      },
    });
    run.start();
    const form = await until(() => view?.ui[0], 'the form');
    const email = nodes(form.tree ?? '').find((n) => n.props.vaultKey === 'email');
    run.uiEvent('details', {
      handler: (email?.props.onChange as { $handler: string } | undefined)?.$handler ?? '',
      rev: form.rev,
      value: 'lucia@example.es',
    });
    const typed = await until(() => {
      const ui = view?.ui[0];
      return ui && ui.rev > form.rev && ui;
    }, 'the email in the tree');
    // "Ahora no": the user still keeps what they typed.
    const notNow = nodes(typed.tree ?? '').find(
      (n) => n.type === 'Button' && n.children.includes('Ahora no'),
    );
    run.uiEvent('details', {
      handler: (notNow?.props.onClick as { $handler: string } | undefined)?.$handler ?? '',
      rev: typed.rev,
    });
    await until(() => view?.status === 'succeeded', 'the end');
    expect(saved).toEqual([{ key: 'email', value: 'lucia@example.es' }]);
  });

  it('resumes from durable state: closed interfaces and memoized steps are not repeated', async () => {
    const source = playgroundWorkflows('es').find((w) => w.id === 'cita-dni')?.source ?? '';
    const state = {
      memo: { slots: { value: ['2026-12-03T09:10'] } },
      ui: {
        'where-and-when': {
          status: 'closed' as const,
          result: { office: 'sur', time: 'morning', from: '2026-12-01' },
        },
        slot: { status: 'open' as const, durable: { slot: '2026-12-03T09:10' }, rev: 4 },
      },
    };
    let view: RunView | undefined;
    const run = new PlaygroundRun('wf-resume', source, state, {
      lang: 'es',
      delayMs: 0,
      history: [{ id: 7, kind: 'call', text: 'ui.present("slot")' }],
      ask: () => () => {},
      onChange: (v) => {
        view = v;
      },
    });
    run.start();
    const resumed = await until(() => view?.ui[0], 'the open interface');
    expect(resumed.key).toBe('slot');
    const appointment = nodes(resumed.tree ?? '').find((n) => n.type === 'Appointment');
    expect(appointment?.props.value).toBe('2026-12-03T09:10');
    expect(view?.lines.some((l) => l.text.startsWith('fetchUrl'))).toBe(false);
    // The previous run's log goes on, marked.
    expect(view?.lines.slice(0, 2).map((l) => [l.id, l.text])).toEqual([
      [7, 'ui.present("slot")'],
      [8, '— resumed from its durable state —'],
    ]);
    run.stop();
  });
});
