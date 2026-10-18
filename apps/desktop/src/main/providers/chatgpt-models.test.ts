import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../remote/http';
import { fetchChatGPTModels, pickChatGPTModel } from './chatgpt-models';

const TOKEN = 'chatgpt-access-token-123';

/** One model of GET /v1/models as OpenAI sends it for a ChatGPT sign-in. */
function model(slug: string, fields: Record<string, unknown> = {}) {
  return {
    slug,
    display_name: slug,
    description: 'Synthetic test model.',
    visibility: 'list',
    supported_in_api: true,
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
    shell_type: 'shell_command',
    priority: 1,
    ...fields,
  };
}

/** A Plus account's list: no gpt-6.1-sol, two hidden models. */
const PLUS = {
  models: [
    model('gpt-6-luna'),
    model('gpt-5.6-terra'),
    model('gpt-5.6-luna'),
    model('gpt-reserve', { visibility: 'hide' }),
    model('codex-auto-review', { visibility: 'hide' }),
  ],
};

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(answer: (sent: Sent) => Response | Promise<Response>): FetchFn & {
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = { url: String(input), init };
    sent.push(req);
    return answer(req);
  }) as FetchFn & { sent: Sent[] };
  fn.sent = sent;
  return fn;
}

describe('fetchChatGPTModels', () => {
  it("lists the account's models with only the bearer token, on api.openai.com", async () => {
    const fetch = fakeFetch(() => Response.json(PLUS));
    expect(await fetchChatGPTModels(fetch, TOKEN)).toEqual([
      'gpt-6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(fetch.sent).toHaveLength(1);
    const [{ url, init }] = fetch.sent as [Sent];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.redirect).toBe('error');
    expect([...new Headers(init?.headers).entries()]).toEqual([
      ['authorization', `Bearer ${TOKEN}`],
    ]);
  });

  it('drops a model only when a field says the app cannot use it', async () => {
    const fetch = fakeFetch(() =>
      Response.json({
        models: [
          model('hidden', { visibility: 'hide' }),
          model('not-in-api', { supported_in_api: false }),
          model('text-only', { input_modalities: ['text'] }),
          // Missing fields keep the model: a smaller answer must not drop every model.
          { slug: 'bare' },
          model('api-unknown', { supported_in_api: undefined }),
          model('listed'),
        ],
      }),
    );
    expect(await fetchChatGPTModels(fetch, TOKEN)).toEqual(['bare', 'api-unknown', 'listed']);
  });

  it('throws on an answer that is not a model list, without the token or the body', async () => {
    for (const body of ['not json', '{"data":[{"id":"gpt-6-luna"}]}', '{"models":[{"id":1}]}']) {
      const fetch = fakeFetch(() => new Response(body, { status: 200 }));
      const err = await fetchChatGPTModels(fetch, TOKEN).catch((e: unknown) => e);
      expect(err).toMatchObject({ category: 'invalid' });
      expect(String((err as Error).message)).not.toContain(TOKEN);
      expect(String((err as Error).message)).not.toContain('gpt-6-luna');
    }
  });

  it('throws on an error status, by kind', async () => {
    const cases: [number, string][] = [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [429, 'http'],
      [500, 'http'],
    ];
    for (const [status, category] of cases) {
      const fetch = fakeFetch(() => Response.json(PLUS, { status }));
      await expect(fetchChatGPTModels(fetch, TOKEN)).rejects.toMatchObject({ category });
    }
  });

  it('throws when OpenAI cannot be reached or takes too long', async () => {
    const offline = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchChatGPTModels(offline, TOKEN)).rejects.toMatchObject({
      category: 'network',
    });
    const hanging = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    await expect(fetchChatGPTModels(hanging, TOKEN, 20)).rejects.toMatchObject({
      category: 'timeout',
    });
  });
});

describe('pickChatGPTModel', () => {
  const preferred = ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-terra'];

  it('picks the first preferred model the account lists', () => {
    // Plus: no sol.
    expect(pickChatGPTModel(['gpt-5.6-terra', 'gpt-6-luna', 'gpt-5.6-luna'], preferred)).toBe(
      'gpt-6-luna',
    );
    // Pro: sol first, whatever the list order.
    expect(pickChatGPTModel(['gpt-6-luna', 'gpt-6.1-sol'], preferred)).toBe('gpt-6.1-sol');
    expect(pickChatGPTModel(['gpt-5.6-luna', 'gpt-5.6-terra'], preferred)).toBe('gpt-5.6-terra');
  });

  it('picks nothing when the account lists none of them', () => {
    expect(pickChatGPTModel(['gpt-5.6-luna'], preferred)).toBeUndefined();
    expect(pickChatGPTModel([], preferred)).toBeUndefined();
  });
});
