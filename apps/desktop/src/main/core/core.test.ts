import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCTION_SERVICES } from '@sa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../app/env';
import { classifyAgentError, friendlyAgentError } from './errors';
import { DebouncedWriter, ensurePrivateDir, writeFileAtomic } from './fs';
import { t } from './i18n';
import { createLogger, redactForLog } from './logger';
import { scrubbableKnownValues } from './secrets';
import { KeyedQueue, Mutex, titleFromMessage } from './util';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('logger', () => {
  it('redacts user content and secrets by key and masks registered secrets anywhere', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sinks: [(l) => lines.push(l)] });
    logger.addSecret('super-secret-password');
    logger.info('typed super-secret-password into page', {
      password: 'hunter2',
      query: 'DNI 12345678Z',
      procedureId: 'p_1',
      nested: { token: 'abc', count: 3 },
    });
    logger.warn('auth header', { header: 'Bearer abcdefghijklmnopqrstuvwxyz' });
    logger.error('key', { info: 'sk-or-v1-0123456789abcdef' });
    const all = lines.join('\n');
    expect(all).not.toContain('super-secret-password');
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('12345678Z');
    expect(all).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(all).not.toContain('sk-or-v1-0123456789abcdef');
    expect(all).toContain('p_1');
    expect(all).toContain('"count":3');
  });

  it('respects the level and child scopes', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', sinks: [(l) => lines.push(l)] });
    logger.info('hidden');
    logger.child('bridge').warn('shown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[bridge] shown');
  });

  it('truncates long strings and arrays', () => {
    const out = redactForLog({
      list: Array.from({ length: 30 }, (_, i) => i),
      s: 'x'.repeat(1000),
    }) as {
      list: unknown[];
      s: string;
    };
    expect(out.list).toHaveLength(21);
    expect(out.s.length).toBeLessThan(400);
  });
});

describe('fs helpers', () => {
  it('writes atomically with private permissions', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sa-fs-'));
    const sub = join(dir, 'a', 'b');
    await ensurePrivateDir(sub);
    await writeFileAtomic(join(sub, 'f.json'), '{"x":1}');
    expect(await readFile(join(sub, 'f.json'), 'utf8')).toBe('{"x":1}');
    if (process.platform !== 'win32') {
      expect((await stat(sub)).mode & 0o777).toBe(0o700);
      expect((await stat(join(sub, 'f.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('coalesces debounced writes and flushes on demand', async () => {
    const writer = new DebouncedWriter(50);
    const written: number[] = [];
    for (let i = 0; i < 5; i++) writer.schedule('k', async () => void written.push(i));
    await writer.flush();
    expect(written).toEqual([4]);
    writer.schedule('k', async () => void written.push(9));
    await writer.cancel('k');
    await new Promise((r) => setTimeout(r, 80));
    expect(written).toEqual([4]);
  });
});

describe('util', () => {
  it('derives placeholder titles from the first message', () => {
    expect(titleFromMessage('  Quiero renovar el DNI\nporque caduca')).toBe(
      'Quiero renovar el DNI',
    );
    expect(titleFromMessage('')).toBe('Nuevo trámite');
    const long = titleFromMessage(
      'Necesito pedir cita para renovar el pasaporte de mi hija en Madrid lo antes posible',
    );
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith('…')).toBe(true);
  });

  it('serializes with Mutex and KeyedQueue', async () => {
    const mutex = new Mutex();
    const order: number[] = [];
    await Promise.all([
      mutex.run(async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      }),
      mutex.run(async () => void order.push(2)),
    ]);
    expect(order).toEqual([1, 2]);
    const queue = new KeyedQueue();
    const seen: string[] = [];
    await Promise.all([
      queue.run('a', async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push('a1');
      }),
      queue.run('b', async () => void seen.push('b1')),
      queue.run('a', async () => void seen.push('a2')),
    ]);
    expect(seen.indexOf('a1')).toBeLessThan(seen.indexOf('a2'));
    expect(seen[0]).toBe('b1');
  });
});

describe('friendly agent errors', () => {
  it('classifies provider failures', () => {
    expect(classifyAgentError('401: {"error":"Invalid API key"}')).toBe('auth');
    expect(classifyAgentError('402: {"message":"Key limit exceeded","code":402}')).toBe('credit');
    // LiteLLM v1.104: a voucher key that spent its max_budget gets 422.
    expect(
      classifyAgentError(
        '422 {"error":{"message":"Budget has been exceeded! Key=sk-...abcd Current cost: 5.01, Max budget: 5.0","type":"budget_exceeded"}}',
      ),
    ).toBe('credit');
    expect(classifyAgentError('429 Too Many Requests')).toBe('rate_limit');
    expect(classifyAgentError('fetch failed: ECONNREFUSED 127.0.0.1:8789')).toBe('network');
    expect(classifyAgentError('No API key found for the selected model.')).toBe('no_provider');
    expect(classifyAgentError('something odd')).toBe('other');
  });

  it.each([
    ['Connection error.', 'No hay conexión a internet.', 'No internet connection.'],
    [
      'APIConnectionError: Connection failed',
      'No hay conexión a internet.',
      'No internet connection.',
    ],
    [
      'Request timed out',
      'El proveedor de IA tarda demasiado en responder. Vuelve a intentarlo.',
      'The AI provider took too long to respond. Try again.',
    ],
    [
      '503 Service unavailable',
      'El proveedor de IA no está disponible ahora. Vuelve a intentarlo más tarde.',
      'The AI provider is unavailable. Try again later.',
    ],
    [
      'context_length_exceeded',
      'La conversación es demasiado larga para este modelo. Elige otro modelo en Ajustes.',
      'The conversation is too long for this model. Choose another model in Settings.',
    ],
    [
      'Unknown provider failure',
      'No se ha podido completar la respuesta. Vuelve a intentarlo.',
      'Could not complete the response. Try again.',
    ],
  ])('localizes %s without raw provider text', (raw, es, en) => {
    expect(friendlyAgentError(raw, 'es')).toBe(es);
    expect(friendlyAgentError(raw, 'en')).toBe(en);
  });

  it('produces plain Spanish and English messages', () => {
    expect(friendlyAgentError('402: Key limit exceeded', 'es')).toBe(t('es', 'agentErrorCredit'));
    expect(friendlyAgentError('401 unauthorized', 'en')).toBe(t('en', 'agentErrorAuth'));
    expect(friendlyAgentError('weird\nstack', 'es')).toBe(
      'No se ha podido completar la respuesta. Vuelve a intentarlo.',
    );
  });
});

describe('env', () => {
  it('uses the built-in production services by default', () => {
    const { keyServerUrl, feedbackServerUrl } = PRODUCTION_SERVICES;
    expect(parseEnv({})).toMatchObject({ keyServerUrl, feedbackServerUrl });
    expect(parseEnv({}, { packaged: true })).toMatchObject({ keyServerUrl, feedbackServerUrl });
  });

  it('turns feature flags on only in development builds', () => {
    expect(parseEnv({}).featureFlags).toBeUndefined();
    expect(parseEnv({ SA_FEATURE_FLAGS: 'dnie-phone, other ' }).featureFlags).toEqual([
      'dnie-phone',
      'other',
    ]);
    expect(parseEnv({ SA_FEATURE_FLAGS: '' }).featureFlags).toEqual([]);
    expect(
      parseEnv({ SA_FEATURE_FLAGS: 'dnie-phone' }, { packaged: true }).featureFlags,
    ).toBeUndefined();
  });

  it("reads Unleash's production flags only in packaged builds", () => {
    const { flagsTokens } = PRODUCTION_SERVICES;
    expect(parseEnv({}).flagsToken).toBe(flagsTokens.development);
    expect(parseEnv({}, { packaged: true }).flagsToken).toBe(flagsTokens.production);
  });

  it('reads the Codex user key only in development builds', () => {
    const SA_DEV_USER_KEY = 'https://llm.example.test/v1/ | sk-dev-key-123';
    expect(parseEnv({ SA_DEV_USER_KEY }).devUserKey).toEqual({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'sk-dev-key-123',
    });
    expect(parseEnv({ SA_DEV_USER_KEY }, { packaged: true }).devUserKey).toBeUndefined();
    const bad = parseEnv({ SA_DEV_USER_KEY: 'sk-dev-key-123' });
    expect(bad.devUserKey).toBeUndefined();
    expect(bad.warnings.join()).toContain('SA_DEV_USER_KEY');
  });

  it('parses overrides', () => {
    const env = parseEnv({
      SA_E2E: '1',
      SA_USER_DATA_DIR: '/tmp/x',
      SA_KEY_SERVER_URL: 'http://127.0.0.1:8787/',
      SA_FEEDBACK_SERVER_URL: 'not a url',
      SA_EXTRA_TRUSTED_HOSTS: 'localhost, Mock.Test ',
      SA_BROWSER_HEADLESS: 'true',
      SA_BROWSER_EXECUTABLE: '/opt/chromium',
      SA_BROWSER_CAPTURE: '1',
      SA_PROVIDER: 'custom|http://127.0.0.1:8789/v1|mock-model',
    });
    expect(env.e2e).toBe(true);
    expect(env.keyServerUrl).toBe('http://127.0.0.1:8787');
    // An invalid URL is ignored (with a warning): the production default applies.
    expect(env.feedbackServerUrl).toBe(PRODUCTION_SERVICES.feedbackServerUrl);
    expect(env.extraTrustedHosts).toEqual(['localhost', 'mock.test']);
    expect(env.browserHeadless).toBe(true);
    expect(env.browserExecutable).toBe('/opt/chromium');
    expect(env.browserCapture).toBe(true);
    expect(parseEnv({ SA_BROWSER_CAPTURE: '1' }, { packaged: true }).browserCapture).toBe(false);
    expect(parseEnv({}).browserCapture).toBe(false);
    expect(parseEnv({ SA_CRLSET_FIXTURE: '1' }).crlSetFixture).toBe(true);
    expect(parseEnv({ SA_CRLSET_FIXTURE: '1' }, { packaged: true }).crlSetFixture).toBe(false);
    expect(env.hideWindow).toBe(false);
    expect(env.provider).toEqual({
      kind: 'custom',
      baseUrl: 'http://127.0.0.1:8789/v1',
      model: 'mock-model',
      api: 'openai-completions',
    });
    expect(env.warnings).toHaveLength(1);
  });

  it('uses the production maps server, none in e2e runs, and a dev-only override', () => {
    expect(parseEnv({}).mapsServerUrl).toBe(PRODUCTION_SERVICES.mapsServerUrl);
    expect(parseEnv({ SA_E2E: '1' }).mapsServerUrl).toBeUndefined();
    expect(parseEnv({ SA_MAPS_SERVER_URL: 'http://127.0.0.1:8793/' }).mapsServerUrl).toBe(
      'http://127.0.0.1:8793',
    );
    expect(
      parseEnv({ SA_MAPS_SERVER_URL: 'http://127.0.0.1:8793' }, { packaged: true }).mapsServerUrl,
    ).toBe(PRODUCTION_SERVICES.mapsServerUrl);
  });

  it('sends error reports from packaged builds, and from development builds only when asked', () => {
    const dsn = 'https://abc@errors.example.com/1';
    expect(parseEnv({}, { packaged: true }).errorReportsDsn).toBe(
      PRODUCTION_SERVICES.errorReportsDsn,
    );
    expect(parseEnv({ SA_ERROR_REPORTS_DSN: dsn }, { packaged: true }).errorReportsDsn).toBe(
      PRODUCTION_SERVICES.errorReportsDsn,
    );
    expect(parseEnv({}).errorReportsDsn).toBeUndefined();
    expect(parseEnv({ SA_ERROR_REPORTS_DSN: dsn }).errorReportsDsn).toBe(dsn);
    expect(parseEnv({ SA_ERROR_REPORTS_DSN: dsn, SA_E2E: '1' }).errorReportsDsn).toBeUndefined();
  });

  it('rejects malformed SA_PROVIDER', () => {
    const env = parseEnv({ SA_PROVIDER: 'openai|x' });
    expect(env.provider).toBeUndefined();
    expect(env.warnings[0]).toMatch(/SA_PROVIDER/);
    expect(
      parseEnv({ SA_PROVIDER: 'custom|http://127.0.0.1:8789/v1|m||images,eyes' }).provider,
    ).toBeUndefined();
    expect(
      parseEnv({ SA_PROVIDER: 'custom|http://127.0.0.1:8789/v1|m||context=12' }).provider,
    ).toBeUndefined();
  });

  it('reads SA_PROVIDER capabilities', () => {
    expect(
      parseEnv({
        SA_PROVIDER:
          'custom|http://127.0.0.1:8789/v1|mock-vision|openai-completions|images, reasoning,context=32768,max=4096',
      }).provider,
    ).toEqual({
      kind: 'custom',
      baseUrl: 'http://127.0.0.1:8789/v1',
      model: 'mock-vision',
      api: 'openai-completions',
      supportsImages: true,
      reasoning: true,
      contextWindow: 32_768,
      maxTokens: 4096,
    });
  });

  it('keeps the global decider key separate and disables paid endpoint fallback in e2e', () => {
    expect(parseEnv({ OPENROUTER_DECIDER_API_KEY: ' dummy-global ' })).toMatchObject({
      deciderApiKey: 'dummy-global',
    });
    const e2e = parseEnv({ SA_E2E: '1', OPENROUTER_DECIDER_API_KEY: 'dummy-global' });
    expect(e2e.deciderApiKey).toBeUndefined();
    expect(
      parseEnv({
        SA_E2E: '1',
        SA_DECIDER_URL: 'https://openrouter.ai/api/v1/systemone',
        OPENROUTER_DECIDER_API_KEY: 'dummy-global',
      }).deciderApiKey,
    ).toBeUndefined();
    expect(
      parseEnv({
        SA_E2E: '1',
        SA_DECIDER_URL: 'http://127.0.0.1:8792/systemone',
        OPENROUTER_DECIDER_API_KEY: 'dummy-global',
      }),
    ).toMatchObject({
      deciderApiKey: 'dummy-global',
      deciderUrl: 'http://127.0.0.1:8792/systemone',
    });
    expect(
      parseEnv({ SA_DECIDER_URL: 'https://evil.test/systemone' }, { packaged: true }).deciderUrl,
    ).toBeUndefined();
  });

  it('ignores security-relevant overrides in packaged builds', () => {
    const env = parseEnv(
      {
        SA_E2E: '1',
        SA_EXTRA_TRUSTED_HOSTS: 'evil.example',
        SA_AGENT_HOST: '/tmp/evil.js',
        SA_PROVIDER: 'custom|https://evil.example/v1|m',
        SA_KEY_SERVER_URL: 'https://evil.example',
        SA_USER_DATA_DIR: '/tmp/portable',
        SA_LOG_LEVEL: 'debug',
        SA_HIDE_WINDOW: '1',
      },
      { packaged: true },
    );
    expect(env).toMatchObject({
      e2e: false,
      hideWindow: false,
      extraTrustedHosts: [],
      userDataDir: '/tmp/portable',
      logLevel: 'debug',
    });
    expect(env.agentHost).toBeUndefined();
    expect(env.provider).toBeUndefined();
    // Service URLs are built in: packaged builds ignore the development override.
    expect(env.keyServerUrl).toBe(PRODUCTION_SERVICES.keyServerUrl);
    expect(env.warnings[0]).toMatch(
      /ignored in packaged builds: SA_E2E, SA_EXTRA_TRUSTED_HOSTS.*SA_KEY_SERVER_URL/,
    );
  });
});

describe('scrubbable known values', () => {
  it('drops categories and very short values', () => {
    const values = scrubbableKnownValues({
      knownSensitiveValues: () => ['Lucía', 'DNI', 'M', '12345678Z', 'España', 'Madrid'],
      listPersonal: () => [
        { key: 'givenName', value: 'Lucía' },
        { key: 'documentType', value: 'DNI' },
        { key: 'sex', value: 'M' },
        { key: 'addressCountry', value: 'España' },
        { key: 'addressMunicipality', value: 'Madrid' },
      ],
    });
    expect(values).toEqual(['Lucía', '12345678Z', 'Madrid']);
  });
});
