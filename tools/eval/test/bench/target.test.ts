import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BenchTargetError, resolveBenchTarget } from '../../src/bench';
import { isLoopbackAddress, normalizeOrigin } from '../../src/bench/origin';
import { DEFAULT_BENCH_TOKEN, resolveBenchEndpoints } from '../../src/bench/target';

describe('resolveBenchTarget', () => {
  it('is none without SPAINBENCH_DIR and SPAINBENCH_URL', () => {
    expect(resolveBenchTarget({})).toEqual({ mode: 'none' });
    expect(
      resolveBenchTarget({ SPAINBENCH_TOKEN: 'x', SPAINBENCH_SCORING_URL: 'http://127.0.0.1:1' }),
    ).toEqual({
      mode: 'none',
    });
  });

  it('launches from SPAINBENCH_DIR, made absolute', () => {
    expect(resolveBenchTarget({ SPAINBENCH_DIR: '/srv/SpainBench' })).toEqual({
      mode: 'launch',
      dir: '/srv/SpainBench',
    });
    expect(resolveBenchTarget({ SPAINBENCH_DIR: '../SpainBench' }, { cwd: '/work/eval' })).toEqual({
      mode: 'launch',
      dir: resolve('/work/eval', '../SpainBench'),
    });
  });

  it('lets SPAINBENCH_DIR win over SPAINBENCH_URL', () => {
    const target = resolveBenchTarget({
      SPAINBENCH_DIR: '/srv/SpainBench',
      SPAINBENCH_URL: 'http://127.0.0.1:3010',
      SPAINBENCH_TOKEN: 'secret',
    });
    expect(target).toEqual({ mode: 'launch', dir: '/srv/SpainBench' });
  });

  it('treats empty variables as unset', () => {
    expect(resolveBenchTarget({ SPAINBENCH_DIR: '', SPAINBENCH_URL: '  ' })).toEqual({
      mode: 'none',
    });
    expect(
      resolveBenchTarget({
        SPAINBENCH_DIR: '',
        SPAINBENCH_URL: 'http://127.0.0.1:3010',
        SPAINBENCH_TOKEN: '',
      }),
    ).toMatchObject({ mode: 'connect', token: DEFAULT_BENCH_TOKEN });
  });

  it('connects to a loopback server with the default pair of ports and the default token', () => {
    expect(resolveBenchTarget({ SPAINBENCH_URL: 'http://127.0.0.1:3010' })).toEqual({
      mode: 'connect',
      publicUrl: 'http://127.0.0.1:3010',
      scoringUrl: 'http://127.0.0.1:3020',
      token: DEFAULT_BENCH_TOKEN,
    });
    expect(resolveBenchTarget({ SPAINBENCH_URL: 'http://localhost:3010/' })).toMatchObject({
      publicUrl: 'http://localhost:3010',
      scoringUrl: 'http://localhost:3020',
    });
  });

  it('takes the scoring URL and the token it is given', () => {
    expect(
      resolveBenchTarget({
        SPAINBENCH_URL: 'http://127.0.0.1:4010',
        SPAINBENCH_SCORING_URL: 'http://127.0.0.1:4020/',
        SPAINBENCH_TOKEN: 'abc123',
      }),
    ).toEqual({
      mode: 'connect',
      publicUrl: 'http://127.0.0.1:4010',
      scoringUrl: 'http://127.0.0.1:4020',
      token: 'abc123',
    });
  });

  it('needs the scoring URL when the public one is not on port 3010', () => {
    expect(() => resolveBenchTarget({ SPAINBENCH_URL: 'http://127.0.0.1:4010' })).toThrow(
      /SPAINBENCH_SCORING_URL/,
    );
    expect(() => resolveBenchTarget({ SPAINBENCH_URL: 'http://127.0.0.1' })).toThrow(
      BenchTargetError,
    );
  });

  it.each([
    ['not a URL', 'nope'],
    ['a path', 'http://127.0.0.1:3010/sites'],
    ['credentials', 'http://user:pw@127.0.0.1:3010'],
    ['another scheme', 'file:///tmp/x'],
  ])('refuses a public URL that is %s', (_name, url) => {
    expect(() =>
      resolveBenchTarget({ SPAINBENCH_URL: url, SPAINBENCH_SCORING_URL: 'http://127.0.0.1:3020' }),
    ).toThrow(BenchTargetError);
  });

  it('refuses the same URL for both listeners', () => {
    expect(() =>
      resolveBenchTarget({
        SPAINBENCH_URL: 'http://127.0.0.1:3010',
        SPAINBENCH_SCORING_URL: 'http://127.0.0.1:3010',
      }),
    ).toThrow(/same/);
  });

  it('refuses the same listener under another name', () => {
    for (const scoring of [
      'http://localhost:3010',
      'http://[::1]:3010',
      'http://127.0.0.2:3010',
      'http://[::ffff:127.0.0.1]:3010',
    ]) {
      expect(() =>
        resolveBenchTarget({
          SPAINBENCH_URL: 'http://127.0.0.1:3010',
          SPAINBENCH_SCORING_URL: scoring,
        }),
      ).toThrow(/same listener|not on this machine/);
    }
  });

  describe('a server that is not on this machine', () => {
    const remote = {
      SPAINBENCH_URL: 'http://bench.example.org:3010',
      SPAINBENCH_SCORING_URL: 'http://bench.example.org:3020',
      SPAINBENCH_TOKEN: 'remote-token',
    };

    it('is refused, whatever the environment says: the network layer only reaches loopback', () => {
      expect(() => resolveBenchTarget(remote)).toThrow(BenchTargetError);
      expect(() => resolveBenchTarget(remote)).toThrow(/not on this machine/);
      expect(() => resolveBenchTarget({ ...remote, SPAINBENCH_ALLOW_REMOTE: '1' })).toThrow(
        /not on this machine/,
      );
    });

    it('is refused when only the scoring listener is remote', () => {
      expect(() =>
        resolveBenchTarget({
          SPAINBENCH_URL: 'http://127.0.0.1:3010',
          SPAINBENCH_SCORING_URL: 'http://10.0.0.5:3020',
          SPAINBENCH_TOKEN: 't',
        }),
      ).toThrow(/10\.0\.0\.5/);
    });

    it('does not put the token in a refusal', () => {
      try {
        resolveBenchTarget(remote);
      } catch (error) {
        expect(String(error)).not.toContain('remote-token');
      }
    });
  });
});

describe('resolveBenchEndpoints', () => {
  it('guesses port 3020 only for the default public port', () => {
    expect(resolveBenchEndpoints({ publicUrl: 'http://127.0.0.1:3010' }).scoringUrl).toBe(
      'http://127.0.0.1:3020',
    );
    expect(() => resolveBenchEndpoints({ publicUrl: 'http://127.0.0.1:3011' })).toThrow(
      BenchTargetError,
    );
  });

  it('checks both origins for loopback', () => {
    expect(() =>
      resolveBenchEndpoints({
        publicUrl: 'http://example.com:3010',
        scoringUrl: 'http://127.0.0.1:3020',
      }),
    ).toThrow(/example\.com/);
  });
});

describe('origins', () => {
  it.each([
    ['http://127.0.0.1:3010', true],
    ['http://127.255.0.9:1', true],
    ['http://localhost:1', true],
    ['http://LOCALHOST:1', true],
    ['http://[::1]:3010', true],
    ['http://128.0.0.1:1', false],
    ['http://0.0.0.0:1', false],
    ['http://127.0.0.1.example.com:1', false],
    ['http://foo.localhost:1', false],
    ['http://10.0.0.1:1', false],
    ['http://[::2]:1', false],
  ])('%s is loopback: %s', (origin, expected) => {
    expect(isLoopbackAddress(new URL(origin).hostname)).toBe(expected);
  });

  it('normalises a plain origin and refuses anything else', () => {
    expect(normalizeOrigin('http://127.0.0.1:3010/')).toBe('http://127.0.0.1:3010');
    expect(normalizeOrigin('https://Bench.Example:8443')).toBe('https://bench.example:8443');
    for (const bad of [
      '',
      'x',
      'http://h/p',
      'http://h/?q=1',
      'http://h/#f',
      'http://u@h',
      'ws://h',
    ]) {
      expect(normalizeOrigin(bad)).toBeUndefined();
    }
  });
});
