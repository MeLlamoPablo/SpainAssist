import { afterEach, describe, expect, it } from 'vitest';
import { networkKey, normalizeIp } from '../src/client-ip';
import { DEFAULT_RATE_LIMITS, TokenBucketLimiter } from '../src/rate-limit';
import { errorCode, type Harness, idToken, setup } from './helpers';

describe('TokenBucketLimiter', () => {
  it('allows a burst, then refills over time', () => {
    let now = 0;
    const bucket = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 0.5 }, () => now);
    expect([bucket.take('a'), bucket.take('a'), bucket.take('a')].every((r) => r.ok)).toBe(true);
    expect(bucket.take('a')).toEqual({ ok: false, retryAfterSeconds: 2 });
    expect(bucket.take('b').ok).toBe(true); // independent keys
    now += 1000; // half a token
    expect(bucket.take('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
    now += 1000;
    expect(bucket.take('a').ok).toBe(true);
    now += 60_000; // never above capacity
    expect([1, 2, 3, 4].map(() => bucket.take('a').ok)).toEqual([true, true, true, false]);
  });

  it('bounds memory by forgetting idle or oldest clients', () => {
    let now = 0;
    const bucket = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 }, () => now, 100);
    for (let i = 0; i < 100; i++) bucket.take(`ip-${i}`);
    now += 5000; // all refilled: swept on the next insert
    bucket.take('new');
    expect(bucket.size).toBe(1);
    for (let i = 0; i < 300; i++) bucket.take(`busy-${i}`); // no time passes: evict oldest
    expect(bucket.size).toBeLessThanOrEqual(100);
  });
});

describe('client addresses', () => {
  it('normalizes IPs and groups IPv6 clients by /64', () => {
    expect(normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIp('192.0.2.1:5678')).toBe('192.0.2.1');
    expect(normalizeIp('[2001:DB8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('fe80::1%en0')).toBe('fe80::1');
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(networkKey('192.0.2.1')).toBe('192.0.2.1');
    expect(networkKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(networkKey('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(networkKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(networkKey('::1')).toBe('0:0:0:0::/64');
    expect(networkKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
    expect(networkKey(null)).toBe('unknown');
  });
});

describe('HTTP rate limiting', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const strict = {
    redeem: { capacity: 2, refillPerSecond: 0.1 },
    chatgptKeys: { capacity: 1, refillPerSecond: 0.1 },
  };

  it('limits each endpoint per client and sets Retry-After', async () => {
    let now = 0;
    h = await setup({ config: { rateLimit: strict }, now: () => now });
    const redeem = () => h!.redeem('SA-000000', { ip: '192.0.2.1' });
    expect((await redeem()).status).toBe(400);
    expect((await redeem()).status).toBe(400);
    const limited = await redeem();
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).toBe('10');
    // Other clients and other endpoints have their own buckets.
    expect((await h.redeem('SA-000000', { ip: '192.0.2.2' })).status).toBe(400);
    const chatgpt = async () =>
      h!.request('POST', '/v1/chatgpt-keys', {
        ip: '192.0.2.1',
        body: { idToken: await idToken() },
      });
    expect((await chatgpt()).status).toBe(200);
    const again = await chatgpt();
    expect(again.status).toBe(429);
    expect(again.headers.get('retry-after')).toBe('10'); // the bucket, before the ID token
    now += 10_000;
    expect((await redeem()).status).toBe(400);
  });

  it('ignores X-Forwarded-For unless TRUST_PROXY is set', async () => {
    h = await setup({ config: { rateLimit: strict } });
    const spoofed = (n: number) =>
      h!.redeem('SA-000000', { headers: { 'x-forwarded-for': `198.51.100.${n}` } });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await spoofed(i)).status);
    expect(statuses).toEqual([400, 400, 429]);
  });

  it('uses the address added by the trusted proxy, not client-supplied hops', async () => {
    h = await setup({ config: { rateLimit: strict, trustProxyHops: 1 } });
    const via = (xff: string) =>
      h!.redeem('SA-000000', { ip: '10.0.0.2', headers: { 'x-forwarded-for': xff } });
    // The client forges a left-most entry each time; the proxy appends the real address.
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await via(`1.2.3.${i}, 192.0.2.50`)).status);
    expect(statuses).toEqual([400, 400, 429]);
    expect((await via('192.0.2.51')).status).toBe(400);
  });

  it('can be disabled', async () => {
    h = await setup({ config: { rateLimit: false } });
    for (let i = 0; i < 20; i++) expect((await h.redeem('SA-000000')).status).toBe(400);
  });

  it('has sane defaults', () => {
    expect(DEFAULT_RATE_LIMITS.redeem.capacity).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_RATE_LIMITS.chatgptKeys.capacity).toBeGreaterThanOrEqual(2);
  });
});
