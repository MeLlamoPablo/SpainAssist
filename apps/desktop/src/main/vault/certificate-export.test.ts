import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDemoIdentity } from '@sa/mock-sede';
import { createTestKeyProvider, readPkcs12, Vault } from '@sa/vault';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import { t } from '../core/i18n';
import { createLogger } from '../core/logger';
import type { Biometric } from '../ports';
import { createTestApp, type TestApp } from '../testing/harness';
import type { SavePathRequest } from './certificate-export';
import { VaultService } from './service';

const PASSWORD = 'Contraseña-ñ 1';
const unixModes = process.platform !== 'win32';

const dirs: string[] = [];
/** The app of the running test, closed after it. */
let current: TestApp | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sa-export-test-'));
  dirs.push(dir);
  return dir;
}

/** Touch ID that answers `ok` and records each reason. */
function touchId(ok = true): Biometric & { reasons: string[] } {
  const reasons: string[] = [];
  return {
    reasons,
    available: () => true,
    prompt: async (reason) => {
      reasons.push(reason);
      return ok;
    },
  };
}

describe('exporting a certificate from Mis datos', () => {
  it('asks for Touch ID, then where to save, and writes a .p12 that opens with the new password', async () => {
    const dir = await tempDir();
    const vault = await Vault.open(join(dir, 'vault'), createTestKeyProvider('export'));
    const demo = loadDemoIdentity();
    const credential = await vault.addCertificate({
      fileName: 'demo.p12',
      p12: demo.p12,
      passphrase: demo.passphrase,
    });
    const target = join(dir, 'Escritorio', 'mi certificado.p12');
    await mkdir(join(dir, 'Escritorio'));
    const requests: SavePathRequest[] = [];
    const biometric = touchId();
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sinks: [(line) => lines.push(line)] });
    const service = new VaultService({
      vault,
      events: new EventBus(),
      logger,
      biometric,
      tmpDir: join(dir, 'tmp'),
      downloadsDir: join(dir, 'Downloads'),
      openPath: async () => '',
      lang: () => 'es',
      dniePhone: true,
      chooseSavePath: async (request) => {
        requests.push(request);
        // Touch ID came first.
        expect(biometric.reasons).toHaveLength(1);
        return target;
      },
    });

    expect(await service.exportCertificate(credential.id, PASSWORD)).toBe('mi certificado.p12');
    expect(biometric.reasons).toEqual(['exportar tu certificado digital']);
    const holder = credential.certificate?.holderName;
    expect(holder).toBeTruthy();
    expect(requests).toEqual([
      {
        title: 'Exportar certificado',
        defaultPath: join(dir, 'Downloads', `Certificado ${holder}.p12`),
        buttonLabel: 'Exportar',
        filters: [{ name: 'Certificado digital (.p12)', extensions: ['p12', 'pfx'] }],
      },
    ]);

    if (unixModes) expect((await stat(target)).mode & 0o777).toBe(0o600);
    const contents = await readPkcs12(await readFile(target), PASSWORD);
    expect(contents.certificate.raw.equals(demo.certDer)).toBe(true);
    expect(contents.chain).toHaveLength(demo.chainPem.length);

    // The password is a secret for the logger from then on.
    logger.info('probe', { value: PASSWORD });
    expect(lines.join('\n')).not.toContain(PASSWORD);
    expect(lines.join('\n')).toContain('certificate exported');
  });

  describe('through IPC', () => {
    async function withCertificate(opts: Parameters<typeof createTestApp>[0] = {}) {
      const app = await createTestApp(opts);
      current = app;
      const cert = await app.invoke('vault.addCertificate', {
        fileName: 'a.p12',
        bytes: new Uint8Array([1, 2, 3]),
        passphrase: 'pw',
      });
      return { app, cert };
    }

    it('replaces the file the user chose to overwrite, private to the user', async () => {
      const dir = await tempDir();
      const target = join(dir, 'Certificado.p12');
      await writeFile(target, 'old', { mode: 0o644 });
      const { app, cert } = await withCertificate({ chooseSavePath: async () => target });

      expect(await app.invoke('vault.exportCertificate', cert.id, PASSWORD)).toBe(
        'Certificado.p12',
      );
      expect((await readFile(target)).toString()).toBe(`exported:${PASSWORD}:\u0001\u0002\u0003`);
      if (unixModes) expect((await stat(target)).mode & 0o777).toBe(0o600);
    });

    it('writes nothing when the user cancels Touch ID or the save dialog', async () => {
      const dir = await tempDir();
      let asked = 0;
      const refused = touchId(false);
      const first = await withCertificate({
        biometric: refused,
        chooseSavePath: async () => {
          asked++;
          return join(dir, 'a.p12');
        },
      });
      expect(await first.app.invoke('vault.exportCertificate', first.cert.id, PASSWORD)).toBeNull();
      expect(refused.reasons).toHaveLength(1);
      expect(asked).toBe(0);
      await first.app.close();

      const second = await withCertificate({ chooseSavePath: async () => undefined });
      expect(
        await second.app.invoke('vault.exportCertificate', second.cert.id, PASSWORD),
      ).toBeNull();
      expect(existsSync(join(dir, 'a.p12'))).toBe(false);
    });

    it('refuses short passwords, other credentials and a missing save dialog', async () => {
      const biometric = touchId();
      const { app, cert } = await withCertificate({
        biometric,
        chooseSavePath: async () => {
          throw new Error('no dialog expected');
        },
      });
      await expect(app.invoke('vault.exportCertificate', cert.id, '1234567')).rejects.toMatchObject(
        { code: 'bad_request' },
      );
      const clave = await app.invoke('vault.addClave', { username: '12345678Z', password: 'pw' });
      await expect(app.invoke('vault.exportCertificate', clave.id, PASSWORD)).rejects.toThrow(
        t('es', 'vaultNotFound'),
      );
      expect(biometric.reasons).toEqual([]);
      expect(app.logLines.join('\n')).not.toContain('1234567');
      await app.close();

      const headless = await withCertificate();
      await expect(
        headless.app.invoke('vault.exportCertificate', headless.cert.id, PASSWORD),
      ).rejects.toMatchObject({ code: 'unavailable' });
    });
  });
});
