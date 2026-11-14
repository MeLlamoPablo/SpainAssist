import { z } from 'zod';
import { APPOINTMENT_MAX_SLOTS, APPOINTMENT_MORE, APPOINTMENT_SLOT } from './chat';
import { hiddenFromAgents, PersonalFieldKey } from './vault';

/**
 * Codemode (the `codemode` feature flag): agents write JavaScript workflows instead of calling
 * one tool per step. A workflow is a durable record with a stable id; it serves procedures, keeps
 * memoized results and the state of the interfaces it shows the user, and resumes from them after
 * a restart. Design and decisions: docs/codemode.md.
 *
 * This file holds what main, the agent host and the renderer share: the native UI components a
 * workflow may render (`@spainassist/ui`), the tree it sends, and the records the renderer shows.
 */

// ---------------------------------------------------------------------------------------------
// UI trees
// ---------------------------------------------------------------------------------------------

/** A function prop in a rendered tree: the sandbox keeps the function, the tree only its id. */
export const UiHandler = z.object({ $handler: z.string().min(1).max(400) });
export type UiHandler = z.infer<typeof UiHandler>;

const Label = z.string().min(1).max(200);
const Short = z.string().max(500);
const Handler = UiHandler.optional();
const Option = z.object({
  value: z.string().max(200),
  label: z.string().min(1).max(200),
  description: z.string().max(300).optional(),
});
const MapOption = z.object({
  value: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  /** Street address with number and municipality, located on the map by the app. */
  address: z.string().min(1).max(500),
});
const Tone = z.enum(['default', 'muted', 'info', 'success', 'warning', 'error']);
/**
 * The personal data a field asks for (Mis datos: "email", "custom.<slug>"). When the interface
 * closes, the app saves the field's value there itself (uiTreeAnswers): no checkbox, no agent call.
 */
const VaultKey = PersonalFieldKey.refine((key) => !hiddenFromAgents(key), {
  message: 'is not available to agents',
}).optional();

/**
 * Props of each native component, validated by main before the renderer sees a tree. Values are
 * what the user picks: strings (text, options, dates YYYY-MM-DD, slots YYYY-MM-DDTHH:MM,
 * document ids), string arrays (MultiChoice) and booleans (Checkbox).
 */
export const UI_COMPONENT_PROPS = {
  /** The root the runtime wraps every tree in. */
  Root: z.object({}),
  /** A card with an optional title: the usual outermost component. */
  Form: z.object({ title: Label.optional(), description: Short.optional() }),
  Section: z.object({ title: Label.optional() }),
  /** Plain text (children). Markdown is not interpreted. */
  Text: z.object({ tone: Tone.optional(), size: z.enum(['sm', 'md']).optional() }),
  Callout: z.object({ tone: Tone.optional(), title: Label.optional() }),
  /** Key facts: "Coste: 12 €". */
  Facts: z.object({
    items: z.array(z.object({ label: Label, value: z.string().min(1).max(500) })).max(20),
  }),
  /** An https link the app opens in the user's browser. */
  Link: z.object({
    href: z
      .string()
      .url()
      .max(2000)
      .refine((href) => href.startsWith('https://'), 'Links must be https.'),
  }),
  Divider: z.object({}),
  /** A working indicator, e.g. while the workflow looks up options. */
  Progress: z.object({ label: Label.optional() }),
  TextField: z.object({
    label: Label,
    value: z.string().max(5000).optional(),
    type: z.enum(['text', 'email', 'phone', 'number', 'date', 'textarea']).optional(),
    placeholder: z.string().max(200).optional(),
    help: Short.optional(),
    error: Short.optional(),
    required: z.boolean().optional(),
    disabled: z.boolean().optional(),
    vaultKey: VaultKey,
    onChange: Handler,
  }),
  Select: z.object({
    label: Label,
    options: z.array(Option).max(200),
    value: z.string().max(200).optional(),
    placeholder: z.string().max(200).optional(),
    help: Short.optional(),
    error: Short.optional(),
    required: z.boolean().optional(),
    disabled: z.boolean().optional(),
    vaultKey: VaultKey,
    onChange: Handler,
  }),
  /** One of a few options as buttons ("Mañanas" / "Tardes"). */
  Choice: z.object({
    label: Label.optional(),
    options: z.array(Option).min(1).max(12),
    value: z.string().max(200).optional(),
    help: Short.optional(),
    error: Short.optional(),
    disabled: z.boolean().optional(),
    vaultKey: VaultKey,
    onChange: Handler,
  }),
  MultiChoice: z.object({
    label: Label.optional(),
    options: z.array(Option).min(1).max(50),
    value: z.array(z.string().max(200)).max(50).optional(),
    help: Short.optional(),
    error: Short.optional(),
    disabled: z.boolean().optional(),
    onChange: Handler,
  }),
  Checkbox: z.object({
    label: Label,
    checked: z.boolean().optional(),
    help: Short.optional(),
    disabled: z.boolean().optional(),
    onChange: Handler,
  }),
  /** A Spanish province from the app's list; the value is its name. */
  Province: z.object({
    label: Label.optional(),
    value: z.string().max(100).optional(),
    help: Short.optional(),
    error: Short.optional(),
    vaultKey: VaultKey,
    onChange: Handler,
  }),
  /** A saved document, or one the user adds or scans now; the value is its document id. */
  DocumentPicker: z.object({
    label: Label,
    value: z.string().max(120).optional(),
    help: Short.optional(),
    error: Short.optional(),
    onChange: Handler,
  }),
  /** Places on a map and in a list, closest to the user first; the value is the option's. */
  Map: z.object({
    label: Label.optional(),
    options: z.array(MapOption).min(1).max(50),
    value: z.string().max(200).optional(),
    onChange: Handler,
  }),
  Appointment: z
    .object({
      label: Label.optional(),
      slots: z.array(z.string().regex(APPOINTMENT_SLOT)).min(1).max(APPOINTMENT_MAX_SLOTS),
      value: z.string().max(40).optional(),
      /** Offer "none of these" (the handler gets APPOINTMENT_MORE). */
      allowMore: z.boolean().optional(),
      onChange: Handler,
    })
    // The renderer shows the chosen slot as a date.
    .refine((p) => !p.value || p.value === APPOINTMENT_MORE || p.slots.includes(p.value), {
      path: ['value'],
      message: 'must be one of the slots',
    }),
  /** Buttons, right-aligned. */
  Actions: z.object({}),
  Button: z.object({
    type: z.enum(['primary', 'secondary', 'danger', 'ghost']).optional(),
    disabled: z.boolean().optional(),
    loading: z.boolean().optional(),
    onClick: Handler,
  }),
} as const;

export type UiComponent = keyof typeof UI_COMPONENT_PROPS;
export const UI_COMPONENTS = Object.keys(UI_COMPONENT_PROPS) as UiComponent[];

/** Components that take children (the others ignore them). */
export const UI_CONTAINERS: ReadonlySet<UiComponent> = new Set<UiComponent>([
  'Root',
  'Form',
  'Section',
  'Text',
  'Callout',
  'Link',
  'Actions',
  'Button',
]);

export type UiElement = {
  type: UiComponent;
  props: Record<string, unknown>;
  children: UiNode[];
};
export type UiNode = string | UiElement;

export const UI_LIMITS = {
  /** Nodes in one tree. */
  nodes: 600,
  depth: 24,
  /** Serialized size of one tree. */
  bytes: 256 * 1024,
  /** Distinct map addresses in one tree (main looks each one up before showing it). */
  addresses: 50,
} as const;

/**
 * Checks a tree from a workflow: known components, valid props, within limits. Returns the
 * first problem in plain words, or null. Main runs it on every tree before the renderer sees it.
 */
export function uiTreeProblem(tree: unknown): string | null {
  let nodes = 0;
  const addresses = new Set<string>();
  const visit = (node: unknown, depth: number, path: string): string | null => {
    if (++nodes > UI_LIMITS.nodes) return `The interface has more than ${UI_LIMITS.nodes} parts.`;
    if (depth > UI_LIMITS.depth) return `The interface nests deeper than ${UI_LIMITS.depth}.`;
    if (typeof node === 'string') return node.length > 5000 ? `${path}: text too long.` : null;
    if (!node || typeof node !== 'object') return `${path}: not a component.`;
    const { type, props, children } = node as Partial<UiElement>;
    if (typeof type !== 'string' || !Object.hasOwn(UI_COMPONENT_PROPS, type))
      return `${path}: unknown component "${String(type)}".`;
    // The renderer reads props by name: they must be there, even empty.
    if (!props || typeof props !== 'object' || Array.isArray(props))
      return `${path} <${type}>: props must be an object.`;
    const schema = UI_COMPONENT_PROPS[type as UiComponent];
    const parsed = schema.safeParse(props);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return `${path} <${type}>: ${issue?.path.join('.') || 'props'} ${issue?.message ?? 'invalid'}.`;
    }
    if (type === 'Map') {
      for (const option of (props as { options: { address: string }[] }).options)
        addresses.add(option.address);
      if (addresses.size > UI_LIMITS.addresses)
        return `The interface's maps have more than ${UI_LIMITS.addresses} places.`;
    }
    if (!Array.isArray(children)) return `${path} <${type}>: children must be a list.`;
    for (const [i, child] of children.entries()) {
      const problem = visit(child, depth + 1, `${path}/${type}[${i}]`);
      if (problem) return problem;
    }
    return null;
  };
  try {
    if (JSON.stringify(tree).length > UI_LIMITS.bytes) return 'The interface is too large.';
  } catch {
    return 'The interface is not serializable.';
  }
  const problem = visit(tree, 0, 'root');
  if (problem) return problem;
  // An empty card would wait for an answer the user has no way to give.
  const { children } = tree as UiElement;
  if (!children.some((c) => typeof c !== 'string' || c.trim()))
    return 'The interface shows nothing: its render function returned null or no components. Return what the user should see, e.g. <Form>…</Form>.';
  return null;
}

/** Every address of the Map components of a tree (the only ones main looks up for it). */
export function uiTreeAddresses(tree: UiNode): string[] {
  const out: string[] = [];
  const visit = (node: UiNode) => {
    if (typeof node === 'string') return;
    if (node.type === 'Map') {
      const options = (node.props.options ?? []) as { address?: string }[];
      for (const option of options) if (option.address) out.push(option.address);
    }
    for (const child of node.children) visit(child);
  };
  visit(tree);
  return [...new Set(out)];
}

/** A value an interface saves to Mis datos (`vaultKey`). */
export interface UiAnswer {
  key: string;
  value: string;
  /** The field's label, for a "custom.<slug>" key. */
  label?: string;
}

/**
 * What a closing interface saves to Mis datos, from its last tree: the value of every field with
 * a `vaultKey` that the user filled in and the workflow doesn't flag (`error`). The last field of
 * a key wins.
 */
export function uiTreeAnswers(tree: UiNode | undefined): UiAnswer[] {
  const answers = new Map<string, UiAnswer>();
  const visit = (node: UiNode) => {
    if (typeof node === 'string') return;
    const { vaultKey, value, error, label } = node.props as Record<string, unknown>;
    if (typeof vaultKey === 'string' && typeof value === 'string' && value.trim() && !error)
      answers.set(vaultKey, {
        key: vaultKey,
        value: value.trim(),
        ...(vaultKey.startsWith('custom.') && typeof label === 'string' ? { label } : {}),
      });
    for (const child of node.children) visit(child);
  };
  if (tree) visit(tree);
  return [...answers.values()];
}

/** An event the user caused on a rendered tree, sent back to the workflow. */
export const UiEvent = z.object({
  /** The handler id from the tree (`{$handler}`). */
  handler: z.string().min(1).max(400),
  /** Revision of the tree the user acted on. */
  rev: z.number().int().nonnegative(),
  /** The new value (onChange), absent for clicks. */
  value: z
    .union([z.string().max(10_000), z.array(z.string().max(200)).max(50), z.boolean()])
    .optional(),
});
export type UiEvent = z.infer<typeof UiEvent>;

/**
 * The handler of the event main sends a run when the app could not draw one of its interfaces
 * (`value`: what failed). The kernel fails that interface's `present`, as if it had been refused.
 * Real handler ids always contain "#".
 */
export const UI_FAILED = '$failed';

// ---------------------------------------------------------------------------------------------
// Workflows and agents, as the renderer sees them
// ---------------------------------------------------------------------------------------------

/** A stable, model-chosen name: lower-case letters, digits and dashes. */
export const CodemodeSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lower-case letters, digits and dashes.');

export const WorkflowStatus = z.enum([
  'running',
  /** Blocked on the user (an interface is open); safe to resume from its state. */
  'waiting_user',
  'succeeded',
  'failed',
  'cancelled',
  /** Its process ended while it ran; memoized steps are kept, the owner decides what's next. */
  'interrupted',
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatus>;

/** An interface a workflow shows the user (`api.ui.present`). */
export interface WorkflowUi {
  key: string;
  status: 'open' | 'closed';
  /** Latest tree; open interfaces only. */
  tree?: UiNode;
  rev: number;
  openedAt: string;
}

export interface WorkflowInfo {
  id: string;
  title?: string;
  status: WorkflowStatus;
  /** The agent that last ran it. */
  agentId: string;
  /**
   * Open interfaces only, oldest first. Not tied to procedures: the renderer shows them in
   * "Para ti" without saying which procedures their workflow serves (docs/codemode.md, decision 5).
   */
  ui: WorkflowUi[];
  /** Whether a process is executing it right now (events reach it at once). */
  attached: boolean;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export const CodemodeAgentKind = z.enum(['orchestrator', 'agent']);
export type CodemodeAgentKind = z.infer<typeof CodemodeAgentKind>;

/** An agent of the codemode harness, independent of procedures (the progress meter). */
export interface CodemodeAgentInfo {
  id: string;
  kind: CodemodeAgentKind;
  /** What the agent is doing now, as an ongoing action in the user's language ("Analizando la página de Correos…"). */
  status: string;
  /** The agent that started it (the orchestrator). */
  parentId?: string;
  activity: 'idle' | 'working' | 'waiting_user';
  /** What it is doing right now, in plain words ("Navegando por sede.policia.gob.es"). */
  now?: string;
  /** When the current stretch of work started (ISO), while working. */
  since?: string;
  /** Procedures it has touched, most recent first. */
  procedures: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
