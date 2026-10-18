import { z } from 'zod';
import type { FetchFn } from '../remote/http';

/** OpenAI's model list for a ChatGPT sign-in: what the account's plan offers. */
const MODELS_URL = 'https://api.openai.com/v1/models';
/** The list only picks a model: past this, the app uses its default one. */
const MODELS_TIMEOUT_MS = 5_000;

/** Why the model list is unavailable: logged instead of the answer, which is never logged. */
type ModelsErrorCategory = 'network' | 'timeout' | 'unauthorized' | 'http' | 'invalid';

class ChatGPTModelsError extends Error {
  constructor(readonly category: ModelsErrorCategory) {
    super(`ChatGPT model list unavailable (${category})`);
    this.name = 'ChatGPTModelsError';
  }
}

/** Fields the app reads; OpenAI sends more, which are ignored. */
const ModelList = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      visibility: z.string().optional(),
      supported_in_api: z.boolean().optional(),
      input_modalities: z.array(z.string()).optional(),
    }),
  ),
});

/**
 * Ids of the models a ChatGPT account may run agents on. A model is dropped only when a field
 * says so (hidden, not in the API, or no images): a missing field keeps it, so a smaller answer
 * does not send every account back to a model its plan refuses. Requests carry only the bearer
 * token and never follow redirects; the token and the answer never go into errors.
 */
export async function fetchChatGPTModels(
  fetchFn: FetchFn,
  accessToken: string,
  timeoutMs = MODELS_TIMEOUT_MS,
): Promise<string[]> {
  let res: Response;
  try {
    res = await fetchFn(MODELS_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new ChatGPTModelsError(timedOut ? 'timeout' : 'network');
  }
  if (res.status === 401 || res.status === 403) throw new ChatGPTModelsError('unauthorized');
  if (!res.ok) throw new ChatGPTModelsError('http');
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ChatGPTModelsError('invalid');
  }
  const parsed = ModelList.safeParse(body);
  if (!parsed.success) throw new ChatGPTModelsError('invalid');
  return parsed.data.models
    .filter(
      (m) =>
        (m.visibility === undefined || m.visibility === 'list') &&
        m.supported_in_api !== false &&
        (m.input_modalities === undefined || m.input_modalities.includes('image')),
    )
    .map((m) => m.slug);
}

/** The first of `preferred` (best first) that the account lists, if any. */
export function pickChatGPTModel(
  available: readonly string[],
  preferred: readonly string[],
): string | undefined {
  return preferred.find((id) => available.includes(id));
}
