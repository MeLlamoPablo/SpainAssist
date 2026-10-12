import { describe, expect, it } from 'vitest';
import {
  adminPageUrl,
  feedbackServerUrlFromState,
  readTfvarsString,
  resolveAdminLink,
} from '../src/cli/admin-link';

const tfvars = `
# feedback_admin_token = "old"
domain               = "example.org"
feedback_admin_token = "tok\\"en/+"
`;
const state = JSON.stringify({
  outputs: { urls: { value: { feedback_server: 'https://feedback.from-state.org' } } },
});

describe('admin link', () => {
  it('reads tfvars strings, skipping comments and unescaping quotes', () => {
    expect(readTfvarsString(tfvars, 'feedback_admin_token')).toBe('tok"en/+');
    expect(readTfvarsString(tfvars, 'missing')).toBeUndefined();
  });

  it('puts the token in the fragment of /admin', () => {
    expect(adminPageUrl('https://feedback.example.org', 'a b')).toBe(
      'https://feedback.example.org/admin#token=a%20b',
    );
  });

  it('prefers the URL from the state, then the domain', () => {
    expect(feedbackServerUrlFromState(state)).toBe('https://feedback.from-state.org');
    expect(feedbackServerUrlFromState('not json')).toBeUndefined();
    expect(resolveAdminLink({ tfvars, state })).toBe(
      'https://feedback.from-state.org/admin#token=tok%22en%2F%2B',
    );
    expect(resolveAdminLink({ tfvars })).toMatch(/^https:\/\/feedback\.example\.org\/admin#/);
  });

  it('explains what is missing', () => {
    expect(() => resolveAdminLink({})).toThrow(/not found/);
    expect(() => resolveAdminLink({ tfvars: '\0GITCRYPT\0…' })).toThrow(/git-crypt unlock/);
    expect(() => resolveAdminLink({ tfvars: 'domain = "x.org"' })).toThrow(/is empty/);
    expect(() => resolveAdminLink({ tfvars: 'feedback_admin_token = "t"' })).toThrow(/no feedback/);
  });
});
