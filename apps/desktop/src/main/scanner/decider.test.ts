import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_DECIDER_ENDPOINT, FRAME_DECIDER_MODEL, OpenRouterFrameGate } from './decider';

const image = 'data:image/jpeg;base64,/9j/2Q==';
const reply = (present = 0.99, legible = 0.99) => ({
  model: FRAME_DECIDER_MODEL,
  answers: {
    document_present: { type: 'noul', noul: present },
    document_legible: { type: 'noul', noul: legible },
  },
  usage: { input_tokens: 700, output_tokens: 0, cost: 0.000028 },
});
afterEach(() => vi.unstubAllGlobals());

describe('OpenRouter document frame gate', () => {
  it('uses the global key only in the auth header and sends images as multimodal state', async () => {
    const request = vi.fn(async () => Response.json(reply()));
    vi.stubGlobal('fetch', request);
    const gate = new OpenRouterFrameGate({ apiKey: 'global-test-only' });
    const result = await gate.check(image, new AbortController().signal);
    expect(result).toMatchObject({ accepted: true, usage: reply().usage });
    const [endpoint, init] = request.mock.calls[0]! as unknown as [string, RequestInit];
    expect(endpoint).toBe(FRAME_DECIDER_ENDPOINT);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer global-test-only' });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: FRAME_DECIDER_MODEL,
      state: [expect.any(String), { type: 'image_url', image_url: { url: image } }],
    });
    expect(body.questions.document_present.instructions).toContain('either side');
    expect(Object.keys(body.questions)).toEqual(['document_present', 'document_legible']);
    expect(init.body).not.toContain('global-test-only');
    expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
  });

  it.each([
    [0.1, 0.99],
    [0.99, 0.1],
    [0.79, 0.99],
    [0.99, 0.699],
  ])('rejects absent or unreadable documents (%s, %s)', async (p, l) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(reply(p, l))),
    );
    const result = await new OpenRouterFrameGate({ apiKey: 'test-only' }).check(
      image,
      new AbortController().signal,
    );
    expect(result.accepted).toBe(false);
  });

  it.each([
    [0.9898418041596478, 0.8499270324697367],
    [0.9891816780081235, 0.8207690363924005],
    [0.8, 0.7],
    [0.9851873224125879, 0.7292369757371859],
    [0.986609325902985, 0.7862392941715958],
    [0.9872525498234753, 0.7944378371114998],
  ])('accepts readable frames at the boundary and inspected scan scores (%s, %s)', async (p, l) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(reply(p, l))),
    );
    expect(
      await new OpenRouterFrameGate({ apiKey: 'test-only' }).check(
        image,
        new AbortController().signal,
      ),
    ).toMatchObject({ accepted: true });
  });

  it.each([reply(2), { error: { message: 'secret and image' } }])(
    'rejects malformed decisions without exposing raw content',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(body)),
      );
      await expect(
        new OpenRouterFrameGate({ apiKey: 'test-only' }).check(image, new AbortController().signal),
      ).rejects.toThrow('frame_check_failed');
    },
  );

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [422, 'http'],
    [429, 'http'],
    [503, 'http'],
  ])('reports only safe HTTP diagnostics for status %s', async (status, category) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('raw secret and image', { status })),
    );
    await expect(
      new OpenRouterFrameGate({ apiKey: 'test-only' }).check(image, new AbortController().signal),
    ).rejects.toMatchObject({ category, status, message: 'frame_check_failed' });
  });

  it('screens on the gateway with the user key, and recognizes a used-up allowance', async () => {
    const request = vi.fn(async () => Response.json(reply()));
    vi.stubGlobal('fetch', request);
    const gate = new OpenRouterFrameGate({
      access: async () => ({
        endpoint: 'https://llm.example.test/openrouter/alpha/decisions',
        apiKey: 'sk-gateway-user-key',
      }),
    });
    expect(await gate.check(image, new AbortController().signal)).toMatchObject({
      accepted: true,
    });
    const [endpoint, init] = request.mock.calls[0]! as unknown as [string, RequestInit];
    expect(endpoint).toBe('https://llm.example.test/openrouter/alpha/decisions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-gateway-user-key' });
    expect(JSON.parse(init.body as string).model).toBe(FRAME_DECIDER_MODEL);

    // LiteLLM's answer when the daily or monthly window is used up.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: 'ExceededBudget: Key over 1d budget. Spend=$0.1000, Limit=$0.10',
              type: 'budget_exceeded',
              code: '422',
            },
          },
          { status: 422 },
        ),
      ),
    );
    const error = await gate.check(image, new AbortController().signal).catch((e) => e);
    expect(error).toMatchObject({ category: 'budget', status: 422, permanent: true });
    expect(error.message).toBe('frame_check_failed');
  });

  it('prefers the development key over the user key', async () => {
    const request = vi.fn(async () => Response.json(reply()));
    vi.stubGlobal('fetch', request);
    const access = vi.fn(async () => ({ endpoint: 'https://gateway', apiKey: 'user' }));
    await new OpenRouterFrameGate({ apiKey: 'dev-key', access }).check(
      image,
      new AbortController().signal,
    );
    expect(access).not.toHaveBeenCalled();
    expect((request.mock.calls[0] as unknown as [string])[0]).toBe(FRAME_DECIDER_ENDPOINT);
  });

  it('reports a missing key when the user has no gateway key', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const error = await new OpenRouterFrameGate({ access: async () => undefined })
      .check(image, new AbortController().signal)
      .catch((e) => e);
    expect(error).toMatchObject({ category: 'missing_key', permanent: true });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not infer without a key and aborts a pending request', async () => {
    const request = vi.fn(async () => {
      throw new Error('must not call');
    });
    vi.stubGlobal('fetch', request);
    await expect(
      new OpenRouterFrameGate({}).check(image, new AbortController().signal),
    ).rejects.toThrow('frame_check_failed');
    expect(request).not.toHaveBeenCalled();
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(new Error('raw secret')), {
              once: true,
            });
          }),
      ),
    );
    const checking = new OpenRouterFrameGate({ apiKey: 'test-only' }).check(
      image,
      controller.signal,
    );
    controller.abort();
    await expect(checking).rejects.toThrow('frame_check_failed');
  });
});
