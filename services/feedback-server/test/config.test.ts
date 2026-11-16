import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_USER_ID_SECRET, loadConfig, resolveDatabaseUrl, SERVICE_DIR } from '../src/config';

describe('config', () => {
  it('resolves database URLs', () => {
    expect(resolveDatabaseUrl(undefined)).toBe(
      `pglite://${join(SERVICE_DIR, '.data/feedback-server')}`,
    );
    expect(resolveDatabaseUrl('pglite://memory')).toBe('pglite://memory');
    expect(resolveDatabaseUrl('pglite:///tmp/x')).toBe('pglite:///tmp/x');
    expect(resolveDatabaseUrl('postgres://u:p@db:5432/f')).toBe('postgres://u:p@db:5432/f');
  });

  it('reads the environment', () => {
    expect(loadConfig({})).toMatchObject({
      host: '127.0.0.1',
      port: 8788,
      devSeed: false,
      adminToken: undefined,
      trustProxy: false,
      mcp: true,
    });
    expect(
      loadConfig({
        PORT: '9000',
        DEV_SEED: '1',
        ADMIN_TOKEN: 't',
        MCP_ENABLED: 'false',
      }),
    ).toMatchObject({
      port: 9000,
      devSeed: true,
      adminToken: 't',
      mcp: false,
    });
  });

  it('reads the key check and the limits', () => {
    const defaults = loadConfig({});
    expect(defaults.users).toBeUndefined();
    expect(defaults).toMatchObject({
      submitPerHour: 60,
      votePerHour: 300,
      submitPerKeyPerDay: 30,
      votePerKeyPerDay: 200,
    });
    expect(
      loadConfig({
        LITELLM_URL: 'http://litellm:4000/',
        SUBMIT_DAILY_LIMIT: '5',
        VOTE_DAILY_LIMIT: '7',
        RATE_LIMIT_VOTE_PER_HOUR: '9',
      }),
    ).toMatchObject({
      users: { litellmUrl: 'http://litellm:4000', idSecret: DEV_USER_ID_SECRET },
      submitPerKeyPerDay: 5,
      votePerKeyPerDay: 7,
      votePerHour: 9,
    });
    expect(() => loadConfig({ LITELLM_URL: 'litellm:4000' })).toThrow(/LITELLM_URL/);
  });

  it('needs a user id secret with Postgres', () => {
    const postgres = { LITELLM_URL: 'http://litellm:4000', DATABASE_URL: 'postgres://db/f' };
    expect(() => loadConfig(postgres)).toThrow(/USER_ID_SECRET is required/);
    const secret = 's'.repeat(32);
    expect(loadConfig({ ...postgres, USER_ID_SECRET: secret }).users).toEqual({
      litellmUrl: 'http://litellm:4000',
      idSecret: secret,
    });
    expect(() => loadConfig({ ...postgres, USER_ID_SECRET: 'short' })).toThrow(/32 characters/);
  });

  it('reads the vote policy', () => {
    expect(loadConfig({}).votes).toEqual({ threshold: 5, decayStartDays: 90, decayEndDays: 365 });
    expect(
      loadConfig({ VOTE_THRESHOLD: '3', VOTE_DECAY_START_DAYS: '30', VOTE_DECAY_END_DAYS: '60' })
        .votes,
    ).toEqual({ threshold: 3, decayStartDays: 30, decayEndDays: 60 });
    expect(() => loadConfig({ VOTE_THRESHOLD: '0' })).toThrow(/VOTE_THRESHOLD/);
    expect(() => loadConfig({ VOTE_DECAY_START_DAYS: '400' })).toThrow(/VOTE_DECAY_END_DAYS/);
  });

  it('turns hybrid search on with an embeddings key', () => {
    expect(loadConfig({}).embeddings).toBeUndefined();
    expect(loadConfig({ EMBEDDINGS_URL: 'https://llm.test/v1' }).embeddings).toBeUndefined();
    // The gateway that checks users' keys also serves embeddings.
    const litellm = { LITELLM_URL: 'http://litellm:4000/', EMBEDDINGS_API_KEY: ' sk-embed ' };
    expect(loadConfig(litellm).embeddings).toEqual({
      url: 'http://litellm:4000/v1',
      apiKey: 'sk-embed',
      model: 'google/gemini-embedding-001',
      dimensions: 1536,
      minSimilarity: 0.64,
    });
    expect(
      loadConfig({
        ...litellm,
        EMBEDDINGS_URL: 'https://llm.test/v1/',
        EMBEDDINGS_MODEL: 'acme/embed',
        EMBEDDINGS_DIMENSIONS: '768',
        EMBEDDINGS_MIN_SIMILARITY: '0.5',
      }).embeddings,
    ).toEqual({
      url: 'https://llm.test/v1',
      apiKey: 'sk-embed',
      model: 'acme/embed',
      dimensions: 768,
      minSimilarity: 0.5,
    });
    expect(() => loadConfig({ EMBEDDINGS_API_KEY: 'sk-embed' })).toThrow(/EMBEDDINGS_URL/);
    expect(() => loadConfig({ ...litellm, EMBEDDINGS_URL: 'llm.test' })).toThrow(/EMBEDDINGS_URL/);
    expect(() => loadConfig({ ...litellm, EMBEDDINGS_DIMENSIONS: '0' })).toThrow(/DIMENSIONS/);
    expect(() => loadConfig({ ...litellm, EMBEDDINGS_DIMENSIONS: '20000' })).toThrow(/DIMENSIONS/);
    for (const bad of ['1.5', '-0.1', 'high'])
      expect(() => loadConfig({ ...litellm, EMBEDDINGS_MIN_SIMILARITY: bad })).toThrow(
        /MIN_SIMILARITY/,
      );
  });
});
