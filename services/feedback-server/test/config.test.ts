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
});
