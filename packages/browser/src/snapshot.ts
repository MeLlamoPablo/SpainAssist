/**
 * Renders `page.ariaSnapshotJSON({ mode: 'ai' })` (Playwright 1.63) as the YAML-like text the
 * model sees, with:
 *  - masking: secrets typed by the app and values of password fields become "••••";
 *  - a size budget: when the page is too big, content is removed in passes, least useful first
 *    (wrapper divs, long texts, long option lists, menus/footers/cookie-banner text, repetitive
 *    lists, plain text, links) while form controls, buttons, headings, alerts and dialogs stay.
 *
 * The unpruned format matches Playwright's own renderer (packages/isomorphic/
 * ariaSnapshotRenderer.ts) so refs and syntax look exactly like `page.ariaSnapshot()`. Dropping
 * nodes from the text never invalidates refs: they resolve against the browser-side snapshot.
 */
import { MASK } from './errors';

/** Node of `ariaSnapshotJSON({ mode: 'ai' })`. */
export interface AriaJsonNode {
  role: string;
  name?: string;
  text?: string;
  children?: Array<AriaJsonNode | string>;
  ref?: string;
  cursor?: string;
  url?: string;
  placeholder?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  active?: boolean;
  invalid?: boolean | string;
  level?: number;
  pressed?: boolean | 'mixed';
  selected?: boolean;
  ariaHidden?: boolean;
}

interface ElNode {
  kind: 'el';
  role: string;
  name: string;
  /** Single text child / input value. */
  value?: string;
  children: TNode[];
  ref?: string;
  cursor?: string;
  url?: string;
  placeholder?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  active?: boolean;
  invalid?: boolean | string;
  level?: number;
  pressed?: boolean | 'mixed';
  selected?: boolean;
  ariaHidden?: boolean;
  /** Set on the root of a boilerplate region (menus, footer, cookie banner...). */
  region?: string;
}
interface TextNode {
  kind: 'text';
  text: string;
}
interface CommentNode {
  kind: 'comment';
  text: string;
  /** Content this comment stands for (so later passes can report accurate totals). */
  links?: number;
  texts?: number;
}
type TNode = ElNode | TextNode | CommentNode;

export interface RenderOptions {
  /** Max characters of the rendered snapshot. */
  budget: number;
  /** Exact strings to mask everywhere (secrets typed by the app, with encoded variants). */
  secrets?: readonly string[];
  /** Current values of password inputs: masked in text fields (and elsewhere when >= 3 chars). */
  passwordValues?: readonly string[];
}

export interface RefMeta {
  role: string;
  name: string;
}

export interface RenderResult {
  text: string;
  truncated: boolean;
  /** Every ref of the (masked, unpruned) snapshot. */
  refs: Map<string, RefMeta>;
  /** All visible text of the snapshot (masked), for heuristics such as error-page detection. */
  fullText: string;
}

const TEXT_INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const CONTROL_ROLES = new Set([
  'button',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
]);
/** Kept with all their content (error messages, modal dialogs). */
const KEEP_WHOLE_ROLES = new Set(['alert', 'alertdialog', 'status', 'dialog', 'heading']);
const BOILERPLATE_ROLES: Record<string, string> = {
  navigation: 'navigation',
  contentinfo: 'footer',
  complementary: 'sidebar',
  menubar: 'menu',
  menu: 'menu',
  banner: 'header',
};

// --- YAML helpers (same rules as Playwright's isomorphic/yaml.ts) -----------------------------

function yamlStringNeedsQuotes(str: string): boolean {
  if (str.length === 0) return true;
  if (/^\s|\s$/.test(str)) return true;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors Playwright's YAML rules
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(str)) return true;
  if (/^-/.test(str)) return true;
  if (/[\n:](\s|$)/.test(str)) return true;
  if (/\s#/.test(str)) return true;
  if (/[\n\r]/.test(str)) return true;
  if (/^[&*\],?!>|@"'#%]/.test(str)) return true;
  if (/[{}`]/.test(str)) return true;
  if (/^\[/.test(str)) return true;
  if (
    !Number.isNaN(Number(str)) ||
    ['y', 'n', 'yes', 'no', 'true', 'false', 'on', 'off', 'null'].includes(str.toLowerCase())
  )
    return true;
  return false;
}

function yamlEscapeKeyIfNeeded(str: string): string {
  if (!yamlStringNeedsQuotes(str)) return str;
  return `'${str.replace(/'/g, "''")}'`;
}

function yamlEscapeValueIfNeeded(str: string): string {
  if (!yamlStringNeedsQuotes(str)) return str;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors Playwright's YAML rules
  const escaped = str.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
    }
  });
  return `"${escaped}"`;
}

// --- Parsing + masking ------------------------------------------------------------------------

class Masker {
  private readonly global: string[];
  private readonly passwords: string[];
  constructor(secrets: readonly string[], passwordValues: readonly string[]) {
    this.passwords = passwordValues.filter((p) => p.length > 0);
    const global = new Set<string>(secrets.filter((s) => s.length > 0));
    for (const p of this.passwords) if (p.length >= 3) global.add(p);
    this.global = [...global].sort((a, b) => b.length - a.length);
  }
  text(s: string): string {
    let out = s;
    for (const secret of this.global) if (out.includes(secret)) out = out.split(secret).join(MASK);
    return out;
  }
  value(role: string, s: string): string {
    if (s && TEXT_INPUT_ROLES.has(role)) {
      for (const p of this.passwords) {
        // Prefix matches cover a user typing in the password field while we snapshot.
        if (p === s || p.startsWith(s) || s.startsWith(p)) return MASK;
      }
    }
    return this.text(s);
  }
}

function convert(item: unknown, masker: Masker): TNode | null {
  if (typeof item === 'string') return { kind: 'text', text: masker.text(item) };
  if (!item || typeof item !== 'object') return null;
  const n = item as AriaJsonNode;
  if (n.role === 'text') return { kind: 'text', text: masker.text(n.text ?? '') };
  const el: ElNode = {
    kind: 'el',
    role: String(n.role ?? 'generic'),
    name: masker.text(n.name ?? ''),
    children: [],
  };
  if (n.text !== undefined) el.value = masker.value(el.role, String(n.text));
  if (n.ref !== undefined) el.ref = n.ref;
  if (n.cursor !== undefined) el.cursor = n.cursor;
  if (n.url !== undefined) el.url = masker.text(String(n.url));
  if (n.placeholder !== undefined) el.placeholder = masker.text(String(n.placeholder));
  if (n.checked !== undefined) el.checked = n.checked;
  if (n.disabled) el.disabled = true;
  if (n.expanded) el.expanded = true;
  if (n.active) el.active = true;
  if (n.invalid !== undefined) el.invalid = n.invalid;
  if (n.level !== undefined) el.level = n.level;
  if (n.pressed !== undefined) el.pressed = n.pressed;
  if (n.selected) el.selected = true;
  if (n.ariaHidden) el.ariaHidden = true;
  for (const child of n.children ?? []) {
    const c = convert(child, masker);
    if (c) el.children.push(c);
  }
  return el;
}

// --- Rendering --------------------------------------------------------------------------------

function createKey(node: ElNode): string {
  let key = node.role;
  if (node.name && node.name.length <= 900) {
    const name = node.name;
    const stringified = name.startsWith('/') && name.endsWith('/') ? name : JSON.stringify(name);
    key += ` ${stringified}`;
  }
  if (node.checked === 'mixed') key += ' [checked=mixed]';
  if (node.checked === true) key += ' [checked]';
  if (node.disabled) key += ' [disabled]';
  if (node.expanded) key += ' [expanded]';
  if (node.active) key += ' [active]';
  if (node.invalid === 'grammar' || node.invalid === 'spelling')
    key += ` [invalid=${node.invalid}]`;
  if (node.invalid === true) key += ' [invalid]';
  if (node.level) key += ` [level=${node.level}]`;
  if (node.pressed === 'mixed') key += ' [pressed=mixed]';
  if (node.pressed === true) key += ' [pressed]';
  if (node.selected === true) key += ' [selected]';
  if (node.ariaHidden) key += ' [aria-hidden]';
  if (node.ref) {
    key += ` [ref=${node.ref}]`;
    if (node.cursor === 'pointer') key += ' [cursor=pointer]';
  }
  return key;
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function renderNodes(nodes: readonly TNode[], depth: number, lines: string[]): void {
  for (const node of nodes) {
    if (node.kind === 'text') {
      if (node.text) lines.push(`${indent(depth)}- text: ${yamlEscapeValueIfNeeded(node.text)}`);
      continue;
    }
    if (node.kind === 'comment') {
      lines.push(`${indent(depth)}# ${node.text}`);
      continue;
    }
    const key = `${indent(depth)}- ${yamlEscapeKeyIfNeeded(createKey(node))}`;
    const props: [string, string][] = [];
    if (node.url !== undefined) props.push(['url', node.url]);
    if (node.placeholder !== undefined) props.push(['placeholder', node.placeholder]);
    if (node.value === undefined && !props.length && !node.children.length) {
      lines.push(key);
    } else if (node.value !== undefined && !props.length) {
      lines.push(`${key}: ${yamlEscapeValueIfNeeded(node.value)}`);
    } else {
      lines.push(`${key}:`);
      for (const [name, value] of props)
        lines.push(`${indent(depth + 1)}- /${name}: ${yamlEscapeValueIfNeeded(value)}`);
      if (node.value !== undefined) {
        if (node.value)
          lines.push(`${indent(depth + 1)}- text: ${yamlEscapeValueIfNeeded(node.value)}`);
      } else {
        renderNodes(node.children, depth + 1, lines);
      }
    }
  }
}

function render(root: ElNode): string[] {
  const lines: string[] = [];
  renderNodes(root.children, 0, lines);
  return lines;
}

function size(lines: readonly string[]): number {
  let n = 0;
  for (const l of lines) n += l.length + 1;
  return Math.max(0, n - 1);
}

// --- Analysis helpers -------------------------------------------------------------------------

function* walk(node: ElNode): Generator<ElNode> {
  yield node;
  for (const c of node.children) if (c.kind === 'el') yield* walk(c);
}

function isEssential(node: ElNode): boolean {
  return (
    CONTROL_ROLES.has(node.role) ||
    KEEP_WHOLE_ROLES.has(node.role) ||
    node.role === 'iframe' ||
    !!node.active ||
    (node.cursor === 'pointer' && node.role !== 'link' && node.role !== 'menuitem') ||
    (node.role === 'img' && /captcha/i.test(node.name))
  );
}

function hasEssentialDescendant(node: ElNode): boolean {
  for (const c of node.children) {
    if (c.kind !== 'el') continue;
    if (isEssential(c) || hasEssentialDescendant(c)) return true;
  }
  return false;
}

function textOf(node: TNode, out: string[], limit: { left: number }): void {
  if (limit.left <= 0) return;
  if (node.kind === 'text') {
    out.push(node.text);
    limit.left -= node.text.length;
    return;
  }
  if (node.kind === 'comment') return;
  if (node.name) {
    out.push(node.name);
    limit.left -= node.name.length;
  }
  if (node.value) {
    out.push(node.value);
    limit.left -= node.value.length;
  }
  for (const c of node.children) textOf(c, out, limit);
}

const COOKIE_WORD = /\bcookies?\b/i;

/** Marks menus/footers/sidebars/headers and the smallest container that looks like a cookie banner. */
function markRegions(root: ElNode): void {
  const visit = (node: ElNode, inRegion: boolean): void => {
    let here = inRegion;
    if (!inRegion && node !== root && BOILERPLATE_ROLES[node.role]) {
      node.region = BOILERPLATE_ROLES[node.role];
      here = true;
    }
    for (const c of node.children) if (c.kind === 'el') visit(c, here);
  };
  visit(root, false);

  // Cookie banners: the smallest subtree that mentions cookies, has little text (<= 3000 chars)
  // and a few controls (1-10). Computed bottom-up in one pass.
  interface Info {
    textLen: number;
    cookie: boolean;
    controls: number;
    banner: boolean;
  }
  const info = (node: ElNode): Info => {
    let textLen = node.name.length + (node.value?.length ?? 0);
    let cookie = COOKIE_WORD.test(node.name) || (!!node.value && COOKIE_WORD.test(node.value));
    let controls = 0;
    let banner = false;
    for (const c of node.children) {
      if (c.kind === 'text') {
        textLen += c.text.length;
        if (!cookie && COOKIE_WORD.test(c.text)) cookie = true;
      } else if (c.kind === 'el') {
        const ci = info(c);
        textLen = Math.min(textLen + ci.textLen, 100_000);
        cookie ||= ci.cookie;
        controls += ci.controls + (CONTROL_ROLES.has(c.role) || c.role === 'link' ? 1 : 0);
        banner ||= ci.banner;
      }
    }
    const eligibleRole =
      node !== root && !(KEEP_WHOLE_ROLES.has(node.role) && !node.role.endsWith('dialog'));
    if (!banner && eligibleRole && cookie && textLen <= 3000 && controls >= 1 && controls <= 10) {
      node.region = 'cookie banner';
      banner = true;
    }
    return { textLen, cookie, controls, banner };
  };
  info(root);
}

// --- Passes -----------------------------------------------------------------------------------

interface PassState {
  lossy: boolean;
}

/** Removes anonymous wrapper divs (generic without name/pointer/focus), keeping their content. */
function unwrapGenerics(node: ElNode): void {
  const out: TNode[] = [];
  for (const c of node.children) {
    if (c.kind !== 'el') {
      out.push(c);
      continue;
    }
    unwrapGenerics(c);
    if (c.role === 'generic' && !c.name && c.cursor !== 'pointer' && !c.active && !c.region) {
      if (c.value !== undefined && c.value !== '') out.push({ kind: 'text', text: c.value });
      out.push(...c.children);
      continue;
    }
    out.push(c);
  }
  node.children = out;
}

function cloneTree(node: ElNode): ElNode {
  return {
    ...node,
    children: node.children.map((c) => (c.kind === 'el' ? cloneTree(c) : { ...c })),
  };
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function trimStrings(
  node: ElNode,
  limits: { text: number; name: number; url: number; dropUrls?: boolean },
  state: PassState,
): void {
  if (node.name.length > limits.name) {
    node.name = cut(node.name, limits.name);
    state.lossy = true;
  }
  if (node.value !== undefined && node.value.length > limits.text && node.value !== MASK) {
    node.value = cut(node.value, limits.text);
    state.lossy = true;
  }
  if (node.url !== undefined) {
    if (limits.dropUrls && node.role === 'link') {
      node.url = undefined;
      state.lossy = true;
    } else if (node.url.length > limits.url) {
      node.url = cut(node.url, limits.url);
      state.lossy = true;
    }
  }
  for (const c of node.children) {
    if (c.kind === 'text' && c.text.length > limits.text) {
      c.text = cut(c.text, limits.text);
      state.lossy = true;
    } else if (c.kind === 'el') {
      trimStrings(c, limits, state);
    }
  }
}

/** Long option lists: keep the selected ones, the first few and the last one. */
function collapseOptions(root: ElNode, state: PassState): void {
  for (const node of walk(root)) {
    if (node.role !== 'combobox' && node.role !== 'listbox') continue;
    const options = node.children.filter(
      (c): c is ElNode => c.kind === 'el' && c.role === 'option',
    );
    if (options.length <= 12) continue;
    const keep = new Set<ElNode>([...options.slice(0, 8), options[options.length - 1]!]);
    for (const o of options) if (o.selected) keep.add(o);
    const out: TNode[] = [];
    let hidden = 0;
    let commentAt = -1;
    for (const c of node.children) {
      if (c.kind === 'el' && c.role === 'option' && !keep.has(c)) {
        hidden++;
        if (commentAt < 0) commentAt = out.length;
        continue;
      }
      out.push(c);
    }
    if (hidden) {
      out.splice(commentAt, 0, {
        kind: 'comment',
        text: `… ${hidden} more options (select them by their text with browser_select)`,
      });
      node.children = out;
      state.lossy = true;
    }
  }
}

/** Runs of >= minRun siblings with the same role: keep head/tail, summarize the middle. */
function collapseRuns(
  node: ElNode,
  opts: { minRun: number; head: number; tail: number; onlyInRegions: boolean; inRegion?: boolean },
  state: PassState,
): void {
  const inRegion = opts.inRegion || !!node.region;
  const children = node.children;
  const out: TNode[] = [];
  let i = 0;
  while (i < children.length) {
    const c = children[i]!;
    if (c.kind !== 'el') {
      out.push(c);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < children.length) {
      const d = children[j]!;
      if (d.kind !== 'el' || d.role !== c.role) break;
      j++;
    }
    const run = children.slice(i, j) as ElNode[];
    const eligible =
      run.length >= opts.minRun &&
      (!opts.onlyInRegions || inRegion) &&
      (inRegion || !run.some((r) => isEssential(r) || hasEssentialDescendant(r)));
    if (eligible) {
      const hiddenNodes = run.slice(opts.head, run.length - opts.tail);
      const counts = countContent(hiddenNodes);
      out.push(...run.slice(0, opts.head));
      out.push({
        kind: 'comment',
        text: `… ${hiddenNodes.length} more ${c.role} items`,
        links: counts.links,
        texts: counts.texts,
      });
      if (opts.tail) out.push(...run.slice(run.length - opts.tail));
      state.lossy = true;
    } else {
      out.push(...run);
    }
    i = j;
  }
  node.children = out;
  for (const c of node.children) if (c.kind === 'el') collapseRuns(c, { ...opts, inRegion }, state);
}

interface PruneCounts {
  links: number;
  texts: number;
}

/** Links and pieces of text in `nodes` (including what earlier comments stand for). */
function countContent(
  nodes: readonly TNode[],
  counts: PruneCounts = { links: 0, texts: 0 },
): PruneCounts {
  for (const n of nodes) {
    if (n.kind === 'text') {
      if (n.text.trim()) counts.texts++;
    } else if (n.kind === 'comment') {
      counts.links += n.links ?? 0;
      counts.texts += n.texts ?? 0;
    } else if (n.role === 'link') {
      counts.links++;
    } else {
      if (n.value?.trim()) counts.texts++;
      countContent(n.children, counts);
    }
  }
  return counts;
}

/**
 * Removes non-essential content below `node`, keeping essential nodes (controls, headings,
 * alerts, dialogs, iframes...) and the containers leading to them. Returns whether the node
 * itself must be kept.
 */
function prune(node: ElNode, opts: { keepLinks: boolean }, counts: PruneCounts): boolean {
  const cookieBanner = node.region === 'cookie banner';
  if (KEEP_WHOLE_ROLES.has(node.role) && !cookieBanner) return true;
  if (CONTROL_ROLES.has(node.role)) return true;
  if (node.role === 'link') return opts.keepLinks; // counted by the caller when dropped
  let anyKept = false;
  const out: TNode[] = [];
  const commented: PruneCounts = { links: 0, texts: 0 };
  for (const c of node.children) {
    if (c.kind === 'comment') {
      out.push(c);
      commented.links += c.links ?? 0;
      commented.texts += c.texts ?? 0;
    } else if (c.kind === 'text') {
      if (c.text.trim()) counts.texts++;
    } else {
      const childOpts = cookieBanner ? { keepLinks: false } : opts;
      if (prune(c, childOpts, counts)) {
        out.push(c);
        anyKept = true;
      } else if (c.role === 'link') {
        counts.links++;
      } else if (c.value || (c.name && !c.children.length)) {
        counts.texts++;
      }
    }
  }
  node.children = out;
  if (node.value !== undefined && !isEssential(node)) {
    if (node.value.trim()) counts.texts++;
    node.value = undefined;
  }
  const kept = anyKept || isEssential(node);
  if (!kept) {
    // Comments inside a dropped container: fold what they stood for into the totals.
    counts.links += commented.links;
    counts.texts += commented.texts;
  }
  return kept;
}

function summary(counts: PruneCounts, where: string): string {
  const parts: string[] = [];
  if (counts.links) parts.push(`${counts.links} links`);
  if (counts.texts) parts.push(`${counts.texts} texts`);
  return `${parts.join(' and ')} hidden (${where}) to fit the size limit`;
}

function pruneRegions(root: ElNode, minSize: number, state: PassState): void {
  for (const node of [...walk(root)]) {
    if (!node.region) continue;
    const lines: string[] = [];
    renderNodes([node], 0, lines);
    if (size(lines) < minSize) continue;
    const counts: PruneCounts = { links: 0, texts: 0 };
    const kind = node.region;
    // Nested regions are handled as part of this one.
    for (const d of walk(node)) if (d !== node) d.region = undefined;
    prune(node, { keepLinks: false }, counts);
    node.region = kind;
    if (counts.links || counts.texts) {
      node.children.unshift({ kind: 'comment', text: summary(counts, kind ?? 'region') });
      state.lossy = true;
    }
  }
}

function pruneMain(root: ElNode, keepLinks: boolean, state: PassState): void {
  const counts: PruneCounts = { links: 0, texts: 0 };
  const out: TNode[] = [];
  for (const c of root.children) {
    if (c.kind === 'el') {
      if (c.region || prune(c, { keepLinks }, counts)) out.push(c);
      else if (c.role === 'link') counts.links++;
      else if (c.value || c.name) counts.texts++;
    } else if (c.kind === 'text') {
      if (c.text.trim()) counts.texts++;
    } else {
      out.push(c);
    }
  }
  root.children = out;
  if (counts.links || counts.texts) {
    root.children.unshift({ kind: 'comment', text: summary(counts, 'page content') });
    state.lossy = true;
  }
}

function hardCut(lines: string[], budget: number): string {
  const out: string[] = [];
  let used = 0;
  const reserve = 60;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (used + line.length + 1 > budget - reserve) {
      const rest = lines.length - i;
      out.push(`# … ${rest} more lines not shown (size limit)`);
      return out.join('\n').slice(0, budget);
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

// --- Entry point ------------------------------------------------------------------------------

/** Renders the snapshot JSON within `budget` characters. */
export function renderSnapshot(json: unknown, opts: RenderOptions): RenderResult {
  const masker = new Masker(opts.secrets ?? [], opts.passwordValues ?? []);
  const root: ElNode = { kind: 'el', role: 'fragment', name: '', children: [] };
  for (const item of Array.isArray(json) ? json : []) {
    const c = convert(item, masker);
    if (c) root.children.push(c);
  }

  const refs = new Map<string, RefMeta>();
  for (const n of walk(root)) if (n.ref) refs.set(n.ref, { role: n.role, name: n.name });
  const textParts: string[] = [];
  textOf(root, textParts, { left: 200_000 });
  const fullText = textParts.join('\n');

  const budget = Math.max(200, opts.budget);
  let lines = render(root);
  if (size(lines) <= budget) return { text: lines.join('\n'), truncated: false, refs, fullText };

  markRegions(root);
  type Pass = (tree: ElNode, state: PassState) => void;
  // Each step lists variants from mild to aggressive; variants are tried on copies and the
  // first one that fits wins (so content is not cut more than needed).
  const steps: Pass[][] = [
    // 1. Wrapper divs and very long strings.
    [
      (tree, st) => {
        unwrapGenerics(tree);
        trimStrings(tree, { text: 600, name: 300, url: 200 }, st);
      },
    ],
    // 2. Long option lists and repetitive lists inside menus/footers.
    [
      (tree, st) => {
        collapseOptions(tree, st);
        collapseRuns(tree, { minRun: 10, head: 4, tail: 0, onlyInRegions: true }, st);
      },
    ],
    // 3. Menus, footers, sidebars, big headers, cookie-banner text: keep only their controls.
    [(tree, st) => pruneRegions(tree, 300, st)],
    // 4. Repetitive lists in the content (rows, paragraphs, results...).
    [30, 15, 8, 4].map(
      (head): Pass =>
        (tree, st) =>
          collapseRuns(tree, { minRun: head + 6, head, tail: 1, onlyInRegions: false }, st),
    ),
    // 5. Shorter texts, no link URLs.
    [(tree, st) => trimStrings(tree, { text: 200, name: 150, url: 120, dropUrls: true }, st)],
    // 6. Plain text in the content (links, controls, headings, alerts stay).
    [(tree, st) => pruneMain(tree, true, st)],
    // 7. Links in the content too.
    [(tree, st) => pruneMain(tree, false, st)],
  ];
  let current = root;
  let state: PassState = { lossy: false };
  for (const variants of steps) {
    let candidate = current;
    let candidateState = state;
    for (const variant of variants) {
      candidate = variants.length > 1 ? cloneTree(current) : current;
      candidateState = { ...state };
      variant(candidate, candidateState);
      lines = render(candidate);
      if (size(lines) <= budget) {
        return { text: lines.join('\n'), truncated: candidateState.lossy, refs, fullText };
      }
    }
    current = candidate;
    state = candidateState;
  }
  return { text: hardCut(lines, budget), truncated: true, refs, fullText };
}
