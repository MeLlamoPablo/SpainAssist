import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/logger';
import { createTestApp, type TestApp } from '../testing/harness';
import {
  createSafeStorageKeyProvider,
  createTouchIdBiometric,
  type SafeStorageLike,
} from './keyProvider';

function fakeSafeStorage(available = true): SafeStorageLike & { plain: boolean; backend: string } {
  const store = {
    plain: false,
    backend: 'gnome_libsecret',
    async isAsyncEncryptionAvailable() {
      return available || store.plain;
    },
    async encryptStringAsync(s: string) {
      return Buffer.from(`enc:${Buffer.from(s).toString('hex')}`);
    },
    async decryptStringAsync(b: Buffer) {
      return {
        result: Buffer.from(b.toString().slice(4), 'hex').toString(),
        shouldReEncrypt: false,
      };
    },
    getSelectedStorageBackend() {
      return store.plain ? 'basic_text' : store.backend;
    },
    setUsePlainTextEncryption(v: boolean) {
      store.plain = v;
    },
  };
  return store;
}

describe('safeStorage KeyProvider', () => {
  it('wraps the data key with the async API and labels the OS backend', async () => {
    const kp = await createSafeStorageKeyProvider(fakeSafeStorage(), 'darwin', silentLogger);
    expect(kp).toMatchObject({ backend: 'macOS Keychain', secure: true });
    const key = randomBytes(32);
    const wrapped = await kp.encrypt(key);
    expect(wrapped.equals(key)).toBe(false);
    expect((await kp.decrypt(wrapped)).equals(key)).toBe(true);
    expect(
      (await createSafeStorageKeyProvider(fakeSafeStorage(), 'win32', silentLogger)).backend,
    ).toBe('Windows DPAPI');
    expect(
      await createSafeStorageKeyProvider(fakeSafeStorage(), 'linux', silentLogger),
    ).toMatchObject({
      backend: 'libsecret',
      secure: true,
    });
  });

  it('falls back to basic_text on Linux without a keyring, flagged as insecure', async () => {
    const storage = fakeSafeStorage(false);
    const kp = await createSafeStorageKeyProvider(storage, 'linux', silentLogger);
    expect(storage.plain).toBe(true);
    expect(kp).toMatchObject({ backend: 'basic_text', secure: false });
  });

  it('fails when the OS offers no encryption', async () => {
    await expect(
      createSafeStorageKeyProvider(fakeSafeStorage(false), 'darwin', silentLogger),
    ).rejects.toThrow(/not available/);
  });
});

describe('Touch ID', () => {
  it('prompts on macOS when available and reports failures', async () => {
    let fail = false;
    const prefs = {
      canPromptTouchID: () => true,
      promptTouchID: async () => {
        if (fail) throw new Error('cancelled');
      },
    };
    const bio = createTouchIdBiometric(prefs, 'darwin', silentLogger);
    expect(bio.available()).toBe(true);
    expect(await bio.prompt('usar tu Cl@ve')).toBe(true);
    fail = true;
    expect(await bio.prompt('usar tu Cl@ve')).toBe(false);
    const linux = createTouchIdBiometric(prefs, 'linux', silentLogger);
    expect(linux.available()).toBe(false);
    expect(await linux.prompt('x')).toBe(true);
  });
});

describe('browser wiring', () => {
  let app: TestApp | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await app?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    app = undefined;
    dir = undefined;
  });

  it('keeps downloads out of the vault until the agent saves them', async () => {
    app = await createTestApp();
    const { procedureId } = await app.procedureWithToken();
    dir = await mkdtemp(join(tmpdir(), 'sa-dl-'));
    const file = join(dir, 'tmp-download');
    await writeFile(file, '%PDF-1.7');
    const res = await app.services.browser.onDownload(procedureId, {
      path: file,
      suggestedName: 'Justificante_registro.pdf',
      mimeType: 'application/pdf',
    });
    expect(res).toEqual({
      downloadId: expect.any(String),
      name: 'Justificante_registro.pdf',
      mimeType: 'application/pdf',
    });
    expect(app.vault.listDocuments()).toEqual([]);
    expect(app.services.procedures.transcript(procedureId).at(-1)?.type).not.toBe('notice');

    const doc = await app.services.browser.saveDownload(
      procedureId,
      res.downloadId,
      'Justificante de registro - Empadronamiento',
    );
    expect(doc).toMatchObject({
      name: 'Justificante de registro - Empadronamiento.pdf',
      source: 'download',
      procedureId,
    });
    expect(app.services.browser.downloads.get(procedureId, res.downloadId)).toBeUndefined();
  });

  it("saves a download under a name that's a valid file name on Windows too", async () => {
    app = await createTestApp();
    const { procedureId } = await app.procedureWithToken();
    dir = await mkdtemp(join(tmpdir(), 'sa-dl-'));
    const saved: string[] = [];
    for (const title of [
      'Informe de vida laboral - 2026-10-12',
      'Justificante.pdf',
      'Recibo 2026/10',
      'Cita: DNI?',
      'CON',
      'Lpt1 ',
    ]) {
      const file = join(dir, randomBytes(4).toString('hex'));
      await writeFile(file, '%PDF-1.7');
      const download = await app.services.browser.onDownload(procedureId, {
        path: file,
        suggestedName: 'justificante.pdf',
        mimeType: 'application/pdf',
      });
      const doc = await app.services.browser.saveDownload(procedureId, download.downloadId, title);
      saved.push(doc?.name ?? '');
    }
    expect(saved).toEqual([
      'Informe de vida laboral - 2026-10-12.pdf',
      'Justificante.pdf',
      'Recibo 2026-10.pdf',
      'Cita_ DNI_.pdf',
      '_CON.pdf',
      '_Lpt1.pdf',
    ]);
  });

  it('deleting a credential closes contexts holding its certificate and permits a fresh browser', async () => {
    app = await createTestApp();
    const { procedureId } = await app.procedureWithToken();
    const certificate = await app.invoke('vault.addCertificate', {
      fileName: 'test.p12',
      bytes: new Uint8Array([1, 2, 3]),
      passphrase: 'test',
    });
    const browser = app.services.browser.get();
    await browser.open(procedureId, 'https://mock.invalid');
    await browser.useClientCertificate(procedureId, {
      origins: ['https://mock.invalid'],
      identity: {
        id: certificate.id,
        chain: [],
        key: { prepare: async () => {}, sign: async () => Buffer.alloc(0) },
      },
    });
    expect(app.browser.certificates).toHaveLength(1);
    await app.invoke('vault.deleteCredential', certificate.id);
    expect(app.vault.getCredential(certificate.id)).toBeUndefined();
    expect(app.services.browser.current()).toBeUndefined();
    expect(app.browser.certificates).toEqual([]);
    expect(app.browser.isOpen(procedureId)).toBe(false);
    await app.services.browser.get().open(procedureId, 'https://mock.invalid');
    expect(app.browser.isOpen(procedureId)).toBe(true);
    expect(app.browser.certificates).toEqual([]);
  });

  it('asks before signing, lets the user pick a certificate, and returns it only on approval', async () => {
    app = await createTestApp();
    const { procedureId } = await app.procedureWithToken();
    const summary = {
      method: 'sign',
      format: 'CAdES',
      algorithm: 'SHA256withRSA',
      origin: 'https://sede.example.gob.es',
      description: 'solicitud.pdf',
      dataSize: 2048,
      dataSha256: 'ab'.repeat(32),
      documents: [],
      verifiable: false,
    };
    // No certificate: a notice, no signature.
    expect(await app.services.browser.approveSignature(procedureId, summary)).toBeNull();
    expect(app.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
      type: 'notice',
      level: 'warning',
    });

    const a = await app.vault.addCertificate({
      fileName: 'a.p12',
      p12: Buffer.from('AAA'),
      passphrase: 'pa',
    });
    const b = await app.vault.addCertificate({
      fileName: 'b.p12',
      p12: Buffer.from('BBB'),
      passphrase: 'pb',
    });
    const approval = app.services.browser.approveSignature(procedureId, summary);
    await app.waitFor(() => !!app!.pendingPrompt(procedureId));
    const pick = app.pendingPrompt(procedureId)!;
    expect(pick.prompt).toMatchObject({ kind: 'form', fields: [{ type: 'select' }] });
    await app.invoke('chat.respond', pick.id, {
      kind: 'form',
      values: { certificate: b.id },
      dismissed: false,
      savedToVault: [],
    });
    await app.waitFor(() => app!.pendingPrompt(procedureId)?.prompt.kind === 'confirm');
    const confirm = app.pendingPrompt(procedureId)!;
    expect(confirm.prompt).toMatchObject({ kind: 'confirm', confirmKind: 'signature' });
    const details = confirm.prompt.kind === 'confirm' ? confirm.prompt.details : [];
    expect(details?.map((d) => d.value)).toContain('sede.example.gob.es');
    expect(details?.map((d) => d.value)).toContain('2.0 KB');
    await app.invoke('chat.respond', confirm.id, { kind: 'confirm', approved: true });
    const cert = await approval;
    expect(cert).toEqual({
      kind: 'p12',
      credentialId: b.id,
      p12: Buffer.from('BBB'),
      passphrase: 'pb',
    });
    expect(app.vault.getCredential(b.id)?.lastUsedAt).toBeDefined();
    expect(app.vault.getCredential(a.id)?.lastUsedAt).toBeUndefined();

    // Declined -> null; aborted -> null.
    await app.vault.deleteCredential(a.id);
    const declined = app.services.browser.approveSignature(procedureId, summary);
    await app.waitFor(() => !!app!.pendingPrompt(procedureId));
    await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
      kind: 'confirm',
      approved: false,
    });
    expect(await declined).toBeNull();
    const aborted = app.services.browser.approveSignature(procedureId, summary);
    await app.waitFor(() => !!app!.pendingPrompt(procedureId));
    await app.invoke('procedures.stop', procedureId);
    expect(await aborted).toBeNull();
  });
});

/** Routes the app's personal data saves and overview through a real encrypted vault. */
async function routeToRealVault(app: TestApp): Promise<void> {
  const realVault = await Vault.open(
    join(app.paths.userData, 'partial-vault'),
    createTestKeyProvider('partial'),
  );
  vi.spyOn(app.vault, 'setPersonal').mockImplementation((items, source) =>
    realVault.setPersonal(items, source),
  );
  vi.spyOn(app.vault, 'overview').mockImplementation((opts) => realVault.overview(opts));
}

describe('personal data failure diagnostics', () => {
  it.each([
    ['passportSupportNumber', 'PRIVATE-PASSPORT', 'unknown_field', 'passportSupportNumber'],
    ['passportExpiry', 'PRIVATE-DATE', 'invalid_date', 'passportExpiry'],
    ['sex', 'PRIVATE-SEX', 'invalid_option', 'sex'],
    ['custom.private_field', 'PRIVATE-VALUE', 'label_required', 'custom'],
    ['PRIVATE-FIELD', 'PRIVATE-VALUE', 'invalid_key', undefined],
  ])(
    'logs a safe reason for rejected %s input before localizing it',
    async (key, value, reason, field) => {
      const app = await createTestApp();
      try {
        const realVault = await Vault.open(
          join(app.paths.userData, 'diagnostic-vault'),
          createTestKeyProvider('diagnostics'),
        );
        vi.spyOn(app.vault, 'setPersonal').mockImplementation((items) =>
          realVault.setPersonal(items, 'manual'),
        );
        await expect(
          app.services.vault.setPersonal([{ key: key!, value: value! }]),
        ).rejects.toMatchObject({
          code: 'invalid_input',
          message: 'Hay datos que no son válidos.',
        });
        const line = app.logLines.find((line) => line.includes('vault personal data save failed'))!;
        expect(line).toBeDefined();
        const diagnostic = JSON.parse(line.slice(line.indexOf('{')));
        expect(diagnostic).toEqual({
          failureCode: 'invalid_input',
          reason,
          ...(field ? { field } : {}),
        });
        expect(line).not.toContain('PRIVATE');
        expect(line).not.toContain('private_field');
      } finally {
        await app.close();
      }
    },
  );

  it('saves the valid items of a partial save and reports the rejected ones', async () => {
    const app = await createTestApp();
    try {
      await routeToRealVault(app);
      const result = await app.invoke('vault.setPersonalPartial', [
        { key: 'givenName', value: 'Lucía' },
        { key: 'custom.private_note', value: 'PRIVATE-VALUE' },
        { key: 'passportExpiry', value: 'PRIVATE-DATE' },
        { key: 'passportIssuingAuthority', value: 'Madrid' },
      ]);
      expect(result.rejected).toEqual([
        { key: 'custom.private_note', reason: 'label_required' },
        { key: 'passportExpiry', reason: 'invalid_date' },
      ]);
      expect(result.overview.personal.map((item) => item.key).sort()).toEqual([
        'givenName',
        'passportIssuingAuthority',
      ]);
      const lines = app.logLines.filter((line) =>
        line.includes('vault personal data item rejected'),
      );
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('"field":"custom"');
      expect(lines[1]).toContain('"field":"passportExpiry"');
      expect(lines.join('\n')).not.toMatch(/PRIVATE|private_note/);
    } finally {
      await app.close();
    }
  });

  it('saves document scan fields with the scan source', async () => {
    const app = await createTestApp();
    try {
      await routeToRealVault(app);
      const result = await app.invoke('vault.setPersonalPartial', [
        { key: 'givenName', value: 'Lucía' },
        { key: 'dniNumber', value: '12345678Z' },
      ]);
      expect(result.overview.personal.map((item) => item.source)).toEqual(['scan', 'scan']);
    } finally {
      await app.close();
    }
  });

  it('does not log raw unexpected errors from the vault', async () => {
    const app = await createTestApp();
    try {
      vi.spyOn(app.vault, 'setPersonal').mockRejectedValue(new Error('PRIVATE raw failure'));
      await expect(app.services.vault.setPersonal([])).rejects.toThrow();
      const line = app.logLines.find((line) => line.includes('vault personal data save failed'))!;
      expect(line).toContain('unexpected_error');
      expect(line).not.toContain('PRIVATE');
      expect(line).not.toContain('private_field');
    } finally {
      await app.close();
    }
  });
});
