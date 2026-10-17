import {
  CustomModelCapabilities,
  type CustomProbeInput,
  type CustomProbeResult,
  type CustomServer,
} from '@sa/shared';
import { z } from 'zod';
import type { FetchFn } from '../remote/http';

/** Each probe request gives up after this long: probing never holds the user up. */
const PROBE_TIMEOUT_MS = 3_000;
/** Bigger answers are ignored (OpenRouter's model list is about 1 MB). */
const MAX_BODY_CHARS = 8_000_000;

type Detected = CustomModelCapabilities;

/** What one probe learned. */
interface Finding {
  server?: CustomServer;
  models?: string[];
  detected: Detected;
}

/**
 * Asks a custom endpoint which models it serves and what `input.model` can do, through every API
 * we know, in parallel. Best effort: unreachable servers, errors and odd answers give an empty
 * result (the app then assumes CUSTOM_MODEL_DEFAULTS). Requests stay on the endpoint's origin
 * (redirects are not followed), so the key only goes there; it is never logged.
 */
export async function probeCustomEndpoint(
  input: CustomProbeInput,
  fetchFn: FetchFn,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<CustomProbeResult> {
  if (!/^https?:\/\//i.test(input.baseUrl)) return { reachable: false, models: [], detected: {} };
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const root = baseUrl.replace(/\/v1$/i, '');
  const model = input.model.trim();
  const apiKey = input.apiKey?.trim() || undefined;
  const get = (url: string, headers: Record<string, string>, body?: unknown) =>
    fetchJson(fetchFn, url, headers, timeoutMs, body);
  const bearer: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const listHeaders =
    input.api === 'anthropic-messages'
      ? { 'anthropic-version': '2023-06-01', ...(apiKey ? { 'x-api-key': apiKey } : {}) }
      : bearer;
  // Anthropic clients append /v1 to the base URL themselves; OpenAI clients don't.
  const listUrl =
    input.api === 'anthropic-messages' && !/\/v1$/i.test(baseUrl)
      ? `${baseUrl}/v1/models`
      : `${baseUrl}/models`;

  const [ollama, lmstudio, llamacpp, openai] = await Promise.all([
    model
      ? Promise.all([
          get(`${root}/api/show`, bearer, { model }),
          get(`${root}/api/ps`, bearer),
        ]).then(([show, ps]) => parseOllama(show, ps, model))
      : undefined,
    get(`${root}/api/v0/models`, bearer).then((body) => parseLmStudio(body, model)),
    get(`${root}/props`, bearer).then(parseLlamaCpp),
    get(listUrl, listHeaders).then((body) => parseModelList(body, model)),
  ]);

  const native = [ollama, lmstudio, llamacpp].filter((f): f is Finding => !!f);
  const findings = [...native, ...(openai ? [openai] : [])];
  const detected: Detected = {};
  for (const finding of findings) {
    for (const [key, value] of Object.entries(finding.detected) as [keyof Detected, never][]) {
      if (value !== undefined && detected[key] === undefined) detected[key] = value;
    }
  }
  return {
    reachable: findings.length > 0,
    ...(native[0]?.server ? { server: native[0].server } : openai ? { server: 'openai' } : {}),
    models: [...new Set(openai?.models ?? lmstudio?.models ?? [])],
    detected,
  };
}

async function fetchJson(
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  body?: unknown,
): Promise<unknown> {
  try {
    const res = await fetchFn(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    const text = await res.text();
    return text.length > MAX_BODY_CHARS ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

// --- parsing ---------------------------------------------------------------------------------

/** Keeps only values the contract accepts (sane numbers), dropping the rest. */
function clean(values: Detected): Detected {
  const out: Detected = {};
  for (const [key, value] of Object.entries(values) as [keyof Detected, unknown][]) {
    if (value === undefined) continue;
    const field = CustomModelCapabilities.shape[key].safeParse(value);
    if (field.success && field.data !== undefined) Object.assign(out, { [key]: field.data });
  }
  return out;
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

const firstCount = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const n = count(value);
    if (n !== undefined) return n;
  }
  return undefined;
};

const Entry = z.looseObject({ id: z.string().min(1) });
const ModelList = z.object({ data: z.array(z.unknown()) });

function entries(body: unknown): z.infer<typeof Entry>[] | undefined {
  const list = ModelList.safeParse(body);
  if (!list.success) return undefined;
  return list.data.data.flatMap((item) => {
    const entry = Entry.safeParse(item);
    return entry.success ? [entry.data] : [];
  });
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** `true`, or `{ supported: true }` (capability objects of some model APIs). */
function flag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const supported = record(value).supported;
  return typeof supported === 'boolean' ? supported : undefined;
}

/**
 * Capabilities as a list (`["vision", "thinking"]`) or an object
 * (`{ vision: true }`, `{ image_input: { supported: true } }`).
 */
function capabilities(value: unknown): { images?: boolean; reasoning?: boolean } {
  if (Array.isArray(value)) {
    const list = strings(value).map((s) => s.toLowerCase());
    if (list.length === 0) return {};
    return {
      images: list.some((s) => s === 'vision' || s.startsWith('image')),
      reasoning: list.some((s) => s === 'thinking' || s === 'reasoning'),
    };
  }
  const caps = record(value);
  const images = flag(caps.vision) ?? flag(caps.image_input) ?? flag(caps.images);
  const reasoning = flag(caps.thinking) ?? flag(caps.reasoning);
  return {
    ...(images !== undefined ? { images } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

/**
 * `GET {baseUrl}/models` of OpenAI-compatible servers (and Anthropic's `/v1/models`). Most list
 * ids only; some add limits and capabilities: `context_length`, `architecture.input_modalities`
 * and `supported_parameters` (OpenRouter), `max_model_len` (vLLM), `context_window` (Groq),
 * `max_input_tokens` / `max_tokens` / `capabilities` (Anthropic, LiteLLM).
 */
export function parseModelList(body: unknown, model: string): Finding | undefined {
  const list = entries(body);
  if (!list) return undefined;
  const entry = list.find((e) => e.id === model);
  if (!entry) return { models: list.map((e) => e.id), detected: {} };
  const architecture = record(entry.architecture);
  const topProvider = record(entry.top_provider);
  const caps = capabilities(entry.capabilities);
  const modalities = strings(architecture.input_modalities ?? entry.input_modalities);
  const parameters = strings(entry.supported_parameters);
  return {
    models: list.map((e) => e.id),
    detected: clean({
      contextWindow: firstCount(
        entry.context_length,
        topProvider.context_length,
        entry.max_model_len,
        entry.max_context_length,
        entry.context_window,
        entry.max_input_tokens,
      ),
      maxTokens: firstCount(
        topProvider.max_completion_tokens,
        entry.max_completion_tokens,
        entry.max_output_tokens,
        entry.max_tokens,
      ),
      supportsImages: modalities.length > 0 ? modalities.includes('image') : caps.images,
      reasoning:
        parameters.length > 0
          ? parameters.includes('reasoning') || parameters.includes('include_reasoning')
          : caps.reasoning,
    }),
  };
}

const OllamaShow = z.object({
  capabilities: z.array(z.string()).optional().catch(undefined),
  model_info: z.record(z.string(), z.unknown()).optional().catch(undefined),
  parameters: z.string().optional().catch(undefined),
});
const OllamaPs = z.object({
  models: z.array(z.looseObject({ name: z.string().optional(), model: z.string().optional() })),
});

/**
 * Ollama: `POST /api/show` gives `capabilities` (`vision`, `thinking`) and the model's limits,
 * `GET /api/ps` the context the loaded model runs with. Ollama serves `num_ctx` tokens of
 * context (its Modelfile parameter, else the server's setting), which is often far below the
 * model's maximum, so that comes first.
 */
export function parseOllama(show: unknown, ps: unknown, model: string): Finding | undefined {
  const parsed = OllamaShow.safeParse(show);
  if (!parsed.success || (!parsed.data.capabilities && !parsed.data.model_info)) return undefined;
  const { capabilities: caps, model_info: info = {}, parameters = '' } = parsed.data;
  const numCtx = /^num_ctx\s+(\d+)/m.exec(parameters)?.[1];
  const running = OllamaPs.safeParse(ps);
  const loaded = running.success
    ? running.data.models.find((m) => m.name === model || m.model === model)
    : undefined;
  const trained = Object.entries(info).find(([key]) => key.endsWith('.context_length'))?.[1];
  const listed = caps ? capabilities(caps) : {};
  return {
    server: 'ollama',
    detected: clean({
      contextWindow: firstCount(
        numCtx ? Number(numCtx) : undefined,
        loaded?.context_length,
        trained,
      ),
      supportsImages: caps ? listed.images === true : undefined,
      reasoning: caps ? listed.reasoning === true : undefined,
    }),
  };
}

/**
 * LM Studio: `GET /api/v0/models` lists models with `type` (`llm`, `vlm`: vision, `embeddings`)
 * and `max_context_length`, plus `loaded_context_length` when loaded.
 */
export function parseLmStudio(body: unknown, model: string): Finding | undefined {
  const list = entries(body)?.filter((e) => typeof e.type === 'string');
  if (!list?.length) return undefined;
  const entry = list.find((e) => e.id === model);
  const caps = capabilities(entry?.capabilities);
  return {
    server: 'lmstudio',
    models: list.filter((e) => e.type !== 'embeddings').map((e) => e.id),
    detected: entry
      ? clean({
          contextWindow: firstCount(entry.loaded_context_length, entry.max_context_length),
          supportsImages:
            entry.type === 'vlm' ? true : entry.type === 'llm' ? (caps.images ?? false) : undefined,
          reasoning: caps.reasoning,
        })
      : {},
  };
}

const LlamaCppProps = z.object({
  default_generation_settings: z.looseObject({ n_ctx: z.number() }),
  modalities: z.looseObject({ vision: z.boolean().optional() }).optional().catch(undefined),
});

/** llama.cpp's llama-server: `GET /props` gives the served context and `modalities.vision`. */
export function parseLlamaCpp(body: unknown): Finding | undefined {
  const props = LlamaCppProps.safeParse(body);
  if (!props.success) return undefined;
  return {
    server: 'llamacpp',
    detected: clean({
      contextWindow: count(props.data.default_generation_settings.n_ctx),
      supportsImages: props.data.modalities?.vision,
    }),
  };
}
