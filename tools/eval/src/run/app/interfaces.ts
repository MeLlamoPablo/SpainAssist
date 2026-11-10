/**
 * Codemode's interfaces as the harness sees them (docs/codemode.md, "Interfaces"): a workflow's
 * `api.ui.present` shows the user a tree of native components, not one of the app's prompts. The
 * simulator answers prompts, so each interface it can act on becomes a `form` prompt, and its
 * answer goes back the way the renderer sends it: an `onChange` per input, then a click.
 *
 *   inputs      TextField, Select, Choice, MultiChoice, Checkbox, Province, DocumentPicker, Map and
 *               Appointment become the form field of the same kind (`select` for a Choice).
 *   buttons     with inputs and one button, it is pressed after them; with several (or none of
 *               the inputs), the form gets a `button` select whose options are their labels, so
 *               the answer says which one the user presses.
 *   texts       Form and Section titles, Text, Callout, Facts and Link texts are the message, which
 *               the rules' text matchers read as they read a prompt's.
 *
 * An interface's first render is a prompt at once: components are synchronous, so a workflow loads
 * its data before `present` and the first tree is the whole question (in 85 Haiku runs no first
 * render changed before it was answered). After an answer, the same interface becomes a new prompt
 * only with a newer tree (the click's effect: an error, the next step) once that tree has held
 * still for a moment (`settleMs`), since a handler runs on after the click. A tree whose buttons
 * are loading, or with nothing to act on, is no prompt. Every render is logged
 * (`interface_render`).
 */
import {
  APPOINTMENT_MORE,
  ASSISTANT_AGENT_ID,
  type PromptResponse,
  type UiElement,
  type UiNode,
  type WorkflowInfo,
} from '@sa/shared';
import type { PendingPrompt } from '../../contracts';

type Field = NonNullable<PendingPrompt['fields']>[number];

/** The key of the field that says which button the user presses. */
export const BUTTON_FIELD = 'button';

const INPUTS = {
  TextField: 'text',
  Select: 'select',
  Choice: 'select',
  MultiChoice: 'multiselect',
  Checkbox: 'boolean',
  Province: 'province',
  DocumentPicker: 'document',
  Map: 'map-options',
  Appointment: 'appointment',
} as const;
type InputType = keyof typeof INPUTS;

const TEXT_FIELD_TYPES = new Set(['text', 'email', 'phone', 'number', 'date', 'textarea']);

/** Where a control is, in a way a re-render keeps: its component, label and rank among equals. */
interface Control {
  locator: string;
  component: InputType | 'Button';
  label: string;
  handler: string;
  props: Record<string, unknown>;
  /** A button the form keeps disabled until its inputs are filled in. */
  disabled?: boolean;
}

/** What one tree shows: its texts and the controls the user can act on. */
export interface ReadTree {
  title?: string;
  texts: string[];
  inputs: Control[];
  buttons: Control[];
  /** A button is loading: the workflow is busy with the last click. */
  loading: boolean;
}

function textOf(nodes: readonly UiNode[]): string {
  return nodes
    .map((node) => (typeof node === 'string' ? node : textOf(node.children)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function handlerOf(value: unknown): string | undefined {
  return value &&
    typeof value === 'object' &&
    typeof (value as { $handler?: unknown }).$handler === 'string'
    ? (value as { $handler: string }).$handler
    : undefined;
}

/**
 * Reads a tree: its texts in order, every enabled input that has a handler, and every button that
 * has one (a disabled one too: filling the inputs in usually enables it).
 */
export function readTree(tree: UiNode): ReadTree {
  const out: ReadTree = { texts: [], inputs: [], buttons: [], loading: false };
  const seen = new Map<string, number>();
  const locate = (component: string, label: string) => {
    const base = `${component}\u0000${label}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}\u0000${n}`;
  };
  const visit = (node: UiNode): void => {
    if (typeof node === 'string') {
      const text = node.replace(/\s+/g, ' ').trim();
      if (text) out.texts.push(text);
      return;
    }
    const { type, props, children } = node as UiElement;
    switch (type) {
      case 'Form':
        if (typeof props.title === 'string') {
          out.title ??= props.title;
          out.texts.push(props.title);
        }
        if (typeof props.description === 'string') out.texts.push(props.description);
        break;
      case 'Section':
      case 'Callout':
        if (typeof props.title === 'string') out.texts.push(props.title);
        break;
      case 'Facts':
        for (const item of (props.items ?? []) as { label: string; value: string }[]) {
          out.texts.push(`${item.label}: ${item.value}`);
        }
        return;
      case 'Link': {
        const text = textOf(children);
        out.texts.push(text ? `${text} (${String(props.href)})` : String(props.href));
        return;
      }
      case 'Progress':
        if (typeof props.label === 'string') out.texts.push(props.label);
        return;
      case 'Button': {
        if (props.loading === true) out.loading = true;
        const handler = handlerOf(props.onClick);
        const label = textOf(children) || 'OK';
        if (handler && props.loading !== true) {
          out.buttons.push({
            locator: locate('Button', label),
            component: 'Button',
            label,
            handler,
            props,
            ...(props.disabled === true ? { disabled: true } : {}),
          });
        }
        return;
      }
      default:
        if (Object.hasOwn(INPUTS, type)) {
          const handler = handlerOf(props.onChange);
          const label = typeof props.label === 'string' ? props.label : '';
          if (handler && props.disabled !== true) {
            out.inputs.push({
              locator: locate(type, label),
              component: type as InputType,
              label,
              handler,
              props,
            });
          }
          return;
        }
    }
    for (const child of children) visit(child);
  };
  visit(tree);
  return out;
}

/** Whether the user can do something with a tree now. */
export function actionable(read: ReadTree): boolean {
  return !read.loading && (read.inputs.length > 0 || read.buttons.some((b) => !b.disabled));
}

/** A field key from a label: `lower-case-words`, unique in the form. */
function keyFor(label: string, fallback: string, taken: Set<string>): string {
  const base =
    label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || fallback;
  let key = base === BUTTON_FIELD ? `${base}_1` : base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  taken.add(key);
  return key;
}

function options(props: Record<string, unknown>): { value: string; label: string }[] {
  return ((props.options ?? []) as { value: string; label: string }[]).map(({ value, label }) => ({
    value,
    label,
  }));
}

function fieldOf(control: Control, key: string): Field {
  const { props } = control;
  const component = control.component as InputType;
  const label = control.label || defaultLabel(component);
  const field: Field = {
    key,
    type: INPUTS[component],
    label,
    required: props.required === true,
  };
  switch (component) {
    case 'TextField':
      if (typeof props.type === 'string' && TEXT_FIELD_TYPES.has(props.type))
        field.type = props.type;
      if (typeof props.value === 'string' && props.value) field.defaultValue = props.value;
      break;
    case 'Select':
    case 'Choice':
    case 'Map':
      field.options = options(props);
      field.required = true;
      if (typeof props.value === 'string' && props.value) field.defaultValue = props.value;
      break;
    case 'MultiChoice':
      field.options = options(props);
      break;
    case 'Checkbox':
      if (props.checked === true) field.defaultValue = 'true';
      break;
    case 'Province':
    case 'DocumentPicker':
      field.required = true;
      if (typeof props.value === 'string' && props.value) field.defaultValue = props.value;
      break;
    case 'Appointment':
      field.slots = [...((props.slots ?? []) as string[])];
      field.required = true;
      break;
  }
  return field;
}

function defaultLabel(component: InputType): string {
  switch (component) {
    case 'Appointment':
      return 'Cita';
    case 'Map':
      return 'Lugar';
    case 'Province':
      return 'Provincia';
    default:
      return 'Respuesta';
  }
}

/** The form a tree asks, and which field is which control. */
export interface InterfaceForm {
  title: string;
  message?: string;
  fields: Field[];
  /** Field key -> the control's locator. */
  inputs: Map<string, string>;
  /** Button label (the `button` field's values) -> the button's locator. */
  buttons: Map<string, string>;
}

export function interfaceForm(read: ReadTree, fallbackTitle: string): InterfaceForm {
  const taken = new Set<string>([BUTTON_FIELD]);
  const fields: Field[] = [];
  const inputs = new Map<string, string>();
  for (const control of read.inputs) {
    const key = keyFor(control.label, control.component.toLowerCase(), taken);
    fields.push(fieldOf(control, key));
    inputs.set(key, control.locator);
  }
  const buttons = new Map<string, string>();
  for (const button of read.buttons) {
    let label = button.label;
    for (let n = 2; buttons.has(label); n++) label = `${button.label} (${n})`;
    buttons.set(label, button.locator);
  }
  if (buttons.size > 1 || (buttons.size === 1 && fields.length === 0)) {
    const labels = [...buttons.keys()];
    const primary = read.buttons.find(
      (b) => b.props.type === 'primary' || b.props.type === undefined,
    );
    fields.push({
      key: BUTTON_FIELD,
      type: 'select',
      label: 'Botón que pulsas',
      options: labels.map((label) => ({ value: label, label })),
      required: true,
      ...(fields.length > 0 && primary ? { defaultValue: primary.label } : {}),
    });
  }
  const title = read.title ?? fallbackTitle;
  const texts = read.texts.filter((text) => text !== read.title);
  return {
    title,
    ...(texts.length > 0 ? { message: texts.join('\n') } : {}),
    fields,
    inputs,
    buttons,
  };
}

/** The event value an input's `onChange` gets for a form answer, or undefined to leave it. */
function eventValue(
  control: Control,
  value: string | string[] | boolean,
): string | string[] | boolean | undefined {
  switch (control.component) {
    case 'Checkbox':
      return value === true || value === 'true';
    case 'MultiChoice':
      return Array.isArray(value) ? value : String(value) ? [String(value)] : [];
    case 'Appointment':
      return value === APPOINTMENT_MORE ? APPOINTMENT_MORE : String(value);
    default:
      return Array.isArray(value) ? value.join(', ') : String(value);
  }
}

function currentValue(control: Control): unknown {
  return control.component === 'Checkbox' ? control.props.checked === true : control.props.value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// -------------------------------------------------------------------------------------------
// The interfaces of a run
// -------------------------------------------------------------------------------------------

interface InterfacePort {
  /** The workflows as the renderer gets them (`codemode.state`). */
  workflows(): WorkflowInfo[];
  /** The renderer's `codemode.uiEvent`. */
  uiEvent(
    workflowId: string,
    key: string,
    event: { handler: string; rev: number; value?: string | string[] | boolean },
  ): Promise<boolean>;
}

interface Shown {
  prompt: PendingPrompt;
  form: InterfaceForm;
  rev: number;
}

interface Entry {
  workflowId: string;
  key: string;
  seq: number;
  /** The rev the last answer acted on: only a newer tree is a new prompt. */
  answeredRev: number;
  /** The tree that last answer acted on (to wait longer for a click that changes nothing). */
  answeredTree?: string;
  shown?: Shown;
  answering: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** When the timer was first set for the tree on screen (a tree that never holds still). */
  waitingSince?: number;
  /** The last rev reported to `onRender`. */
  renderedRev?: number;
}

export interface InterfacePromptsOptions {
  port: InterfacePort;
  /** A new prompt: list it (it already is) and announce it. */
  onShown(prompt: PendingPrompt): void;
  /** Something the run's notes should say. */
  onNote(text: string): void;
  /** A render of an open interface (each rev once). */
  onRender?(render: { workflowId: string; key: string; rev: number; actionable: boolean }): void;
  /** How long a tree after an answer must hold still to be a prompt (default 1.5 s). */
  settleMs?: number;
  /** The longest a changing tree waits to be a prompt (default 5 s). */
  maxSettleMs?: number;
  /** As `settleMs`, for a tree identical to the one just answered (default 8 s). */
  repeatSettleMs?: number;
  /** How long to wait for the re-render an event causes (default 3 s). */
  renderWaitMs?: number;
}

const POLL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The open interfaces of the run's workflows, as prompts of the simulator. */
export class InterfacePrompts {
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(private readonly options: InterfacePromptsOptions) {}

  /** A workflow changed (`codemode.workflow`): its interfaces may have opened, changed or closed. */
  update(workflow: WorkflowInfo): void {
    if (this.closed) return;
    const open = new Set<string>();
    for (const ui of workflow.ui) {
      if (ui.status !== 'open' || !ui.tree) continue;
      const id = `${workflow.id}\u0000${ui.key}`;
      open.add(id);
      let entry = this.entries.get(id);
      if (!entry) {
        entry = { workflowId: workflow.id, key: ui.key, seq: 0, answeredRev: -1, answering: false };
        this.entries.set(id, entry);
      }
      if (entry.renderedRev !== ui.rev) {
        entry.renderedRev = ui.rev;
        this.options.onRender?.({
          workflowId: workflow.id,
          key: ui.key,
          rev: ui.rev,
          actionable: actionable(readTree(ui.tree)),
        });
      }
      this.schedule(entry);
    }
    for (const [id, entry] of this.entries) {
      if (entry.workflowId !== workflow.id || open.has(id)) continue;
      // Closed (answered by the workflow itself, withdrawn, the workflow ended): no longer pending.
      if (entry.timer) clearTimeout(entry.timer);
      this.entries.delete(id);
    }
  }

  /** Prompts shown and not answered yet, oldest first. */
  pending(): PendingPrompt[] {
    return [...this.entries.values()]
      .filter((entry) => entry.shown && !entry.answering)
      .map((entry) => (entry.shown as Shown).prompt);
  }

  owns(itemId: string): boolean {
    return itemId.startsWith('wf_');
  }

  /**
   * Whether an interface is being answered (events still going to the workflow), or is waiting
   * for its tree to hold still before it is shown: the run is not quiet while a prompt is coming.
   */
  busy(): boolean {
    return [...this.entries.values()].some((entry) => entry.answering || entry.timer !== undefined);
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.entries.clear();
  }

  private latest(
    entry: Entry,
  ): { rev: number; tree: UiNode; title?: string; workflow: WorkflowInfo } | undefined {
    const workflow = this.options.port.workflows().find((w) => w.id === entry.workflowId);
    const ui = workflow?.ui.find((u) => u.key === entry.key && u.status === 'open');
    return workflow && ui?.tree ? { rev: ui.rev, tree: ui.tree, workflow } : undefined;
  }

  /** Shows the interface as a prompt once its tree has held still, if the user can act on it. */
  private schedule(entry: Entry): void {
    if (entry.answering) return;
    const now = this.latest(entry);
    if (!now || now.rev <= entry.answeredRev) return;
    // Re-rendered before it was answered (options loaded, a value changed): `show` decides.
    if (entry.shown?.rev === now.rev) return;
    const repeat =
      entry.answeredTree !== undefined && entry.answeredTree === JSON.stringify(now.tree);
    // A first render (never shown, never answered) is the whole question: no wait.
    const first = entry.answeredRev === -1 && !entry.shown;
    const settle = first
      ? 0
      : repeat
        ? (this.options.repeatSettleMs ?? 8000)
        : (this.options.settleMs ?? 1500);
    // A tree that keeps changing (a progress text) is shown anyway after a while.
    const waitingSince = entry.waitingSince ?? Date.now();
    const left = Math.max(settle, this.options.maxSettleMs ?? 5000) - (Date.now() - waitingSince);
    if (entry.timer) clearTimeout(entry.timer);
    entry.waitingSince = waitingSince;
    entry.timer = setTimeout(
      () => {
        entry.timer = undefined;
        entry.waitingSince = undefined;
        this.show(entry);
      },
      Math.max(0, Math.min(settle, left)),
    );
  }

  private show(entry: Entry): void {
    if (this.closed || entry.answering) return;
    const now = this.latest(entry);
    if (!now || now.rev <= entry.answeredRev) return;
    const read = readTree(now.tree);
    if (!actionable(read)) {
      // Busy again (a loading button), or nothing left to do: no longer a question.
      entry.shown = undefined;
      return;
    }
    const form = interfaceForm(read, now.workflow.title ?? 'Pregunta');
    if (entry.shown) {
      const was = entry.shown.form;
      if (
        was.title === form.title &&
        was.message === form.message &&
        same(was.fields, form.fields)
      ) {
        // The same question: the prompt the simulator has stays valid.
        entry.shown = { ...entry.shown, form, rev: now.rev };
        return;
      }
    }
    entry.seq += 1;
    const assistant = now.workflow.agentId === ASSISTANT_AGENT_ID;
    const prompt: PendingPrompt = {
      itemId: `wf_${entry.workflowId}:${entry.key}:${entry.seq}`,
      agent: assistant ? 'assistant' : 'procedure',
      kind: 'form',
      title: form.title,
      ...(form.message ? { message: form.message } : {}),
      fields: form.fields,
    };
    entry.shown = { prompt, form, rev: now.rev };
    this.options.onShown(prompt);
  }

  /** Plays a form answer on the interface: each input's change, then the click. */
  async respond(itemId: string, response: PromptResponse): Promise<void> {
    const entry = [...this.entries.values()].find((e) => e.shown?.prompt.itemId === itemId);
    if (!entry?.shown || entry.answering) throw new Error(`No pending interface ${itemId}`);
    if (response.kind !== 'form')
      throw new Error(`An interface takes a form answer, not ${response.kind}`);
    const { form, rev: shownRev } = entry.shown;
    entry.answering = true;
    try {
      if (response.dismissed || !response.values) {
        // The renderer has no way to dismiss an interface: the user leaves it open.
        entry.answeredRev = entry.shown.rev;
        this.options.onNote(`interface ${itemId} was left unanswered (dismissed)`);
        return;
      }
      const values = response.values;
      for (const [key, locator] of form.inputs) {
        const value = values[key];
        if (value === undefined) continue;
        const now = this.latest(entry);
        if (!now) return;
        const control = readTree(now.tree).inputs.find((c) => c.locator === locator);
        if (!control) {
          this.options.onNote(`interface ${itemId}: "${key}" is no longer on screen`);
          continue;
        }
        const next = eventValue(control, value);
        if (next === undefined || same(next, currentValue(control))) continue;
        await this.options.port.uiEvent(entry.workflowId, entry.key, {
          handler: control.handler,
          rev: now.rev,
          value: next,
        });
        await this.rendered(entry, now.rev);
      }
      const choice = values[BUTTON_FIELD];
      const label =
        typeof choice === 'string' && form.buttons.has(choice)
          ? choice
          : form.buttons.size === 1
            ? [...form.buttons.keys()][0]
            : undefined;
      let now = this.latest(entry);
      if (!now) return;
      if (label === undefined) {
        entry.answeredRev = now.rev;
        entry.answeredTree = JSON.stringify(now.tree);
        return;
      }
      const locator = form.buttons.get(label);
      let button = readTree(now.tree).buttons.find((b) => b.locator === locator);
      // The form may enable it a moment after its inputs changed.
      const deadline = Date.now() + (this.options.renderWaitMs ?? 3000);
      while (button?.disabled && Date.now() < deadline) {
        await sleep(POLL_MS);
        now = this.latest(entry);
        if (!now) return;
        button = readTree(now.tree).buttons.find((b) => b.locator === locator);
      }
      if (!button || button.disabled) {
        this.options.onNote(
          `interface ${itemId}: the button "${label}" is ${button ? 'still disabled' : 'no longer on screen'}`,
        );
        // Not answered as far as the form goes: what is on screen now is asked again.
        entry.answeredRev = shownRev;
        entry.answeredTree = undefined;
        return;
      }
      entry.answeredRev = now.rev;
      entry.answeredTree = JSON.stringify(now.tree);
      await this.options.port.uiEvent(entry.workflowId, entry.key, {
        handler: button.handler,
        rev: now.rev,
      });
    } finally {
      entry.shown = undefined;
      entry.answering = false;
      if (this.entries.get(`${entry.workflowId}\u0000${entry.key}`) === entry) this.schedule(entry);
    }
  }

  /** Waits for the re-render an event causes (none comes when the tree did not change). */
  private async rendered(entry: Entry, rev: number): Promise<void> {
    const deadline = Date.now() + (this.options.renderWaitMs ?? 3000);
    while (Date.now() < deadline) {
      const now = this.latest(entry);
      if (!now || now.rev > rev) return;
      await sleep(POLL_MS);
    }
  }
}
