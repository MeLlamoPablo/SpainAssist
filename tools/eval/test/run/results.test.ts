import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Fixture, RunResult } from '../../src/contracts';
import { findFixture, getFixture } from '../../src/fixtures';
import {
  generateRunId,
  isValidRunId,
  RunSecrets,
  readRunResult,
  renderActivity,
  renderRunReport,
  renderSummaryTable,
  reportRun,
  summarizeResult,
} from '../../src/run';
import { copyLedgerLines, defaultRunsRoot, fixtureHash, readEvents } from '../../src/run/results';
import { emptyMeterUsage } from '../../src/scoring';
import { createEnv, type Env, miniFixture } from './support/harness';

const dirs: string[] = [];
let env: Env | undefined;
afterEach(() => {
  env?.dispose();
  env = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-results-'));
  dirs.push(dir);
  return dir;
}

describe('run ids', () => {
  const now = new Date('2026-10-17T06:30:15Z');

  it('is <fixture>-<provider>-<yyyymmdd-hhmmss>-<4 hex>, in UTC', () => {
    expect(
      generateRunId({
        fixtureId: 'vida-laboral-sin-datos',
        provider: 'voucher',
        now,
        suffix: 'a1b2',
      }),
    ).toBe('vida-laboral-sin-datos-voucher-20261017-063015-a1b2');
    const random = generateRunId({ fixtureId: 'x', provider: 'mock', now });
    expect(random).toMatch(/^x-mock-20261017-063015-[0-9a-f]{4}$/);
    expect(generateRunId({ fixtureId: 'x', provider: 'mock', now })).not.toBe(random);
  });

  it('is always a valid world id and meter-safe path segment', () => {
    for (const fixtureId of [
      'vida-laboral-inyeccion:page-title',
      'a'.repeat(80),
      'with spaces/and:odd*chars',
      ':::',
      'Ünïcode-ñ',
    ]) {
      for (const provider of ['voucher', 'codex', 'mock'] as const) {
        const id = generateRunId({ fixtureId, provider, now, suffix: 'ffff' });
        expect(id, fixtureId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        expect(id.endsWith(`-${provider}-20261017-063015-ffff`)).toBe(true);
        expect(isValidRunId(id)).toBe(true);
      }
    }
    expect(generateRunId({ fixtureId: ':::', provider: 'mock', now, suffix: '0000' })).toBe(
      'run-mock-20261017-063015-0000',
    );
    expect(
      generateRunId({ fixtureId: 'a'.repeat(80), provider: 'voucher', now, suffix: '0000' }),
    ).toHaveLength(64);
  });

  // The meter's route accepts `[A-Za-z0-9._~-]{1,80}` for an agent key (src/llm/meter.ts), and
  // SpainBench's world id is `/^[A-Za-z0-9_-]{1,64}$/` (server/kernel/worlds.mjs).
  const AGENT_KEY = /^[A-Za-z0-9._~-]{1,80}$/;
  const ids = [
    'vida-laboral-sin-datos',
    'vida-laboral-inyeccion:page-title',
    'a'.repeat(100),
  ].flatMap((fixtureId) =>
    (['voucher', 'codex', 'mock'] as const).map((provider) =>
      generateRunId({ fixtureId, provider, now }),
    ),
  );

  it("fits the meter's agent key characters", () => {
    for (const id of ids) expect(id).toMatch(AGENT_KEY);
  });

  it.runIf(process.env.SPAINBENCH_DIR)("fits SpainBench's own world id rule", async () => {
    const { worldIdPattern } = (await import(
      /* @vite-ignore */ `${process.env.SPAINBENCH_DIR}/server/kernel/worlds.mjs`
    )) as { worldIdPattern: RegExp };
    for (const id of ids) expect(id).toMatch(worldIdPattern);
  });

  it('refuses a suffix that is not four hex digits, and ids outside the alphabet', () => {
    expect(() => generateRunId({ fixtureId: 'x', provider: 'mock', now, suffix: 'xyz1' })).toThrow(
      /4 hex digits/,
    );
    for (const bad of ['', 'a b', 'a/b', 'a:b', 'ñ', 'a.b', 'a'.repeat(65)]) {
      expect(isValidRunId(bad), bad).toBe(false);
    }
    expect(isValidRunId('ok_Id-1')).toBe(true);
  });
});

describe('the default runs root', () => {
  it("is spainbench/runs in the OS's data folder, outside the checkout", () => {
    expect(defaultRunsRoot({}, 'darwin', '/Users/u')).toBe(
      '/Users/u/Library/Application Support/spainbench/runs',
    );
    expect(defaultRunsRoot({}, 'linux', '/home/u')).toBe('/home/u/.local/share/spainbench/runs');
    expect(defaultRunsRoot({ XDG_DATA_HOME: '/data' }, 'linux', '/home/u')).toBe(
      '/data/spainbench/runs',
    );
    // A relative XDG_DATA_HOME is invalid by the spec and ignored.
    expect(defaultRunsRoot({ XDG_DATA_HOME: 'data' }, 'linux', '/home/u')).toBe(
      '/home/u/.local/share/spainbench/runs',
    );
    expect(defaultRunsRoot({}, 'darwin', '/Users/u')).not.toContain(process.cwd());
    // SPAINBENCH_DATA_DIR moves the whole data folder, runs included.
    expect(defaultRunsRoot({ SPAINBENCH_DATA_DIR: '/tmp/sb' }, 'linux', '/home/u')).toBe(
      '/tmp/sb/runs',
    );
  });
});

describe('fixtureHash', () => {
  it('is stable for the same fixture and changes with its rules, regexes and custom tests', () => {
    const fixture = getFixture('vida-laboral-sin-datos');
    expect(fixtureHash(fixture)).toMatch(/^[0-9a-f]{16}$/);
    expect(fixtureHash(getFixture('vida-laboral-sin-datos'))).toBe(fixtureHash(fixture));
    expect(fixtureHash(getFixture('vida-laboral-con-datos'))).not.toBe(fixtureHash(fixture));

    const base = miniFixture();
    const regex = miniFixture({
      rules: base.rules.map((rule) =>
        rule.id === 'said-thanks'
          ? { ...rule, condition: { type: 'prose', from: 'assistant', matches: /vale/i } as const }
          : rule,
      ),
    });
    expect(fixtureHash(regex)).not.toBe(fixtureHash(base));
    const custom = (test: () => boolean): Fixture =>
      miniFixture({
        rules: [
          ...base.rules,
          {
            id: 'c',
            description: 'c',
            kind: 'scored',
            condition: { type: 'custom', name: 'c', test },
          },
        ],
      });
    expect(fixtureHash(custom(() => true))).not.toBe(fixtureHash(custom(() => false)));
  });
});

describe('RunSecrets', () => {
  it('masks values, their other spellings, bearer tokens and keys', () => {
    const secrets = new RunSecrets();
    secrets.addAll(['S3cr3t-Passw0rd', 'pa"ss\\word-123', undefined, null, '', 'abc']);
    // 'abc' is under the shared minimum: masking it would mangle ordinary text.
    expect(secrets.list()).toEqual(['S3cr3t-Passw0rd', 'pa"ss\\word-123']);
    expect(secrets.scrub('clave S3cr3t-Passw0rd, abc')).toBe('clave [redacted], abc');
    expect(secrets.scrub(JSON.stringify({ p: 'pa"ss\\word-123' }))).toBe('{"p":"[redacted]"}');
    expect(secrets.scrub('pa"ss\\word-123')).toBe('[redacted]');
    expect(secrets.scrub('Authorization: Bearer abcdef0123456789 and sk-abcdef0123456789')).toBe(
      'Authorization: Bearer [redacted] and sk-[redacted]',
    );
    expect(secrets.leaks('x S3cr3t-Passw0rd x')).toBe(true);
    expect(secrets.leaks('nothing here')).toBe(false);
  });

  it('masks a password in the form, base64 and hex spellings a log may hold, like the net logs', () => {
    const secrets = new RunSecrets();
    secrets.addAll(['SpainBench2026!', '1234']);
    const password = 'SpainBench2026!';
    for (const spelling of [
      'SpainBench2026%21',
      encodeURIComponent(password),
      Buffer.from(password).toString('base64'),
      Buffer.from(password).toString('base64url'),
      Buffer.from(password).toString('hex'),
      Buffer.from(password).toString('hex').toUpperCase(),
    ]) {
      expect(secrets.scrub(`password=${spelling}&x=1`), spelling).toBe('password=[redacted]&x=1');
    }
    // Base64 of the password after one or two other bytes: the characters its own bytes decide
    // are masked (the ones at the edges also depend on the neighbours).
    for (const prefix of ['', 'x', 'xy']) {
      const encoded = Buffer.from(`${prefix}${password}\n`).toString('base64');
      const masked = secrets.scrub(`d=${encoded}`);
      expect(masked, prefix).toContain('[redacted]');
      expect(masked, prefix).not.toContain(encoded.slice(4, -4));
    }
    // A four-character PIN is a secret too (the minimum is shared with the net logs).
    expect(secrets.scrub('pin 1234 ok')).toBe('pin [redacted] ok');
  });
});

describe('events.jsonl', () => {
  const line = (seq: number, type = 'note') => JSON.stringify({ seq, t: 'x', type, text: 'n' });

  it('reads the observations, up to a seq when asked', () => {
    const dir = tmp();
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, `${[1, 2, 3, 4].map((n) => line(n)).join('\n')}\n`);
    expect(readEvents(file).observations.map((o) => o.seq)).toEqual([1, 2, 3, 4]);
    const upTo = readEvents(file, 2);
    expect(upTo.observations.map((o) => o.seq)).toEqual([1, 2]);
    expect(upTo.lines).toEqual([line(1), line(2)]);
  });

  it('ignores a torn last line and refuses anything else that is not an observation', () => {
    const dir = tmp();
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, `${line(1)}\n${line(2)}\n{"seq":3,"t":"x","ty`);
    expect(readEvents(file).observations).toHaveLength(2);
    writeFileSync(file, `${line(1)}\n{"nope":true}\n${line(3)}\n`);
    expect(() => readEvents(file)).toThrow(/events\.jsonl:2 is not an observation/);
    writeFileSync(file, `${line(1)}\nnot json\n${line(3)}\n`);
    expect(() => readEvents(file)).toThrow(/events\.jsonl:2 is not valid JSON/);
    expect(() => readEvents(join(dir, 'missing.jsonl'))).toThrow(/Cannot read/);
  });
});

describe('the meter ledger of a run', () => {
  it('copies the lines of one run from every month file and skips torn lines', () => {
    const dir = tmp();
    const ledger = join(dir, 'ledger');
    mkdirSync(ledger);
    const record = (runId: string, n: number) => JSON.stringify({ type: 'request', runId, n });
    writeFileSync(join(ledger, 'spend-2026-09.jsonl'), `${record('r1', 1)}\n${record('r2', 2)}\n`);
    writeFileSync(
      join(ledger, 'spend-2026-10.jsonl'),
      `${record('r1', 3)}\n${JSON.stringify({ type: 'epoch' })}\n{"type":"request","runId":"r1","n`,
    );
    writeFileSync(join(ledger, 'notes.txt'), record('r1', 99));
    const target = join(dir, 'meter.jsonl');
    expect(copyLedgerLines(ledger, 'r1', target)).toBe(2);
    expect(
      readFileSync(target, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { n: number }).n),
    ).toEqual([1, 3]);
    expect(copyLedgerLines(join(dir, 'nope'), 'r1', join(dir, 'empty.jsonl'))).toBe(0);
    expect(readFileSync(join(dir, 'empty.jsonl'), 'utf8')).toBe('');
  });
});

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'run-1',
    fixtureId: 'fx',
    provider: 'mock',
    status: 'completed',
    score: 0.85,
    scoreBeforePenalty: 0.9,
    wrongTurns: 1,
    rules: [],
    usage: { ...emptyMeterUsage(), costUsd: 0.0123 },
    durationMs: 75_000,
    endedBy: 'quiescent',
    notes: [],
    ...overrides,
  };
}

describe('summaries', () => {
  it('one line: status, score, fixture, provider, time, cost, why it ended, the folder', () => {
    expect(summarizeResult(result(), '/runs/run-1')).toBe(
      'completed (85.0%) | fx [mock] | 1 min 15 s | $0.0123 (mock, not charged) | ended by quiescent | /runs/run-1',
    );
    expect(
      summarizeResult(
        result({
          status: 'failed_required',
          score: 0,
          durationMs: 3500,
          endedBy: 'required-failed',
          rules: [
            { ruleId: 'pdf', kind: 'required', negate: false, matched: false, passed: false },
            { ruleId: 'leak', kind: 'required', negate: true, matched: true, passed: false },
            { ruleId: 'nice', kind: 'scored', negate: false, matched: false, passed: false },
          ],
        }),
      ),
    ).toBe(
      'failed_required (0.0%) | fx [mock] | 3.5 s | $0.0123 (mock, not charged) | ended by required-failed | failed: pdf, leak',
    );
    expect(summarizeResult(result({ status: 'aborted', score: null }))).toContain(
      'aborted (no score)',
    );
  });

  it('says a run was cut short, and which negated rules were not tested to the end', () => {
    const cut = result({ endedBy: 'limit:cost', unsettledNegated: ['no-exfil', 'no-secret-leak'] });
    expect(summarizeResult(cut)).toContain(
      'ended by limit:cost | cut short: no-exfil, no-secret-leak not tested to the end',
    );
    expect(summarizeResult(result())).not.toContain('cut short');
    expect(renderSummaryTable([cut])).toContain('| fx | mock | completed (cut short) | 85.0% |');
  });

  it('says what a run cost in the unit its provider is charged in', () => {
    const usage = { ...result().usage, requests: 42 };
    expect(summarizeResult(result({ provider: 'voucher', usage }))).toContain(' | $0.0123 | ');
    expect(summarizeResult(result({ provider: 'codex', usage }))).toContain(
      ' | 42 requests (ChatGPT plan) | ',
    );
    expect(summarizeResult(result({ provider: 'mock', usage }))).toContain(
      ' | $0.0123 (mock, not charged) | ',
    );
  });

  it('says how much of the run was replayed from earlier recordings, and how much of it loosely', () => {
    const replayed = (cacheHits: number, looseHits?: number) =>
      summarizeResult(
        result({
          provider: 'voucher',
          usage: {
            ...result().usage,
            requests: 12,
            cacheHits,
            ...(looseHits !== undefined ? { looseHits } : {}),
          },
        }),
      );
    expect(replayed(0)).not.toContain('replayed');
    expect(replayed(8, 3)).toContain(
      ' | $0.0123 | 8 of 12 requests replayed (3 loose) | ended by ',
    );
    expect(replayed(12, 0)).toContain('12 of 12 requests replayed (0 loose)');
    // A result written before loose hits were counted has none to report.
    expect(replayed(5)).toContain('5 of 12 requests replayed (0 loose)');
  });

  it('a table of several runs, with the mean of the scored ones and the total cost', () => {
    const table = renderSummaryTable([
      result({ runId: 'a', fixtureId: 'one', score: 1, wrongTurns: 0 }),
      result({ runId: 'b', fixtureId: 'two', score: 0.5 }),
      result({
        runId: 'c',
        fixtureId: 'three',
        status: 'inconclusive',
        score: null,
        endedBy: 'a|b',
      }),
    ]);
    expect(table).toContain('| Fixture | Provider | Status | Score |');
    expect(table).toContain(
      '| one | mock | completed | 100.0% | 0 | quiescent | $0.0123 (mock, not charged) | 1 min 15 s | `a` |',
    );
    expect(table).toContain('| three | mock | inconclusive | - | 1 | a\\|b |');
    expect(table).toContain('2 of 3 run(s) scored, mean 75.0%; total cost $0.0369.');
    expect(renderSummaryTable([result({ score: null, status: 'error' })])).toContain(
      '1 run(s), none scored.',
    );
  });

  it('counts what happened in a run', () => {
    const text = renderActivity([
      { seq: 1, t: 't', type: 'user_message', text: 'hola' },
      {
        seq: 2,
        t: 't',
        type: 'tool_start',
        agent: 'assistant',
        toolCallId: '1',
        tool: 'procedure_start',
        args: {},
      },
      {
        seq: 3,
        t: 't',
        type: 'tool_start',
        agent: 'procedure',
        toolCallId: '2',
        tool: 'browser_click',
        args: {},
      },
      {
        seq: 4,
        t: 't',
        type: 'tool_start',
        agent: 'procedure',
        toolCallId: '3',
        tool: 'browser_click',
        args: {},
      },
      { seq: 5, t: 't', type: 'prompt_answered', itemId: 'a', by: 'structured' },
      { seq: 6, t: 't', type: 'prompt_answered', itemId: 'b', by: 'default' },
      {
        seq: 7,
        t: 't',
        type: 'prompt_shown',
        prompt: { itemId: 'a', agent: 'procedure', kind: 'form', title: 'x' },
      },
      { seq: 8, t: 't', type: 'bench', what: 'download', data: {} },
    ]);
    expect(text).toBe(
      [
        '## Activity',
        '',
        '- Observations: 8',
        '- Tool calls: 3 (assistant 1, procedure 2); most used: browser_click x2, procedure_start x1',
        '- Prompts: 1 shown, 2 answered (scripted 1, answerer 0, default 1)',
        '- Network: 0 request(s)',
        '- SpainBench events: download x1',
      ].join('\n'),
    );
  });

  it('puts the activity after the scoring report when the observations are known', () => {
    const report = renderRunReport({ result: result(), observations: [] });
    expect(report).toContain('# SpainBench run: fx');
    expect(report.indexOf('## Usage')).toBeLessThan(report.indexOf('## Activity'));
    expect(renderRunReport({ result: result() })).not.toContain('## Activity');
  });
});

describe('eval report <runDir>', () => {
  async function finishedRun(script: Parameters<Env['run']>[1]) {
    env = createEnv();
    return env.run(miniFixture(), script);
  }

  it('renders report.md again from result.json and events.jsonl, without any service', async () => {
    const outcome = await finishedRun(async (ctx) => {
      ctx.tool('procedure', 'do_it');
      ctx.say('assistant', 'Gracias');
      ctx.bench.wrongTurn(ctx.spec.runId);
    });
    const written = readFileSync(outcome.reportFile, 'utf8');
    expect(written).toContain('## Wrong turns: 1');
    expect(written).toContain('/missing/1');
    rmSync(outcome.reportFile);
    const markdown = reportRun(outcome.runDir, { findFixture: () => miniFixture() });
    expect(markdown).toBe(written);
    expect(readFileSync(outcome.reportFile, 'utf8')).toBe(written);
    expect(readRunResult(outcome.runDir)).toEqual(outcome.result);
  });

  it('describes the rules when the registry knows the fixture, and works when it does not', async () => {
    const outcome = await finishedRun(async (ctx) => {
      ctx.tool('procedure', 'do_it');
    });
    const known = reportRun(outcome.runDir, { findFixture: () => miniFixture(), write: false });
    expect(known).toContain('`did-it`: The procedure agent did the task.');
    expect(known).toContain('(Mini fixture)');
    const unknown = reportRun(outcome.runDir, { findFixture, write: false });
    expect(unknown).toContain('| `did-it` |');
    expect(unknown).not.toContain('The procedure agent did the task.');
  });

  it('takes the wrong turns from the logged events when SpainBench state was not saved', async () => {
    const outcome = await finishedRun(async (ctx) => {
      ctx.tool('procedure', 'do_it');
      ctx.bench.wrongTurn(ctx.spec.runId);
      ctx.bench.emit(ctx.spec.runId, 'wrong_turn', {
        seq: 9,
        host: 'portal.seg-social.gob.es',
        path: '/logged-only',
        kind: 'not-found',
      });
    });
    rmSync(join(outcome.runDir, 'bench'), { recursive: true });
    expect(reportRun(outcome.runDir, { write: false })).toContain('/logged-only');
  });

  it('tells what is missing', () => {
    const dir = tmp();
    expect(() => reportRun(dir)).toThrow(/has no result\.json/);
    writeFileSync(join(dir, 'result.json'), '{"runId":1}');
    expect(() => reportRun(dir)).toThrow(/result\.json is invalid/);
    writeFileSync(join(dir, 'result.json'), 'nope');
    expect(() => reportRun(dir)).toThrow(/not valid JSON/);
  });

  it('works on a result without any events', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result()));
    const markdown = reportRun(dir, { write: false });
    expect(markdown).toContain('# SpainBench run: fx');
    expect(markdown).not.toContain('## Activity');
  });
});
