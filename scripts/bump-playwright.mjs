#!/usr/bin/env node
// Sets playwright-core (and the Playwright packages that must match it) to one version in every
// workspace package.json, keeping each range's prefix (`^1.63.0` stays a caret range). The app's
// Chromium revision comes from playwright-core's browsers.json, so this is how it gets updated
// (.github/workflows/browser-update.yml). Run `corepack pnpm install` afterwards for the lockfile.
//
//   node scripts/bump-playwright.mjs 1.64.0
//
// Prints the version that apps/desktop pinned before the bump.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = ['playwright-core', 'playwright', '@playwright/test'];
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: node scripts/bump-playwright.mjs <x.y.z>');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The globs of pnpm-workspace.yaml.
const dirs = ['e2e'];
for (const group of ['apps', 'packages', 'services', 'tools']) {
  for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(join(group, entry.name));
  }
}

let previous;
for (const dir of dirs) {
  const file = join(root, dir, 'package.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  // Edit the text, not a re-serialized object, so the file's formatting stays as it is.
  const pkg = JSON.parse(text);
  let next = text;
  for (const section of SECTIONS) {
    for (const name of PACKAGES) {
      const range = pkg[section]?.[name];
      if (!range) continue;
      const match = /^([~^]?)(\d+\.\d+\.\d+)$/.exec(range);
      if (!match) throw new Error(`${dir}: unexpected ${name} range ${range}`);
      if (dir === 'apps/desktop' && name === 'playwright-core') previous = match[2];
      next = next.replace(
        `${JSON.stringify(name)}: ${JSON.stringify(range)}`,
        () => `${JSON.stringify(name)}: "${match[1]}${version}"`,
      );
    }
  }
  if (next !== text) {
    writeFileSync(file, next);
    console.error(`Updated ${dir}/package.json`);
  }
}
if (!previous) throw new Error('apps/desktop does not pin playwright-core');
console.log(previous);
