/**
 * Host-side gate for binding browser actions: submitting, booking or cancelling an appointment,
 * paying or signing needs a confirm_action the user approved. The system prompt asks the model
 * for it; this enforces it, so page content that manipulates the model cannot skip the user.
 *
 * The target is classified from the latest page snapshot the model saw (role, accessible name,
 * text and link URL of the element and its descendants). Unknown targets count as binding. On a
 * page that looks like a final or review step, generic labels ("Aceptar", "Continuar") and
 * unlabelled buttons count too. An approval is tied to the page's origin and, when the model
 * names the element in confirm_action, to that element's label.
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
  /** The page looks like a final or review step (summary, declaration, amount to pay). */
  review: boolean;
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

/** Generic "go on" labels: binding only on a review step. */
const SOFT_FINAL = [
  /\b(aceptar|continuar|finalizar|siguiente|terminar|accept|continue|finish|next)\b/,
];

/** Page text of a final or review step, before the last click sends everything. */
const REVIEW_CUES = [
  /\b(resumen|revise|revisa|revisar|compruebe|comprueba|verifique|confirmacion)\b/,
  /\b(declaro|declaracion responsable)\b/,
  /\bacepto (las |los )?(condiciones|terminos)\b/,
  /\b(importe (a pagar|total)|total a pagar)\b/,
  /\b(summary|review your|i declare|i accept the (terms|conditions)|amount due|total to pay)\b/,
];

/** Roles whose text doesn't describe the page (controls and what the user typed). */
const NOT_PAGE_TEXT_ROLES = new Set([...TEXT_INPUT_ROLES, 'button', 'link', 'menuitem', 'option']);

function matches(text: string, patterns: readonly RegExp[]): boolean {
  const plain = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');
  return patterns.some((pattern) => pattern.test(plain));
}

/** True when a button or link label names a binding action (submit, pay, sign, book...). */
export function isBindingLabel(label: string): boolean {
  return matches(label, BINDING_PATTERNS);
}

/** True when page text looks like a final or review step. */
export function isReviewText(text: string): boolean {
  return matches(text, REVIEW_CUES);
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
  const pageText: string[] = [];
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
      const text = unquote(item.slice(5).trim());
      if (parent) parent.label += ` ${text}`;
      if (!parent || !NOT_PAGE_TEXT_ROLES.has(parent.role)) pageText.push(text);
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
    if (!NOT_PAGE_TEXT_ROLES.has(role)) pageText.push(node.label);
    nodes.push(node);
    stack.push(node);
  }
  for (const done of stack) done.end = nodes.length;
  return { url, nodes, review: isReviewText(pageText.join('\n')) };
}

const withoutHash = (url: string) => url.split('#')[0];

/** Whether the node at `index` is binding on its own (not through its descendants). */
function bindingAt(page: PageIndex, index: number): boolean {
  const node = page.nodes[index];
  if (!node || NON_ACTION_ROLES.has(node.role)) return false;
  // A link to another page is a plain navigation (`#` and javascript: links run page scripts).
  if (
    node.role === 'link' &&
    node.url &&
    /^https?:/i.test(node.url) &&
    withoutHash(node.url) !== withoutHash(page.url)
  ) {
    return false;
  }
  if (isBindingLabel(node.label)) return true;
  if (!page.review) return false;
  // On a review step, "Aceptar"/"Continuar"... and unlabelled buttons may be the final send.
  if (matches(node.label, SOFT_FINAL)) return true;
  return node.role === 'button' && page.nodes.slice(index, node.end).every((n) => !n.label.trim());
}

function verdictAt(page: PageIndex, index: number): BindingVerdict {
  return { binding: true, label: page.nodes[index]?.label.trim() || '(unlabelled button)' };
}

function firstBinding(page: PageIndex, from: number, to: number): BindingVerdict {
  for (let i = from; i < to; i++) if (bindingAt(page, i)) return verdictAt(page, i);
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
    const active = page.nodes.findIndex((n) => n.active);
    const node = page.nodes[active];
    if (node && !TEXT_INPUT_ROLES.has(node.role)) {
      return bindingAt(page, active) ? verdictAt(page, active) : { binding: false };
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

function originOf(url: string): string | undefined {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * What a confirm_action approval allows: one binding action on the page's origin and, when the
 * model named the element (confirm_action `ref`), only an action whose target has that label.
 */
export interface Approval {
  origin?: string;
  label?: string;
}

/**
 * Tracks the latest page and the user's last confirm_action answer. One approval allows one
 * binding action; a new confirm_action replaces it.
 */
export class BindingGate {
  private page: PageIndex | undefined;
  private approval: Approval | undefined;

  /** The page the model now sees; `undefined` while it is unknown (e.g. during an action). */
  setPage(snapshot: string | undefined, url = ''): void {
    this.page = snapshot === undefined ? undefined : parseSnapshot(snapshot, url);
  }

  /** URL of the current page, if known. */
  pageUrl(): string | undefined {
    return this.page?.url || undefined;
  }

  /** Absolute URL a link (ref) of the current page points to, if it is one. */
  linkUrl(ref: string): string | undefined {
    const node = this.page?.nodes.find((n) => n.ref === ref);
    if (node?.role !== 'link' || !node.url) return undefined;
    try {
      return new URL(node.url, this.page?.url || undefined).href;
    } catch {
      return undefined;
    }
  }

  /**
   * What an approval asked for now would allow, or why it can't be asked: `ref` must be in the
   * latest snapshot.
   */
  approvalFor(ref?: string): Approval | string {
    const origin = this.page ? originOf(this.page.url) : undefined;
    if (ref === undefined) return { origin };
    const index = this.page?.nodes.findIndex((n) => n.ref === ref) ?? -1;
    const node = this.page?.nodes[index];
    if (!this.page || !node) {
      return `Ref ${ref} is not in the latest page snapshot. Call browser_snapshot and use a ref from it.`;
    }
    const verdict = firstBinding(this.page, index, node.end);
    return { origin, label: 'label' in verdict ? verdict.label : node.label.trim() };
  }

  /** The user approved a confirm_action (straight from their answer). */
  grant(approval: Approval): void {
    this.approval = approval;
  }

  /** No approval stands (a new confirm_action was asked, or the user declined). */
  revoke(): void {
    this.approval = undefined;
  }

  /**
   * Undefined when `action` may go ahead (using up the approval if it is binding); otherwise
   * the explanation for the model.
   */
  check(action: GatedAction): string | undefined {
    const verdict = classifyAction(this.page, action);
    if (!verdict.binding) return undefined;
    const what =
      action.kind === 'click'
        ? `clicking ${action.ref}`
        : action.kind === 'key'
          ? `pressing ${action.key}`
          : 'submitting this form';
    const approval = this.approval;
    const origin = this.page ? originOf(this.page.url) : undefined;
    const label = 'label' in verdict ? verdict.label : undefined;
    const unseen = `it cannot tell whether ${what} is binding, because the latest page snapshot does not show it. Call browser_snapshot and use a ref from it.`;
    let why: string;
    if (approval?.origin && approval.origin !== origin) {
      why = `Blocked by the app: the user's approval was for ${approval.origin}, not this page (${origin ?? 'unknown'}).`;
    } else if (approval && approval.label !== undefined && approval.label !== label) {
      why =
        label === undefined
          ? `Blocked by the app: ${unseen}`
          : `Blocked by the app: the user approved ${quote(approval.label)}, not ${what} (${quote(label)}).`;
    } else if (approval) {
      this.approval = undefined;
      return undefined;
    } else {
      why =
        label === undefined
          ? `Blocked by the app: ${unseen}`
          : `Blocked by the app: ${what} looks binding (${quote(label)}): it may submit, book or cancel an appointment, pay or sign.`;
    }
    return `${why} If it is binding, call confirm_action first (with ref: the element you will click) and a plain summary of exactly what will be sent and to whom, and repeat this action only if the user approves. Each approval allows one binding action on that site. Do not try to work around this.`;
  }
}

function quote(text: string): string {
  return JSON.stringify(text.slice(0, 120));
}
