import { afterEach, describe, expect, it } from 'vitest';
import { createFakeFetch, createTestApp, jsonResponse, type TestApp } from '../testing/harness';

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** The fake provider library's voucher key: the gateway key sent with learnings and votes. */
const VOUCHER_KEY = 'sk-litellm-voucher-key-123456';

async function setup(handler: Parameters<typeof createFakeFetch>[0], { voucher = true } = {}) {
  const fetch = createFakeFetch(handler);
  app = await createTestApp({
    fetch,
    env: { keyServerUrl: 'http://keys.test', feedbackServerUrl: 'http://feedback.test' },
  });
  if (voucher) expect((await app.invoke('providers.redeemVoucher', 'VALID-CODE')).ok).toBe(true);
  const { procedureId, token } = await app.procedureWithToken();
  await app.vault.setPersonal(
    [
      { key: 'givenName', value: 'Lucía' },
      { key: 'surname1', value: 'Fernández' },
      { key: 'dniNumber', value: '12345678Z' },
    ],
    'manual',
  );
  return { app, fetch, procedureId, token };
}

describe('feedback.submit', () => {
  it('does not contact a backend when the service has not been deployed', async () => {
    const fetch = createFakeFetch(() => {
      throw new Error('Unexpected request');
    });
    app = await createTestApp({
      fetch,
      env: { feedbackServerUrl: undefined, keyServerUrl: undefined },
    });
    const { token } = await app.procedureWithToken();
    const result = await app.rpc('feedback.search', { query: 'cita dni' }, token);
    expect(result).toMatchObject({ status: 503, body: { error: { code: 'unavailable' } } });
    const voucher = await app.invoke('providers.redeemVoucher', 'test-code');
    expect(voucher.ok).toBe(false);
    expect(fetch.requests).toEqual([]);
  });

  it('searches and shares learnings with all feature flags off', async () => {
    const fetch = createFakeFetch((req) => {
      if (req.url.pathname === '/v1/feedback/search') return jsonResponse(200, { results: [] });
      if (req.url.pathname === '/v1/feedback')
        return jsonResponse(200, { id: 'fb_1', redactions: 0 });
      throw new Error('Unexpected request');
    });
    app = await createTestApp({
      fetch,
      env: { keyServerUrl: 'http://keys.test', feedbackServerUrl: 'http://feedback.test' },
      features: { dniePhone: false, mustUpdate: false, errorReports: false },
    });
    expect((await app.invoke('providers.redeemVoucher', 'VALID-CODE')).ok).toBe(true);
    const { token } = await app.procedureWithToken();
    const search = await app.rpc('feedback.search', { query: 'cita dni' }, token);
    expect(search).toMatchObject({ status: 200, body: { ok: true, result: { results: [] } } });
    const submit = await app.rpc(
      'feedback.submit',
      {
        procedure: 'Renovación del DNI',
        kind: 'tip',
        title: 'Mira las citas temprano',
        body: 'Las citas nuevas aparecen a primera hora.',
      },
      token,
    );
    expect(submit).toMatchObject({
      status: 200,
      body: { ok: true, result: { submitted: true, id: 'fb_1' } },
    });
    expect(fetch.requests.map((r) => r.url.pathname)).toEqual([
      '/v1/feedback/search',
      '/v1/feedback',
    ]);
  });

  it('scrubs every field (vault values + regex), strips URL params and shows what was shared', async () => {
    const { app, fetch, procedureId, token } = await setup((req) => {
      if (req.url.pathname === '/v1/feedback')
        return jsonResponse(200, { id: 'fb_1', redactions: 1 });
      return jsonResponse(404, {});
    });
    const res = await app.rpc(
      'feedback.submit',
      {
        procedure: 'Renovación del DNI',
        administration: 'Policía Nacional',
        region: 'Comunidad de Madrid',
        kind: 'tip',
        title: 'Cita rápida para Lucía Fernández',
        body: 'Con el DNI 12345678Z y el correo lucia.f@example.com la cita salió en dos días.',
        tags: ['dni', 'Fernández'],
        urls: ['https://sede.policia.gob.es/citaprevia/12345678Z?dni=12345678Z#paso2'],
      },
      token,
    );
    expect(res.body.result).toEqual({ submitted: true, id: 'fb_1', redactions: 7 });
    const sent = fetch.requests.find((r) => r.url.pathname === '/v1/feedback')!;
    const json = JSON.stringify(sent.body);
    for (const leaked of [
      'Lucía',
      'Fernández',
      '12345678Z',
      'lucia.f@example.com',
      '?dni',
      '#paso2',
    ])
      expect(json).not.toContain(leaked);
    expect(sent.body).toMatchObject({
      procedure: 'Renovación del DNI',
      administration: 'Policía Nacional',
      kind: 'tip',
      appVersion: '0.0.0-test',
      author: 'test/voucher-model · medium',
    });
    expect(sent.body.urls).toEqual(['https://sede.policia.gob.es/citaprevia/%5BDATO%5D']);
    expect(sent.headers.get('authorization')).toBe(`Bearer ${VOUCHER_KEY}`);
    const notice = app.services.procedures.transcript(procedureId).at(-1);
    expect(notice?.type).toBe('notice');
    const text = notice?.type === 'notice' ? notice.text : '';
    expect(text).toContain('Has compartido este aprendizaje');
    expect(text).toContain(sent.body.title);
    expect(text).toContain(sent.body.body);
    expect(text).not.toContain('12345678Z');
  });

  it('sets the author from the procedure agent model, never from the agent', async () => {
    const { app, fetch, token } = await setup((req) =>
      req.url.pathname === '/v1/feedback'
        ? jsonResponse(201, { id: 'fb_2', redactions: 0 })
        : jsonResponse(404, {}),
    );
    const res = await app.rpc(
      'feedback.submit',
      {
        procedure: 'Renovación del DNI',
        kind: 'tip',
        title: 'Mira las citas temprano',
        body: 'Las citas nuevas aparecen a primera hora.',
        author: 'human',
      },
      token,
    );
    expect(res.body.result).toMatchObject({ submitted: true });
    const sent = fetch.requests.find((r) => r.url.pathname === '/v1/feedback')!;
    expect(sent.body.author).toBe('test/voucher-model · medium');
  });

  it('sends nothing without a gateway key, and passes on refusals as reasons', async () => {
    const tip = {
      procedure: 'Renovación del DNI',
      kind: 'tip',
      title: 'Mira las citas temprano',
      body: 'Las citas nuevas aparecen a primera hora.',
    };
    const none = await setup(() => jsonResponse(201, { id: 'x', redactions: 0 }), {
      voucher: false,
    });
    expect((await none.app.rpc('feedback.submit', tip, none.token)).body.result).toMatchObject({
      submitted: false,
      reason: expect.stringContaining('voucher'),
    });
    expect(none.fetch.requests).toEqual([]);
    await none.app.close();

    const broke = await setup(() =>
      jsonResponse(403, { error: { code: 'no_credit', message: 'No credit.' } }),
    );
    expect((await broke.app.rpc('feedback.submit', tip, broke.token)).body.result).toMatchObject({
      submitted: false,
      reason: expect.stringContaining('no credit'),
    });
  });

  it('sends nothing when the user turned sharing off', async () => {
    const { app, fetch, token } = await setup(() => jsonResponse(200, { id: 'x', redactions: 0 }));
    await app.invoke('settings.update', { shareLearnings: false });
    const res = await app.rpc(
      'feedback.submit',
      {
        procedure: 'Renovación del DNI',
        kind: 'tip',
        title: 'Un consejo útil',
        body: 'Pide cita a primera hora.',
      },
      token,
    );
    expect(res.body.result).toMatchObject({ submitted: false, redactions: 0 });
    expect(fetch.requests).toEqual([]);
  });

  it('does not send submissions emptied by scrubbing; offline search is unavailable', async () => {
    const { app, fetch, token } = await setup(() => {
      throw new TypeError('fetch failed');
    });
    const res = await app.rpc(
      'feedback.submit',
      {
        procedure: 'Renovación del DNI',
        kind: 'tip',
        title: 'Lucía Fernández',
        body: 'Lucía Fernández 12345678Z',
      },
      token,
    );
    expect(res.body.result).toMatchObject({ submitted: false });
    expect(fetch.requests).toEqual([]);
    const search = await app.rpc('feedback.search', { query: 'cita dni' }, token);
    expect(search).toMatchObject({ status: 503, body: { error: { code: 'unavailable' } } });
  });

  it('feedback.search scrubs the query', async () => {
    const { app, fetch, token } = await setup(() => jsonResponse(200, { results: [] }));
    const res = await app.rpc(
      'feedback.search',
      { query: 'cita para Lucía', procedure: 'DNI' },
      token,
    );
    expect(res.body.result).toEqual({ results: [] });
    expect(fetch.requests[0]?.url.searchParams.get('q')).toBe('cita para [DATO]');
  });
});

describe('feedback.vote', () => {
  const id = '6f1c2b9e-0d4a-4c1e-9a52-3b7d8e9f0a1b';

  it('sends only the vote', async () => {
    const { app, fetch, token } = await setup((req) =>
      req.url.pathname === `/v1/feedback/${id}/vote`
        ? jsonResponse(200, { id, counted: true })
        : jsonResponse(404, {}),
    );
    const res = await app.rpc('feedback.vote', { id, vote: 'down' }, token);
    expect(res.body.result).toEqual({ counted: true });
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]).toMatchObject({ method: 'POST', body: { vote: 'down' } });
    expect(fetch.requests[0]?.headers.get('authorization')).toBe(`Bearer ${VOUCHER_KEY}`);
  });

  it('needs a gateway key and passes on refusals as reasons', async () => {
    const none = await setup(() => jsonResponse(200, { id, counted: true }), { voucher: false });
    const noKey = await none.app.rpc('feedback.vote', { id, vote: 'up' }, none.token);
    expect(noKey.body.result).toMatchObject({
      counted: false,
      reason: expect.stringContaining('voucher'),
    });
    expect(none.fetch.requests).toEqual([]);
    await none.app.close();

    const limited = await setup(() =>
      jsonResponse(429, { error: { code: 'quota_exceeded', message: 'Daily limit reached.' } }),
    );
    const res = await limited.app.rpc('feedback.vote', { id, vote: 'up' }, limited.token);
    expect(res.body.result).toMatchObject({
      counted: false,
      reason: expect.stringContaining('Do not retry'),
    });
  });

  it('explains repeated votes and unknown ids', async () => {
    const { app, token } = await setup((req) =>
      req.url.pathname === `/v1/feedback/${id}/vote`
        ? jsonResponse(200, { id, counted: false })
        : jsonResponse(404, { error: { code: 'not_found', message: 'Feedback not found.' } }),
    );
    expect((await app.rpc('feedback.vote', { id, vote: 'up' }, token)).body.result).toMatchObject({
      counted: false,
      reason: expect.stringContaining('already'),
    });
    const unknown = await app.rpc('feedback.vote', { id: 'f-unknown', vote: 'up' }, token);
    expect(unknown.body.result).toMatchObject({
      counted: false,
      reason: expect.stringContaining('feedback_search'),
    });
  });

  it('sends nothing when the user turned sharing off', async () => {
    const { app, fetch, token } = await setup(() => jsonResponse(200, { id, counted: true }));
    await app.invoke('settings.update', { shareLearnings: false });
    const res = await app.rpc('feedback.vote', { id, vote: 'up' }, token);
    expect(res.body.result).toMatchObject({ counted: false });
    expect(fetch.requests).toEqual([]);
  });
});

describe('agent credentials over the bridge', () => {
  it('returns only the configured provider credential', async () => {
    const { app, token } = await setup(() => jsonResponse(404, {}));
    await app.invoke('providers.setByok', {
      provider: 'anthropic',
      apiKey: 'sk-ant-secret-key',
      model: 'claude-x',
    });
    const own = await app.rpc('agent.credential', { providerId: 'anthropic' }, token);
    expect(own.body.result).toEqual({ credential: { type: 'api_key', key: 'sk-ant-secret-key' } });
    const other = await app.rpc('agent.credential', { providerId: 'openai' }, token);
    expect(other.body.result).toEqual({ credential: null });
    expect(app.logLines.join('\n')).not.toContain('sk-ant-secret-key');
  });

  it('hands the Exa key to procedure agents of BYOK and custom endpoints only', async () => {
    const { app, token } = await setup(() => jsonResponse(404, {}));
    await app.invoke('providers.setByok', {
      provider: 'anthropic',
      apiKey: 'sk-ant-secret-key',
      model: 'claude-x',
    });
    expect((await app.rpc('agent.exaKey', {}, token)).body.result).toEqual({ key: null });
    await app.invoke('providers.setExaKey', 'exa-secret-key-123');
    expect((await app.rpc('agent.exaKey', {}, token)).body.result).toEqual({
      key: 'exa-secret-key-123',
    });
    // The assistant never researches: it can't read the key.
    const assistant = await app.say('Hola');
    expect((await app.rpc('agent.exaKey', {}, assistant.token)).body.error?.code).toBe(
      'policy_denied',
    );
    expect(app.logLines.join('\n')).not.toContain('exa-secret-key-123');
    // A voucher has no use for it: switching away deletes it.
    expect((await app.invoke('providers.redeemVoucher', 'VALID-CODE')).ok).toBe(true);
    expect((await app.rpc('agent.exaKey', {}, token)).body.result).toEqual({ key: null });
  });

  it('gives custom endpoints without a key a placeholder', async () => {
    const { app, token } = await setup(() => jsonResponse(404, {}));
    await app.invoke('providers.setCustom', {
      baseUrl: 'http://127.0.0.1:8789/v1',
      api: 'openai-completions',
      model: 'mock-model',
    });
    const res = await app.rpc('agent.credential', { providerId: 'custom' }, token);
    expect(res.body.result.credential).toMatchObject({ type: 'api_key' });
  });
});
