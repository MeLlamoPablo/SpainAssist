import '../llm/helpers/no-network';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountIdPrefix, describeVoucher, relativeTime } from '../../src/cli/commands/auth';
import { budgetStatus } from '../../src/llm/budget';
import {
  CODEX_TERMS_WARNING,
  type CodexLoginOptions,
  runCodexLogin,
} from '../../src/llm/codex-auth';
import { writeCodexFile } from '../../src/llm/home';
import { type FakeAuth, startFakeAuth } from '../llm/helpers/fake-codex-auth';
import { TEST_VOUCHER_KEY, writeLitellmFile } from '../llm/helpers/tmp-home';
import { type Cli, makeCli } from './support';

let cli: Cli;
afterEach(() => cli?.cleanup());

const ACCESS = 'ACCESS-TOKEN-SECRET-0123456789';
const REFRESH = 'REFRESH-TOKEN-SECRET-0123456789';

/** A stored Codex login that expires `ms` after the harness' clock. */
function storeCodex(ms: number, accountId = 'acct-0123456789abcdef') {
  writeCodexFile(
    {
      v: 1,
      provider: 'openai-codex',
      account: 'dev@example.test',
      loginAt: '2026-10-16T08:00:00.000Z',
      updatedAt: '2026-10-16T08:00:00.000Z',
      credential: {
        type: 'oauth',
        access: ACCESS,
        refresh: REFRESH,
        expires: cli.clock.now.getTime() + ms,
        accountId,
      },
    },
    cli.home,
  );
}

const noSecrets = (text: string) => {
  for (const secret of [ACCESS, REFRESH, TEST_VOUCHER_KEY]) expect(text).not.toContain(secret);
};

describe('eval login codex', () => {
  let auth: FakeAuth;
  beforeEach(async () => {
    auth = await startFakeAuth();
  });
  afterEach(async () => {
    await auth.close();
  });

  /** The real `runCodexLogin` against the fake auth server, recording what it was asked. */
  const loginAgainstFake = (calls: CodexLoginOptions[] = []) => ({
    runCodexLogin: (options: CodexLoginOptions) => {
      calls.push(options);
      return runCodexLogin({ ...options, endpoints: auth.endpoints, sleep: async () => {} });
    },
  });

  it('prints the terms and exits 2 without consent, contacting nobody', async () => {
    cli = makeCli(); // runCodexLogin would throw if it were called
    expect(await cli.run('login', 'codex')).toBe(2);
    expect(cli.err()).toContain(CODEX_TERMS_WARNING);
    expect(cli.err()).toMatch(/pass --codex-consent or set SA_EVAL_CODEX_CONSENT=1/);
    expect(cli.err()).toMatch(/Nobody was contacted and nothing was stored/);
    expect(cli.out()).toBe('');
    expect(auth.calls).toHaveLength(0);
    expect(existsSync(join(cli.home, 'codex.json'))).toBe(false);
  });

  it('signs in with --codex-consent: URL and code on stderr, the summary on stdout, tokens stored 0600', async () => {
    const calls: CodexLoginOptions[] = [];
    cli = makeCli({ deps: loginAgainstFake(calls) });
    expect(await cli.run('login', 'codex', '--codex-consent')).toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ home: cli.home, consent: true });
    expect(cli.err()).toContain(CODEX_TERMS_WARNING);
    expect(cli.err()).toMatch(
      /Open http:\/\/127\.0\.0\.1:\d+\/codex\/device and enter the code ABCD-1234/,
    );
    expect(cli.out()).toMatch(
      /^Signed in to Codex: account id acct-fak…, access token valid until \d{4}-\d{2}-\d{2}T[\d:.]+Z, stored in .*codex\.json\n$/,
    );
    const file = join(cli.home, 'codex.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      credential: { access: string; refresh: string };
    };
    // The tokens are in the file and nowhere on the terminal.
    expect(cli.out() + cli.err()).not.toContain(stored.credential.access);
    expect(cli.out() + cli.err()).not.toContain(stored.credential.refresh);
    expect(cli.out() + cli.err()).not.toContain('acct-fake-1');
  });

  it('takes the consent from SA_EVAL_CODEX_CONSENT=1', async () => {
    cli = makeCli({ env: { SA_EVAL_CODEX_CONSENT: '1' }, deps: loginAgainstFake() });
    expect(await cli.run('login', 'codex')).toBe(0);
    expect(existsSync(join(cli.home, 'codex.json'))).toBe(true);
    cli.cleanup();
    cli = makeCli({ env: { SA_EVAL_CODEX_CONSENT: 'yes' }, deps: loginAgainstFake() });
    expect(await cli.run('login', 'codex')).toBe(2);
  });

  it('reports a login that the server refused, exit 1, and stores nothing', async () => {
    await auth.close();
    auth = await startFakeAuth({ deviceError: 'device_code_expired' });
    cli = makeCli({ deps: loginAgainstFake() });
    expect(await cli.run('login', 'codex', '--codex-consent')).toBe(1);
    expect(cli.err()).toMatch(/error: /);
    expect(cli.out()).toBe('');
    expect(existsSync(join(cli.home, 'codex.json'))).toBe(false);
  });

  it('is cancelled by Ctrl-C through the login signal: exit 1, nothing stored', async () => {
    let waiting!: () => void;
    const started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    cli = makeCli({
      deps: {
        runCodexLogin: (options) =>
          new Promise((_, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            waiting();
          }),
      },
    });
    const done = cli.run('login', 'codex', '--codex-consent');
    await started;
    cli.interrupt();
    expect(await done).toBe(1);
    expect(cli.err()).toContain('Login cancelled: nothing was stored.');
    expect(cli.listeners()).toBe(0);
  });

  it('only knows codex', async () => {
    cli = makeCli();
    expect(await cli.run('login', 'voucher')).toBe(2);
    expect(cli.err()).toMatch(/Unknown provider "voucher": only "codex" has a login/);
    expect(await cli.run('login')).toBe(2);
    expect(cli.err()).toMatch(/Missing codex/);
  });
});

describe('eval whoami and eval logout', () => {
  it('says nothing is set up on a fresh credentials home', async () => {
    cli = makeCli();
    expect(await cli.run('whoami')).toBe(0);
    expect(cli.out()).toContain(`Credentials home: ${cli.home}`);
    expect(cli.out()).toContain('Codex: not logged in (eval login codex --codex-consent)');
    expect(cli.out()).toContain('Voucher key: none (no litellm.json in the credentials home)');
  });

  it('shows the Codex login without its tokens or the whole account id', async () => {
    cli = makeCli();
    storeCodex(3 * 3_600_000);
    expect(await cli.run('whoami')).toBe(0);
    const out = cli.out();
    expect(out).toMatch(
      /Codex: logged in, account id acct-012…; access token valid until 2026-10-17T13:00:00\.000Z \(in 3 hour\(s\)\); signed in 2026-10-16T08:00:00\.000Z/,
    );
    noSecrets(out);
    expect(out).not.toContain('acct-0123456789abcdef');
    expect(out).not.toContain('dev@example.test');
  });

  it('says an expired access token is refreshed when used', async () => {
    cli = makeCli();
    storeCodex(-60_000);
    expect(await cli.run('whoami')).toBe(0);
    expect(cli.out()).toMatch(
      /access token expired 2026-10-17T09:59:00\.000Z \(refreshed when used\)/,
    );
  });

  it('shows whether the voucher key exists and until when it is valid, never the key', async () => {
    cli = makeCli();
    writeLitellmFile(cli.home, {
      baseUrl: 'https://gateway.example.test/v1/',
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
    expect(await cli.run('whoami')).toBe(0);
    expect(cli.out()).toMatch(
      /Voucher key: present \(gateway gateway\.example\.test\), valid until 2026-11-01T00:00:00\.000Z \(in 15 day\(s\)\)/,
    );
    noSecrets(cli.out());
    expect(cli.out()).not.toContain('/v1');
  });

  it('flags an expired voucher key, and a key file without an expiry date', async () => {
    cli = makeCli();
    writeLitellmFile(cli.home, { expiresAt: '2026-10-01T00:00:00.000Z' });
    await cli.run('whoami');
    expect(cli.out()).toMatch(
      /Voucher key: present \(gateway 127\.0\.0\.1:9\), EXPIRED 2026-10-01T00:00:00\.000Z \(16 day\(s\) ago\)/,
    );
    cli.cleanup();
    cli = makeCli();
    writeLitellmFile(cli.home, { expiresAt: null });
    await cli.run('whoami');
    expect(cli.out()).toMatch(/present \(gateway 127\.0\.0\.1:9\), no expiry date recorded/);
  });

  it('reports a credential file that other users can read instead of using it (exit 1)', async () => {
    cli = makeCli();
    writeLitellmFile(cli.home, {}, 0o644);
    expect(await cli.run('whoami')).toBe(1);
    expect(cli.out()).toMatch(/Voucher key: unusable: .*litellm\.json is readable by other users/);
    noSecrets(cli.out());
  });

  it('reports a credentials home that is not a folder instead of crashing', async () => {
    cli = makeCli();
    rmSync(cli.home, { recursive: true });
    writeFileSync(cli.home, 'not a folder');
    expect(await cli.run('whoami')).toBe(1);
    expect(cli.out()).toMatch(/Codex: unusable: /);
    expect(cli.out()).toMatch(/Voucher key: unusable: /);
  });

  it('logout removes the Codex login, and says when there was none', async () => {
    cli = makeCli();
    storeCodex(3_600_000);
    expect(await cli.run('logout', 'codex')).toBe(0);
    expect(cli.out()).toMatch(
      /Codex login removed from the credentials home \(no token was revoked at OpenAI\)/,
    );
    expect(existsSync(join(cli.home, 'codex.json'))).toBe(false);
    expect(await cli.run('logout', 'codex')).toBe(0);
    expect(cli.out()).toMatch(/There was no Codex login to remove\./);
    expect(await cli.run('whoami')).toBe(0);
    expect(cli.out()).toContain('Codex: not logged in');
  });

  it('logout only knows codex', async () => {
    cli = makeCli();
    expect(await cli.run('logout', 'voucher')).toBe(2);
    expect(await cli.run('logout')).toBe(2);
  });
});

describe('helpers', () => {
  it('accountIdPrefix keeps eight characters at most', () => {
    expect(accountIdPrefix('acct-0123456789abcdef')).toBe('acct-012…');
    expect(accountIdPrefix('short')).toBe('short');
    expect(accountIdPrefix(undefined)).toBe('unknown');
    expect(accountIdPrefix('')).toBe('unknown');
  });

  it('relativeTime speaks of days, hours and minutes, ahead or behind', () => {
    const now = Date.UTC(2026, 9, 17, 10);
    expect(relativeTime(now + 2 * 86_400_000, now)).toBe('in 2 day(s)');
    expect(relativeTime(now - 5 * 3_600_000, now)).toBe('5 hour(s) ago');
    expect(relativeTime(now + 30_000, now)).toBe('in 1 minute(s)');
    expect(relativeTime(now + 20 * 60_000, now)).toBe('in 20 minute(s)');
  });

  it('describeVoucher never returns the key', () => {
    cli = makeCli();
    writeLitellmFile(cli.home);
    const voucher = describeVoucher(cli.home, new Date());
    expect(JSON.stringify(voucher)).not.toContain(TEST_VOUCHER_KEY);
    expect(voucher).toMatchObject({ present: true, ok: true, expired: false });
  });
});

describe('eval budget', () => {
  /** The real `budgetStatus` over a fake key server that answers from `credit`. */
  function withKeyServer(credit: unknown) {
    const calls: { url: string; authorization: string | null }[] = [];
    const options: { offline?: boolean; home?: string }[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify(credit), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return {
      calls,
      options,
      deps: {
        budgetStatus: (given: Parameters<typeof budgetStatus>[0] = {}) => {
          options.push(given);
          return budgetStatus({ ...given, fetchImpl });
        },
      },
    };
  }

  it('shows the key balance, the ledger, the caps and Codex, and never the key', async () => {
    const server = withKeyServer({
      limitUsd: 5,
      spendUsd: 1.25,
      maxBudgetUsd: 4.5,
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    cli = makeCli({ deps: server.deps });
    writeLitellmFile(cli.home, {
      keyServerUrl: 'http://127.0.0.1:1',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    expect(await cli.run('budget')).toBe(0);
    const out = cli.out();
    expect(out).toContain(`Credentials home: ${cli.home}`);
    expect(out).toMatch(/balance \$3\.25 left \(spent \$1\.25 of \$4\.50; vouchers \$5\.00\)/);
    expect(out).toMatch(/Ledger \(real voucher spend/);
    expect(out).toMatch(
      /Caps \(voucher runs\)\n {2}per run 250 requests and the cost limit of its fixture/,
    );
    expect(out).toContain('and what the key has left');
    expect(out).toMatch(
      /Limits of a run[^\n]*\n {2}150 model requests and \$0\.30 per run, 400 tool calls, 12 prompts, 20 minutes/,
    );
    expect(out).toMatch(
      /Budget of the harness[^\n]*\n {2}the key's balance, the daily and lifetime caps/,
    );
    expect(out).toMatch(/Codex \(ChatGPT plan, no eval cap\)\n {2}not logged in/);
    noSecrets(out);
    expect(server.options).toEqual([{ home: cli.home, limits: { perRunUsd: 0.3 } }]);
    expect(server.calls).toEqual([
      { url: 'http://127.0.0.1:1/v1/vouchers/credit', authorization: `Bearer ${TEST_VOUCHER_KEY}` },
    ]);
  });

  it('--offline does not ask the key server', async () => {
    const server = withKeyServer({ limitUsd: 5, spendUsd: 0, maxBudgetUsd: 5, expiresAt: null });
    cli = makeCli({ deps: server.deps });
    writeLitellmFile(cli.home);
    expect(await cli.run('budget', '--offline')).toBe(0);
    expect(cli.out()).toMatch(/balance unavailable: offline: the key server was not asked/);
    expect(server.calls).toHaveLength(0);
    expect(server.options).toEqual([{ home: cli.home, limits: { perRunUsd: 0.3 }, offline: true }]);
  });

  it('says the voucher is not configured when there is no key file, and still shows the rest', async () => {
    cli = makeCli({ deps: { budgetStatus } });
    expect(await cli.run('budget', '--offline')).toBe(0);
    expect(cli.out()).toMatch(
      /Voucher key\n {2}not configured: No voucher key: .*litellm\.json does not exist/,
    );
    expect(cli.out()).toContain('Ledger');
    expect(cli.out()).toContain('Caps');
  });

  it('shows the Codex login and the kill switch', async () => {
    cli = makeCli({ deps: { budgetStatus } });
    storeCodex(3_600_000);
    writeFileSync(join(cli.home, 'STOP'), ''); // touch STOP
    expect(await cli.run('budget', '--offline')).toBe(0);
    expect(cli.out()).toMatch(/KILL SWITCH ON/);
    expect(cli.out()).toMatch(/logged in; access token/);
    // An older file may still carry the account's e-mail: it is never shown.
    expect(cli.out()).not.toContain('dev@example.test');
    noSecrets(cli.out());
  });

  it('takes no arguments', async () => {
    cli = makeCli();
    expect(await cli.run('budget', 'x')).toBe(2);
  });
});
