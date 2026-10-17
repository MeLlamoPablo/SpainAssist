import './helpers/no-network';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAnswererMessages } from '../../src/answers/answerer';
import { createDirectorySink } from '../../src/llm/answerer';
import {
  MIN_SECRET_LENGTH,
  redactPatterns,
  SecretMasker,
  SecretRegistry,
  secretSpellings,
} from '../../src/llm/redact';
import { SecretBook } from '../../src/run/app/secrets';
import { RunSecrets } from '../../src/run/secrets';
import { jwt } from './helpers/fake-codex-auth';

describe('redaction', () => {
  it('masks bearer tokens, API keys and JWTs by pattern', () => {
    expect(redactPatterns('Authorization: Bearer abc.def-123 and more')).toBe(
      'Authorization: Bearer [redacted] and more',
    );
    expect(redactPatterns('key=sk-abcdef0123456789 ok')).toBe('key=sk-[redacted] ok');
    const token = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2ln';
    expect(redactPatterns(`token ${token}!`)).toBe('token [redacted-jwt]!');
  });

  it('masks registered secrets, longest first, and ignores short strings', () => {
    const secrets = new SecretRegistry();
    secrets.addAuthorization('Bearer my-very-secret-value');
    secrets.add('my-very-secret');
    secrets.add('abc'); // under the minimum: too short to be a secret
    secrets.add(undefined);
    expect(secrets.has('x my-very-secret-value y')).toBe(true);
    expect(secrets.redact('x my-very-secret-value y abc')).toBe('x [redacted] y abc');
    expect(secrets.has('nothing here')).toBe(false);
    expect(secrets.list()).toEqual(['my-very-secret-value', 'my-very-secret']);
  });

  it('has one minimum for every layer: four characters', () => {
    expect(MIN_SECRET_LENGTH).toBe(4);
    const masker = new SecretMasker('#');
    expect(masker.add('123')).toBe(false);
    expect(masker.add('1234')).toBe(true);
    expect(masker.add('1234')).toBe(false);
    expect(masker.mask('pin 1234, 123')).toBe('pin #, 123');
  });
});

describe('the spellings of a secret', () => {
  const PASSWORD = 'Zorro "Azul" & 2026\\ ñ!';

  it('lists the plain, JSON, HTML, URL, form, base64 (three alignments), hex and base32 forms', () => {
    const spellings = secretSpellings(PASSWORD);
    expect(spellings).toEqual(
      expect.arrayContaining([
        PASSWORD,
        'Zorro \\"Azul\\" & 2026\\\\ ñ!',
        'Zorro \\"Azul\\" & 2026\\\\ \\u00f1!',
        'Zorro &quot;Azul&quot; &amp; 2026\\ ñ!',
        encodeURIComponent(PASSWORD),
        encodeURIComponent(PASSWORD).replace(/%20/g, '+'),
        Buffer.from(PASSWORD).toString('hex'),
        Buffer.from(PASSWORD).toString('hex').toUpperCase(),
      ]),
    );
    // The three byte alignments of base64 give three different needles (plus url-safe forms).
    const base64 = spellings.filter(
      (s) => /^[A-Za-z0-9+/]{12,}$/.test(s) && !/^[0-9a-f]+$/i.test(s),
    );
    expect(new Set(base64).size).toBeGreaterThanOrEqual(3);
    // Longest first, so a spelling that contains another is masked whole.
    expect(spellings.map((s) => s.length)).toEqual(
      [...spellings.map((s) => s.length)].sort((a, b) => b - a),
    );
  });

  it('masks every spelling in every layer that writes a file: one implementation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-eval-redact-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const registry = new SecretRegistry();
    registry.add(PASSWORD);
    const run = new RunSecrets();
    run.add(PASSWORD);
    const book = new SecretBook();
    book.add(PASSWORD);
    const sink = createDirectorySink(dir, [PASSWORD]);
    const layers: Record<string, (text: string) => string> = {
      'meter registry': (text) => registry.redact(text),
      'run (events, run.json, result.json, bench)': run.scrub,
      'typed secrets (net logs, transcripts)': (text) => book.mask(text),
      'answerer prompt': (text) =>
        buildAnswererMessages({
          persona: 'p',
          instructions: 'i',
          prompt: { kind: 'form', agent: 'a', title: 't', fields: [] } as never,
          dialogue: [{ from: 'procedure', text }],
          redact: [PASSWORD],
        })[1]!.content,
    };
    for (const [layer, scrub] of Object.entries(layers)) {
      for (const spelling of secretSpellings(PASSWORD)) {
        expect(scrub(`antes ${spelling} después`), `${layer}: ${spelling}`).not.toContain(spelling);
      }
    }
    // The answerer transcript (a JSON file) holds them masked as well, also the ones the model
    // quoted inside its own JSON.
    let n = 0;
    for (const spelling of [
      PASSWORD,
      JSON.stringify(PASSWORD).slice(1, -1),
      encodeURIComponent(PASSWORD),
      Buffer.from(PASSWORD).toString('base64'),
      Buffer.from(PASSWORD).toString('hex'),
    ]) {
      n++;
      void sink({
        n,
        attempt: 1,
        at: 'x',
        provider: 'mock',
        model: 'm',
        thinking: 'low',
        request: { system: spelling, messages: [] },
      });
      const written = readFileSync(join(dir, `${String(n).padStart(3, '0')}-1.json`), 'utf8');
      expect(written, spelling).not.toContain(JSON.stringify(spelling).slice(1, -1));
    }
  });
});

describe('what a recording keeps', () => {
  const USER_ID = 'user-AbCdEf0123456789xyz';
  const token = jwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-0123-4567-89ab',
      chatgpt_user_id: USER_ID,
      organizations: [{ id: 'org-Zz99Yy88', title: 'Personal' }],
    },
    'https://api.openai.com/profile': { email: 'dev.person@example.test' },
    sub: 'auth0|0123456789abcdef',
  });
  const registry = () => {
    const secrets = new SecretRegistry();
    secrets.addAuthorization(`Bearer ${token}`);
    return secrets;
  };

  it('blanks the account fields of the JSON in an SSE stream and in a plain body', () => {
    const sse = [
      'event: response.created',
      `data: {"type":"response.created","response":{"id":"resp_1","user":null,"safety_identifier":"${USER_ID}","metadata":{}}}`,
      '',
      `data: {"type":"response.completed","response":{"safety_identifier": "${USER_ID}","output":[{"type":"message","content":[{"text":"Hola"}]}]}}`,
      '',
    ].join('\n');
    const scrubbed = registry().scrubRecordedBody(sse);
    expect(scrubbed).not.toContain(USER_ID);
    expect(scrubbed).toContain('"safety_identifier":"[redacted-id]"');
    expect(scrubbed).toContain('"user":null');
    expect(scrubbed).toContain('"text":"Hola"');
    expect(new SecretRegistry().scrubRecordedBody('{"user":"someone","project":"p1","a":1}')).toBe(
      '{"user":"[redacted-id]","project":"[redacted-id]","a":1}',
    );
  });

  it('blanks the identifiers of the account in use wherever they appear, but not ordinary text', () => {
    const scrubbed = registry().scrubRecordedBody(
      JSON.stringify({
        text: `Tu cuenta es dev.person@example.test (acct-0123-4567-89ab, ${USER_ID}, org-Zz99Yy88)`,
        email: 'x@y.test',
      }),
    );
    for (const identity of [
      'dev.person@example.test',
      'acct-0123-4567-89ab',
      USER_ID,
      'org-Zz99Yy88',
      'auth0|0123456789abcdef',
    ]) {
      expect(scrubbed).not.toContain(identity);
    }
    expect(scrubbed).toContain('Tu cuenta es');
    // A response that quotes the identifiers is still recorded (scrubbed), not skipped like one
    // that quotes the key: the identifiers are not in the secrets' `has`.
    expect(registry().has(`x ${USER_ID} y`)).toBe(false);
    expect(registry().has(`x ${token} y`)).toBe(true);
  });

  it('leaves a model answer without account fields exactly as it is', () => {
    const body =
      'data: {"choices":[{"delta":{"content":"Hola, soy una respuesta {\\"user\\":\\"x\\"}"}}]}\n\n';
    expect(registry().scrubRecordedBody(body)).toBe(body);
  });

  it('drops the headers that describe the account or plan and keeps the replayable ones', () => {
    const kept = registry().scrubRecordedHeaders({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-litellm-response-cost': '0.0012',
      'x-litellm-key-spend': '1.5',
      'x-litellm-key-max-budget': '5',
      'x-codex-plan-type': 'plus',
      'x-codex-primary-used-percent': '12',
      'x-ratelimit-remaining-requests': '99',
      'openai-organization': 'org-Zz99Yy88',
      'openai-project': 'proj_1',
      'x-note': `for ${USER_ID}`,
    });
    expect(kept).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-litellm-response-cost': '0.0012',
      'x-note': 'for [redacted-id]',
    });
  });
});
