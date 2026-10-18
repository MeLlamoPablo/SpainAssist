import { describe, expect, it } from 'vitest';
import { collectOthers, collectPackages, isPermissive, renderNotices } from './notices';

describe('isPermissive', () => {
  it.each([
    ['MIT', true],
    ['(BSD-3-Clause OR GPL-2.0)', true],
    ['(MIT AND Zlib)', true],
    ['Apache-2.0 WITH LLVM-exception', true],
    ['GPL-2.0', false],
    ['(MIT AND GPL-3.0-only)', false],
    ['LGPL-2.1-or-later', false],
    ['MPL-2.0', false],
    ['SEE LICENSE IN LICENSE.md', false],
    ['UNKNOWN', false],
  ])('%s: %s', (expression, expected) => {
    expect(isPermissive(expression)).toBe(expected);
  });
});

describe('the desktop app’s third-party components', () => {
  const packages = collectPackages();

  it('are the external, bundled and workspace dependencies, not the build tools', () => {
    const names = new Set(packages.map((p) => p.name));
    for (const name of [
      '@earendil-works/pi-coding-agent',
      'playwright-core',
      'react',
      'node-forge',
      'unpdf',
    ]) {
      expect(names).toContain(name);
    }
    for (const name of ['electron-vite', 'vite', 'vitest', '@sa/shared', '@sa/mock-sede']) {
      expect(names).not.toContain(name);
    }
  });

  // AGENTS.md: no copyleft or proprietary dependency without a decision.
  it('have permissive licences', () => {
    expect(
      packages.filter((p) => !isPermissive(p.license)).map((p) => `${p.name}: ${p.license}`),
    ).toEqual([]);
  });

  it('all get a notice', () => {
    const others = collectOthers();
    const text = renderNotices([...packages, ...others]);
    for (const c of [...packages, ...others])
      expect(text).toContain(`${c.name}${c.version ? `@${c.version}` : ''}: `);
    expect(text).toMatch(
      /node-forge@[\d.]+: \(BSD-3-Clause OR GPL-2\.0\), used under BSD-3-Clause/,
    );
    expect(text).toContain('PDF.js (bundled in unpdf): Apache-2.0');
    expect(text).toContain('Instrument Serif (font): OFL-1.1');
    expect(text).toMatch(/Chrome for Testing .*@\d+\.\d+\.\d+\.\d+: LicenseRef-Chrome-for-Testing/);
  });
});
