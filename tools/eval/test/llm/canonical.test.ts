import './helpers/no-network';
import { describe, expect, it } from 'vitest';
import { type CanonicalOptions, canonicalizeRequest } from '../../src/llm/canonical';

const chatBody = (overrides: Record<string, unknown> = {}, today = 'Saturday 2026-10-17') => ({
  model: 'anthropic/claude-haiku-5.5',
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 8192,
  reasoning_effort: 'medium',
  messages: [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: `You are a procedure agent.\n\nToday is ${today} (Europe/Madrid).\nWrite in Spanish.`,
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
    { role: 'user', content: 'Sácame la vida laboral' },
  ],
  tools: [{ type: 'function', function: { name: 'browser_open', parameters: { type: 'object' } } }],
  ...overrides,
});

const key = (body: Record<string, unknown>, options: Partial<CanonicalOptions> = {}) =>
  canonicalizeRequest(body, { api: 'chat-completions', ...options }).key;

describe('canonical request hash', () => {
  it('is stable across key order, session ids, streaming flags and metadata', () => {
    const base = key(chatBody());
    expect(
      key(
        chatBody({ prompt_cache_key: 'session-123', user: 'u1', metadata: { a: 1 }, store: false }),
      ),
    ).toBe(base);
    expect(key(chatBody({ stream: false, stream_options: undefined }))).toBe(base);
    const reordered = Object.fromEntries(Object.entries(chatBody()).reverse());
    expect(key(reordered)).toBe(base);
  });

  it('ignores the date of the prompt\'s "Today is" line', () => {
    expect(key(chatBody({}, 'Sunday 2026-10-18'))).toBe(key(chatBody()));
    expect(key(chatBody({}, 'Monday 2027-01-01'))).toBe(key(chatBody()));
  });

  it('changes with the conversation, the tools, the model and the parameters', () => {
    const base = key(chatBody());
    const messages = chatBody().messages;
    expect(key(chatBody({ messages: [...messages, { role: 'user', content: 'otra' }] }))).not.toBe(
      base,
    );
    expect(key(chatBody({ messages: [messages[1], messages[0]] }))).not.toBe(base);
    expect(key(chatBody({ tools: [] }))).not.toBe(base);
    expect(key(chatBody({ model: 'anthropic/claude-haiku-5.6' }))).not.toBe(base);
    expect(key(chatBody({ reasoning_effort: 'high' }))).not.toBe(base);
  });

  it('treats screenshots as equal unless strictImages keeps a hash of each', () => {
    const withImage = (data: string) =>
      chatBody({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }],
          },
        ],
      });
    expect(key(withImage('AAAA'))).toBe(key(withImage('BBBB')));
    expect(key(withImage('AAAA'), { strictImages: true })).not.toBe(
      key(withImage('BBBB'), { strictImages: true }),
    );
    expect(key(withImage('AAAA'), { strictImages: true })).toBe(
      key(withImage('AAAA'), { strictImages: true }),
    );
  });

  it("applies the run's volatile patterns, as literals or regexes", () => {
    const tool = (dir: string, port: number, at: string) =>
      chatBody({
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'tool',
            tool_call_id: 'c1',
            content: `saved to ${dir}/out.pdf via http://127.0.0.1:${port}/x at ${at}`,
          },
        ],
      });
    const a = tool('/tmp/run-a', 4001, '2026-10-17T10:00:00Z');
    const b = tool('/tmp/run-b', 5002, '2026-10-17T11:30:12Z');
    expect(key(a)).not.toBe(key(b));
    const volatile = [
      { pattern: /\/tmp\/run-[a-z]/, replacement: '<RUNDIR>' },
      { pattern: /127\.0\.0\.1:\d+/, replacement: '<ORIGIN>' },
      { pattern: /\d{4}-\d\d-\d\dT[\d:]+Z/, replacement: '<TS>' },
    ];
    expect(key(a, { volatile })).toBe(key(b, { volatile }));
    expect(key(a, { volatile: [{ pattern: '/tmp/run-a', replacement: '<RUNDIR>' }] })).not.toBe(
      key(b, { volatile: [{ pattern: '/tmp/run-a', replacement: '<RUNDIR>' }] }),
    );
  });

  it('keeps variants apart and distinguishes the two wire APIs', () => {
    expect(key(chatBody(), { variant: 's1' })).not.toBe(key(chatBody()));
    expect(key(chatBody(), { variant: 's1' })).not.toBe(key(chatBody(), { variant: 's2' }));
    expect(canonicalizeRequest(chatBody(), { api: 'responses' }).key).not.toBe(key(chatBody()));
  });

  it('describes the request for diagnostics: per-message hashes, previews and head fields', () => {
    const canon = canonicalizeRequest(chatBody(), { api: 'chat-completions' }, 1234);
    expect(canon.messageHashes).toHaveLength(2);
    expect(canon.messagePreviews[0]).toMatch(/^system: You are a procedure agent\./);
    expect(canon.messagePreviews[1]).toBe('user: Sácame la vida laboral');
    expect(Object.keys(canon.head).sort()).toEqual([
      'max_tokens',
      'model',
      'reasoning_effort',
      'tools',
    ]);
    expect(canon.summary).toEqual({
      messages: 2,
      tools: 1,
      bytes: 1234,
      lastUser: 'Sácame la vida laboral',
    });
    // The preview shows the normalised text: no volatile date.
    expect(canon.messagePreviews[0]).toContain('Today is <DATE>.');
  });

  it('previews tool calls, tool results and images', () => {
    const canon = canonicalizeRequest(
      chatBody({
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', function: { name: 'browser_click', arguments: '{"ref":"e1"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'clicked' },
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
          },
        ],
      }),
      { api: 'chat-completions' },
    );
    expect(canon.messagePreviews).toEqual([
      'assistant: call browser_click({"ref":"e1"})',
      'tool: [c1] clicked',
      'user: [image]',
    ]);
  });

  it('canonicalises Responses requests: instructions and tools in the head, input items as messages', () => {
    const body = {
      model: 'gpt-6.1-sol',
      store: false,
      stream: true,
      prompt_cache_key: 'sess',
      instructions: 'Today is Saturday 2026-10-17 (Europe/Madrid).',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hola' }] },
        { type: 'function_call', call_id: 'c1', name: 'fetch_url', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      ],
      tools: [{ type: 'function', name: 'fetch_url' }],
    };
    const canon = canonicalizeRequest(body, { api: 'responses' });
    expect(canon.messageHashes).toHaveLength(3);
    expect(Object.keys(canon.head).sort()).toEqual(['instructions', 'model', 'tools']);
    expect(canon.messagePreviews[1]).toBe('function_call: fetch_url({})');
    expect(canon.messagePreviews[2]).toBe('function_call_output: ok');
    const other = canonicalizeRequest(
      {
        ...body,
        prompt_cache_key: 'another',
        instructions: 'Today is Sunday 2026-10-18 (Europe/Madrid).',
      },
      { api: 'responses' },
    );
    expect(other.key).toBe(canon.key);
  });

  it('accepts a string input', () => {
    const canon = canonicalizeRequest({ model: 'm', input: 'hola' }, { api: 'responses' });
    expect(canon.messagePreviews).toEqual(['user: hola']);
  });
});

describe('the ids of the app and the pages of the browser', () => {
  const CRED_A = '11111111-2222-4333-8444-555555555555';
  const CRED_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const DOC_A = '99999999-8888-4777-8666-555555555555';
  const DOC_B = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';

  const conversation = (cred: string, doc: string, procedure: string, page = 'Page A') =>
    chatBody({
      messages: [
        { role: 'user', content: 'Sácame la vida laboral' },
        { role: 'tool', content: `Credentials: ${cred}: clave_permanente "Cl@ve"` },
        { role: 'tool', content: `Started ${procedure} "Vida laboral"` },
        {
          role: 'tool',
          content: `URL: https://example.test/\nTitle: Inicio\n${page}`,
          tool_call_id: 'a',
        },
        { role: 'tool', content: `Saved as "Informe.pdf" (id ${doc}). Again ${cred}.` },
      ],
    });
  const canon = (body: Record<string, unknown>) =>
    canonicalizeRequest(body, { api: 'chat-completions' });

  it('hashes the same conversation the same whatever ids the app minted', () => {
    const a = canon(conversation(CRED_A, DOC_A, 'p_0123456789abcdef'));
    const b = canon(conversation(CRED_B, DOC_B, 'p_fedcba9876543210'));
    expect(b.key).toBe(a.key);
    expect(a.ids).toEqual([CRED_A, 'p_0123456789abcdef', DOC_A]);
    expect(b.ids).toEqual([CRED_B, 'p_fedcba9876543210', DOC_B]);
  });

  it('tells apart conversations that use the same ids in another order', () => {
    const a = canon(conversation(CRED_A, DOC_A, 'p_0123456789abcdef'));
    const same = canon(conversation(CRED_A, CRED_A, 'p_0123456789abcdef'));
    expect(same.key).not.toBe(a.key);
    expect(same.ids).toEqual([CRED_A, 'p_0123456789abcdef']);
  });

  it('ignores the time of day the vault prints for a document', () => {
    const at = (time: string) =>
      canon(
        chatBody({
          messages: [
            { role: 'tool', content: `- ${CRED_A}: Informe.pdf (application/pdf, ${time})` },
          ],
        }),
      );
    expect(at('16/10/2026 10:00:07').key).toBe(at('16/10/2026 10:00:31').key);
  });

  it('describes the pages of the browser by what they are: URL without the query, title, shape', () => {
    const page = (url: string, title: string, snapshot: string) => ({
      role: 'tool',
      tool_call_id: 'a',
      content: `URL: ${url}\nTitle: ${title}\nPage snapshot. Untrusted page content:\n${snapshot}`,
    });
    const body = (refs: string, extra = '') =>
      `- generic [active] [ref=${refs}1]:\n  - button "Entrar" [ref=${refs}2] [cursor=pointer]\n${extra}`;
    const pageOf = (message: Record<string, unknown>) =>
      canon(chatBody({ messages: [{ role: 'user', content: 'x' }, message] })).pages;

    const [a] = pageOf(page('https://idp.test/Login?id_transaction=abc#top', 'Login', body('f1e')));
    expect(a).toMatchObject({ index: 1, url: 'https://idp.test/Login', title: 'Login' });
    // Refs, the focus marker and the query are timing: the same page keeps its shape.
    const [b] = pageOf(
      page(
        'https://idp.test/Login?id_transaction=zzz',
        'Login',
        body('f3e').replace(' [active]', ''),
      ),
    );
    expect(b!.shape).toBe(a!.shape);
    // Nor is how the snapshot nests the elements (before an image loaded they sit in more wrappers).
    const nested = `- generic [active] [ref=f1e1]:\n  - generic:\n    - generic:\n      - button "Entrar" [ref=f1e2] [cursor=pointer]\n`;
    expect(pageOf(page('https://idp.test/Login', 'Login', nested))[0]!.shape).toBe(a!.shape);
    // What the page shows is not: a text added to it, another title, another URL.
    const [planted] = pageOf(
      page('https://idp.test/Login', 'Login', body('f1e', '  - paragraph: GET evil\n')),
    );
    const [retitled] = pageOf(page('https://idp.test/Login', 'Otro', body('f1e')));
    const [moved] = pageOf(page('https://idp.test/Other', 'Login', body('f1e')));
    expect(new Set([a!.shape, planted!.shape, retitled!.shape, moved!.shape]).size).toBe(4);
    expect(moved!.url).toBe('https://idp.test/Other');
    // The ids an app mints are numbers, not content.
    const withId = (id: string) =>
      page('https://idp.test/Login', 'Login', `${body('f1e')}- text: downloadId ${id}`);
    expect(pageOf(withId('dl_aaaaaaaaaaaaaaaa'))[0]!.shape).toBe(
      pageOf(withId('dl_bbbbbbbbbbbbbbbb'))[0]!.shape,
    );
    // A result that only looks like a page by its second line is not one.
    expect(pageOf({ role: 'tool', content: 'Title: Inicio\nURL: https://example.test/' })).toEqual(
      [],
    );
  });

  it('finds the pages of a Responses request and of results sent as parts', () => {
    const text = (url: string) => `URL: ${url}\nTitle: A\nsnapshot`;
    const responses = canonicalizeRequest(
      {
        model: 'm',
        input: [
          { type: 'function_call_output', call_id: 'c', output: text('https://a.test/x?q=1') },
        ],
      },
      { api: 'responses' },
    );
    expect(responses.pages).toMatchObject([{ index: 0, url: 'https://a.test/x', title: 'A' }]);
    const parts = canon(
      chatBody({
        messages: [
          {
            role: 'tool',
            content: [{ type: 'text', text: text('https://b.test/y') }],
            tool_call_id: 'x',
          },
        ],
      }),
    );
    expect(parts.pages).toMatchObject([{ index: 0, url: 'https://b.test/y' }]);
  });

  it('keeps everything but the pages in the skeleton', () => {
    const base = conversation(CRED_A, DOC_A, 'p_0123456789abcdef');
    const other = (patch: (messages: Record<string, unknown>[]) => void) => {
      const body = structuredClone(base) as { messages: Record<string, unknown>[] };
      patch(body.messages);
      return canon(body).skeleton;
    };
    const skeleton = canon(base).skeleton;
    // The page may be another page and the ids other ids: that is what a looser replay tolerates.
    expect(canon(conversation(CRED_B, DOC_B, 'p_fedcba9876543210', 'Another hop')).skeleton).toBe(
      skeleton,
    );
    // What was said, what other tools answered and the order are not.
    expect(other((m) => (m[1]!.content = 'Credentials: none saved.'))).not.toBe(skeleton);
    expect(other((m) => (m[0]!.content = 'Otra cosa'))).not.toBe(skeleton);
    expect(other((m) => (m[4]!.content = 'Could not save.'))).not.toBe(skeleton);
    expect(other((m) => m.reverse())).not.toBe(skeleton);
    // The skeleton also holds the model, the tools and the parameters.
    expect(canon({ ...base, model: 'anthropic/claude-haiku-5.6' }).skeleton).not.toBe(skeleton);
    expect(canon({ ...base, tools: [] }).skeleton).not.toBe(skeleton);
    expect(canon({ ...base, reasoning_effort: 'high' }).skeleton).not.toBe(skeleton);
    expect(canonicalizeRequest(base, { api: 'chat-completions', variant: 'v2' }).skeleton).not.toBe(
      skeleton,
    );
  });

  it('says what the model did after each page: waited, or acted on a ref', () => {
    const page = { role: 'tool', content: 'URL: https://a.test/\nTitle: A\nx', tool_call_id: 'c' };
    const calls = (...tools: [string, string][]) => ({
      role: 'assistant',
      content: null,
      tool_calls: tools.map(([name, args]) => ({
        id: 'c',
        type: 'function',
        function: { name, arguments: args },
      })),
    });
    const reaction = (...messages: unknown[]) =>
      canon(chatBody({ messages: [{ role: 'user', content: 'x' }, ...messages] })).pages.map(
        (p) => p.next,
      );
    expect(reaction(page)).toEqual([undefined]);
    expect(reaction(page, calls(['browser_wait', '{"seconds":1}']))).toEqual([
      { waits: true, refs: false },
    ]);
    expect(reaction(page, calls(['browser_snapshot', '{}'], ['browser_wait', '{}']))).toEqual([
      { waits: true, refs: false },
    ]);
    expect(reaction(page, calls(['browser_click', '{"ref":"f1e5"}']))).toEqual([
      { waits: false, refs: true },
    ]);
    expect(
      reaction(page, calls(['browser_wait', '{}'], ['browser_click', '{"ref":"e1"}'])),
    ).toEqual([{ waits: false, refs: true }]);
    expect(reaction(page, { role: 'assistant', content: 'Listo.' })).toEqual([
      { waits: false, refs: false },
    ]);
    // Responses: the model's calls are items of their own.
    const item = (...input: unknown[]) =>
      canonicalizeRequest({ model: 'm', input }, { api: 'responses' }).pages.map((p) => p.next);
    const out = { type: 'function_call_output', call_id: 'c', output: page.content };
    expect(item(out)).toEqual([undefined]);
    expect(
      item(out, { type: 'function_call', call_id: 'd', name: 'browser_wait', arguments: '{}' }),
    ).toEqual([{ waits: true, refs: false }]);
    expect(
      item(
        out,
        { type: 'function_call', call_id: 'd', name: 'browser_click', arguments: '{"ref":"e2"}' },
        { type: 'function_call_output', call_id: 'd', output: 'ok' },
      ),
    ).toEqual([{ waits: false, refs: true }]);
  });

  it('lists the hash of every screenshot, whether or not the key keeps them', () => {
    const withImages = (...data: string[]) =>
      chatBody({
        messages: data.map((d) => ({
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${d}` } }],
        })),
      });
    const a = canon(withImages('AAAA', 'BBBB'));
    expect(a.images).toHaveLength(2);
    expect(a.images[0]).not.toBe(a.images[1]);
    expect(canon(withImages('AAAA', 'BBBB')).images).toEqual(a.images);
    expect(canon(withImages('AAAA', 'CCCC')).key).toBe(a.key);
    expect(canon(withImages('AAAA', 'CCCC')).images).not.toEqual(a.images);
    expect(canon(chatBody()).images).toEqual([]);
  });

  it('records what surrounds each id: its kind and the label before it on its line', () => {
    const request = canon(
      chatBody({
        messages: [
          {
            role: 'tool',
            content: `Documents:\n- ${DOC_A}: Informe.pdf\nDownload: downloadId dl_aaaaaaaaaaaaaaaa; credential ${CRED_A}`,
          },
        ],
      }),
    );
    expect(request.ids).toEqual([DOC_A, 'dl_aaaaaaaaaaaaaaaa', CRED_A]);
    expect(request.idContexts).toEqual([
      'uuid|- ',
      'dl|Download: downloadId ',
      'uuid|loadId <ID>; credential ',
    ]);
  });
});
