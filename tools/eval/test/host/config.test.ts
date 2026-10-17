import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EVAL_CONFIG_ENV,
  evalHostLaunch,
  evalHostPath,
  loadHostEvalConfig,
  parseHostEvalConfig,
  writeHostEvalConfig,
} from '../../src/host';
import { hostConfig, recordedAnswer } from './support';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-eval-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const valid = () => hostConfig('http://127.0.0.1:3010', join(dir, 'host.jsonl'));

function problems(config: unknown): string {
  try {
    parseHostEvalConfig(config);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the config to be rejected');
}

describe('HostEvalConfig schema', () => {
  it('accepts a complete config, with the recorded research answer', () => {
    const config = valid();
    expect(parseHostEvalConfig(config)).toEqual(config);
  });

  it('accepts every unmapped mode', () => {
    for (const unmapped of [
      { mode: 'enotfound' },
      { mode: 'econnrefused' },
      { mode: 'timeout' },
      { mode: 'status', status: 404 },
    ] as const) {
      expect(parseHostEvalConfig({ ...valid(), unmapped }).unmapped).toEqual(unmapped);
    }
    expect(problems({ ...valid(), unmapped: { mode: 'status', status: 99 } })).toContain(
      'unmapped',
    );
    expect(problems({ ...valid(), unmapped: { mode: 'status' } })).toContain('unmapped');
    expect(problems({ ...valid(), unmapped: { mode: 'dns' } })).toContain('unmapped');
  });

  it('refuses an upstream that is not a plain loopback origin', () => {
    for (const mockOrigin of [
      'https://127.0.0.1:3010',
      'http://portal.seg-social.gob.es',
      'http://10.0.0.5:3010',
      'not a url',
    ]) {
      expect(problems({ ...valid(), mockOrigin })).toContain('mockOrigin');
    }
    expect(
      parseHostEvalConfig({ ...valid(), mockOrigin: 'http://localhost:3010' }).mockOrigin,
    ).toBe('http://localhost:3010');
  });

  it('needs a loopback scoring origin that is not the mock listener, whatever it is called', () => {
    for (const scoringOrigin of [
      'http://127.0.0.1:3010',
      'http://localhost:3010',
      'http://[::ffff:127.0.0.1]:3010',
    ]) {
      expect(problems({ ...valid(), scoringOrigin })).toContain('scoring listener');
    }
    for (const scoringOrigin of ['https://127.0.0.1:3020', 'http://10.0.0.5:3020', 'nope']) {
      expect(problems({ ...valid(), scoringOrigin })).toContain('scoringOrigin');
    }
    const { scoringOrigin: _left, ...without } = valid();
    expect(problems(without)).toContain('scoringOrigin');
    expect(
      parseHostEvalConfig({ ...valid(), scoringOrigin: 'http://127.0.0.1:3020' }).scoringOrigin,
    ).toBe('http://127.0.0.1:3020');
  });

  it('refuses routes that cannot be mapped: IP literals, loopback names, odd wildcards', () => {
    for (const route of ['127.0.0.1', 'localhost', '192.0.2.4', 'a.*.es', '*', '']) {
      expect(problems({ ...valid(), routes: [route] })).toContain('routes');
    }
    expect(
      parseHostEvalConfig({ ...valid(), routes: ['*.seg-social.gob.es', 'www.boe.es'] }).routes,
    ).toEqual(['*.seg-social.gob.es', 'www.boe.es']);
  });

  it('refuses an answer that the product tool would silently drop', () => {
    const answer = recordedAnswer();
    expect(problems({ ...valid(), research: { shape: 'auto', answers: [] } })).toContain(
      'at least one recorded research answer',
    );
    expect(
      problems({
        ...valid(),
        research: { shape: 'auto', answers: [{ ...answer, id: 'not-a-uuid' }] },
      }),
    ).toContain('research');
    expect(
      problems({
        ...valid(),
        research: {
          shape: 'auto',
          answers: [{ ...answer, output: { ...answer.output, type: 'html' } }],
        },
      }),
    ).toContain('research');
    expect(problems({ ...valid(), research: { shape: 'exa', answers: [answer] } })).toContain(
      'research',
    );
  });

  it('wants an ISO instant with its offset for the clock', () => {
    expect(parseHostEvalConfig({ ...valid(), now: '2026-10-17T07:30:00Z' }).now).toBe(
      '2026-10-17T07:30:00Z',
    );
    for (const now of ['2026-10-17', 'yesterday', '2026-10-17T09:30:00']) {
      expect(problems({ ...valid(), now })).toContain('now');
    }
  });

  it('refuses origins that are not http(s) or ws(s), and fields it does not know', () => {
    expect(
      parseHostEvalConfig({
        ...valid(),
        llm: { extraAllowOrigins: ['https://chatgpt.com', 'wss://chatgpt.com'] },
      }).llm.extraAllowOrigins,
    ).toEqual(['https://chatgpt.com', 'wss://chatgpt.com']);
    expect(problems({ ...valid(), llm: { extraAllowOrigins: ['ftp://x.es'] } })).toContain('llm');
    expect(problems({ ...valid(), llm: { extraAllowOrigins: ['chatgpt.com'] } })).toContain('llm');
    expect(problems({ ...valid(), allowPrivateHosts: true })).toContain('allowPrivateHosts');
    expect(problems({ ...valid(), worldId: '' })).toContain('worldId');
    expect(problems({ ...valid(), netlog: '' })).toContain('netlog');
  });
});

describe('the config file', () => {
  it('is written valid, private and readable through SA_EVAL_CONFIG', () => {
    const file = join(dir, 'nested', 'host-config.json');
    expect(writeHostEvalConfig(file, valid())).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    expect(loadHostEvalConfig({ [EVAL_CONFIG_ENV]: file })).toEqual(valid());
  });

  it('refuses to write an invalid config', () => {
    const file = join(dir, 'host-config.json');
    expect(() => writeHostEvalConfig(file, { ...valid(), routes: ['127.0.0.1'] })).toThrow(
      /Invalid eval host config/,
    );
    expect(() => readFileSync(file)).toThrow();
  });

  it('says what is wrong when it cannot be loaded', () => {
    expect(() => loadHostEvalConfig({})).toThrow(/SA_EVAL_CONFIG is not set/);
    expect(() => loadHostEvalConfig({ [EVAL_CONFIG_ENV]: join(dir, 'missing.json') })).toThrow(
      /Cannot read the eval host config/,
    );
    const garbage = join(dir, 'garbage.json');
    writeFileSync(garbage, '{ not json');
    expect(() => loadHostEvalConfig({ [EVAL_CONFIG_ENV]: garbage })).toThrow(/is not JSON/);
    const wrong = join(dir, 'wrong.json');
    writeFileSync(wrong, JSON.stringify({ worldId: 'x' }));
    expect(() => loadHostEvalConfig({ [EVAL_CONFIG_ENV]: wrong })).toThrow(
      /Invalid eval host config/,
    );
  });
});

describe('evalHostLaunch', () => {
  it('points the product launch at the eval bundle with the config file, and nothing else', () => {
    const launch = evalHostLaunch('/runs/r1/host-config.json', {
      PATH: '/usr/bin',
      HOME: '/home/x',
      TZ: 'Europe/Madrid',
      HTTPS_PROXY: 'http://proxy:3128',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      NODE_OPTIONS: '--require /evil.js',
      OPENAI_API_KEY: 'sk-secret',
    });
    expect(launch.hostPath).toBe(evalHostPath());
    expect(launch.hostPath.endsWith(join('tools', 'eval', 'dist', 'eval-host.js'))).toBe(true);
    expect(launch.extraEnv).toEqual({ SA_EVAL_CONFIG: '/runs/r1/host-config.json' });
    expect(Object.fromEntries(Object.entries(launch.inheritEnv).filter(([, v]) => v))).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      TZ: 'Europe/Madrid',
    });
  });
});
