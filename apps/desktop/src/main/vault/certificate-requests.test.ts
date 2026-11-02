/**
 * Mis datos → Credenciales: pending FNMT certificate requests reach the renderer in the vault
 * overview ("En proceso"), and the user can discard one with its key.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../core/i18n';
import { createTestApp, type TestApp } from '../testing/harness';

let app: TestApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const KEY = Buffer.from('a private key that must never reach the renderer');

async function addRequest(target: TestApp, procedureId?: string) {
  return target.vault.addCertificateRequest({
    publicKeyHash: 'WrpR88SZuLkhNxKKnk0ShWhX7Za2FK0W0h581OBeCdc',
    privateKey: KEY,
    keyDescription: 'rsa 2048',
    origin: 'https://apus20.sede.fnmt.gob.es',
    ...(procedureId ? { procedureId } : {}),
  });
}

describe('Mis datos: pending FNMT certificate requests', () => {
  it('lists them in the overview without their key, and discards one with its key', async () => {
    app = await createTestApp();
    const { procedureId } = await app.procedureWithToken();
    const request = await addRequest(app, procedureId);

    const overview = await app.invoke('vault.overview');
    expect(overview.certificateRequests).toEqual([request]);
    expect(JSON.stringify(overview)).not.toContain(KEY.toString('base64'));

    const seen = app.events.length;
    const after = await app.invoke('vault.deleteCertificateRequest', request.id);
    expect(after.certificateRequests).toEqual([]);
    expect(app.vault.listCertificateRequests()).toEqual([]);
    await expect(app.vault.getCertificateRequestKey(request.id)).rejects.toThrow();
    expect(app.events.slice(seen)).toContainEqual({ type: 'vault.changed' });
    await expect(app.invoke('vault.deleteCertificateRequest', request.id)).rejects.toThrow(
      t('es', 'vaultNotFound'),
    );
  });

  it('keeps a request when its procedure is deleted', async () => {
    app = await createTestApp();
    const { procedureId } = await app.procedureWithToken();
    const request = await addRequest(app, procedureId);
    await app.invoke('procedures.delete', procedureId);
    expect((await app.invoke('vault.overview')).certificateRequests).toEqual([request]);
  });
});
