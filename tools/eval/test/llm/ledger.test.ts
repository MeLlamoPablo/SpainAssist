import './helpers/no-network';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger, type LedgerRecord } from '../../src/llm/ledger';
import { makeHome, type TestHome } from './helpers/tmp-home';

const base: LedgerRecord = {
  runId: 'run-1',
  agent: 'procedure-1',
  provider: 'voucher',
  model: 'anthropic/claude-haiku-5.5',
  kind: 'forward',
  path: '/v1/chat/completions',
  status: 200,
  cost: { usd: 0.01, source: 'header' },
};

describe('spend ledger', () => {
  let t: TestHome;
  let dir: string;
  let clock: Date;
  const now = () => clock;
  beforeEach(() => {
    t = makeHome();
    dir = join(t.home, 'ledger');
    clock = new Date('2026-10-17T10:00:00.000Z');
  });
  afterEach(() => t.cleanup());

  it('appends one JSON line per request to a monthly 0600 file', () => {
    const ledger = new Ledger(dir, now);
    ledger.append(base);
    ledger.append({ ...base, kind: 'reject', reason: 'run_budget', status: 402, cost: undefined });
    const files = readdirSync(dir);
    expect(files).toEqual(['spend-2026-10.jsonl']);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    const lines = readFileSync(join(dir, files[0]!), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      type: 'request',
      v: 1,
      ts: '2026-10-17T10:00:00.000Z',
      runId: 'run-1',
    });
  });

  it('splits months and keeps long errors short', () => {
    const ledger = new Ledger(dir, now);
    ledger.append(base);
    clock = new Date('2026-11-02T08:00:00.000Z');
    const entry = ledger.append({ ...base, error: 'x'.repeat(5000) });
    expect(readdirSync(dir).sort()).toEqual(['spend-2026-10.jsonl', 'spend-2026-11.jsonl']);
    expect(entry.error).toHaveLength(400);
    expect(ledger.summary().byDay).toEqual({ '2026-10-17': 0.01, '2026-11-02': 0.01 });
  });

  it('counts only forwarded voucher requests as real spend', () => {
    const ledger = new Ledger(dir, now);
    ledger.append(base);
    ledger.append({ ...base, kind: 'replay', cost: { usd: 0.5, source: 'header', virtual: true } });
    ledger.append({ ...base, provider: 'mock', cost: { usd: 9, source: 'header' } });
    ledger.append({
      ...base,
      provider: 'codex',
      cost: { usd: 0, source: 'none' },
      apiEquivalentUsd: 3,
    });
    ledger.append({ ...base, kind: 'reject', reason: 'daily', status: 402, cost: undefined });
    const summary = ledger.summary();
    expect(summary.sinceEpochUsd).toBeCloseTo(0.01, 12);
    expect(summary.allTimeUsd).toBeCloseTo(0.01, 12);
    expect(summary.replayedUsd).toBeCloseTo(0.5, 12);
    expect(summary.requests).toEqual({ forward: 3, replay: 1, reject: 1 });
    expect(ledger.spentTodayUsd()).toBeCloseTo(0.01, 12);
    expect(summary.byRun['run-1']).toMatchObject({ requests: 3, replays: 1, rejects: 1 });
  });

  it('groups by day, run, agent role and model', () => {
    const ledger = new Ledger(dir, now);
    ledger.append(base);
    ledger.append({ ...base, agent: 'procedure-2', cost: { usd: 0.02, source: 'header' } });
    ledger.append({
      ...base,
      runId: 'run-2',
      agent: 'answerer',
      model: 'other/model',
      cost: { usd: 0.03, source: 'estimate' },
    });
    clock = new Date('2026-10-18T10:00:00.000Z');
    ledger.append(base);
    const summary = ledger.summary();
    expect(summary.byDay['2026-10-17']).toBeCloseTo(0.06, 12);
    expect(summary.byDay['2026-10-18']).toBeCloseTo(0.01, 12);
    expect(summary.byRun['run-1']?.usd).toBeCloseTo(0.04, 12);
    expect(summary.byRun['run-2']?.usd).toBeCloseTo(0.03, 12);
    expect(summary.byAgent.procedure).toMatchObject({ requests: 3 });
    expect(summary.byAgent.procedure?.usd).toBeCloseTo(0.04, 12);
    expect(summary.byAgent.answerer?.usd).toBeCloseTo(0.03, 12);
    expect(summary.byModel['other/model']?.requests).toBe(1);
  });

  it('sees what other processes appended, including a line that was torn when first read', () => {
    const a = new Ledger(dir, now);
    a.append(base);
    const b = new Ledger(dir, now);
    expect(b.spentSinceEpochUsd()).toBeCloseTo(0.01, 12);
    b.append(base);
    expect(a.spentSinceEpochUsd()).toBeCloseTo(0.01, 12); // not refreshed yet
    a.refresh();
    expect(a.spentSinceEpochUsd()).toBeCloseTo(0.02, 12);

    const file = join(dir, 'spend-2026-10.jsonl');
    const line = JSON.stringify({
      type: 'request',
      v: 1,
      ts: '2026-10-17T10:00:01.000Z',
      ...base,
      cost: { usd: 0.5, source: 'header' },
    });
    appendFileSync(file, line.slice(0, 40));
    a.refresh();
    expect(a.spentSinceEpochUsd()).toBeCloseTo(0.02, 12);
    appendFileSync(file, `${line.slice(40)}\n`);
    a.refresh();
    expect(a.spentSinceEpochUsd()).toBeCloseTo(0.52, 12);
    appendFileSync(file, 'not json at all\n');
    a.refresh();
    expect(a.spentSinceEpochUsd()).toBeCloseTo(0.52, 12);
  });

  it('resets the lifetime total at an epoch but keeps the history', () => {
    const ledger = new Ledger(dir, now);
    ledger.append(base);
    clock = new Date('2026-10-17T12:00:00.000Z');
    ledger.epoch('new voucher');
    expect(ledger.spentSinceEpochUsd()).toBe(0);
    expect(ledger.summary().lastEpochAt).toBe('2026-10-17T12:00:00.000Z');
    ledger.append(base);
    const summary = ledger.summary();
    expect(summary.sinceEpochUsd).toBeCloseTo(0.01, 12);
    expect(summary.allTimeUsd).toBeCloseTo(0.02, 12);
    expect(new Ledger(dir, now).spentSinceEpochUsd()).toBeCloseTo(0.01, 12);
  });

  it('counts Codex requests in rolling windows and remembers the last key headers', () => {
    const ledger = new Ledger(dir, now);
    for (const hoursAgo of [30, 10, 4, 2, 0.5]) {
      clock = new Date(Date.parse('2026-10-17T10:00:00.000Z') - hoursAgo * 3_600_000);
      ledger.append({ ...base, provider: 'codex', cost: undefined });
    }
    clock = new Date('2026-10-17T10:00:00.000Z');
    expect(ledger.codexRequestsWithin(5 * 3_600_000)).toBe(3);
    expect(ledger.codexRequestsWithin(24 * 3_600_000)).toBe(4);
    expect(ledger.summary().codex).toEqual({ requestsLast5h: 3, requestsLastDay: 4, total: 5 });
    clock = new Date('2026-10-17T16:00:00.000Z');
    expect(ledger.codexRequestsWithin(5 * 3_600_000)).toBe(0);

    ledger.append({ ...base, litellm: { keySpendUsd: 1.5, keyMaxBudgetUsd: 5 } });
    expect(ledger.summary().lastKey).toEqual({
      spendUsd: 1.5,
      maxBudgetUsd: 5,
      at: '2026-10-17T16:00:00.000Z',
    });
  });

  describe('reservations: a request is on the books from the moment it starts', () => {
    const reservation = (
      rid: string,
      usd = 0.02,
      extra: Partial<Parameters<Ledger['reserve']>[0]> = {},
    ) => ({
      rid,
      run: 'run-1',
      agent: 'procedure-1',
      provider: 'voucher' as const,
      path: '/v1/chat/completions',
      usd,
      ...extra,
    });

    it('counts the worst case as pending until the request settles with the same rid', () => {
      const ledger = new Ledger(dir, now);
      ledger.reserve(reservation('r1'));
      ledger.reserve(reservation('r2', 0.03));
      expect(ledger.pendingUsd()).toBeCloseTo(0.05, 12);
      expect(ledger.pendingUsd({ day: '2026-10-17' })).toBeCloseTo(0.05, 12);
      expect(ledger.pendingUsd({ day: '2026-10-16' })).toBe(0);
      // Pending is not spend, and a reservation is not a request.
      expect(ledger.spentTodayUsd()).toBe(0);
      expect(ledger.summary().requests).toEqual({ forward: 0, replay: 0, reject: 0 });
      expect(ledger.summary().pending).toMatchObject({ requests: 2 });
      expect(ledger.summary().pending.usd).toBeCloseTo(0.05, 12);

      ledger.append({ ...base, rid: 'r1', cost: { usd: 0.004, source: 'header' } });
      expect(ledger.pendingUsd()).toBeCloseTo(0.03, 12);
      expect(ledger.spentTodayUsd()).toBeCloseTo(0.004, 12);
      ledger.release('r2');
      expect(ledger.pendingUsd()).toBe(0);
      expect(ledger.summary().pending).toEqual({ requests: 0, usd: 0 });
    });

    it('is seen by other processes, and what a dead process left stays on the books', () => {
      const a = new Ledger(dir, now);
      a.reserve(reservation('lost'));
      // Another process starts later and finds the reservation of a process that never settled.
      const b = new Ledger(dir, now);
      expect(b.pendingUsd()).toBeCloseTo(0.02, 12);
      expect(b.spentTodayUsd() + b.pendingUsd({ day: '2026-10-17' })).toBeCloseTo(0.02, 12);
      // Only a recent reservation can still be in flight: the old one is no longer subtracted
      // from the key's balance (the key server already knows what it cost), but still counts today.
      clock = new Date('2026-10-17T11:00:00.000Z');
      expect(b.pendingUsd({ sinceMs: clock.getTime() - 30 * 60_000 })).toBe(0);
      expect(b.pendingUsd({ day: '2026-10-17' })).toBeCloseTo(0.02, 12);
      expect(b.summary().pending).toMatchObject({
        requests: 1,
        oldest: '2026-10-17T10:00:00.000Z',
      });
    });

    it('only counts voucher reservations as dollars', () => {
      const ledger = new Ledger(dir, now);
      ledger.reserve(reservation('m', 0.5, { provider: 'mock' }));
      ledger.reserve(reservation('c', 0, { provider: 'codex' }));
      expect(ledger.pendingUsd()).toBe(0);
    });

    it('counts a pending Codex request in the rolling windows once, and not at all once released', () => {
      const ledger = new Ledger(dir, now);
      ledger.reserve(reservation('c1', 0, { provider: 'codex' }));
      ledger.reserve(reservation('c2', 0, { provider: 'codex' }));
      expect(ledger.codexRequestsWithin(5 * 3_600_000)).toBe(2);
      ledger.append({ ...base, provider: 'codex', rid: 'c1', cost: undefined });
      expect(ledger.codexRequestsWithin(5 * 3_600_000)).toBe(2);
      ledger.release('c2');
      expect(ledger.codexRequestsWithin(5 * 3_600_000)).toBe(1);
      expect(ledger.summary().codex).toMatchObject({ requestsLast5h: 1, total: 1 });
      // A forward line of an older version has no rid and counts as before.
      ledger.append({ ...base, provider: 'codex', cost: undefined });
      expect(ledger.codexRequestsWithin(5 * 3_600_000)).toBe(2);
    });

    it('keeps reservations out of the lifetime total of an earlier epoch', () => {
      const ledger = new Ledger(dir, now);
      ledger.reserve(reservation('before'));
      clock = new Date('2026-10-17T12:00:00.000Z');
      ledger.epoch('new voucher');
      ledger.reserve(reservation('after', 0.01));
      expect(ledger.pendingSinceEpochUsd()).toBeCloseTo(0.01, 12);
      expect(ledger.pendingUsd()).toBeCloseTo(0.03, 12);
    });
  });

  it('starts empty when the directory does not exist', () => {
    const ledger = new Ledger(join(t.home, 'nowhere'), now);
    expect(ledger.summary()).toMatchObject({
      sinceEpochUsd: 0,
      requests: { forward: 0, replay: 0, reject: 0 },
      pending: { requests: 0, usd: 0 },
    });
  });
});
