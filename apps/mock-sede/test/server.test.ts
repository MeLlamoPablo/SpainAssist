import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { loadDemoIdentity, type MockSede, startMockSede } from '../src/index';
import { pemToDer, signCadesBes } from './helpers/cades-signer';

let sede: MockSede;
let browser: Browser;
beforeAll(async () => {
  sede = await startMockSede({ publicHost: '127.0.0.1', captchaInCita: false });
  browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
  });
});
afterAll(async () => {
  await browser?.close();
  await sede?.close();
});
async function pageFor() {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  return { context, page: await context.newPage() };
}
async function login(page: Page, path: string) {
  await page.goto(sede.url + path);
  await page.getByRole('button', { name: 'Acceso Cl@ve Permanente', exact: true }).click();
  await page.getByLabel('DNI o NIE', { exact: false }).fill('99999999R');
  await page.getByLabel('Contraseña', { exact: false }).fill('clave-demo-1234');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  if (path.includes('residencia')) {
    await page.locator('input[name="codigo"]').fill(sede.test.latestSms()!.code);
    await page.getByRole('button', { name: 'Validar código' }).click();
  }
  await page.waitForURL(sede.url + path);
}
test('Permanente SMS and real CAdES submission produce a PDF receipt', async () => {
  const { context, page } = await pageFor();
  try {
    await login(page, '/tramites/residencia/solicitud/datos-personales');
    await page.locator('[name="fechaNacimiento"]').fill('05/03/1990');
    await page.locator('[name="sexo"][value="M"]').check();
    await page.locator('[name="paisNacimiento"]').selectOption({ label: 'España' });
    await page.locator('[name="nacionalidad"]').selectOption({ label: 'España' });
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    for (const [name, value] of Object.entries({
      via: 'Mayor',
      numero: '5',
      codigoPostal: '28001',
      municipio: 'Madrid',
      email: 'demo@example.test',
      emailConfirmacion: 'demo@example.test',
      telefono: '612345678',
    }))
      await page.locator(`[name="${name}"]`).fill(value);
    await page.locator('[name="tipoVia"]').selectOption({ index: 1 });
    await page.locator('[name="provincia"]').selectOption('28');
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await page.locator('[name="motivo"]').selectOption({ index: 1 });
    await page.locator('input[type="file"]').setInputFiles({
      name: 'domicilio.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\nfixture'),
    });
    await page.locator('input[type="checkbox"][required]').check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    const identity = loadDemoIdentity();
    await page.exposeFunction('__testSign', (data: string) => ({
      signature: signCadesBes({
        data: Buffer.from(data, 'base64'),
        certPem: identity.certPem,
        keyPem: identity.keyPem,
        chainPem: identity.chainPem,
      }).toString('base64'),
      certificate: Buffer.from(pemToDer(identity.certPem)).toString('base64'),
    }));
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const win = window as unknown as {
          AutoScript: { sign: (...args: unknown[]) => void };
          __testSign(data: string): Promise<{ signature: string; certificate: string }>;
        };
        win.AutoScript.sign = (data, _algorithm, _format, _params, callback) => {
          void win
            .__testSign(data as string)
            .then((result) =>
              (callback as (s: string, c: string) => void)(result.signature, result.certificate),
            );
        };
      });
    });
    await page.reload();
    await page.getByRole('button', { name: 'Firmar y enviar', exact: true }).click();
    await page.waitForURL(/justificante\//);
    expect(sede.test.submissions().at(-1)?.signature?.valid).toBe(true);
    const response = await context.request.get(`${page.url()}/pdf`);
    expect((await response.body()).subarray(0, 5).toString()).toBe('%PDF-');
  } finally {
    await context.close();
  }
});
test('Movil approval returns to the requested procedure', async () => {
  const { context, page } = await pageFor();
  try {
    await page.goto(`${sede.url}/tramites/residencia/solicitud/datos-personales`);
    await page.getByRole('button', { name: 'Acceso Cl@ve Móvil', exact: true }).click();
    expect(sede.test.approveMovil()).toBeDefined();
    await page.getByRole('button', { name: 'Ya he confirmado el acceso en la app' }).click();
    await page.waitForURL(/datos-personales/);
    expect(await page.locator('[name="dni"]').inputValue()).toBe('99999999R');
  } finally {
    await context.close();
  }
});
test('certificate login distinguishes missing and trusted certificates', async () => {
  const { context, page } = await pageFor();
  try {
    await page.goto(`${sede.url}/tramites/residencia/solicitud/datos-personales`);
    await page
      .getByRole('button', { name: 'Acceso DNIe / Certificado electrónico', exact: true })
      .click();
    await page.getByText(/003002/).waitFor();
  } finally {
    await context.close();
  }
  const identity = loadDemoIdentity();
  const authenticated = await browser.newContext({
    ignoreHTTPSErrors: true,
    clientCertificates: [
      {
        origin: sede.certUrl,
        cert: Buffer.from(identity.certPem + identity.chainPem.join('\n')),
        key: Buffer.from(identity.keyPem),
      },
    ],
  });
  try {
    const p = await authenticated.newPage();
    await p.goto(`${sede.url}/tramites/residencia/solicitud/datos-personales`);
    await p
      .getByRole('button', { name: 'Acceso DNIe / Certificado electrónico', exact: true })
      .click();
    await p.waitForURL(/datos-personales/);
    expect(await p.locator('[name="dni"]').inputValue()).toBe('99999999R');
  } finally {
    await authenticated.close();
  }
});
test('cita booking reserves a slot', async () => {
  const { context, page } = await pageFor();
  try {
    await login(page, '/tramites/cita/solicitud/oficina');
    await page.locator('[name="oficina"]').selectOption({ index: 1 });
    await page.locator('[name="servicio"]').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await page.locator('input[type="radio"]:enabled').first().check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await page.locator('[name="telefono"]').fill('612345678');
    await page.locator('[name="privacidad"]').check();
    await page.getByRole('button', { name: 'Confirmar cita', exact: true }).click();
    await page.waitForURL(/justificante\//);
    expect(sede.test.appointments()).toHaveLength(1);
  } finally {
    await context.close();
  }
});
