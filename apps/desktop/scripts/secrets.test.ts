import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findEmbeddedExaKeys, listTextFiles, scanFiles } from './secrets';

// Assembled at run time, so this file never holds a key-shaped literal itself.
const FAKE_KEY = ['0123abcd', '4567', '89ab', 'cdef', '0123456789ab'].join('-');
const ENV_NAME = ['EXA', 'API', 'KEY'].join('_');

const rules = (text: string) => findEmbeddedExaKeys(text, 'f.js').map((f) => f.rule);

describe('findEmbeddedExaKeys', () => {
  it.each([
    ['an environment default', `const key = process.env.${ENV_NAME} ?? '';`],
    ['a .env line', `${ENV_NAME}=${FAKE_KEY}`],
    ['a literal header', `headers: { 'x-api-key': 'sk-${FAKE_KEY}' }`],
    ['a minified literal header', `{"x-api-key":"${FAKE_KEY}"}`],
    ['a key in a URL', `fetch("https://api.exa.ai/search?apiKey=${FAKE_KEY}")`],
    ["a key in the MCP server's URL", `fetch("https://mcp.exa.ai/mcp?tools=x&key=${FAKE_KEY}")`],
    ['a UUID next to Exa', `const exa = { url: "https://api.exa.ai", k: "${FAKE_KEY}" };`],
  ])('catches %s', (_name, text) => {
    expect(rules(text).length).toBeGreaterThan(0);
  });

  it.each([
    ['the key read at call time', `headers: { 'x-api-key': key, 'content-type': 'json' }`],
    ['a minified variable header', '{"x-api-key":e,"content-type":"application/json"}'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text with a template literal
    ['a template header', 'headers: { "x-api-key": `${apiKey}` }'],
    ['the official endpoint', "export const EXA_API_URL = 'https://api.exa.ai';"],
    ['the keyless MCP endpoint', "const url = 'https://mcp.exa.ai/mcp?tools=web_fetch_exa';"],
    ['an unrelated UUID', `const run = "${FAKE_KEY}";`],
  ])('allows %s', (_name, text) => {
    expect(rules(text)).toEqual([]);
  });

  it('never prints the key it found', () => {
    const [finding] = findEmbeddedExaKeys(`{"x-api-key":"${FAKE_KEY}"}`, 'f.js');
    expect(finding?.excerpt).not.toContain(FAKE_KEY);
  });
});

describe('scanFiles', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('flags a shipped .env file and keys in nested files, and skips node_modules', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sa-secrets-'));
    mkdirSync(path.join(dir, 'main'));
    mkdirSync(path.join(dir, 'node_modules'));
    writeFileSync(path.join(dir, '.env'), 'OTHER=1\n');
    writeFileSync(path.join(dir, 'main', 'index.js'), `x={"x-api-key":"${FAKE_KEY}"}`);
    writeFileSync(path.join(dir, 'node_modules', 'lib.js'), `${ENV_NAME}=1`);
    writeFileSync(path.join(dir, 'logo.png'), `${ENV_NAME}=1`);
    const findings = scanFiles(listTextFiles([dir]));
    expect(findings.map((f) => path.relative(dir!, f.file)).sort()).toEqual([
      '.env',
      path.join('main', 'index.js'),
    ]);
  });
});

/**
 * The same rules on the repository: the app, its packages and services, CI and infrastructure
 * (not docs, which describe the old development key, and not tests, which hold fakes).
 */
describe('the repository', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const self = new Set(['secrets.ts', 'secrets.test.ts']);

  it('carries no Exa key, Exa key default or keyless Exa endpoint', () => {
    const files = listTextFiles(
      ['apps', 'packages', 'services', 'tools', 'e2e', 'infra', '.github'].map((d) =>
        path.join(root, d),
      ),
      new Set(['node_modules', 'dist', 'out', 'build', '.gradle', 'test', 'fixtures', '.git']),
    ).filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file) && !self.has(path.basename(file)));
    expect(files.length).toBeGreaterThan(100);
    expect(
      scanFiles(files)
        // The developer's own, git-ignored .env files are not part of the repository.
        .filter((f) => f.rule !== 'a .env file in the app')
        .map((f) => `${path.relative(root, f.file)}: ${f.rule}`),
    ).toEqual([]);
  });
});
