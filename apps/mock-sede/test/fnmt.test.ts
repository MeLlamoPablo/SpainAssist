/**
 * The FNMT-like certificate request and download pages: the request is checked and registered,
 * the download waits for the identity check and hands over a certificate for the request's key.
 * Without the app's shim, the page fails the way FNMT's does without the Configurador.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { createCertificateRequest, parseIssuedCertificates } from '@sa/signer';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type MockSede, startMockSede } from '../src/index';

let sede: MockSede;
beforeAll(async () => {
  sede = await startMockSede({ publicHost: '127.0.0.1' });
});
afterAll(async () => {
  await sede?.close();
});
beforeEach(() => sede.test.reset());

const post = (path: string, fields: Record<string, string>) =>
  sede.fetch(`${sede.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

const identity = {
  NIF_SG: '99999999R',
  APELLIDO1_SG: 'Española',
  EMAIL_XX: 'carmen@example.com',
  EMAIL_OBLIG_VERIFICADO_XX: 'carmen@example.com',
  aceptarCondiciones: 'si',
};

describe('FNMT-like certificate request', () => {
  it('registers a valid request, waits for the identity check and issues for its key', async () => {
    const request = createCertificateRequest({ type: 'rsa', bits: 2048 });
    const missing = await post('/fnmt/solicitud', identity);
    expect(missing.status).toBe(422);
    expect(await missing.text()).toContain('No se han generado las claves');
    const forged = Buffer.from(request.pkcs10);
    forged[forged.length - 1] ^= 0xff;
    const bad = await post('/fnmt/solicitud', { ...identity, PKCS10: forged.toString('base64') });
    expect(await bad.text()).toContain('La firma de la petición de certificado no es correcta');

    const ok = await post('/fnmt/solicitud', {
      ...identity,
      PKCS10: request.pkcs10.toString('base64'),
    });
    expect(ok.status).toBe(200);
    const [registered] = sede.test.fnmtRequests();
    expect(registered).toMatchObject({
      dni: '99999999R',
      publicKeyHash: request.publicKeyHash,
      accredited: false,
    });
    expect(await ok.text()).toContain(registered!.code);

    const download = {
      NIF_SG: '99999999R',
      APELLIDO1_SG: 'ESPAÑOLA',
      COD_SOLICITUD: registered!.code,
      aceptarCondiciones: '1',
    };
    expect(await (await post('/fnmt/descarga', download)).text()).toContain(
      'todavía no está acreditada',
    );
    expect(
      await (await post('/fnmt/descarga', { ...download, APELLIDO1_SG: 'Otro' })).text(),
    ).toContain('no corresponden a ninguna solicitud');

    sede.test.accreditFnmt();
    const page = await (await post('/fnmt/descarga', download)).text();
    const data = JSON.parse(
      /<script type="application\/json" id="datos-certificado">(.*?)<\/script>/s.exec(page)![1]!,
    ) as string;
    const certs = parseIssuedCertificates(data).map((der) => new X509Certificate(der));
    const leaf = certs.find((c) => !c.ca)!;
    expect(leaf.subject).toContain('CN=ESPAÑOLA ESPAÑOLA CARMEN - 99999999R');
    const spki = leaf.publicKey.export({ type: 'spki', format: 'der' });
    expect(createHash('sha256').update(spki).digest('base64url')).toBe(request.publicKeyHash);
    expect(certs.some((c) => c.subject.includes('AC MOCK-FNMT Usuarios'))).toBe(true);
    // A second download hands out the same certificate.
    const again = await (await post('/fnmt/descarga', download)).text();
    expect(again).toContain(data.slice(0, 40));
    expect(sede.test.fnmtRequests()[0]?.downloads).toBe(2);
  });

  it('fails like FNMT without the Configurador when no app answers', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const dialogs: string[] = [];
      page.on('dialog', (d) => {
        dialogs.push(d.message());
        void d.accept();
      });
      await page.goto(`${sede.url}/fnmt/solicitud`);
      await page.locator('[name="NIF_SG"]').fill(identity.NIF_SG);
      await page.locator('[name="APELLIDO1_SG"]').fill(identity.APELLIDO1_SG);
      await page.locator('[name="EMAIL_XX"]').fill(identity.EMAIL_XX);
      await page.locator('[name="EMAIL_OBLIG_VERIFICADO_XX"]').fill(identity.EMAIL_XX);
      await page.locator('[name="aceptarCondiciones"]').check();
      await page.getByRole('button', { name: 'Enviar petición' }).click();
      await expect
        .poll(() => dialogs, { timeout: 10_000 })
        .toEqual([expect.stringContaining('no se encuentra instalada')]);
      await expect(page.locator('#error-solicitud')).toBeDefined();
      expect(await page.locator('#error-solicitud').textContent()).toContain(
        'no se encuentra instalada',
      );
      expect(sede.test.fnmtRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
