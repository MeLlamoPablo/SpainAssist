import { validateMatcher } from '../answers/matcher';
import type { Condition, Observation, Rule } from '../contracts';
import { parsePath } from './path';

/**
 * A condition compiled into a tree. Leaves are told apart by what they depend on:
 *
 * - observation leaves (`toolCall`, `toolResult`, `prose`, `prompt`, `net`) are decided by single observations
 *   and are monotone: once seen, always true. The engine tracks them as they arrive.
 * - state leaves (`bench`, `vaultDocument`, `secretLeak`, `custom`, and `net` with `exfil`) read
 *   the run's current state and are sampled by `RuleEngine.evaluate`.
 */

/** What a state leaf reads. An observation that may change it marks the dependency dirty. */
export type Dep = 'bench' | 'vault' | 'secret' | 'custom';

export const ALL_DEPS: readonly Dep[] = ['bench', 'vault', 'secret', 'custom'];

type ObservationLeafKind = 'toolCall' | 'toolResult' | 'prose' | 'prompt' | 'net';
type StateLeafKind = 'exfil' | 'bench' | 'vault' | 'secret' | 'custom';

export interface LeafNode {
  op: 'leaf';
  /** `<ruleId>#<path in the condition tree>`: stable across runs, used by checkpoints. */
  id: string;
  kind: ObservationLeafKind | StateLeafKind;
  condition: Condition;
  /** State leaves only. */
  deps: readonly Dep[];
}

interface GroupNode {
  op: 'all' | 'any';
  id: string;
  kids: Node[];
}

interface NotNode {
  op: 'not';
  id: string;
  kid: Node;
}

export type Node = LeafNode | GroupNode | NotNode;

/**
 * The observation type that decides a leaf, if any. `exfil` leaves are decided by bench
 * observations of exfiltration and also by the bench state.
 */
export function observationTypeOf(kind: LeafNode['kind']): Observation['type'] | undefined {
  switch (kind) {
    case 'toolCall':
      return 'tool_start';
    case 'toolResult':
      return 'tool_end';
    case 'prose':
      return 'assistant_message';
    case 'prompt':
      return 'prompt_shown';
    case 'net':
      return 'net';
    case 'exfil':
      return 'bench';
    default:
      return undefined;
  }
}

export function isStateLeaf(kind: LeafNode['kind']): kind is StateLeafKind {
  return (
    kind !== 'toolCall' &&
    kind !== 'toolResult' &&
    kind !== 'prose' &&
    kind !== 'prompt' &&
    kind !== 'net'
  );
}

/** Compiles and validates a condition. Throws a descriptive error for an invalid one. */
export function compileCondition(condition: Condition, id: string): Node {
  const leaf = (kind: LeafNode['kind'], deps: readonly Dep[] = []): LeafNode => ({
    op: 'leaf',
    id,
    kind,
    condition,
    deps,
  });
  switch (condition.type) {
    case 'toolCall': {
      if (
        typeof condition.tool === 'string'
          ? condition.tool === ''
          : !(condition.tool instanceof RegExp)
      ) {
        throw new Error('toolCall needs a tool name or a regex');
      }
      for (const key of Object.keys(condition.args ?? {})) if (key !== '*') parsePath(key);
      return leaf('toolCall');
    }
    case 'toolResult': {
      if (!(condition.matches instanceof RegExp)) throw new Error('toolResult needs a regex');
      const { tool } = condition;
      if (
        tool !== undefined &&
        (typeof tool === 'string' ? tool === '' : !(tool instanceof RegExp))
      ) {
        throw new Error('toolResult needs a tool name or a regex when it names a tool');
      }
      return leaf('toolResult');
    }
    case 'prose':
      if (!(condition.matches instanceof RegExp)) throw new Error('prose needs a regex');
      return leaf('prose');
    case 'prompt': {
      const issues = validateMatcher(condition.match, 'prompt');
      if (issues.length > 0) throw new Error(issues.join('; '));
      return leaf('prompt');
    }
    case 'net': {
      const where = condition.where;
      if (where.exfil === false) {
        throw new Error('net.exfil can only be true: negate the rule to ask for no exfiltration');
      }
      if (where.exfil && (where.route !== undefined || where.channel !== undefined)) {
        throw new Error('net.exfil cannot be combined with route or channel');
      }
      return where.exfil ? leaf('exfil', ['bench']) : leaf('net');
    }
    case 'bench':
      parsePath(condition.path);
      return leaf('bench', ['bench']);
    case 'vaultDocument': {
      const spec = condition.where.pdfCsvMatchesBenchDownload;
      if (spec) {
        if (!spec.site) throw new Error('vaultDocument.pdfCsvMatchesBenchDownload needs a site');
        for (const key of Object.keys(spec.where)) parsePath(key);
      }
      return leaf('vault', spec ? ['vault', 'bench'] : ['vault']);
    }
    case 'secretLeak':
      return leaf('secret', ['secret']);
    case 'custom':
      if (!condition.name) throw new Error('custom conditions need a name');
      if (typeof condition.test !== 'function') {
        throw new Error(`custom condition "${condition.name}" needs a test function`);
      }
      return leaf('custom', ['custom']);
    case 'all':
    case 'any': {
      if (!Array.isArray(condition.of) || condition.of.length === 0) {
        throw new Error(`${condition.type} needs at least one condition`);
      }
      return {
        op: condition.type,
        id,
        kids: condition.of.map((child, index) => compileCondition(child, childId(id, index))),
      };
    }
    case 'not':
      if (!condition.of) throw new Error('not needs a condition');
      return { op: 'not', id, kid: compileCondition(condition.of, childId(id, 0)) };
    default:
      throw new Error(`Unknown condition type ${String((condition as { type?: unknown }).type)}`);
  }
}

function childId(parent: string, index: number): string {
  return parent.endsWith('#') ? `${parent}${index}` : `${parent}.${index}`;
}

/** The root id of a rule's tree. */
export function rootId(ruleId: string): string {
  return `${ruleId}#`;
}

export function* leavesOf(node: Node): Generator<LeafNode> {
  if (node.op === 'leaf') yield node;
  else if (node.op === 'not') yield* leavesOf(node.kid);
  else for (const kid of node.kids) yield* leavesOf(kid);
}

/** Problems of one rule, empty when it is valid. */
export function validateRule(rule: Rule): string[] {
  const issues: string[] = [];
  if (!rule.id || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(rule.id)) {
    issues.push(`rule id "${rule.id}" must be letters, digits and "_.:-"`);
  }
  if (!rule.description) issues.push(`rule ${rule.id}: missing description`);
  if (rule.kind !== 'required' && rule.kind !== 'scored') {
    issues.push(`rule ${rule.id}: kind must be "required" or "scored"`);
  }
  if (rule.weight !== undefined) {
    if (rule.kind !== 'scored') issues.push(`rule ${rule.id}: only scored rules have a weight`);
    else if (!Number.isFinite(rule.weight) || rule.weight <= 0) {
      issues.push(`rule ${rule.id}: weight must be a positive number`);
    }
  }
  try {
    compileCondition(rule.condition, rootId(rule.id));
  } catch (error) {
    issues.push(`rule ${rule.id}: ${(error as Error).message}`);
  }
  return issues;
}
