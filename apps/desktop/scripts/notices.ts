/**
 * Writes THIRD_PARTY_NOTICES.txt: the licence and notice files of every third-party component
 * the desktop app ships.
 *
 *   corepack pnpm --filter @sa/desktop notices [--out <file>]
 *
 * The package* scripts run it before electron-builder (scripts/package.mjs), which ships the file
 * and LICENSE outside the ASAR (electron-builder.ts).
 *
 * What ships:
 * - the app's `dependencies` (kept external and copied into the app by the packager);
 * - everything the build bundles: the runtime `devDependencies`, and the `dependencies` of the
 *   workspace packages (`@sa/*`, our own MIT code), all followed transitively;
 * - Electron, the bundled Instrument Serif font and the Go standard library in `sa-sidecar`.
 * Chromium's notices are Electron's own `LICENSES.chromium.html`.
 *
 * Fails, and writes nothing, when a licence isn't permissive: copyleft or proprietary code needs
 * a decision first (AGENTS.md, DECISIONS D16).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** devDependencies that build or test the app but aren't part of it (plus every `@types/*`). */
const BUILD_ONLY = new Set([
  '@sa/mock-sede',
  '@tailwindcss/vite',
  '@vitejs/plugin-react',
  'electron',
  'electron-builder',
  'electron-vite',
  'vite',
]);

/** SPDX ids that ask only for their notice to be kept. */
const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  // The PSF licence (argparse, via js-yaml in electron-updater): keep the notice, nothing more.
  'Python-2.0',
  'Unlicense',
  'Zlib',
  // Fonts: bundling them with software is allowed; only a modified font must stay OFL.
  'OFL-1.1',
]);

/** Packages that bundle another project's code without shipping its notice. */
const EMBEDDED: Record<string, Component> = {
  unpdf: {
    name: 'PDF.js (bundled in unpdf)',
    license: 'Apache-2.0',
    files: [
      {
        name: 'NOTICE',
        text: 'Copyright 2012 Mozilla Foundation. Licensed under the Apache License, Version 2.0 (its text is in this file). https://github.com/mozilla/pdf.js',
      },
    ],
  },
};

/** Licence and notice files at a package's top level. */
const NOTICE_FILE = /^(licen[cs]e|copying|notice|third[-_]?party[-_]?notices)([-._].*)?$/i;

export interface Component {
  name: string;
  version?: string;
  /** SPDX expression, as the package declares it ("UNKNOWN" when it doesn't). */
  license: string;
  author?: string;
  /** Licence and notice files, verbatim. */
  files: { name: string; text: string }[];
}

interface PackageJson {
  name: string;
  version: string;
  author?: string | { name: string };
  license?: string | { type: string };
  licenses?: { type: string }[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const readJson = (file: string): PackageJson => JSON.parse(readFileSync(file, 'utf8'));

/** Whether an SPDX expression (`MIT`, `(BSD-3-Clause OR GPL-2.0)`, `MIT AND ISC`) is permissive. */
export function isPermissive(expression: string): boolean {
  const tokens = expression.replace(/[()]/g, ' $& ').split(/\s+/).filter(Boolean);
  let i = 0;
  const atom = (): boolean => {
    const token = tokens[i++];
    if (token === '(') {
      const value = or();
      return tokens[i++] === ')' && value;
    }
    if (tokens[i] === 'WITH') i += 2;
    return token !== undefined && PERMISSIVE.has(token.replace(/\+$/, ''));
  };
  const and = (): boolean => {
    let value = atom();
    while (tokens[i] === 'AND') {
      i++;
      value = atom() && value;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (tokens[i] === 'OR') {
      i++;
      value = and() || value;
    }
    return value;
  };
  return or() && i === tokens.length;
}

/** For a choice between licences (`(BSD-3-Clause OR GPL-2.0)`), the permissive one we use. */
function chosenLicense(expression: string): string | undefined {
  const options = expression.replace(/^\((.*)\)$/, '$1').split(' OR ');
  return options.length > 1 ? options.find((option) => isPermissive(option)) : undefined;
}

function licenseOf(pkg: PackageJson): string {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (pkg.licenses?.length) return pkg.licenses.map((l) => l.type).join(' OR ');
  return 'UNKNOWN';
}

function authorOf(pkg: PackageJson): string | undefined {
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  return author?.replace(/\s*[<(].*$/, '').trim() || undefined;
}

function noticeFiles(dir: string): Component['files'] {
  return readdirSync(dir)
    .filter((name) => NOTICE_FILE.test(name) && statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8').trim() }));
}

/** Node's lookup: `<ancestor>/node_modules/<name>`, from the package's real directory up. */
function resolvePackage(fromDir: string, name: string): string | undefined {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name);
      if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

const isWorkspacePackage = (dir: string) => !dir.split(path.sep).includes('node_modules');

/** Every third-party npm package the app ships, sorted by name and version. */
export function collectPackages(appDir = APP_DIR): Component[] {
  const app = readJson(path.join(appDir, 'package.json'));
  const found = new Map<string, Component>();
  const visited = new Set<string>();
  const missing: string[] = [];

  const visit = (fromDir: string, name: string, required: boolean) => {
    const dir = resolvePackage(fromDir, name);
    if (!dir) {
      if (required) missing.push(`${name} (from ${path.relative(appDir, fromDir) || '.'})`);
      return;
    }
    if (visited.has(dir)) return;
    visited.add(dir);
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!isWorkspacePackage(dir)) {
      found.set(dir, {
        name: pkg.name,
        version: pkg.version,
        license: licenseOf(pkg),
        author: authorOf(pkg),
        files: noticeFiles(dir),
      });
      const embedded = EMBEDDED[pkg.name];
      if (embedded) found.set(`${dir}#embedded`, embedded);
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dir, dep, true);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dir, dep, false);
    for (const dep of Object.keys(pkg.peerDependencies ?? {})) {
      if (!pkg.peerDependenciesMeta?.[dep]?.optional) visit(dir, dep, false);
    }
  };

  const appDeps = Object.keys(app.dependencies ?? {});
  const bundled = Object.keys(app.devDependencies ?? {}).filter(
    (name) => !BUILD_ONLY.has(name) && !name.startsWith('@types/'),
  );
  for (const name of [...appDeps, ...bundled]) visit(appDir, name, true);
  if (missing.length) throw new Error(`Not installed: ${missing.join(', ')}`);

  return [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? ''),
  );
}

/** Electron itself, the bundled font and the Go standard library compiled into sa-sidecar. */
export function collectOthers(appDir = APP_DIR): Component[] {
  const electronDir = resolvePackage(appDir, 'electron');
  if (!electronDir) throw new Error('electron is not installed');
  const electron = readJson(path.join(electronDir, 'package.json'));
  const font = path.join(appDir, 'src/renderer/src/assets/brand/OFL.txt');
  const others: Component[] = [
    {
      name: 'electron',
      version: electron.version,
      license: licenseOf(electron),
      files: noticeFiles(electronDir),
    },
    {
      name: 'Instrument Serif (font)',
      license: 'OFL-1.1',
      files: [{ name: 'OFL.txt', text: readFileSync(font, 'utf8').trim() }],
    },
  ];
  const go = goLicense();
  if (go) {
    others.push({
      name: 'Go standard library (in sa-sidecar)',
      license: 'BSD-3-Clause',
      files: [go],
    });
  } else if (sidecarBuilt(appDir)) {
    throw new Error('sa-sidecar is built, but without Go its licence (BSD-3-Clause) is missing');
  }
  return others;
}

function goLicense(): Component['files'][number] | undefined {
  let goroot: string;
  try {
    goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
  // Homebrew keeps it one level above GOROOT.
  for (const file of [path.join(goroot, 'LICENSE'), path.join(goroot, '..', 'LICENSE')]) {
    if (existsSync(file)) return { name: 'LICENSE', text: readFileSync(file, 'utf8').trim() };
  }
  throw new Error(`Go's LICENSE is not in ${goroot}`);
}

function sidecarBuilt(appDir: string): boolean {
  const vendor = path.join(appDir, 'vendor');
  if (!existsSync(vendor)) return false;
  return readdirSync(vendor).some((dir) =>
    readdirSync(path.join(vendor, dir)).some((file) => file.startsWith('sa-sidecar')),
  );
}

/** The MIT permission text, from our own LICENSE: for MIT packages that ship no licence file. */
function mitText(appDir: string): string {
  const ours = readFileSync(path.join(appDir, '../../LICENSE'), 'utf8');
  return ours.slice(ours.indexOf('Permission is hereby granted')).trim();
}

function noticeText(component: Component, mit: string): string {
  if (component.files.length) return component.files.map((f) => f.text).join('\n\n');
  if (component.license === 'MIT') {
    return `MIT License\n\nCopyright (c) ${component.author ?? `the ${component.name} authors`}\n\n${mit}`;
  }
  return `The package ships no licence file. Its package.json declares ${component.license}${component.author ? `, by ${component.author}` : ''}.`;
}

const RULE = '-'.repeat(79);

/** The notices file: a summary, then each distinct licence text with the components under it. */
export function renderNotices(components: Component[], appDir = APP_DIR): string {
  const mit = mitText(appDir);
  const groups = new Map<string, Component[]>();
  for (const component of components) {
    const text = noticeText(component, mit);
    groups.set(text, [...(groups.get(text) ?? []), component]);
  }
  const counts = new Map<string, number>();
  for (const { license } of components) counts.set(license, (counts.get(license) ?? 0) + 1);

  const lines = [
    'Spain Assist: third-party notices',
    '',
    'Spain Assist is MIT-licensed (LICENSE). It includes the third-party software below, each',
    "under its own licence. Chromium's notices are in LICENSES.chromium.html, shipped with Electron.",
    '',
    `${components.length} components:`,
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([license, n]) => `  ${license}: ${n}`),
  ];
  for (const [text, members] of groups) {
    lines.push('', RULE, '');
    for (const c of members) {
      const chosen = chosenLicense(c.license);
      lines.push(
        `${c.name}${c.version ? `@${c.version}` : ''}: ${c.license}${chosen ? `, used under ${chosen}` : ''}`,
      );
    }
    lines.push('', text);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = path.resolve(
    outIndex >= 0 ? args[outIndex + 1]! : path.join(APP_DIR, 'THIRD_PARTY_NOTICES.txt'),
  );
  const components = [...collectPackages(), ...collectOthers()];
  const blocked = components.filter((c) => !isPermissive(c.license));
  if (blocked.length) {
    console.error(
      'notices: these licences are not permissive; decide on them first (DECISIONS D16):\n' +
        blocked.map((c) => `  ${c.name}@${c.version}: ${c.license}`).join('\n'),
    );
    process.exit(1);
  }
  writeFileSync(out, renderNotices(components));
  console.log(`notices: ${components.length} components in ${out}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
