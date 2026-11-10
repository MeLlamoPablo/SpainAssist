import type { Frame, Locator, Page } from 'playwright-core';
import { BrowserError } from './errors';

/**
 * Playwright locators described as data, for codemode workflows: the workflow's sandbox builds a
 * chain (`page.getByRole('row').filter({ hasText: 'Libre' }).first()`) and the app replays it on
 * the real page with the real Playwright API, so waiting, strictness and errors are Playwright's.
 * Only these steps exist; nothing reaches the context, the browser or other procedures.
 *
 * A target string is a ref from the latest snapshot ("e12") or `loc:` + the JSON of a chain.
 */
export type LocatorStep =
  | ['ref', string]
  | ['locator', string, LocatorOptions | null]
  | ['getByRole', string, RoleOptions | null]
  | [
      'getByText' | 'getByLabel' | 'getByPlaceholder' | 'getByTitle' | 'getByAltText',
      TextArg,
      TextOptions | null,
    ]
  | ['getByTestId', string]
  | ['filter', FilterOptions]
  | ['nth', number]
  | ['first']
  | ['last'];

export type LocatorChain = LocatorStep[];

/** A RegExp crossing the sandbox boundary. */
interface SerializedRegExp {
  $re: string;
  flags?: string;
}
type TextArg = string | SerializedRegExp;
interface LocatorOptions {
  hasText?: TextArg;
  hasNotText?: TextArg;
}
interface TextOptions {
  exact?: boolean;
}
interface RoleOptions {
  name?: TextArg;
  exact?: boolean;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  includeHidden?: boolean;
  level?: number;
  pressed?: boolean;
  selected?: boolean;
}
interface FilterOptions {
  hasText?: TextArg;
  hasNotText?: TextArg;
  visible?: boolean;
}

export const LOCATOR_PREFIX = 'loc:';
const MAX_STEPS = 16;
const MAX_TEXT = 500;

/** A target for the browser's ref-taking actions: the ref as is, or the chain encoded. */
export function encodeTarget(chain: LocatorChain): string {
  if (chain.length === 1 && chain[0]?.[0] === 'ref') return chain[0][1];
  return LOCATOR_PREFIX + JSON.stringify(chain);
}

export function isLocatorTarget(target: string): boolean {
  return target.startsWith(LOCATOR_PREFIX);
}

function bad(message: string): never {
  throw new BrowserError('bad_input', message);
}

function text(value: unknown, what: string): string | RegExp {
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT) bad(`${what} is too long.`);
    return value;
  }
  if (value && typeof value === 'object' && typeof (value as SerializedRegExp).$re === 'string') {
    const { $re, flags } = value as SerializedRegExp;
    if ($re.length > MAX_TEXT) bad(`${what} is too long.`);
    try {
      return new RegExp($re, (flags ?? '').replace(/[^imsu]/g, ''));
    } catch {
      bad(`${what} is not a valid regular expression.`);
    }
  }
  return bad(`${what} must be a string or a RegExp.`);
}

function opts<T extends object>(value: unknown, allowed: readonly string[]): Partial<T> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) bad('Locator options must be an object.');
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!allowed.includes(key)) bad(`Unsupported locator option "${key}".`);
    out[key] = v;
  }
  return out as Partial<T>;
}

function textOptions(
  value: unknown,
  what: string,
): { hasText?: string | RegExp; hasNotText?: string | RegExp; visible?: boolean } {
  const o = opts<FilterOptions>(value, ['hasText', 'hasNotText', 'visible']);
  return {
    ...(o.hasText !== undefined ? { hasText: text(o.hasText, `${what} hasText`) } : {}),
    ...(o.hasNotText !== undefined ? { hasNotText: text(o.hasNotText, `${what} hasNotText`) } : {}),
    ...(o.visible !== undefined ? { visible: !!o.visible } : {}),
  };
}

/** Parses a target string into a chain (a bare ref becomes `[['ref', ref]]`). */
export function parseTarget(target: string): LocatorChain {
  const t = target.trim();
  if (!isLocatorTarget(t)) return [['ref', t]];
  let chain: unknown;
  try {
    chain = JSON.parse(t.slice(LOCATOR_PREFIX.length));
  } catch {
    bad('The locator is not valid JSON.');
  }
  if (!Array.isArray(chain)) bad('A locator is a list of steps.');
  if (chain.length > MAX_STEPS) bad(`A locator has at most ${MAX_STEPS} steps.`);
  return chain as LocatorChain;
}

const REF_RE = /^(?:f\d+)?e\d+$/;

/** The Playwright locator of a chain on `page`. Throws `bad_input` for anything unknown. */
export function buildLocator(page: Page | Frame, chain: LocatorChain): Locator {
  if (!chain.length) bad('Empty locator.');
  let loc: Locator | undefined;
  const root = page;
  for (const [index, step] of chain.entries()) {
    if (!Array.isArray(step) || typeof step[0] !== 'string') bad('Invalid locator step.');
    const base: Page | Frame | Locator = loc ?? root;
    const [name] = step;
    switch (name) {
      case 'ref': {
        if (index !== 0) bad('ref(...) must start a locator.');
        const ref = String(step[1] ?? '').trim();
        if (!REF_RE.test(ref))
          bad(`"${ref}" is not a ref. Use a ref from the latest snapshot, like e12.`);
        loc = root.locator(`aria-ref=${ref}`);
        break;
      }
      case 'locator': {
        const selector = step[1];
        if (typeof selector !== 'string' || !selector.trim() || selector.length > 1000)
          bad('locator(selector) needs a selector string.');
        loc = base.locator(selector, textOptions(step[2], 'locator'));
        break;
      }
      case 'getByRole': {
        const role = step[1];
        if (typeof role !== 'string' || !/^[a-z]{2,40}$/.test(role))
          bad('getByRole needs an ARIA role like "button".');
        const o = opts<RoleOptions>(step[2], [
          'name',
          'exact',
          'checked',
          'disabled',
          'expanded',
          'includeHidden',
          'level',
          'pressed',
          'selected',
        ]);
        loc = base.getByRole(
          role as Parameters<Page['getByRole']>[0],
          {
            ...o,
            ...(o.name !== undefined ? { name: text(o.name, 'getByRole name') } : {}),
          } as Parameters<Page['getByRole']>[1],
        );
        break;
      }
      case 'getByText':
      case 'getByLabel':
      case 'getByPlaceholder':
      case 'getByTitle':
      case 'getByAltText': {
        const o = opts<TextOptions>(step[2], ['exact']);
        loc = base[name](text(step[1], name), o.exact !== undefined ? { exact: !!o.exact } : {});
        break;
      }
      case 'getByTestId': {
        if (typeof step[1] !== 'string') bad('getByTestId needs a string.');
        loc = base.getByTestId(step[1]);
        break;
      }
      case 'filter':
        if (!loc) bad('filter(...) needs a locator before it.');
        loc = loc.filter(textOptions(step[1], 'filter'));
        break;
      case 'nth': {
        if (!loc) bad('nth(...) needs a locator before it.');
        const n = step[1];
        if (typeof n !== 'number' || !Number.isInteger(n) || n < -1000 || n > 1000)
          bad('nth(i) needs an integer.');
        loc = loc.nth(n);
        break;
      }
      case 'first':
        if (!loc) bad('first() needs a locator before it.');
        loc = loc.first();
        break;
      case 'last':
        if (!loc) bad('last() needs a locator before it.');
        loc = loc.last();
        break;
      default:
        bad(`Unknown locator step "${String(name)}".`);
    }
  }
  return loc as Locator;
}

/** "getByRole('button', { name: 'Enviar' })…": a chain as the model wrote it, for messages. */
export function describeChain(chain: LocatorChain): string {
  return chain
    .map(([name, ...args]) => {
      if (name === 'ref') return `ref(${JSON.stringify(args[0])})`;
      const shown = args
        .filter((a) => a !== null && a !== undefined)
        .map((a) => JSON.stringify(a))
        .join(', ');
      return `${name}(${shown})`;
    })
    .join('.')
    .slice(0, 300);
}
