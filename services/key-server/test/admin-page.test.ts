import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adminPageUrl,
  isGitCryptLocked,
  keyServerUrlFromState,
  readTfvarsString,
  resolveAdminLink,
} from '../src/cli/admin-link';
import { ADMIN_TOKEN, errorCode, type Harness, setup } from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const inlineHash = (html: string, tag: 'script' | 'style') => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html);
  expect(match, `inline <${tag}>`).not.toBeNull();
  return `'sha256-${createHash('sha256').update(match![1]!).digest('base64')}'`;
};

describe('GET /admin', () => {
  it('serves the page without a token, with strict security headers', async () => {
    h = await setup();
    const res = await h.request('GET', '/admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const html = await res.text();
    const csp = res.headers.get('content-security-policy') ?? '';
    const directives = Object.fromEntries(
      csp.split(';').map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values.join(' ')];
      }),
    );
    expect(directives).toEqual({
      'default-src': "'none'",
      'script-src': inlineHash(html, 'script'),
      'style-src': inlineHash(html, 'style'),
      'connect-src': "'self'",
      'img-src': "'self' data:",
      'base-uri': "'none'",
      'form-action': "'none'",
      'frame-ancestors': "'none'",
    });
    // No third-party origins anywhere in the page.
    expect(csp).not.toMatch(/https?:/);
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it('holds no data and never mentions the configured token', async () => {
    h = await setup();
    await h.createVouchers({ note: 'secret-note-xyz' });
    const html = await (await h.request('GET', '/admin')).text();
    expect(html).not.toContain(ADMIN_TOKEN);
    expect(html).not.toContain('secret-note-xyz');
  });

  it('draws new codes with a zero that does not look like an O', async () => {
    h = await setup();
    const html = await (await h.request('GET', '/admin')).text();
    const rule = /\.codes code \{([^}]*)\}/.exec(html)?.[1] ?? '';
    // The font shorthand resets font-variant-numeric, so slashed-zero has to come after it.
    expect(rule.indexOf('font-variant-numeric: slashed-zero')).toBeGreaterThan(
      rule.indexOf('font:'),
    );
    expect(rule).toMatch(/font:[^;]*Menlo, Consolas/);
    expect(html).toContain('No llevan O, I, L ni U');
  });

  it('does not exist when ADMIN_TOKEN is not configured', async () => {
    h = await setup({ config: { adminToken: undefined } });
    const res = await h.request('GET', '/admin');
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('leaves the API behind the token', async () => {
    h = await setup();
    expect((await h.request('GET', '/admin/vouchers')).status).toBe(401);
    expect((await h.request('POST', '/admin')).status).toBe(401);
  });
});

describe('admin link (vouchers script)', () => {
  const tfvars = `
# key_server_admin_token = "commented-out"
domain = "spainassist.es"
key_server_admin_token = "tok-0123456789abcdef"
feedback_admin_token   = "other"
`;

  it('reads string variables from terraform.tfvars', () => {
    expect(readTfvarsString(tfvars, 'key_server_admin_token')).toBe('tok-0123456789abcdef');
    expect(readTfvarsString(tfvars, 'domain')).toBe('spainassist.es');
    expect(readTfvarsString('a = "x\\"y"', 'a')).toBe('x"y');
    expect(readTfvarsString('# domain = "x"', 'domain')).toBeUndefined();
    expect(readTfvarsString('other_domain = "x"', 'domain')).toBeUndefined();
  });

  it('puts the token in the fragment, never in the query', () => {
    const url = adminPageUrl('https://keys.example.org', 'a b&c');
    expect(url).toBe('https://keys.example.org/admin#token=a%20b%26c');
  });

  it('prefers the URL from the Terraform state, then the domain', () => {
    const state = JSON.stringify({
      outputs: { urls: { value: { key_server: 'https://keys.1-2-3-4.sslip.io' } } },
    });
    expect(keyServerUrlFromState(state)).toBe('https://keys.1-2-3-4.sslip.io');
    expect(resolveAdminLink({ tfvars, state })).toBe(
      'https://keys.1-2-3-4.sslip.io/admin#token=tok-0123456789abcdef',
    );
    expect(resolveAdminLink({ tfvars })).toBe(
      'https://keys.spainassist.es/admin#token=tok-0123456789abcdef',
    );
  });

  it('explains what is missing', () => {
    expect(() => resolveAdminLink({})).toThrow(/not found/);
    expect(isGitCryptLocked('\0GITCRYPT\0...')).toBe(true);
    expect(() => resolveAdminLink({ tfvars: '\0GITCRYPT\0...' })).toThrow(/git-crypt unlock/);
    expect(() => resolveAdminLink({ tfvars: 'domain = "x.org"' })).toThrow(/admin page/);
    expect(() => resolveAdminLink({ tfvars: 'key_server_admin_token = "t"' })).toThrow(
      /no key server URL/,
    );
  });
});
