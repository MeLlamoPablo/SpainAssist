/**
 * Turns text into vectors for hybrid search. The only implementation calls an OpenAI-compatible
 * `/embeddings` endpoint: our LiteLLM gateway, which sends it to OpenRouter.
 */
export interface Embedder {
  /**
   * Names the vector space ("<model>@<dimensions>"). It is stored with every vector: vectors
   * of another space are never compared, and the indexer replaces them.
   */
  readonly space: string;
  /** One vector per text, in order. Throws `EmbeddingError`. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/** The embeddings endpoint failed or sent something unusable. The message never holds input text. */
export class EmbeddingError extends Error {
  override name = 'EmbeddingError';
}

export interface GatewayEmbedderOptions {
  /** Base URL of the OpenAI-compatible API, e.g. `https://llm.example/v1`. */
  url: string;
  apiKey: string;
  model: string;
  dimensions: number;
  fetch?: typeof fetch;
}

export function createGatewayEmbedder(options: GatewayEmbedderOptions): Embedder {
  const { model, dimensions } = options;
  const send = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/+$/, '')}/embeddings`;
  return {
    space: `${model}@${dimensions}`,
    async embed(texts, signal) {
      if (texts.length === 0) return [];
      let res: Response;
      try {
        res = await send(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({ model, input: texts, dimensions, encoding_format: 'float' }),
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        throw new EmbeddingError(
          `The embeddings endpoint can't be reached (${err instanceof Error ? err.name : 'error'}).`,
        );
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new EmbeddingError(`The embeddings endpoint answered ${res.status}.`);
      }
      const json = (await res.json().catch(() => undefined)) as
        | { data?: { index?: unknown; embedding?: unknown }[] }
        | undefined;
      const data = json?.data;
      if (!Array.isArray(data) || data.length !== texts.length)
        throw new EmbeddingError('The embeddings endpoint sent an unexpected answer.');
      const vectors: number[][] = [];
      for (const [position, item] of data.entries()) {
        const index = typeof item.index === 'number' ? item.index : position;
        const vector = item.embedding;
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= texts.length ||
          vectors[index] !== undefined ||
          !Array.isArray(vector) ||
          vector.length !== dimensions ||
          !vector.every((n) => typeof n === 'number' && Number.isFinite(n))
        )
          throw new EmbeddingError('The embeddings endpoint sent an unexpected vector.');
        vectors[index] = vector as number[];
      }
      return vectors;
    },
  };
}

/** A vector as pgvector reads it: `[0.1,0.2,…]`, for a `$n::vector` parameter. */
export const toVectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`;
