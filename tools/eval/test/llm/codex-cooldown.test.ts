import './helpers/no-network';
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cooldownFromError,
  isUsageLimit,
  readCooldown,
  writeCooldown,
} from '../../src/llm/codex-cooldown';
import { makeHome, type TestHome } from './helpers/tmp-home';

const MINUTE = 60_000;

describe('the shared Codex cooldown', () => {
  let t: TestHome;
  let file: string;
  beforeEach(() => {
    t = makeHome();
    file = join(t.home, 'codex-cooldown.json');
  });
  afterEach(() => t.cleanup());

  const setMtime = (ms: number) => utimesSync(file, new Date(ms), new Date(ms));

  it('is written by the first process that sees a usage limit and read by every other', () => {
    const now = Date.now();
    const error = { type: 'usage_limit_reached', planType: 'plus', resetsInSeconds: 600 };
    expect(isUsageLimit(error)).toBe(true);
    expect(isUsageLimit({ type: 'server_error' })).toBe(false);
    writeCooldown(file, cooldownFromError(error, now));
    expect(readCooldown(file, now + MINUTE)).toMatchObject({
      untilMs: now + 600_000,
      planType: 'plus',
    });
    expect(readCooldown(file, now + 11 * MINUTE)).toBeUndefined();
  });

  it('is no cooldown when there is no file', () => {
    expect(readCooldown(file, Date.now())).toBeUndefined();
    expect(
      readCooldown(join(file, 'inside-a-file-that-does-not-exist'), Date.now()),
    ).toBeUndefined();
  });

  it('counts a broken file as a limit seen when it was written, instead of failing open', () => {
    const now = Date.now();
    for (const broken of [
      '{ "untilMs": 17',
      '',
      'not json at all',
      '{"untilMs":"tomorrow","observedAt":"x"}',
      '["untilMs"]',
      '{"observedAt":"2026-10-17T10:00:00.000Z"}',
    ]) {
      writeFileSync(file, broken);
      const written = Math.floor((now - 5 * MINUTE) / 1000) * 1000;
      setMtime(written);
      const cooldown = readCooldown(file, now);
      expect(cooldown, broken).toMatchObject({ broken: true });
      // The default thirty minutes counted from the last write.
      expect(cooldown?.untilMs).toBe(written + 30 * MINUTE);
      expect(cooldown?.observedAt).toBe(new Date(written).toISOString());
    }
  });

  it('stops blocking once a broken file is older than the default cooldown', () => {
    const now = Date.now();
    writeFileSync(file, '{ torn');
    setMtime(now - 31 * MINUTE);
    expect(readCooldown(file, now)).toBeUndefined();
  });

  it('counts a file that cannot be read, or that is not a file, the same way', () => {
    const now = Date.now();
    writeFileSync(file, JSON.stringify(cooldownFromError({ type: 'usage_limit_reached' }, now)));
    chmodSync(file, 0o000);
    try {
      expect(readCooldown(file, now)).toMatchObject({ broken: true });
    } finally {
      chmodSync(file, 0o600);
    }
    const directory = join(t.home, 'dir-cooldown.json');
    mkdirSync(directory);
    expect(readCooldown(directory, now)).toMatchObject({ broken: true });
  });

  it('a good file that has passed is over, whatever its age', () => {
    const now = Date.now();
    writeFileSync(file, JSON.stringify({ untilMs: now - 1000, observedAt: 'x' }));
    setMtime(now - 1000);
    expect(readCooldown(file, now)).toBeUndefined();
  });
});
