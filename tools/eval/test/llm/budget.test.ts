import './helpers/no-network';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { budgetStatus, formatBudgetStatus } from '../../src/llm/budget';
import { writeCooldown } from '../../src/llm/codex-cooldown';
import { writeCodexFile } from '../../src/llm/home';
import { Ledger } from '../../src/llm/ledger';
import { makeHome, TEST_VOUCHER_KEY, type TestHome, writeLitellmFile } from './helpers/tmp-home';

/** A fake key server: `GET /v1/vouchers/credit` with a bearer key. */
async function fakeKeyServer(
  credit: unknown | ((authorization: string | undefined) => { status: number; body: unknown }),
): Promise<{
  url: string;
  seen: { path: string; authorization?: string }[];
  close(): Promise<void>;
}> {
  const seen: { path: string; authorization?: string }[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({
      path: req.url ?? '',
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    });
    const answer =
      typeof credit === 'function'
        ? (credit as (a?: string) => { status: number; body: unknown })(req.headers.authorization)
        : { status: 200, body: credit };
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('budgetStatus', () => {
  let t: TestHome;
  let closers: (() => Promise<void>)[];
  beforeEach(() => {
    t = makeHome();
    closers = [];
  });
  afterEach(async () => {
    await Promise.all(closers.map((close) => close()));
    t.cleanup();
  });

  const keyServer = async (credit: Parameters<typeof fakeKeyServer>[0]) => {
    const server = await fakeKeyServer(credit);
    closers.push(server.close);
    return server;
  };

  it("reads the key's balance from the key server with the voucher key", async () => {
    const server = await keyServer({
      limitUsd: 5,
      spendUsd: 1.25,
      maxBudgetUsd: 4.5,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    writeLitellmFile(t.home, { keyServerUrl: server.url, baseUrl: 'http://127.0.0.1:9/v1' });
    const status = await budgetStatus({ home: t.home });
    expect(status.voucher).toEqual({
      status: 'ok',
      baseUrl: 'http://127.0.0.1:9/v1',
      keyServerUrl: server.url,
      limitUsd: 5,
      spendUsd: 1.25,
      maxBudgetUsd: 4.5,
      remainingUsd: 3.25,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(server.seen).toEqual([
      { path: '/v1/vouchers/credit', authorization: `Bearer ${TEST_VOUCHER_KEY}` },
    ]);
    expect(status.stopped).toBe(false);
    expect(JSON.stringify(status)).not.toContain(TEST_VOUCHER_KEY);
  });

  it('adds the ledger totals and the caps', async () => {
    const server = await keyServer({ limitUsd: 5, spendUsd: 0, maxBudgetUsd: 5, expiresAt: null });
    writeLitellmFile(t.home, { keyServerUrl: server.url });
    const clock = new Date('2026-10-17T10:00:00.000Z');
    const ledger = new Ledger(t.paths.ledgerDir, () => clock);
    ledger.append({
      runId: 'r1',
      agent: 'procedure-1',
      provider: 'voucher',
      model: 'anthropic/claude-haiku-5.5',
      kind: 'forward',
      path: '/v1/chat/completions',
      status: 200,
      cost: { usd: 0.0123, source: 'header' },
      litellm: { keySpendUsd: 0.5, keyMaxBudgetUsd: 5 },
    });
    ledger.append({
      runId: 'r1',
      agent: 'procedure-1',
      provider: 'voucher',
      kind: 'replay',
      path: '/v1/chat/completions',
      status: 200,
      cost: { usd: 0.01, source: 'header', virtual: true },
    });
    const status = await budgetStatus({
      home: t.home,
      now: () => clock,
      limits: { perRunUsd: 0.2 },
    });
    expect(status.ledger.sinceEpochUsd).toBeCloseTo(0.0123, 12);
    expect(status.ledger.byDay).toEqual({ '2026-10-17': 0.0123 });
    // The reserve is the floor a run enforces (VOUCHER_FLOOR_USD), not a smaller number.
    expect(status.limits.voucher).toMatchObject({ perRunUsd: 0.2, reserveUsd: 1, dailyUsd: 1 });
    expect(status.limits.codex).toMatchObject({
      perRunRequests: 120,
      codex: { requestsPer5h: 150, requestsPerDay: 400 },
    });
    const text = formatBudgetStatus(status);
    expect(text).toContain('balance $5.00 left');
    expect(text).toContain('since the last epoch $0.0123');
    expect(text).toContain('1 forwarded, 1 replayed (0 loose; would have cost $0.0100)');
    expect(text).toContain('by day: 2026-10-17 $0.0123');
    expect(text).toContain('anthropic/claude-haiku-5.5 $0.0123 (1)');
    expect(text).toContain(
      'per run 250 requests and the cost limit of its fixture (--max-cost overrides it; $0.2000 for a run without one)',
    );
    expect(text).toContain('per agent $0.3500 and 200 requests (answerer $0.0500)');
    expect(text).toContain(
      "per day $1.00 (UTC, all runs and processes); reserve $1.00 of the key's balance, also the floor under which a run does not start",
    );
    expect(text).toContain('last gateway headers: spend $0.5000 of $5.00');
    expect(text).not.toContain(TEST_VOUCHER_KEY);
  });

  it('shows what is reserved and not settled, and how many replays were loose', async () => {
    const clock = new Date('2026-10-17T10:00:00.000Z');
    const ledger = new Ledger(t.paths.ledgerDir, () => clock);
    ledger.reserve({
      rid: 'in-flight',
      run: 'r1',
      agent: 'procedure-1',
      provider: 'voucher',
      path: '/v1/chat/completions',
      usd: 0.0123,
    });
    ledger.append({
      runId: 'r1',
      agent: 'procedure-1',
      provider: 'voucher',
      kind: 'replay',
      path: '/v1/chat/completions',
      status: 200,
      cost: { usd: 0.01, source: 'header', virtual: true },
      loose: true,
      looseWhy: ['page #4: other element refs'],
    });
    const status = await budgetStatus({ home: t.home, offline: true, now: () => clock });
    expect(status.ledger.pending).toEqual({
      requests: 1,
      usd: 0.0123,
      oldest: '2026-10-17T10:00:00.000Z',
    });
    const text = formatBudgetStatus(status);
    expect(text).toContain('0 forwarded, 1 replayed (1 loose; would have cost $0.0100)');
    expect(text).toContain(
      'in flight or never settled: 1 request(s), up to $0.0123 reserved (oldest 2026-10-17T10:00:00.000Z)',
    );
    // Nothing pending, no line.
    const empty = makeHome();
    try {
      const text = formatBudgetStatus(await budgetStatus({ home: empty.home, offline: true }));
      expect(text).not.toContain('in flight or never settled');
    } finally {
      empty.cleanup();
    }
  });

  it('degrades when the key server says no or cannot be reached, still showing the ledger', async () => {
    const refusing = await keyServer(() => ({
      status: 401,
      body: { error: { code: 'invalid_key', message: 'Unknown voucher key' } },
    }));
    writeLitellmFile(t.home, { keyServerUrl: refusing.url });
    const denied = await budgetStatus({ home: t.home });
    expect(denied.voucher).toEqual({
      status: 'unavailable',
      error: 'invalid_key: Unknown voucher key',
    });
    expect(formatBudgetStatus(denied)).toContain(
      'balance unavailable: invalid_key: Unknown voucher key',
    );

    const closed = await keyServer({});
    const url = closed.url;
    await closed.close();
    closers.pop();
    writeLitellmFile(t.home, { keyServerUrl: url });
    const down = await budgetStatus({ home: t.home });
    expect(down.voucher.status).toBe('unavailable');
    expect(JSON.stringify(down)).not.toContain(TEST_VOUCHER_KEY);

    const bad = await keyServer({ nonsense: true });
    writeLitellmFile(t.home, { keyServerUrl: bad.url });
    expect((await budgetStatus({ home: t.home })).voucher).toMatchObject({
      status: 'unavailable',
      error: expect.stringContaining('invalid_response'),
    });

    expect((await budgetStatus({ home: t.home, offline: true })).voucher).toMatchObject({
      status: 'unavailable',
      error: expect.stringContaining('offline'),
    });
  });

  it('works without any credentials and says what is missing', async () => {
    const status = await budgetStatus({ home: t.home });
    expect(status.voucher.status).toBe('not_configured');
    expect(status.codex).toEqual({ loggedIn: false });
    const text = formatBudgetStatus(status);
    expect(text).toContain('not configured');
    expect(text).toContain('not logged in (eval login codex)');
    // An unsafe file is reported, not read.
    writeLitellmFile(t.home, {}, 0o644);
    const unsafe = await budgetStatus({ home: t.home });
    expect(unsafe.voucher).toMatchObject({
      status: 'unavailable',
      error: expect.stringContaining('chmod 600'),
    });
  });

  it('shows the kill switch, the Codex login (no tokens) and the usage-limit pause', async () => {
    writeFileSync(t.paths.stopFile, '');
    const now = new Date('2026-10-17T10:00:00.000Z');
    writeCodexFile(
      {
        v: 1,
        provider: 'openai-codex',
        account: 'dev@example.test',
        loginAt: now.toISOString(),
        updatedAt: now.toISOString(),
        credential: {
          type: 'oauth',
          access: 'access-secret-token',
          refresh: 'refresh-secret-token',
          expires: now.getTime() + 40 * 60_000,
          accountId: 'acct-1',
        },
      },
      t.home,
    );
    writeCooldown(t.paths.codexCooldown, {
      untilMs: now.getTime() + 3_600_000,
      planType: 'plus',
      observedAt: now.toISOString(),
    });
    const ledger = new Ledger(t.paths.ledgerDir, () => now);
    for (let i = 0; i < 4; i++)
      ledger.append({
        runId: 'r',
        agent: 'p',
        provider: 'codex',
        kind: 'forward',
        path: '/x',
        status: 200,
      });
    const status = await budgetStatus({ home: t.home, offline: true, now: () => now });
    expect(status.stopped).toBe(true);
    expect(status.codex).toMatchObject({
      loggedIn: true,
      cooldownUntil: '2026-10-17T11:00:00.000Z',
    });
    // An older file may still carry the account's e-mail: it is never shown.
    expect(JSON.stringify(status)).not.toContain('dev@example.test');
    const text = formatBudgetStatus(status);
    expect(text).toContain('KILL SWITCH ON');
    expect(text).toContain('logged in; access token valid for 40 min');
    expect(text).not.toContain('dev@example.test');
    expect(text).toContain('4 requests in the last 5 hours (cap 150)');
    expect(text).toContain('USAGE LIMIT: paused until 2026-10-17T11:00:00.000Z');
    expect(JSON.stringify(status)).not.toContain('secret-token');
    expect(text).not.toContain('secret-token');
  });
});
