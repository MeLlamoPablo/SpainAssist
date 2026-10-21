import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILE_PREFIX } from '../src/service';
import type { CrlSetComponent } from '../src/types';
import { createTestService, page, startServer, type TestServer } from './helpers';

/**
 * `crlSet` seeds each launch's temporary profile with the app's CRLSet (README.md, "Revoked
 * certificates"). A local server can't show Chromium enforcing it (an untrusted test certificate
 * fails first), so these check the launch around it; the desktop app's live test checks a real
 * revoked site.
 */

const VERSION = '7777';
let server: TestServer;
let componentDir: string;

/** A CRLSet blocking nothing: a JSON header and no parents. */
function writeComponent(dir: string): void {
  const header = Buffer.from(
    JSON.stringify({
      Version: 0,
      ContentType: 'CRLSet',
      Sequence: Number(VERSION),
      DeltaFrom: 0,
      NumParents: 0,
      BlockedSPKIs: [],
    }),
  );
  const length = Buffer.alloc(2);
  length.writeUInt16LE(header.length);
  fs.writeFileSync(path.join(dir, 'crl-set'), Buffer.concat([length, header]));
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ manifest_version: 2, name: 'crl-set-test.data', version: VERSION }),
  );
}

function profiles(): Set<string> {
  return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(PROFILE_PREFIX)));
}

beforeAll(async () => {
  server = await startServer({ '/': page('<p>hola</p>', 'Inicio') });
  componentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-crlset-test-'));
  writeComponent(componentDir);
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(componentDir, { recursive: true, force: true });
});

describe('crlSet', () => {
  it('seeds a temporary profile, browses as usual and deletes the profile on close', async () => {
    const before = profiles();
    const component: CrlSetComponent = { version: VERSION, dir: componentDir };
    const t = createTestService({ crlSet: async () => component });
    try {
      const obs = await t.service.open('crl', `${server.origin}/`);
      expect(obs.title).toBe('Inicio');
      // A second session gets its own context of the same browser.
      const other = await t.service.open('crl-2', `${server.origin}/`);
      expect(other.title).toBe('Inicio');
      const created = [...profiles()].filter((name) => !before.has(name));
      expect(created).toHaveLength(1);
      const seeded = path.join(os.tmpdir(), created[0] as string, 'CertificateRevocation', VERSION);
      expect(fs.readdirSync(seeded).sort()).toEqual(['crl-set', 'manifest.json']);
    } finally {
      await t.cleanup();
    }
    // Deleted when the browser goes away (asynchronously, after `disconnected`).
    await expect.poll(() => [...profiles()].filter((name) => !before.has(name))).toEqual([]);
  });

  it('launches without a CRLSet when the app has none', async () => {
    const before = profiles();
    const t = createTestService({
      crlSet: async () => {
        throw new Error('offline');
      },
    });
    try {
      const obs = await t.service.open('no-crl', `${server.origin}/`);
      expect(obs.title).toBe('Inicio');
      expect([...profiles()].filter((name) => !before.has(name))).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });
});
