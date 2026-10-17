import { describe, expect, it } from 'vitest';
import { BenchVersionError, checkBenchVersion, describeBench, runnable } from '../../src/bench';
import { INJECTION_FEATURE, REQUIRED_FEATURES } from '../../src/bench/check';
import { type Fixture, SUPPORTED_SCORING_API } from '../../src/contracts';
import { getFixture, listFixtures } from '../../src/fixtures';
import { benchVersion } from './fake-server';

describe('checkBenchVersion', () => {
  it('accepts the scoring API the harness supports', () => {
    expect(() => checkBenchVersion(benchVersion())).not.toThrow();
    expect(SUPPORTED_SCORING_API).toBe(1);
  });

  it('says the harness is older than a newer server', () => {
    const error = catching(() => checkBenchVersion(benchVersion({ scoringApi: 2 })));
    expect(error).toBeInstanceOf(BenchVersionError);
    expect(error.older).toBe('harness');
    expect(error.serverApi).toBe(2);
    expect(error.supportedApi).toBe(1);
    expect(error.message).toMatch(/v2/);
    expect(error.message).toMatch(/v1/);
    expect(error.message).toMatch(/harness is older than the server/);
  });

  it('says the server is older than the harness for an older one', () => {
    const error = catching(() => checkBenchVersion(benchVersion({ scoringApi: 0 })));
    expect(error.older).toBe('server');
    expect(error.message).toMatch(/server is older than the harness/);
  });
});

function catching(run: () => void): BenchVersionError {
  try {
    run();
  } catch (error) {
    return error as BenchVersionError;
  }
  throw new Error('Expected it to throw');
}

describe('runnable', () => {
  it('runs every registered fixture on a complete server', () => {
    for (const fixture of [...listFixtures(), getFixture('vida-laboral-inyeccion')]) {
      expect(
        runnable(
          fixture,
          benchVersion({
            injections: [
              { id: 'assistant-notice', summary: '' },
              { id: 'fake-verification', summary: '' },
              { id: 'page-title', summary: '' },
              { id: 'hidden-text', summary: '' },
            ],
          }),
        ),
      ).toEqual({ ok: true });
    }
  });

  const injection = (): Fixture => getFixture('vida-laboral-inyeccion');
  const plain = (): Fixture => getFixture('vida-laboral-con-datos');

  it('refuses a server without a site of the fixture, naming what it has', () => {
    const version = benchVersion({ sites: { 'fnmt-es': { version: '3', contentHash: 'c' } } });
    const result = runnable(plain(), version);
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('no site "seg-social-es"'),
    });
    if (!result.ok) {
      expect(result.reason).toContain('fnmt-es');
      expect(result.reason).not.toContain('\n');
    }
  });

  it('refuses a preset of a site the server does not have', () => {
    const fixture: Fixture = {
      ...plain(),
      world: { sites: ['seg-social-es'], presets: { 'fnmt-es': 'download' } },
    };
    const version = benchVersion({
      sites: { 'seg-social-es': { version: '4', contentHash: 'b' } },
    });
    const result = runnable(fixture, version);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('"fnmt-es"');
  });

  it('refuses an injection variant the server does not list', () => {
    const version = benchVersion({ injections: [{ id: 'page-title', summary: '' }] });
    const result = runnable(injection(), version);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('injection variant "assistant-notice"');
    expect(!result.ok && result.reason).toContain('"page-title"');
    expect(runnable(plain(), version)).toEqual({ ok: true });
  });

  it('refuses a server whose placement points disagree with the PDF page variants', () => {
    const page = (id: string, points: string[]) => ({ id, summary: '', points });
    // assistant-notice is drawn on a PDF page among other points: as plant-points.ts expects.
    expect(
      runnable(
        injection(),
        benchVersion({ injections: [page('assistant-notice', ['portal.top', 'pdf.annex'])] }),
      ),
    ).toEqual({ ok: true });
    const moved = runnable(
      injection(),
      benchVersion({ injections: [page('assistant-notice', ['portal.top', 'vida-laboral.top'])] }),
    );
    expect(!moved.ok && moved.reason).toContain('PDF_PAGE_VARIANTS');
    // An older server that lists no points is taken at its word.
    expect(
      runnable(
        injection(),
        benchVersion({ injections: [{ id: 'assistant-notice', summary: '' }] }),
      ),
    ).toEqual({ ok: true });
  });

  it('says none when the server lists no variant at all', () => {
    const result = runnable(injection(), benchVersion({ injections: [] }));
    expect(!result.ok && result.reason).toContain('it lists none');
  });

  it.each(REQUIRED_FEATURES)('refuses a server without the feature %s', (feature) => {
    const features = benchVersion().features.filter((f) => f !== feature);
    const result = runnable(plain(), benchVersion({ features }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(`"${feature}"`);
  });

  it('needs plants only for a fixture that plants an injection', () => {
    const features = benchVersion().features.filter((f) => f !== INJECTION_FEATURE);
    expect(runnable(plain(), benchVersion({ features }))).toEqual({ ok: true });
    const result = runnable(injection(), benchVersion({ features }));
    expect(!result.ok && result.reason).toContain(`"${INJECTION_FEATURE}"`);
  });

  it('needs the disguise: a server that cannot hide the copy cannot run a fixture', () => {
    expect(REQUIRED_FEATURES).toContain('disguise');
    const features = benchVersion().features.filter((f) => f !== 'disguise');
    const result = runnable(plain(), benchVersion({ features }));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('"disguise"') });
  });

  it('asks for the features the task names: wrong-turns, events, snapshot, collector', () => {
    expect(REQUIRED_FEATURES).toEqual(
      expect.arrayContaining(['wrong-turns', 'events', 'snapshot', 'collector']),
    );
    expect(REQUIRED_FEATURES).not.toContain('plants');
  });

  it('puts every problem on one line', () => {
    const version = benchVersion({ sites: {}, features: [], injections: [] });
    const result = runnable(injection(), version);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain('\n');
      expect(result.reason).toContain('no site');
      expect(result.reason).toContain('injection variant');
      expect(result.reason).toContain('lacks the features');
    }
  });
});

describe('describeBench', () => {
  it('keeps what run.json records about the mock', () => {
    const version = benchVersion();
    expect(describeBench(version)).toEqual({
      name: 'spainbench',
      version: '0.3.0',
      gitSha: 'b7cb28da53b3c8deefc8c98c5b606773019208b1',
      contentHash: 'a'.repeat(64),
      sites: {
        'seg-social-es': { version: '4', contentHash: 'b'.repeat(64) },
        'fnmt-es': { version: '3', contentHash: 'c'.repeat(64) },
      },
      features: version.features,
      scoringApi: 1,
      snapshotFormat: 'spainbench-world/1',
    });
  });

  it('leaves out a git sha the server does not have, and copies instead of sharing', () => {
    const version = benchVersion({ gitSha: undefined });
    const described = describeBench(version);
    expect('gitSha' in described).toBe(false);
    described.features.push('x');
    expect(version.features).not.toContain('x');
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
  });
});
