import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type SaMethod } from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppPaths } from '../app/paths';
import { t } from '../core/i18n';
import { APP_PAGE, createTestApp, type TestApp } from '../testing/harness';
import { SA_ARG_SCHEMAS } from './schemas';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  await app.close();
});

describe('IPC router', () => {
  it('registers a handler and a schema for every SaMethods method', () => {
    expect(app.services.router.methods().sort()).toEqual(Object.keys(SA_ARG_SCHEMAS).sort());
  });

  it('refuses untrusted senders (other origins, iframes)', async () => {
    const router = app.services.router;
    await expect(
      router.dispatch('app.info', [], { senderUrl: 'https://evil.example/', isMainFrame: true }),
    ).rejects.toThrow('Forbidden');
    await expect(
      router.dispatch('app.info', [], { senderUrl: APP_PAGE, isMainFrame: false }),
    ).rejects.toThrow('Forbidden');
    await expect(router.dispatch('app.info', [], { isMainFrame: true })).rejects.toThrow(
      'Forbidden',
    );
    await expect(
      router.dispatch('app.info', [], { senderUrl: APP_PAGE, isMainFrame: true }),
    ).resolves.toMatchObject({
      name: 'Spain Assist',
      isE2E: true,
    });
  });

  it('validates arguments and rejects unknown methods', async () => {
    const dispatch = (method: string, args: unknown[]) =>
      app.services.router.dispatch(method, args, { senderUrl: APP_PAGE, isMainFrame: true });
    await expect(dispatch('procedures.rename', [42])).rejects.toThrow(t('es', 'invalidRequest'));
    await expect(dispatch('settings.update', [{ language: 'fr' }])).rejects.toThrow(
      t('es', 'invalidRequest'),
    );
    await expect(
      dispatch('vault.addDocument', [{ name: 'a', mimeType: 'b', bytes: 'not bytes' }]),
    ).rejects.toThrow(t('es', 'invalidRequest'));
    await expect(dispatch('nope.nope' as SaMethod, [])).rejects.toThrow(/Unknown method/);
    await expect(dispatch('procedures.get', ['p_0000000000000000'])).resolves.toBeNull();
  });

  it('only opens https links and phone numbers outside the app', async () => {
    await app.invoke('app.openExternal', 'https://sede.policia.gob.es/');
    await app.invoke('app.openExternal', 'tel:+34900822010');
    for (const url of ['http://example.com/', 'tel:+34 900;phone-context=x', 'file:///etc/hosts'])
      await expect(app.invoke('app.openExternal', url)).rejects.toThrow(t('es', 'onlyHttps'));
    expect(app.opened).toEqual(['https://sede.policia.gob.es/', 'tel:+34900822010']);
  });

  it('opens the Microsoft Store page only in the Store build', async () => {
    await expect(app.invoke('updates.openStore')).rejects.toThrow(t('es', 'notStoreBuild'));
    expect(app.opened).toEqual([]);
  });

  it('manages procedures: rename, archive, markRead, log, delete', async () => {
    const created = await app.services.procedures.create('Empadronarme en Madrid');
    expect((await app.invoke('procedures.rename', created.id, '  Padrón  ')).title).toBe('Padrón');
    expect((await app.invoke('procedures.archive', created.id, true)).archived).toBe(true);
    await app.invoke('procedures.markRead', created.id);
    expect((await app.invoke('procedures.list')).map((p) => p.id)).toEqual([created.id]);
    expect(await app.invoke('procedures.log', created.id)).toEqual([]);
    await app.invoke('procedures.stop', created.id);
    await app.invoke('procedures.delete', created.id);
    expect(await app.invoke('procedures.get', created.id)).toBeNull();
    await expect(app.invoke('procedures.log', created.id)).rejects.toThrow(
      t('es', 'procedureNotFound'),
    );
    await expect(app.invoke('procedures.stop', created.id)).rejects.toThrow(
      t('es', 'procedureNotFound'),
    );
  });

  it('keeps one conversation: empty messages are rejected, unknown prompts too', async () => {
    expect(await app.invoke('chat.transcript')).toEqual([]);
    expect(await app.invoke('chat.state')).toEqual({ activity: 'idle' });
    await expect(app.invoke('chat.send', { text: '   ' })).rejects.toThrow(t('es', 'emptyMessage'));
    await expect(
      app.invoke('chat.respond', 'q_unknown', { kind: 'confirm', approved: true }),
    ).rejects.toThrow(t('es', 'promptNotPending'));
  });

  it('settings.update emits settings.changed', async () => {
    const next = await app.invoke('settings.update', { shareLearnings: false });
    expect(next.shareLearnings).toBe(false);
    expect(app.events.at(-1)).toEqual({ type: 'settings.changed', settings: next });
  });

  it('media.get never resolves paths outside the media store', async () => {
    expect(await app.invoke('media.get', '../../settings.json')).toBeNull();
    expect(await app.invoke('media.get', 'p_0000000000000000.0000000000000000.jpg')).toBeNull();
  });
});

describe('vault IPC', () => {
  it('stores personal data and emits vault.changed', async () => {
    const overview = await app.invoke('vault.setPersonal', [{ key: 'givenName', value: 'Lucía' }]);
    expect(overview.personal).toMatchObject([
      { key: 'givenName', value: 'Lucía', source: 'manual' },
    ]);
    expect(overview.storage).toEqual({ backend: 'test', secure: false, biometricAvailable: false });
    expect(app.events.at(-1)).toEqual({ type: 'vault.changed' });
    expect((await app.invoke('vault.deletePersonal', ['givenName'])).personal).toEqual([]);
  });

  it('previews images only and opens documents from a private temp dir', async () => {
    const png = await app.invoke('vault.addDocument', {
      name: 'foto.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(png).toMatchObject({ source: 'user', size: 3 });
    expect(await app.invoke('vault.previewDocument', png.id)).toBe('data:image/png;base64,AQID');
    const pdf = await app.invoke('vault.addDocument', {
      name: '../../justificante?.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array([37, 80, 68, 70]),
    });
    expect(await app.invoke('vault.previewDocument', pdf.id)).toBeNull();
    await app.invoke('vault.openDocument', pdf.id);
    const opened = app.openedPaths[0]!;
    expect(opened.startsWith(app.paths.tmpDir)).toBe(true);
    expect(opened).not.toContain('..');
    expect(await readFile(opened, 'utf8')).toBe('%PDF');
    expect((await app.invoke('vault.deleteDocument', pdf.id)).documents).toHaveLength(1);
  });

  it('removes opened copies after the timer fires', async () => {
    const doc = await app.invoke('vault.addDocument', {
      name: 'document.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array([37, 80, 68, 70]),
    });
    vi.useFakeTimers();
    try {
      await app.invoke('vault.openDocument', doc.id);
      const path = app.openedPaths[0]!;
      expect(existsSync(path)).toBe(true);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      vi.useRealTimers();
      await app.waitFor(() => !existsSync(path));
    } finally {
      vi.useRealTimers();
    }
  });

  it('places scratch space in the OS temp directory and separates app profiles', () => {
    const paths = createAppPaths('/profiles/one');
    expect(paths.tmpDir.startsWith(join(tmpdir(), 'SpainAssistant-'))).toBe(true);
    expect(paths.tmpDir).not.toBe(createAppPaths('/profiles/two').tmpDir);
  });

  it('exports decrypted documents without overwriting files, even with concurrent downloads', async () => {
    const doc = await app.invoke('vault.addDocument', {
      name: '../../justificante?.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array([37, 80, 68, 70]),
    });
    const downloads = join(app.dir, 'Downloads');
    await mkdir(downloads);
    await writeFile(join(downloads, 'justificante_.pdf'), 'existing');
    const names = await Promise.all([
      app.invoke('vault.downloadDocument', doc.id),
      app.invoke('vault.downloadDocument', doc.id),
    ]);
    expect(names.sort()).toEqual(['justificante_ (1).pdf', 'justificante_ (2).pdf']);
    expect(await readFile(join(downloads, 'justificante_.pdf'), 'utf8')).toBe('existing');
    for (const name of names) expect(await readFile(join(downloads, name), 'utf8')).toBe('%PDF');
    expect(app.openedPaths).toEqual([]);
    await app.invoke('vault.openDocument', doc.id);
    await app.services.vault.cleanupTmp();
    expect(existsSync(app.openedPaths[0]!)).toBe(false);
    expect(await readdir(downloads)).toHaveLength(3);
    expect(app.vault.getDocument(doc.id)).toBeDefined();
  });

  it('rejects unknown documents and never follows a Downloads file symlink', async () => {
    await expect(app.invoke('vault.downloadDocument', 'missing')).rejects.toThrow(
      t('es', 'vaultNotFound'),
    );
    const doc = await app.invoke('vault.addDocument', {
      name: 'document.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array([37, 80, 68, 70]),
    });
    const downloads = join(app.dir, 'Downloads');
    await mkdir(downloads);
    const target = join(app.dir, 'keep.pdf');
    await writeFile(target, 'keep');
    await symlink(target, join(downloads, doc.name));
    expect(await app.invoke('vault.downloadDocument', doc.id)).toBe('document (1).pdf');
    expect(await readFile(target, 'utf8')).toBe('keep');
  });

  it('adds credentials with friendly errors and policy changes', async () => {
    const clave = await app.invoke('vault.addClave', { username: '12345678Z', password: 'pw' });
    expect(clave).toMatchObject({
      kind: 'clave_permanente',
      policy: 'auto',
      usernameHint: '•••••678Z',
    });
    expect((await app.invoke('vault.setCredentialPolicy', clave.id, 'ask')).policy).toBe('ask');
    await expect(
      app.invoke('vault.addCertificate', {
        fileName: 'a.p12',
        bytes: new Uint8Array([1]),
        passphrase: '',
      }),
    ).rejects.toThrow(t('es', 'vaultInvalidPassphrase'));
    const cert = await app.invoke('vault.addCertificate', {
      fileName: 'a.p12',
      bytes: new Uint8Array([1]),
      passphrase: 'pw',
    });
    expect(cert).toMatchObject({ kind: 'certificate', policy: 'ask' });
    expect((await app.invoke('vault.addClaveMovil')).kind).toBe('clave_movil');
    expect((await app.invoke('vault.deleteCredential', clave.id)).credentials).toHaveLength(2);
    await expect(app.invoke('vault.deleteCredential', clave.id)).rejects.toThrow(
      t('es', 'vaultNotFound'),
    );
  });

  it('wipeAll deletes everything and relaunches', async () => {
    await app.invoke('providers.redeemVoucher', 'VALID-CODE');
    await app.invoke('settings.update', { onboardingCompleted: true });
    await app.invoke('vault.setPersonal', [{ key: 'givenName', value: 'Lucía' }]);
    await app.invoke('chat.send', { text: 'Hola' });
    await app.services.chat.settled();
    const procedure = await app.services.procedures.create('Hola');
    const dir = app.services.procedures.paths(procedure.id).dir;
    await app.services.conversation.flush();
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(app.paths.assistantDir)).toBe(true);
    await app.invoke('vault.wipeAll');
    expect(app.vault.listPersonal()).toEqual([]);
    expect(app.vault.listSecrets()).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(app.paths.settingsFile)).toBe(false);
    expect(app.services.settings.get()).toEqual(DEFAULT_SETTINGS);
    expect(await app.invoke('procedures.list')).toEqual([]);
    expect(await app.invoke('chat.transcript')).toEqual([]);
    expect(existsSync(`${app.paths.assistantDir}/transcript.json`)).toBe(false);
    expect(app.agentLib.clients.every((c) => c.stopped)).toBe(true);
    expect(app.relaunched()).toBe(1);
  });
});
