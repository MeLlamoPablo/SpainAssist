/**
 * The options that `run` and `suite` share (who plays the model, the cache, the limits, the models,
 * the flags and the exit bar), read once. A value that is given must be a good one: an empty one
 * never gets here (`parseCommandArgs` refuses it).
 */
import type { CacheMode, EvalProvider, RunLimits } from '../../contracts';
import { CACHE_MODES } from '../../llm/cache';
import type { EvaluationRequest } from '../../runner';
import {
  choiceOption,
  flag,
  fractionOption,
  type ParsedArgs,
  positiveIntegerOption,
  positiveNumberOption,
  stringOption,
  UsageError,
} from '../args';

const PROVIDERS: readonly EvalProvider[] = ['mock', 'voucher', 'codex', 'local'];

export interface SharedOptions {
  provider: EvalProvider;
  /** The scripted model's name (`--scenario`), when the provider is `mock`. */
  scenarioName: string | undefined;
  minScore: number | undefined;
  json: boolean;
  /** What of an `EvaluationRequest` these options say (not the fixture, run id or folders). */
  request: Pick<
    EvaluationRequest,
    | 'provider'
    | 'cache'
    | 'cacheVariant'
    | 'limits'
    | 'models'
    | 'captureBrowser'
    | 'keepWorld'
    | 'codexConsent'
    | 'localBaseUrl'
  >;
}

export function readSharedOptions(parsed: ParsedArgs, command: string): SharedOptions {
  const text = (name: string) => stringOption(parsed, name);
  const scenarioName = text('scenario');
  const providerText = text('provider');
  const provider: EvalProvider =
    providerText !== undefined
      ? choiceOption('provider', providerText, PROVIDERS)
      : scenarioName !== undefined
        ? 'mock'
        : 'voucher';
  if (provider === 'mock' && scenarioName === undefined) {
    throw new UsageError(
      '--provider mock needs --scenario <name>: the script the model follows.',
      command,
    );
  }
  if (provider !== 'mock' && scenarioName !== undefined) {
    throw new UsageError(
      `--scenario is the script of the mock model: it cannot be used with --provider ${provider}.`,
      command,
    );
  }

  const baseUrl = text('base-url');
  if (provider === 'local' && baseUrl === undefined) {
    throw new UsageError(
      '--provider local needs --base-url <url>: the /v1 URL of the model server.',
      command,
    );
  }
  if (provider !== 'local' && baseUrl !== undefined) {
    throw new UsageError(
      `--base-url is the local model server's: it cannot be used with --provider ${provider}.`,
      command,
    );
  }

  const cacheText = text('cache');
  const cache: CacheMode | undefined =
    cacheText !== undefined ? choiceOption('cache', cacheText, CACHE_MODES) : undefined;

  const limits: Partial<RunLimits> = {};
  const maxCost = text('max-cost');
  if (maxCost !== undefined) limits.maxCostUsd = positiveNumberOption('max-cost', maxCost);
  const maxToolCalls = text('max-tool-calls');
  if (maxToolCalls !== undefined) {
    limits.maxToolCalls = positiveIntegerOption('max-tool-calls', maxToolCalls);
  }
  const maxRequests = text('max-requests');
  if (maxRequests !== undefined) {
    limits.maxRequests = positiveIntegerOption('max-requests', maxRequests);
  }
  const wallClock = text('wall-clock');
  if (wallClock !== undefined) {
    limits.wallClockMs = positiveNumberOption('wall-clock', wallClock) * 60_000;
  }

  const models: NonNullable<EvaluationRequest['models']> = {};
  const every = text('model');
  const assistant = text('assistant-model') ?? every;
  if (assistant !== undefined) models.assistantModel = assistant;
  const procedure = text('procedure-model') ?? every;
  if (procedure !== undefined) models.procedureModel = procedure;
  const answerer = text('answerer-model') ?? every;
  if (answerer !== undefined) models.answererModel = answerer;
  if (provider === 'local' && !(assistant && procedure && answerer)) {
    throw new UsageError(
      '--provider local needs --model <id> (or --assistant-model, --procedure-model and ' +
        "--answerer-model): the product's defaults are gateway models a local server does not have.",
      command,
    );
  }

  const minScoreText = text('min-score');
  const cacheVariant = text('cache-variant');
  return {
    provider,
    scenarioName,
    minScore: minScoreText !== undefined ? fractionOption('min-score', minScoreText) : undefined,
    json: flag(parsed, 'json'),
    request: {
      provider,
      ...(cache ? { cache } : {}),
      ...(cacheVariant !== undefined ? { cacheVariant } : {}),
      ...(baseUrl !== undefined ? { localBaseUrl: baseUrl } : {}),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
      ...(Object.keys(models).length > 0 ? { models } : {}),
      ...(flag(parsed, 'capture-browser') ? { captureBrowser: true } : {}),
      ...(flag(parsed, 'keep-world') ? { keepWorld: true } : {}),
      ...(flag(parsed, 'codex-consent') ? { codexConsent: true } : {}),
    },
  };
}
