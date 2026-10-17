import './helpers/no-network';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOW_IP_GATEWAY_ENV,
  CodexFile,
  EvalHomeError,
  ensurePrivateDir,
  evalHome,
  homePaths,
  loadVoucherCredential,
  readCodexFile,
  readPrivateFile,
  shownPath,
  writeCodexFile,
  writeFileAtomic,
} from '../../src/llm/home';
import { makeHome, TEST_VOUCHER_KEY, type TestHome, writeLitellmFile } from './helpers/tmp-home';

const mode = (path: string) => statSync(path).mode & 0o777;

describe('credentials home', () => {
  let t: TestHome;
  beforeEach(() => {
    t = makeHome();
  });
  afterEach(() => t.cleanup());

  it("resolves SPAINBENCH_DATA_DIR, defaulting to spainbench in the OS's data folder", () => {
    expect(evalHome({ SPAINBENCH_DATA_DIR: t.home })).toBe(t.home);
    expect(evalHome({ SPAINBENCH_DATA_DIR: '  ' }, 'darwin', '/Users/u')).toBe(
      '/Users/u/Library/Application Support/spainbench',
    );
    expect(evalHome({}, 'linux', '/home/u')).toBe('/home/u/.local/share/spainbench');
    expect(evalHome({ XDG_DATA_HOME: '/data' }, 'linux', '/home/u')).toBe('/data/spainbench');
    const paths = homePaths(t.home);
    expect(paths.litellm).toBe(join(t.home, 'litellm.json'));
    expect(paths.codex).toBe(join(t.home, 'codex.json'));
    expect(paths.ledgerDir).toBe(join(t.home, 'ledger'));
    expect(paths.stopFile).toBe(join(t.home, 'STOP'));
  });

  it('creates directories as 0700 and tightens one that is too open', () => {
    const dir = join(t.home, 'a', 'b');
    ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
    const open = join(t.home, 'open');
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    ensurePrivateDir(open);
    expect(mode(open)).toBe(0o700);
  });

  it('writes files atomically as 0600 and leaves no temp files', () => {
    const path = join(t.home, 'sub', 'file.json');
    writeFileAtomic(path, 'one');
    writeFileAtomic(path, 'two');
    expect(readFileSync(path, 'utf8')).toBe('two');
    expect(mode(path)).toBe(0o600);
    expect(mode(join(t.home, 'sub'))).toBe(0o700);
    expect(readdirSync(join(t.home, 'sub'))).toEqual(['file.json']);
  });

  it('reads private files, refuses group/world-readable ones and says how to fix it', () => {
    const path = join(t.home, 'secret.txt');
    expect(readPrivateFile(path)).toBeUndefined();
    writeFileSync(path, 'hush', { mode: 0o600 });
    expect(readPrivateFile(path)).toBe('hush');
    for (const bad of [0o640, 0o604, 0o644, 0o660, 0o666]) {
      chmodSync(path, bad);
      expect(() => readPrivateFile(path)).toThrow(EvalHomeError);
    }
    chmodSync(path, 0o644);
    try {
      readPrivateFile(path);
    } catch (error) {
      expect((error as EvalHomeError).code).toBe('unsafe_permissions');
      expect((error as Error).message).toContain(`chmod 600 ${path}`);
      expect((error as Error).message).not.toContain('hush');
    }
  });

  it('refuses a directory where a file should be', () => {
    mkdirSync(join(t.home, 'dir.json'));
    expect(() => readPrivateFile(join(t.home, 'dir.json'))).toThrow(/not a regular file/);
  });

  it('follows a symlink to a private file but still checks the target mode', () => {
    const target = join(t.home, 'target.json');
    writeFileSync(target, 'x', { mode: 0o600 });
    const link = join(t.home, 'link.json');
    symlinkSync(target, link);
    expect(readPrivateFile(link)).toBe('x');
    chmodSync(target, 0o644);
    expect(() => readPrivateFile(link)).toThrow(EvalHomeError);
  });

  describe('litellm.json', () => {
    it('loads the voucher credential and normalises the URLs', () => {
      writeLitellmFile(t.home, { extra: 'kept out' });
      expect(loadVoucherCredential({ home: t.home })).toEqual({
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: TEST_VOUCHER_KEY,
        keyServerUrl: 'http://127.0.0.1:9',
        limitUsd: 5,
        expiresAt: null,
      });
    });

    it('explains a missing file without leaking anything', () => {
      try {
        loadVoucherCredential({ home: t.home });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(EvalHomeError);
        expect((error as EvalHomeError).code).toBe('missing');
        expect((error as Error).message).toContain(homePaths(t.home).litellm);
      }
    });

    it('refuses a group-readable file', () => {
      writeLitellmFile(t.home, {}, 0o640);
      expect(() => loadVoucherCredential({ home: t.home })).toThrow(/chmod 600/);
    });

    it('reports invalid content by field name, never by value', () => {
      writeLitellmFile(t.home, { baseUrl: 'not a url' });
      try {
        loadVoucherCredential({ home: t.home });
        expect.unreachable();
      } catch (error) {
        expect((error as EvalHomeError).code).toBe('invalid');
        expect((error as Error).message).toContain('baseUrl');
        expect((error as Error).message).not.toContain(TEST_VOUCHER_KEY);
      }
      writeFileSync(homePaths(t.home).litellm, '{ nope', { mode: 0o600 });
      expect(() => loadVoucherCredential({ home: t.home })).toThrow(/not valid JSON/);
    });
  });

  describe('litellm.json: where the key may be sent', () => {
    const refused = (overrides: Record<string, unknown>, env: Record<string, string> = {}) => {
      writeLitellmFile(t.home, overrides);
      try {
        loadVoucherCredential({ home: t.home, env });
      } catch (error) {
        expect(error).toBeInstanceOf(EvalHomeError);
        expect((error as EvalHomeError).code).toBe('invalid');
        expect((error as Error).message).not.toContain(TEST_VOUCHER_KEY);
        return (error as Error).message;
      }
      return undefined;
    };

    it('accepts https to a name, and plain http only to this machine', () => {
      for (const urls of [
        {
          baseUrl: 'https://llm.2-31-6-160.sslip.io/v1',
          keyServerUrl: 'https://keys.example.test',
        },
        { baseUrl: 'http://127.0.0.1:8789/v1', keyServerUrl: 'http://localhost:8787' },
        { baseUrl: 'http://[::1]:8789/v1', keyServerUrl: 'http://127.5.5.5:8787' },
        { baseUrl: 'https://localhost/v1', keyServerUrl: 'https://127.0.0.1' },
      ]) {
        writeLitellmFile(t.home, urls);
        expect(() => loadVoucherCredential({ home: t.home, env: {} })).not.toThrow();
      }
    });

    it('refuses plain http to any other host, for the gateway and the key server alike', () => {
      for (const field of ['baseUrl', 'keyServerUrl']) {
        const message = refused({ [field]: 'http://gateway.example.test/v1' });
        expect(message, field).toContain(field);
        expect(message).toContain('plain http');
        expect(message).toContain('gateway.example.test');
      }
      // Not even a private network address.
      expect(refused({ baseUrl: 'http://10.0.0.5/v1' })).toContain('plain http');
    });

    it('refuses an IP address outside the loopback unless the override is set', () => {
      for (const field of ['baseUrl', 'keyServerUrl']) {
        const message = refused({ [field]: 'https://203.0.113.9/v1' });
        expect(message, field).toContain('IP address 203.0.113.9');
        expect(message).toContain(`${ALLOW_IP_GATEWAY_ENV}=1`);
      }
      expect(refused({ baseUrl: 'https://[2001:db8::1]/v1' })).toContain('IP address');
      expect(
        refused({ baseUrl: 'https://203.0.113.9/v1' }, { [ALLOW_IP_GATEWAY_ENV]: '1' }),
      ).toBeUndefined();
      // The override does not make plain http to a remote host acceptable.
      expect(
        refused({ baseUrl: 'http://203.0.113.9/v1' }, { [ALLOW_IP_GATEWAY_ENV]: '1' }),
      ).toContain('plain http');
      expect(
        refused({ baseUrl: 'https://203.0.113.9/v1' }, { [ALLOW_IP_GATEWAY_ENV]: 'yes' }),
      ).toContain('IP address');
    });

    it('refuses what would be printed or logged with the key: user info, a query, other schemes', () => {
      expect(refused({ baseUrl: 'https://user:pw@gateway.example.test/v1' })).toContain(
        'user name or password',
      );
      expect(refused({ keyServerUrl: 'https://keys.example.test/?token=abc' })).toContain(
        'query or a fragment',
      );
      expect(refused({ baseUrl: 'https://gateway.example.test/v1#frag' })).toContain('fragment');
      expect(refused({ baseUrl: 'ftp://gateway.example.test/v1' })).toContain('http(s)');
      const secretInUrl = refused({ baseUrl: 'https://user:hunter2@gateway.example.test/v1' });
      expect(secretInUrl).not.toContain('hunter2');
    });

    it('refuses a file other users can read with the exact chmod command', () => {
      const path = writeLitellmFile(t.home, {}, 0o644);
      expect(() => loadVoucherCredential({ home: t.home })).toThrow(`chmod 600 ${shownPath(path)}`);
    });
  });

  describe('paths in messages', () => {
    it('are written under ~ when they are in the home directory, so no user name is shown', () => {
      const user = homedir();
      expect(shownPath(join(user, '.local', 'share', 'spainbench', 'codex.json'))).toBe(
        '~/.local/share/spainbench/codex.json',
      );
      expect(shownPath('/srv/evals/codex.json')).toBe('/srv/evals/codex.json');
      expect(shownPath(`${user}x/codex.json`)).toBe(`${user}x/codex.json`);
    });

    it('are quoted for a shell when they need it', () => {
      expect(shownPath("/srv/it's here/codex.json")).toBe(`'/srv/it'\\''s here/codex.json'`);
      expect(shownPath('/srv/two words/codex.json')).toBe("'/srv/two words/codex.json'");
    });
  });

  describe('codex.json', () => {
    const file = () => ({
      v: 1 as const,
      provider: 'openai-codex' as const,
      loginAt: '2026-10-17T10:00:00.000Z',
      updatedAt: '2026-10-17T10:00:00.000Z',
      credential: {
        type: 'oauth' as const,
        access: 'access-token',
        refresh: 'refresh-token',
        expires: 1_800_000_000_000,
        accountId: 'acct-1',
      },
    });

    it('round-trips through an atomic 0600 write', () => {
      expect(readCodexFile(t.home)).toBeUndefined();
      writeCodexFile(file(), t.home);
      expect(mode(homePaths(t.home).codex)).toBe(0o600);
      expect(readCodexFile(t.home)).toEqual(file());
      expect(CodexFile.safeParse({ ...file(), v: 2 }).success).toBe(false);
    });

    it('refuses a codex.json that others can read', () => {
      writeCodexFile(file(), t.home);
      chmodSync(homePaths(t.home).codex, 0o644);
      expect(() => readCodexFile(t.home)).toThrow(EvalHomeError);
    });

    it('does not exist until written', () => {
      expect(existsSync(homePaths(t.home).codex)).toBe(false);
    });
  });
});
