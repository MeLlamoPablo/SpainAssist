/**
 * Host-side gate for binding browser actions: submitting, booking or cancelling an appointment,
 * paying or signing needs a confirm_action the user approved. The system prompt asks the model
 * for it; this enforces it, so page content that manipulates the model cannot skip the user.
 *
 * The target is classified from the latest page snapshot the model saw (role, accessible name,
 * text and link URL of the element and its descendants). Unknown targets count as binding.
 */

/** An element of a page snapshot. */
export interface SnapshotNode {
  role: string;
  ref?: string;
  /** Accessible name, inline value and direct text children. */
  label: string;
  url?: string;
  active: boolean;
  depth: number;
  /** Index after the node's last descendant in `PageIndex.nodes`. */
  end: number;
}

export interface PageIndex {
  url: string;
  nodes: SnapshotNode[];
}

/** What the model is about to do on the current page. */
export type GatedAction =
  /** browser_click on a ref. */
  | { kind: 'click'; ref: string }
  /** Enter in a text field: browser_type / browser_fill_* with submit. */
  | { kind: 'submit' }
  /** browser_press. */
  | { kind: 'key'; key: string };

export type BindingVerdict =
  | { binding: false }
  | { binding: true; label: string }
  | { binding: true; unknown: true };

/** Roles whose own label never makes a click binding (fields, choices, structure). */
const NON_ACTION_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
  'slider',
  'checkbox',
  'radio',
  'switch',
  'listbox',
  'option',
  'tab',
  'menuitemcheckbox',
  'menuitemradio',
  'heading',
  'paragraph',
]);
const TEXT_INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/** Matched on the lowercased label without accents. */
const BINDING_PATTERNS = [
  /\b(enviar|envia|presentar|firmar|pagar|abonar|confirmar|registrar|solicitar|reservar|tramitar)\b/,
  /\brealizar (el )?pago\b/,
  /\b(cancelar|anular) (la |mi |esta )?(cita|reserva)\b/,
  /\b(submit|send|pay|confirm|book|register|apply)\b/,
  /\bsign\b(?![ -]?(in|out|up)\b)/,
  /\b(make (a )?payment|place (the )?order)\b/,
  /\bcancel (the |my |this )?(appointment|booking|reservation)\b/,
];

/** True when a button or link label names a binding action (submit, pay, sign, book...). */
export function isBindingLabel(label: string): boolean {
  const text = label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');
  return BINDING_PATTERNS.some((pattern) => pattern.test(text));
}

const ATTRS = /((?: \[[a-z-]+(?:=[^\s[\]"]*)?\])*)$/;

function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return String(JSON.parse(value));
  } catch {
    return value;
  }
}

/** Splits a YAML item into its key and inline value (see packages/browser/src/snapshot.ts). */
function splitItem(item: string): { key: string; value: string } {
  if (item.startsWith("'")) {
    let i = 1;
    while (i < item.length) {
      if (item[i] === "'") {
        if (item[i + 1] !== "'") break;
        i += 2;
      } else i++;
    }
    const value = item.slice(i + 1).replace(/^:\s?/, '');
    return { key: item.slice(1, i).replace(/''/g, "'"), value };
  }
  const colon = item.indexOf(': ');
  if (colon !== -1) return { key: item.slice(0, colon), value: item.slice(colon + 2) };
  return { key: item.endsWith(':') ? item.slice(0, -1) : item, value: '' };
}

/** Parses the rendered accessibility snapshot of a page. */
export function parseSnapshot(snapshot: string, url = ''): PageIndex {
  const nodes: SnapshotNode[] = [];
  const stack: SnapshotNode[] = [];
  for (const line of snapshot.split('\n')) {
    const match = /^( *)- (.*)$/.exec(line);
    if (!match) continue;
    const depth = (match[1] ?? '').length / 2;
    const item = match[2] ?? '';
    while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= depth) {
      const done = stack.pop();
      if (done) done.end = nodes.length;
    }
    const parent = stack.at(-1);
    if (item.startsWith('text:')) {
      if (parent) parent.label += ` ${unquote(item.slice(5).trim())}`;
      continue;
    }
    if (item.startsWith('/url:')) {
      if (parent) parent.url = unquote(item.slice(5).trim());
      continue;
    }
    const { key, value } = splitItem(item);
    const role = /^[a-z][a-z-]*/.exec(key)?.[0];
    if (!role) continue;
    const attrs = ATTRS.exec(key)?.[1] ?? '';
    const name = key.slice(role.length, key.length - attrs.length).trim();
    const node: SnapshotNode = {
      role,
      label: [unquote(name), unquote(value.trim())].filter(Boolean).join(' '),
      active: attrs.includes('[active]'),
      depth,
      end: nodes.length + 1,
    };
    const ref = /\[ref=([^\]]+)\]/.exec(attrs)?.[1];
    if (ref) node.ref = ref;
    nodes.push(node);
    stack.push(node);
  }
  for (const done of stack) done.end = nodes.length;
  return { url, nodes };
}

const withoutHash = (url: string) => url.split('#')[0];

/** A node that is binding on its own: an action control with a binding label. */
function bindingNode(page: PageIndex, node: SnapshotNode): boolean {
  if (NON_ACTION_ROLES.has(node.role)) return false;
  // A link to another page is a plain navigation (`#` and javascript: links run page scripts).
  if (
    node.role === 'link' &&
    node.url &&
    /^https?:/i.test(node.url) &&
    withoutHash(node.url) !== withoutHash(page.url)
  ) {
    return false;
  }
  return isBindingLabel(node.label);
}

function firstBinding(page: PageIndex, from: number, to: number): BindingVerdict {
  for (let i = from; i < to; i++) {
    const node = page.nodes[i];
    if (node && bindingNode(page, node)) return { binding: true, label: node.label.trim() };
  }
  return { binding: false };
}

/** Last segment of a Playwright key, e.g. "Control+Enter" -> "enter". */
function baseKey(key: string): string {
  return (key.split('+').at(-1) || key).trim().toLowerCase();
}

/**
 * Whether `action` on `page` may be binding. A click is binding when the element or anything
 * inside it is (clicking a container can hit its submit button); Enter in a text field submits
 * its form, so it is binding when the page has any binding control. `page` undefined: unknown.
 */
export function classifyAction(page: PageIndex | undefined, action: GatedAction): BindingVerdict {
  if (action.kind === 'key') {
    const key = baseKey(action.key);
    const enter = key === 'enter' || key === 'numpadenter';
    if (!enter && key !== 'space' && action.key !== ' ') return { binding: false };
    if (!page) return { binding: true, unknown: true };
    const active = page.nodes.find((n) => n.active);
    if (active && !TEXT_INPUT_ROLES.has(active.role)) {
      return bindingNode(page, active)
        ? { binding: true, label: active.label.trim() }
        : { binding: false };
    }
    return enter ? classifyAction(page, { kind: 'submit' }) : { binding: false };
  }
  if (!page) return { binding: true, unknown: true };
  if (action.kind === 'submit') return firstBinding(page, 0, page.nodes.length);
  const index = page.nodes.findIndex((n) => n.ref === action.ref);
  const node = page.nodes[index];
  if (!node) return { binding: true, unknown: true };
  return firstBinding(page, index, node.end);
}

/**
 * Tracks the latest page and the user's last confirm_action answer. One approval allows one
 * binding action; a new confirm_action replaces it.
 */
export class BindingGate {
  private page: PageIndex | undefined;
  private approved = false;

  /** The page the model now sees; `undefined` while it is unknown (e.g. during an action). */
  setPage(snapshot: string | undefined, url = ''): void {
    this.page = snapshot === undefined ? undefined : parseSnapshot(snapshot, url);
  }

  /** The outcome of a confirm_action, straight from the user's answer. */
  setApproval(approved: boolean): void {
    this.approved = approved;
  }

  /**
   * Undefined when `action` may go ahead (using up the approval if it is binding); otherwise
   * the explanation for the model.
   */
  check(action: GatedAction): string | undefined {
    const verdict = classifyAction(this.page, action);
    if (!verdict.binding) return undefined;
    if (this.approved) {
      this.approved = false;
      return undefined;
    }
    const what =
      action.kind === 'click'
        ? `clicking ${action.ref}`
        : action.kind === 'key'
          ? `pressing ${action.key}`
          : 'submitting this form';
    const why =
      'unknown' in verdict
        ? `Blocked by the app: it cannot tell whether ${what} is binding, because the latest page snapshot does not show it. Call browser_snapshot and use a ref from it.`
        : `Blocked by the app: ${what} looks binding (${JSON.stringify(verdict.label.slice(0, 120))}): it may submit, book or cancel an appointment, pay or sign.`;
    return `${why} If it is binding, call confirm_action first with a plain summary of exactly what will be sent and to whom, and repeat this action only if the user approves. Each approval allows one binding action. Do not try to work around this.`;
  }
}
