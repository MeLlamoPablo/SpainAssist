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
    model_specialty: null,
    ...fields,
  };
}

/** A Plus account's list as OpenAI ranks it (`priority`), in another order: no gpt-6.1-sol. */
const PLUS = {
  models: [
    model('gpt-5.6-terra', { priority: 8 }),
    model('codex-auto-review', { priority: 43, visibility: 'hide' }),
    model('gpt-5.6-luna', { priority: 9 }),
    model('gpt-reserve', { priority: 4, visibility: 'hide' }),
    model('gpt-6-luna', { priority: 4 }),
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
  it("lists the account's models as OpenAI ranks them, with only the bearer token", async () => {
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
          model('specialty', { model_specialty: 'code_review' }),
          model('listed'),
        ],
      }),
    );
    expect(await fetchChatGPTModels(fetch, TOKEN)).toEqual(['bare', 'api-unknown', 'listed']);
  });

  it('ranks by priority, keeps OpenAI order for ties, and puts unranked models last', async () => {
    const fetch = fakeFetch(() =>
      Response.json({
        models: [
          model('unranked-a', { priority: undefined }),
          model('tie-first', { priority: 5 }),
          model('worst', { priority: 20 }),
          model('odd-rank', { priority: 'high' }),
          model('tie-second', { priority: 5 }),
          model('best', { priority: 1 }),
        ],
      }),
    );
    expect(await fetchChatGPTModels(fetch, TOKEN)).toEqual([
      'best',
      'tie-first',
      'tie-second',
      'worst',
      'unranked-a',
      'odd-rank',
    ]);
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
  const all = () => true;

  it("keeps the app's model when the account lists it, even ranked lower", () => {
    expect(pickChatGPTModel(['gpt-6-luna', 'gpt-6.1-sol'], 'gpt-6.1-sol', all)).toBe('gpt-6.1-sol');
    // Even when pi's catalog does not know it.
    expect(pickChatGPTModel(['gpt-6-luna', 'gpt-6.1-sol'], 'gpt-6.1-sol', () => false)).toBe(
      'gpt-6.1-sol',
    );
  });

  it('otherwise picks the model OpenAI ranks first', async () => {
    const plus = await fetchChatGPTModels(
      fakeFetch(() => Response.json(PLUS)),
      TOKEN,
    );
    expect(pickChatGPTModel(plus, 'gpt-6.1-sol', all)).toBe('gpt-6-luna');
  });

  it('prefers a model pi knows, then any listed model, over the default', () => {
    const listed = ['gpt-7-luna', 'gpt-6-luna', 'gpt-5.6-terra'];
    const known = (id: string) => id !== 'gpt-7-luna';
    expect(pickChatGPTModel(listed, 'gpt-6.1-sol', known)).toBe('gpt-6-luna');
    // None known: the best-ranked one still beats a default the plan refuses.
    expect(pickChatGPTModel(listed, 'gpt-6.1-sol', () => false)).toBe('gpt-7-luna');
  });

  it('picks nothing from an empty list', () => {
    expect(pickChatGPTModel([], 'gpt-6.1-sol', all)).toBeUndefined();
  });
});
