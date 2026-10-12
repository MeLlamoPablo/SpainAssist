import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, DEV_ENCRYPTION_KEY, DEV_PEPPER, loadConfig } from '../src/config';
import { MIGRATIONS_DIR, migrate } from '../src/db/migrate';
import { openDatabase } from '../src/db/open';
import { createProvisioner } from '../src/providers';
import { LiteLLMProvisioner, MockProvisioner } from '../src/providers/key-provisioner';
import { setup } from './helpers';

describe('migrations', () => {
  it('apply once and are recorded in schema_migrations', async () => {
    const db = await openDatabase('pglite://memory');
    try {
      expect(await migrate(db)).toEqual([
        '001_init',
        '002_chatgpt_keys',
        '003_research_runs',
        '004_voucher_top_ups',
      ]);
      expect(await migrate(db)).toEqual([]);
      const { rows } = await db.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(rows).toEqual([
        { version: '001_init' },
        { version: '002_chatgpt_keys' },
        { version: '003_research_runs' },
        { version: '004_voucher_top_ups' },
      ]);
    } finally {
      await db.close();
    }
  });

  it('002 drops the anonymous search keys of a production database and keeps vouchers', async () => {
    const only001 = mkdtempSync(join(tmpdir(), 'sa-key-server-001-'));
    const db = await openDatabase('pglite://memory');
    try {
      copyFileSync(join(MIGRATIONS_DIR, '001_init.sql'), join(only001, '001_init.sql'));
      await migrate(db, only001);
      const voucher = '00000000-0000-4000-8000-000000000001';
      await db.query(`INSERT INTO vouchers (id, code_hash, amount_usd, status)
                      VALUES ('${voucher}', 'h', 5, 'redeemed')`);
      await db.query(`INSERT INTO issued_keys (id, kind, voucher_id, provider, key_hash, label, limit_usd)
                      VALUES (gen_random_uuid(), 'voucher', '${voucher}', 'litellm', 'k1', 'v', 5),
                             (gen_random_uuid(), 'anon_search', NULL, 'litellm', 'k2', 'a', 0.1)`);
      await db.query(`INSERT INTO anon_token_grants (ip_hash) VALUES ('net')`);

      expect(await migrate(db)).toEqual([
        '002_chatgpt_keys',
        '003_research_runs',
        '004_voucher_top_ups',
      ]);
      const { rows } = await db.query<{ kind: string }>('SELECT kind FROM issued_keys');
      expect(rows).toEqual([{ kind: 'voucher' }]);
      // 004 links each redeemed voucher to the key its amount went to.
      const { rows: links } = await db.query<{ linked: boolean }>(
        `SELECT v.issued_key_id = k.id AS linked FROM vouchers v JOIN issued_keys k ON k.voucher_id = v.id`,
      );
      expect(links).toEqual([{ linked: true }]);
      const { rows: tables } = await db.query<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      expect(tables.map((t) => t.name)).not.toContain('anon_token_grants');
      // The constraints still hold: no anonymous kind, chatgpt keys need an account and a key.
      await expect(
        db.query(`INSERT INTO issued_keys (id, kind, provider, key_hash, label, limit_usd)
                  VALUES (gen_random_uuid(), 'anon_search', 'litellm', 'k3', 'a', 1)`),
      ).rejects.toThrow();
      await expect(
        db.query(`INSERT INTO issued_keys (id, kind, provider, key_hash, label, limit_usd)
                  VALUES (gen_random_uuid(), 'chatgpt', 'litellm', 'k4', 'c', 1)`),
      ).rejects.toThrow();
      await expect(
        db.query(`INSERT INTO issued_keys (id, kind, provider, key_hash, label, limit_usd)
                  VALUES (gen_random_uuid(), 'voucher', 'litellm', 'k5', 'v', 1)`),
      ).rejects.toThrow();
    } finally {
      await db.close();
      rmSync(only001, { recursive: true, force: true });
    }
  });
});

describe('openDatabase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-key-server-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('persists PGlite data and refuses a second process on the same directory', async () => {
    const url = `pglite://${join(dir, 'db')}`;
    const db = await openDatabase(url);
    await migrate(db);
    await db.query(
      `INSERT INTO vouchers (id, code_hash, amount_usd) VALUES (gen_random_uuid(), 'h', 1)`,
    );
    expect(existsSync(`${join(dir, 'db')}.lock`)).toBe(true);
    // A second opener (e.g. the CLI while the server runs) is refused instead of corrupting it.
    await expect(openDatabase(url)).rejects.toThrow(/in use by process/);
    await db.close();
    expect(existsSync(`${join(dir, 'db')}.lock`)).toBe(false);

    // A stale lock left by a dead process is taken over.
    writeFileSync(`${join(dir, 'db')}.lock`, '999999');

    const reopened = await openDatabase(url);
    const { rows } = await reopened.query<{ n: number }>('SELECT count(*)::int AS n FROM vouchers');
    expect(rows[0]!.n).toBe(1);
    await reopened.close();
  });

  it('rejects unsupported URLs', async () => {
    await expect(openDatabase('mysql://localhost/x')).rejects.toThrow(/Unsupported DATABASE_URL/);
  });
});

describe('loadConfig', () => {
  it('has development defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8787,
      databaseUrl: 'pglite://.data/key-server',
      voucherPepper: DEV_PEPPER,
      trustProxyHops: 0,
      devSeed: false,
      keyTtlDays: 180,
      searchTools: [],
      deciderModel: 'perplexity/pplx-decider-v1.1-27b',
      chatgptKeys: {
        enabled: true,
        dailyBudgetUsd: 0.1,
        monthlyBudgetUsd: 0.5,
        globalMonthlyBudgetUsd: null,
        encryptionKey: DEV_ENCRYPTION_KEY,
      },
      openaiIdentity: {
        issuer: 'https://auth.openai.com',
        jwksUrl: 'https://auth.openai.com/.well-known/jwks.json',
        audiencePrefix: 'oaiapp_',
      },
      mockLlmBaseUrl: 'http://127.0.0.1:8789/v1',
    });
    expect(config.litellm).toBeUndefined();
    expect(config.rateLimit).not.toBe(false);
    expect(config.adminToken).toBeUndefined();
    expect(config.warnings).toHaveLength(2); // development pepper and encryption key
    expect(createProvisioner(config)).toBeInstanceOf(MockProvisioner);
  });

  it('reads production settings and treats empty strings as unset', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://u:p@db:5432/keyserver',
      VOUCHER_PEPPER: 'p'.repeat(32),
      ADMIN_TOKEN: 'a'.repeat(32),
      LITELLM_ADMIN_URL: 'http://litellm:4000/',
      LITELLM_MASTER_KEY: 'sk-master',
      LITELLM_PUBLIC_URL: 'https://llm.example.org/',
      LITELLM_KEY_MODELS: 'anthropic/claude-haiku-5.5, moonshotai/kimi-k2.6,',
      LITELLM_SEARCH_TOOLS: ' exa ,parallel',
      KEY_ENCRYPTION_KEY: 'ab'.repeat(32),
      CHATGPT_DAILY_BUDGET_USD: '0.2',
      CHATGPT_MONTHLY_BUDGET_USD: '1',
      CHATGPT_GLOBAL_MONTHLY_BUDGET_USD: '50',
      RATE_LIMIT: 'false',
      TRUST_PROXY: '1',
    });
    expect(config).toMatchObject({
      rateLimit: false,
      trustProxyHops: 1,
      searchTools: ['exa', 'parallel'],
      chatgptKeys: {
        enabled: true,
        dailyBudgetUsd: 0.2,
        monthlyBudgetUsd: 1,
        globalMonthlyBudgetUsd: 50,
        encryptionKey: Buffer.alloc(32, 0xab),
      },
      litellm: {
        adminUrl: 'http://litellm:4000',
        masterKey: 'sk-master',
        publicUrl: 'https://llm.example.org',
        keyModels: ['anthropic/claude-haiku-5.5', 'moonshotai/kimi-k2.6'],
      },
      warnings: [],
    });
    expect(createProvisioner(config)).toBeInstanceOf(LiteLLMProvisioner);
  });

  it('hands clients the admin URL when no public URL is set, and warns about odd settings', () => {
    const config = loadConfig({
      LITELLM_ADMIN_URL: 'http://127.0.0.1:4000',
      LITELLM_MASTER_KEY: 'sk-master',
    });
    expect(config.litellm?.publicUrl).toBe('http://127.0.0.1:4000');
    const mock = loadConfig({ LITELLM_MASTER_KEY: 'sk-master' });
    expect(mock.litellm).toBeUndefined();
    expect(mock.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('LITELLM_ADMIN_URL is not set')]),
    );
  });

  it('refuses unsafe production configuration', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://db/keyserver' })).toThrow(ConfigError);
    expect(() => loadConfig({ VOUCHER_PEPPER: 'short' })).toThrow(/VOUCHER_PEPPER/);
    expect(() => loadConfig({ ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => loadConfig({ DEV_SEED: 'maybe' })).toThrow(/DEV_SEED/);
    expect(() => loadConfig({ LITELLM_ADMIN_URL: 'http://litellm:4000' })).toThrow(
      /LITELLM_MASTER_KEY is required/,
    );
    expect(() => loadConfig({ LITELLM_ADMIN_URL: 'litellm:4000' })).toThrow(/LITELLM_ADMIN_URL/);
    expect(() => loadConfig({ CHATGPT_DAILY_BUDGET_USD: '0' })).toThrow(/CHATGPT_DAILY_BUDGET_USD/);
    expect(() => loadConfig({ KEY_ENCRYPTION_KEY: 'too-short' })).toThrow(/KEY_ENCRYPTION_KEY/);
    // Without an encryption key, Postgres servers keep running without ChatGPT keys.
    const noKey = loadConfig({
      DATABASE_URL: 'postgres://db/keyserver',
      VOUCHER_PEPPER: 'p'.repeat(32),
    });
    expect(noKey.chatgptKeys.enabled).toBe(false);
    expect(noKey.warnings).toEqual([expect.stringContaining('KEY_ENCRYPTION_KEY is not set')]);
    // A base64 key works too.
    const base64 = loadConfig({ KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') });
    expect(base64.chatgptKeys.encryptionKey).toEqual(Buffer.alloc(32, 3));
    // Error messages name the variable, never its value.
    const error = (() => {
      try {
        loadConfig({ LITELLM_ADMIN_URL: 'not a url sk-secret-value' });
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(error).not.toContain('sk-secret-value');
  });
});

describe('misc', () => {
  it('answers /health and JSON 404s', async () => {
    const h = await setup();
    try {
      const health = await h.request('GET', '/health');
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, service: 'key-server', keys: 'mock' });
      const missing = await h.request('GET', '/v1/nope');
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
      const huge = await h.request('POST', '/v1/vouchers/redeem', {
        body: { code: 'x'.repeat(20_000) },
      });
      expect(huge.status).toBe(413);
    } finally {
      await h.close();
    }
  });
});
