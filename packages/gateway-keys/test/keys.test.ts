import { describe, expect, it, vi } from 'vitest';
import {
  bearerKey,
  createKeyChecker,
  KeyCheckUnavailableError,
  KeyQuota,
  keyId,
  userId,
} from '../src';

const KEY = 'sk-user-key-1234567890';

function checker(answer: { status: number; info?: Record<string, unknown> } | 'down') {
  let time = Date.parse('2026-10-10T12:00:00Z');
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    if (answer === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ info: answer.info ?? {} }), { status: answer.status });
  });
  const check = createKeyChecker({
    litellmUrl: 'https://litellm.test',
    fetch: fetchImpl,
    now: () => time,
  });
  return { check, fetchImpl, advance: (ms: number) => (time += ms) };
}

describe('gateway key checks', () => {
  it('asks LiteLLM with the key itself', async () => {
    const { check, fetchImpl } = checker({ status: 200, info: { spend: 1, max_budget: 5 } });
    expect(await check(KEY)).toBe('ok');
    const [[input, init]] = fetchImpl.mock.calls;
    expect(String(input)).toBe('https://litellm.test/key/info');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('tells invalid keys from keys without credit', async () => {
    expect(await checker({ status: 401 }).check(KEY)).toBe('invalid');
    expect(await checker({ status: 200, info: { blocked: true } }).check(KEY)).toBe('invalid');
    expect(await checker({ status: 200, info: { status: 'revoked' } }).check(KEY)).toBe('invalid');
    expect(
      await checker({ status: 200, info: { expires: '2026-01-01T00:00:00Z' } }).check(KEY),
    ).toBe('invalid');
    expect(await checker({ status: 200, info: { spend: 5, max_budget: 5 } }).check(KEY)).toBe(
      'no_credit',
    );
    expect(await checker({ status: 200, info: { spend: 9 } }).check(KEY)).toBe('ok');
  });

  it('caches answers by key hash and fails when LiteLLM is unreachable', async () => {
    const { check, fetchImpl, advance } = checker({ status: 200, info: {} });
    await check(KEY);
    await check(KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(6 * 60_000);
    await check(KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(checker('down').check(KEY)).rejects.toBeInstanceOf(KeyCheckUnavailableError);
    await expect(checker({ status: 500 }).check(KEY)).rejects.toBeInstanceOf(
      KeyCheckUnavailableError,
    );
  });

  it('reads bearer keys and hashes them', () => {
    expect(bearerKey(`Bearer ${KEY}`)).toBe(KEY);
    for (const bad of [undefined, '', KEY, 'Bearer abc', `Basic ${KEY}`, `Bearer ${KEY} x`])
      expect(bearerKey(bad)).toBeUndefined();
    expect(keyId(KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives a stable user id that needs the secret', () => {
    const id = userId(KEY, 'secret-a');
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(userId(KEY, 'secret-a')).toBe(id);
    expect(userId(KEY, 'secret-b')).not.toBe(id);
    expect(userId('sk-other-key-1234567890', 'secret-a')).not.toBe(id);
    expect(id).not.toContain(keyId(KEY));
  });
});

describe('KeyQuota', () => {
  it('counts per key per UTC day', () => {
    let time = Date.parse('2026-10-10T12:00:00Z');
    const quota = new KeyQuota({ day: 2 }, () => time);
    expect(quota.take('a')).toBe(0);
    expect(quota.take('a')).toBe(0);
    expect(quota.take('a')).toBe(12 * 3600);
    expect(quota.take('b')).toBe(0);
    time += 12 * 3600 * 1000;
    expect(quota.take('a')).toBe(0);
  });

  it('also limits per UTC week from Monday, and a refused request uses neither window', () => {
    // Saturday noon UTC: the week ends on Monday 00:00, 36 hours later.
    let time = Date.parse('2026-10-10T12:00:00Z');
    const quota = new KeyQuota({ day: 2, week: 3 }, () => time);
    expect(quota.take('a')).toBe(0);
    expect(quota.take('a')).toBe(0);
    expect(quota.take('a')).toBe(12 * 3600);
    time += 12 * 3600 * 1000; // Sunday 00:00: a new day, same week
    expect(quota.take('a')).toBe(0);
    expect(quota.take('a')).toBe(24 * 3600);
    time += 24 * 3600 * 1000; // Monday 00:00: a new week
    expect(quota.take('a')).toBe(0);
    expect(quota.take('a')).toBe(0);
    expect(quota.take('a')).toBe(24 * 3600);
  });

  it('refuses everything with a limit of 0', () => {
    expect(new KeyQuota({ week: 0 }).take('a')).toBeGreaterThan(0);
  });
});
