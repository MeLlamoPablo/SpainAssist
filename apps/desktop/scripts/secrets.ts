/**
 * Fails when the desktop app would ship an Exa API key (DECISIONS D23): BYOK and custom-endpoint
 * research uses Exa's keyless tier, or the user's own key kept in their vault, so no build,
 * environment default or service config carries one.
 *
 *   corepack pnpm --filter @sa/desktop check:secrets
 *
 * It checks what electron-builder packs from this repo: the electron-vite build (`out/`) and the
 * agent host bundle (`packages/agent/dist`). `scripts/package.mjs` runs it before electron-builder;
 * `secrets.test.ts` runs the same rules on the repository's sources, so a key can't creep in
 * between releases either.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What electron-builder packs from this repo (electron-builder.ts `files`). */
export const SHIPPED_DIRS = [
  path.join(APP_DIR, 'out'),
  path.join(APP_DIR, '..', '..', 'packages', 'agent', 'dist'),
];

export interface Finding {
  file: string;
  rule: string;
  /** The matched text, with anything key-like masked. */
  excerpt: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const RULES: { rule: string; pattern: RegExp }[] = [
  {
    rule: 'EXA_API_KEY: the app never reads an Exa key from its environment or a .env file',
    pattern: /EXA_API_KEY/g,
  },
  {
    rule: 'a literal x-api-key header value (Exa authenticates with x-api-key)',
    pattern: /["']?x-api-key["']?\s*:\s*["'`](?!\$\{)[^"'`\s]{8,}["'`]/gi,
  },
  {
    rule: 'an Exa key in a URL',
    pattern: /exaApiKey=|(?:api|mcp)\.exa\.ai[^"'`\s]*[?&](?:api_?key|key|token)=/gi,
  },
];

/** A UUID (the shape of Exa keys) this close to an Exa mention counts as an embedded key. */
const EXA_NEAR = 300;

function mask(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{8,}/g, (m) =>
    m === 'EXA_API_KEY' || m.includes('exa') ? m : `${m.slice(0, 3)}…`,
  );
}

/** Embedded Exa keys, or the plumbing that would ship one, in one file's text. */
export function findEmbeddedExaKeys(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  for (const { rule, pattern } of RULES) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ file, rule, excerpt: mask(match[0]) });
    }
  }
  for (const match of text.matchAll(UUID)) {
    const at = match.index ?? 0;
    const around = text.slice(Math.max(0, at - EXA_NEAR), at + match[0].length + EXA_NEAR);
    if (/(?<![a-z])exa(?![a-z])/i.test(around)) {
      findings.push({ file, rule: 'a UUID (an Exa key) next to an Exa mention', excerpt: '…' });
    }
  }
  return findings;
}

/** Files whose text can carry a key: code, data, config and environment files. */
const TEXT_FILE =
  /\.(?:[cm]?[jt]sx?|json|html?|css|ya?ml|toml|tf|txt|properties|kts?|env(?:\..+)?)$|^\.env/i;

/** Every text file under `roots` (files or directories), skipping `skipDirs` (by name). */
export function listTextFiles(
  roots: readonly string[],
  skipDirs: ReadonlySet<string> = new Set(['node_modules']),
): string[] {
  const files: string[] = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) {
      for (const entry of readdirSync(p)) {
        if (!skipDirs.has(entry)) walk(path.join(p, entry));
      }
    } else if (TEXT_FILE.test(path.basename(p))) {
      files.push(p);
    }
  };
  for (const root of roots) walk(root);
  return files;
}

/** Checks files; a shipped `.env` file is a finding on its own. */
export function scanFiles(files: readonly string[]): Finding[] {
  return files.flatMap((file) => {
    const found = findEmbeddedExaKeys(readFileSync(file, 'utf8'), file);
    if (/^\.env/.test(path.basename(file)) && !file.endsWith('.example')) {
      found.push({ file, rule: 'a .env file in the app', excerpt: path.basename(file) });
    }
    return found;
  });
}

function main(): void {
  const missing = SHIPPED_DIRS.filter((dir) => !existsSync(dir));
  if (missing.length > 0) {
    console.error(
      `Build the app first (corepack pnpm --filter @sa/desktop build): ${missing.join(', ')}`,
    );
    process.exit(1);
  }
  const files = listTextFiles(SHIPPED_DIRS);
  const findings = scanFiles(files);
  if (findings.length > 0) {
    console.error('The app would ship an Exa API key (DECISIONS D23). Remove it:');
    for (const f of findings) {
      console.error(`  ${path.relative(process.cwd(), f.file)}: ${f.rule} (${f.excerpt})`);
    }
    process.exit(1);
  }
  console.log(`No embedded Exa key in ${files.length} shipped files.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
