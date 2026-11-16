import { describe, expect, it, vi } from 'vitest';
import { createGatewayEmbedder, EmbeddingError, toVectorLiteral } from '../src/embed/embedder';

const options = {
  url: 'https://llm.test/v1/',
  apiKey: 'sk-embed',
  model: 'acme/embed',
  dimensions: 3,
};

const answer = (data: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify({ data }), { status }));

describe('gateway embedder', () => {
  it('asks the OpenAI-compatible endpoint for vectors of the configured size', async () => {
    const fetch = answer([
      { index: 1, embedding: [0, 1, 0] },
      { index: 0, embedding: [1, 0, 0] },
    ]);
    const embedder = createGatewayEmbedder({ ...options, fetch });
    expect(embedder.space).toBe('acme/embed@3');
    // Answers are matched by index, whatever order they come in.
    expect(await embedder.embed(['uno', 'dos'])).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.test/v1/embeddings');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-embed');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'acme/embed',
      input: ['uno', 'dos'],
      dimensions: 3,
      encoding_format: 'float',
    });
  });

  it('makes no request for nothing', async () => {
    const fetch = answer([]);
    expect(await createGatewayEmbedder({ ...options, fetch }).embed([])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails without quoting the text when the endpoint fails or answers nonsense', async () => {
    const text = 'texto privado';
    const failures = [
      answer([], 500),
      answer([{ index: 0, embedding: [1, 0] }]), // wrong size
      answer([{ index: 0, embedding: [1, 0, 'x'] }]),
      answer([{ index: 0, embedding: [1, 0, null] }]),
      answer([{ index: 3, embedding: [1, 0, 0] }]),
      answer([
        { index: 0, embedding: [1, 0, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ]),
      vi.fn(async () => new Response('<html>', { status: 200 })),
      vi.fn(async () => {
        throw new TypeError(`fetch failed for ${text}`);
      }),
    ];
    for (const fetch of failures) {
      const error = await createGatewayEmbedder({ ...options, fetch })
        .embed([text])
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(EmbeddingError);
      expect((error as Error).message).not.toContain(text);
    }
  });

  it('passes the abort signal on', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response('{}');
    });
    const embedder = createGatewayEmbedder({ ...options, fetch });
    await expect(embedder.embed(['uno'], AbortSignal.abort())).rejects.toBeInstanceOf(
      EmbeddingError,
    );
  });

  it('writes vectors as pgvector reads them', () => {
    expect(toVectorLiteral([0.5, -1, 2e-7])).toBe('[0.5,-1,2e-7]');
  });
});
