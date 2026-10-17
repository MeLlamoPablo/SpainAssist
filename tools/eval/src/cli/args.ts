/**
 * Command line parsing for `eval`: each command declares its options once (`OptionSpec`), and the
 * same declaration drives `node:util` `parseArgs` (strict: an unknown option is an error) and the
 * `--help` text, so the two cannot drift apart.
 */
import { parseArgs } from 'node:util';

/** What the user typed cannot be run: the message says what to change. Exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
  /** The command whose `--help` explains the usage (shown after the message). */
  readonly command: string | undefined;
  constructor(message: string, command?: string) {
    super(message);
    this.command = command;
  }
}

export interface OptionSpec {
  name: string;
  type: 'boolean' | 'string';
  short?: string;
  /** The value's name in the help (`--max-cost <usd>`): string options only. */
  arg?: string;
  description: string;
}

export interface CommandSpec {
  name: string;
  /** One line for the command list. */
  summary: string;
  /** `run <fixture> [options]`. */
  usage: string;
  /** What the command does, a few sentences. */
  description: string;
  options: readonly OptionSpec[];
  /** Command lines that work as typed, each with a comment. */
  examples: readonly { command: string; comment?: string }[];
  /** Extra paragraphs after the options (environment, exit codes of this command...). */
  notes?: readonly string[];
}

/** Every command takes `--help`. */
export const HELP_OPTION: OptionSpec = {
  name: 'help',
  type: 'boolean',
  short: 'h',
  description: 'Show this help.',
};

export interface ParsedArgs {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

/** Whether `args` ask for help (`--help` or `-h`, before a `--`). */
export function wantsHelp(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '--help' || arg === '-h') return true;
  }
  return false;
}

/**
 * Parses `args` against the command's options. Unknown options, options without their value (or
 * with an empty one) and stray positionals are `UsageError`s; `positionals` says how many the
 * command takes.
 */
export function parseCommandArgs(
  spec: CommandSpec,
  args: readonly string[],
  positionals: { min: number; max: number; names: string },
): ParsedArgs {
  const options: Record<string, { type: 'boolean' | 'string'; short?: string }> = {};
  for (const option of [HELP_OPTION, ...spec.options]) {
    options[option.name] = {
      type: option.type,
      ...(option.short ? { short: option.short } : {}),
    };
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(cleanParseMessage(error), spec.name);
  }
  const given = parsed.positionals;
  if (given.length < positionals.min) {
    throw new UsageError(`Missing ${positionals.names}.`, spec.name);
  }
  if (given.length > positionals.max) {
    const extra = given.slice(positionals.max).join(' ');
    throw new UsageError(
      positionals.max === 0
        ? `"${spec.name}" takes no arguments (got "${extra}").`
        : `Too many arguments: "${extra}" (expected ${positionals.names}).`,
      spec.name,
    );
  }
  // An option that is given with nothing in it is a mistake, never "not given": `--from "$CKPT"`
  // or `--min-score "$MIN"` with the variable unset must not turn into another command.
  for (const option of spec.options) {
    const value = (parsed.values as ParsedArgs['values'])[option.name];
    if (option.type === 'string' && typeof value === 'string' && value.trim() === '') {
      throw new UsageError(
        `--${option.name} needs a value${option.arg ? ` (<${option.arg}>)` : ''}: it was given empty.`,
        spec.name,
      );
    }
  }
  return { values: parsed.values as ParsedArgs['values'], positionals: given };
}

/** `parseArgs` messages end with tips about its own API (and span lines): keep the first part. */
function cleanParseMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\s*To specify (an option argument|a positional argument)[\s\S]*$/, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** A string option's value, or undefined when it was not given. */
export function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.values[name];
  return typeof value === 'string' ? value : undefined;
}

export function flag(parsed: ParsedArgs, name: string): boolean {
  return parsed.values[name] === true;
}

function parseNumber(option: string, text: string, what: string): number {
  const trimmed = text.trim();
  const value = trimmed === '' ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new UsageError(`--${option} must be ${what} (got "${text}").`);
  }
  return value;
}

export function positiveNumberOption(option: string, text: string): number {
  const value = parseNumber(option, text, 'a positive number');
  if (value <= 0) throw new UsageError(`--${option} must be a positive number (got "${text}").`);
  return value;
}

export function positiveIntegerOption(option: string, text: string): number {
  const value = parseNumber(option, text, 'a whole number from 1');
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--${option} must be a whole number from 1 (got "${text}").`);
  }
  return value;
}

export function fractionOption(option: string, text: string): number {
  const value = parseNumber(option, text, 'a number from 0 to 1');
  if (value < 0 || value > 1) {
    throw new UsageError(`--${option} must be a number from 0 to 1 (got "${text}").`);
  }
  return value;
}

export function choiceOption<T extends string>(
  option: string,
  text: string,
  choices: readonly T[],
): T {
  if ((choices as readonly string[]).includes(text)) return text as T;
  throw new UsageError(`--${option} must be one of ${choices.join(', ')} (got "${text}").`);
}
