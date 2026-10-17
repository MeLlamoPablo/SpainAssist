import './helpers/no-network';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMeter, type MeterHandle, type MeterRun } from '../../src/llm/meter';
import {
  type RealisticBackend,
  SAFETY_IDENTIFIER,
  startRealisticBackend,
} from './helpers/codex-backend';
import { jwt } from './helpers/fake-codex-auth';
import { API_KEY, type MeterEnv, startEnv } from './helpers/meter-env';
import { makeHome, type TestHome } from './helpers/tmp-home';

/**
 * What the record/replay cache keeps. Recordings are meant to be reviewed and may be committed, so
 * they must not carry who made them: the ChatGPT user id of a Codex response (`safety_identifier`),
 * the identifiers in the access token, the plan and usage headers, a voucher key's balance.
 */

const USER_ID = 'user-AbCdEf0123456789xyz';
const ACCOUNT_ID = 'acct-0123-4567-89ab-cdef';
const EMAIL = 'dev.person@example.test';
const ACCESS = jwt({
  'https://api.openai.com/auth': {
    chatgpt_account_id: ACCOUNT_ID,
    chatgpt_user_id: USER_ID,
    organizations: [{ id: 'org-Zz99Yy88' }],
  },
  'https://api.openai.com/profile': { email: EMAIL },
});

function cacheFiles(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? cacheFiles(path) : [path];
    });
  } catch {
    return [];
  }
}

const recorded = (dir: string) =>
  cacheFiles(dir)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

describe('a Codex recording', () => {
  let t: TestHome;
  let backend: RealisticBackend;
  let meter: MeterHandle;
  beforeEach(async () => {
    t = makeHome();
    backend = await startRealisticBackend({ holdMs: 20 });
    meter = await createMeter({
      home: t.home,
      upstreams: { codex: backend.url },
      codexConsent: true,
    });
  });
  afterEach(async () => {
    await meter.close();
    await backend.close();
    t.cleanup();
  });

  const post = (run: MeterRun) =>
    fetch(`${run.agentBaseUrl('answerer')}/codex/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ACCESS}`,
        'chatgpt-account-id': ACCOUNT_ID,
      },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        stream: true,
        instructions: 'You play the user.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hola' }] }],
      }),
    });

  it('keeps no account identifier, plan or usage, and still replays', async () => {
    const run = meter.openRun({ runId: 'rec', provider: 'codex', cache: 'record' });
    const live = await (await post(run)).text();
    // The live answer is untouched: the agent gets what the backend sent.
    expect(live).toContain(SAFETY_IDENTIFIER);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stored = recorded(t.paths.cacheDir);
    expect(stored).toContain('response.completed');
    for (const identity of [SAFETY_IDENTIFIER, USER_ID, ACCOUNT_ID, EMAIL, 'org-Zz99Yy88']) {
      expect(stored, identity).not.toContain(identity);
    }
    expect(stored).toContain('"safety_identifier\\":\\"[redacted-id]');
    expect(stored).not.toMatch(/x-codex-(plan-type|primary|secondary|credits|active)/);

    const replay = meter.openRun({ runId: 'rep', provider: 'codex', cache: 'replay' });
    const replayed = await post(replay);
    expect(replayed.headers.get('x-sa-eval-cache')).toBe('hit');
    expect(replayed.headers.get('x-codex-plan-type')).toBeNull();
    const text = await replayed.text();
    expect(text).toContain('response.completed');
    expect(text).toContain('"safety_identifier":"[redacted-id]"');
    expect(text).not.toContain(SAFETY_IDENTIFIER);
    expect(backend.requests).toHaveLength(1);
  });
});

describe('a voucher recording', () => {
  let env: MeterEnv;
  beforeEach(async () => {
    env = await startEnv();
  });
  afterEach(async () => {
    await env.close();
  });

  it("keeps nothing of the key's balance and budget", async () => {
    const run = env.openRun({ cache: 'record' });
    const res = await fetch(`${run.agentBaseUrl('main')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-5.5',
        messages: [{ role: 'user', content: 'hola' }],
      }),
    });
    // The gateway sends them (the meter learns the balance from them) ...
    expect(res.headers.get('x-litellm-key-spend')).not.toBeNull();
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // ... and the recording does not keep them.
    const stored = recorded(env.t.paths.cacheDir);
    expect(stored).toContain('x-litellm-response-cost');
    expect(stored).not.toContain('x-litellm-key-spend');
    expect(stored).not.toContain('x-litellm-key-max-budget');
  });
});
