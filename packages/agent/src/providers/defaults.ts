import { ResearchMode, ThinkingLevel } from '@sa/shared';
import bundledModelLists from '../../../../models_warningUpdatingThisWillChangeItInAllClientsOnPushToMaster.json';

/** A fixed agent model and its reasoning effort. */
export interface FixedModel {
  id: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * The models of ChatGPT (also Codex in development builds) and vouchers, best first, per role:
 * procedure agents, the assistant (orchestrator), the document scanner (at its level, usually
 * the lowest) and, on a ChatGPT plan, each research mode. A ChatGPT account runs the first one its
 * plan offers, else the model OpenAI ranks first for it at the first one's effort; vouchers run
 * the first one. `decider`: the OpenRouter id of the scan frame decider (one model: the key
 * server reads it from the same file, and keys allow only that one).
 */
export interface ModelLists {
  chatgpt: {
    procedures: FixedModel[];
    assistant: FixedModel[];
    scanner: FixedModel[];
    research: Record<ResearchMode, FixedModel[]>;
    decider: string;
  };
  voucher: {
    procedures: FixedModel[];
    assistant: FixedModel[];
    scanner: FixedModel[];
    decider: string;
  };
}

/** Format version of the models file this app reads; another version is ignored. */
const MODEL_LISTS_VERSION = 1;

/** "<model id>:<reasoning level>", split at the last ":" (OpenRouter ids may contain one). */
function parseEntry(entry: unknown): FixedModel | undefined {
  if (typeof entry !== 'string') return undefined;
  const at = entry.lastIndexOf(':');
  const id = entry.slice(0, at).trim();
  const level = ThinkingLevel.safeParse(entry.slice(at + 1));
  return at > 0 && id && level.success ? { id, thinkingLevel: level.data } : undefined;
}

function parseList(value: unknown, fallback: FixedModel[] | undefined): FixedModel[] {
  const list = Array.isArray(value)
    ? value.map(parseEntry).filter((m): m is FixedModel => m !== undefined)
    : [];
  if (list.length) return list;
  if (fallback) return fallback;
  throw new Error('a list of the models file has no valid model');
}

function parseId(value: unknown, fallback: string | undefined): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (fallback) return fallback;
  throw new Error('a decider of the models file is missing');
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Reads a models file (see the repository's `models_warning…json`). Forgiving, because every
 * released app reads the latest file: fields it does not know are ignored, and entries it cannot
 * read (an unknown reasoning level, no level) are skipped. A list left empty or missing is
 * `fallback`'s; without `fallback`, it throws, and so does any other format version.
 */
export function parseModelLists(json: unknown, fallback?: ModelLists): ModelLists {
  if (field(json, 'version') !== MODEL_LISTS_VERSION) {
    throw new Error('unsupported models file version');
  }
  const chatgpt = field(json, 'chatgpt');
  const voucher = field(json, 'voucher');
  const research = field(chatgpt, 'research');
  return {
    chatgpt: {
      procedures: parseList(field(chatgpt, 'procedures'), fallback?.chatgpt.procedures),
      assistant: parseList(field(chatgpt, 'assistant'), fallback?.chatgpt.assistant),
      scanner: parseList(field(chatgpt, 'scanner'), fallback?.chatgpt.scanner),
      research: Object.fromEntries(
        ResearchMode.options.map((mode) => [
          mode,
          parseList(field(research, mode), fallback?.chatgpt.research[mode]),
        ]),
      ) as Record<ResearchMode, FixedModel[]>,
      decider: parseId(field(chatgpt, 'decider'), fallback?.chatgpt.decider),
    },
    voucher: {
      procedures: parseList(field(voucher, 'procedures'), fallback?.voucher.procedures),
      assistant: parseList(field(voucher, 'assistant'), fallback?.voucher.assistant),
      scanner: parseList(field(voucher, 'scanner'), fallback?.voucher.scanner),
      decider: parseId(field(voucher, 'decider'), fallback?.voucher.decider),
    },
  };
}

/**
 * The models file this app version was built with: what the app runs until it reads the latest
 * one, and whenever it cannot.
 */
export const BUNDLED_MODEL_LISTS: ModelLists = parseModelLists(bundledModelLists);

/** The preferred ChatGPT procedure model this app version was built with. */
const CHATGPT_TEMPLATE = (BUNDLED_MODEL_LISTS.chatgpt.procedures[0] as FixedModel).id;

/** Catalog model used as a template when a provider is asked for an id it does not list. */
export const TEMPLATE_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  openai: CHATGPT_TEMPLATE,
  'openai-codex': CHATGPT_TEMPLATE,
  // Not the voucher default: pi's bundled catalog does not list Claude Haiku 5.5 yet.
  openrouter: 'openai/gpt-6-luna',
};
