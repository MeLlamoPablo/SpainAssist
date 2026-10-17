import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HeadlessApp } from '@sa/desktop/headless';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyProfile,
  isEmptyDirectory,
  profileDirOf,
  seedVault,
} from '../../../src/run/app/profile';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sa-profile-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, text = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

describe('copyProfile', () => {
  it('copies the state of a profile and leaves out what is not', async () => {
    const from = join(root, 'from');
    for (const file of [
      'settings.json',
      'state.json',
      'vault/vault.bin',
      'vault/documents/d.bin',
      'assistant/session.jsonl',
      'procedures/p_1/procedure.json',
      'procedures/p_1/logs-of-the-procedure.txt',
      'logs/main.log',
      'downloads/kept/dl_1',
      'scanner/conversations/c.json',
      'exported-downloads/informe.pdf',
    ]) {
      write(join(from, file), file);
    }
    const to = join(root, 'to');
    write(join(to, 'old.txt'));
    await copyProfile(from, to);
    for (const kept of [
      'settings.json',
      'state.json',
      'vault/vault.bin',
      'vault/documents/d.bin',
      'assistant/session.jsonl',
      'procedures/p_1/procedure.json',
      'procedures/p_1/logs-of-the-procedure.txt',
    ]) {
      expect(readFileSync(join(to, kept), 'utf8'), kept).toBe(kept);
    }
    for (const left of ['logs', 'downloads', 'scanner', 'exported-downloads', 'old.txt']) {
      expect(existsSync(join(to, left)), left).toBe(false);
    }
  });

  it('says when there is nothing to copy', async () => {
    await expect(copyProfile(join(root, 'missing'), join(root, 'to'))).rejects.toThrow(
      /does not exist/,
    );
  });

  it('knows an empty directory, and one that is not there', () => {
    expect(isEmptyDirectory(join(root, 'missing'))).toBe(true);
    mkdirSync(join(root, 'empty'));
    expect(isEmptyDirectory(join(root, 'empty'))).toBe(true);
    write(join(root, 'full', 'a'));
    expect(isEmptyDirectory(join(root, 'full'))).toBe(false);
    expect(profileDirOf('/runs/r1')).toBe('/runs/r1/profile');
  });
});

describe('seedVault', () => {
  function app() {
    const calls: unknown[][] = [];
    const fake = {
      invoke: async (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    };
    return { fake: fake as unknown as HeadlessApp, calls };
  }

  it('saves the personal data and the credentials through the renderer API, registering passwords first', async () => {
    const { fake, calls } = app();
    const registered: string[] = [];
    await seedVault(
      fake,
      {
        personal: { givenName: 'Lucía', 'custom.numero-socio': '42' },
        claves: [
          { username: '53918274H', password: 'Contraseña-1', label: 'Cl@ve Permanente' },
          { username: '12345678Z', password: 'Contraseña-2' },
        ],
      },
      (password) => {
        registered.push(password);
        expect(calls.filter((c) => c[0] === 'vault.addClave')).toHaveLength(registered.length - 1);
      },
    );
    expect(registered).toEqual(['Contraseña-1', 'Contraseña-2']);
    expect(calls).toEqual([
      [
        'vault.setPersonal',
        [
          { key: 'givenName', value: 'Lucía' },
          { key: 'custom.numero-socio', value: '42', label: 'Numero socio' },
        ],
      ],
      [
        'vault.addClave',
        { username: '53918274H', password: 'Contraseña-1', label: 'Cl@ve Permanente' },
      ],
      ['vault.addClave', { username: '12345678Z', password: 'Contraseña-2' }],
    ]);
  });

  it('does nothing for a fixture with no saved data', async () => {
    const { fake, calls } = app();
    await seedVault(fake, undefined, () => {
      throw new Error('no password to register');
    });
    await seedVault(fake, { personal: {}, claves: [] }, () => {});
    expect(calls).toEqual([]);
  });
});
