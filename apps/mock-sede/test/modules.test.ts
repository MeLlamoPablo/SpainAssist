import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserService, createBrowserService } from '@sa/browser';
import type { BrowserObservation } from '@sa/shared';
import { AUTOSCRIPT_SHIM_SOURCE, afirmaHandler } from '@sa/signer';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { chromium } from 'playwright-core';
import { expect, test } from 'vitest';
import { FIXTURE_PATHS, startMockSede } from '../src/index';

test('actual browser, vault and signer submit the residence procedure and encrypt its PDF', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-modules-'));
  const sede = await startMockSede({ publicHost: '127.0.0.1' });
  let browser: BrowserService | undefined;
  try {
    const vault = await Vault.open(join(dir, 'vault'), createTestKeyProvider('integration'));
    const certificate = await vault.addCertificate({
      fileName: 'demo.p12',
      p12: await readFile(FIXTURE_PATHS.demoIdentityP12),
      passphrase: '1234',
    });
    const approvals: string[] = [];
    const documents: string[] = [];
    browser = createBrowserService({
      headless: true,
      ignoreHTTPSErrors: true,
      executablePath: chromium.executablePath(),
      downloadsDir: join(dir, 'downloads'),
      onDownload: async (procedureId, file) => {
        const document = await vault.addDocument({
          name: file.suggestedName,
          mimeType: file.mimeType,
          bytes: await readFile(file.path),
          source: 'download',
          procedureId,
        });
        documents.push(document.id);
        return { downloadId: document.id, name: document.name, mimeType: document.mimeType };
      },
      afirma: {
        shimSource: AUTOSCRIPT_SHIM_SOURCE,
        handler: afirmaHandler,
        context: () => ({
          approveSignature: async (summary) => {
            approvals.push(summary.origin);
            const secret = await vault.getCredentialSecret(certificate.id);
            if (secret.kind !== 'certificate') throw new Error('Expected certificate');
            return {
              kind: 'p12',
              credentialId: certificate.id,
              p12: secret.p12,
              passphrase: secret.passphrase,
            };
          },
        }),
      },
    });
    let observation: BrowserObservation;
    const ref = (role: string, name: string) => {
      const line = observation.snapshot
        .split('\n')
        .find((line) => line.includes(`${role} "${name}`));
      const result = line?.match(/\[ref=([^\]]+)\]/)?.[1];
      if (!result) throw new Error(`Missing ${role} ${name} in snapshot: ${observation.snapshot}`);
      return result;
    };
    const click = async (name: string) => {
      observation = await browser!.click('residence', ref('button', name));
    };
    const fill = async (name: string, value: string, secret = false) => {
      observation = await browser!.type('residence', ref('textbox', name), value, { secret });
    };
    const select = async (name: string, value: string) => {
      observation = await browser!.select('residence', ref('combobox', name), [value]);
    };
    observation = await browser.open(
      'residence',
      `${sede.url}/tramites/residencia/solicitud/datos-personales`,
    );
    await click('Acceso Cl@ve Permanente');
    await fill('DNI o NIE', '99999999R');
    await fill('Contraseña', 'clave-demo-1234', true);
    expect(JSON.stringify(observation)).not.toContain('clave-demo-1234');
    await click('Entrar');
    await fill('Código', sede.test.latestSms()!.code, true);
    await click('Validar código');
    await fill('Fecha de nacimiento', '05/03/1990');
    observation = await browser.check('residence', ref('radio', 'Mujer'), true);
    await select('País de nacimiento', 'España');
    await select('Nacionalidad', 'España');
    await click('Continuar');
    await select('Tipo de vía', 'Calle');
    await fill('Nombre de la vía', 'Mayor');
    await fill('Número', '5');
    await fill('Código postal', '28001');
    await fill('Municipio', 'Madrid');
    await select('Provincia', 'Madrid');
    await fill('Correo electrónico', 'demo@example.test');
    await fill('Repite el correo electrónico', 'demo@example.test');
    await fill('Teléfono móvil', '612345678');
    await click('Continuar');
    await select('Motivo de la solicitud', 'Trámites de vivienda');
    const uploadRef = ref('', 'Documento que acredita tu domicilio');
    observation = await browser.upload('residence', uploadRef, [
      {
        name: 'domicilio.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\nfixture'),
      },
    ]);
    observation = await browser.check('residence', ref('checkbox', 'Declaro'), true);
    await click('Continuar');
    await click('Firmar y enviar');
    expect(observation.url).toContain('/justificante/');
    expect(approvals).toEqual([sede.url]);
    expect(sede.test.submissions().at(-1)?.signature?.valid).toBe(true);
    const pdfLine = observation.snapshot
      .split('\n')
      .find((line) => line.includes('link "') && line.includes('PDF') && line.includes('[ref='));
    const pdfRef = pdfLine?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(pdfRef).toBeDefined();
    observation = await browser.click('residence', pdfRef!);
    expect(documents.length).toBeGreaterThan(0);
    expect((await vault.readDocument(documents[0]!)).subarray(0, 5).toString()).toBe('%PDF-');
    const encryptedState = await readFile(join(dir, 'vault', 'vault.bin'));
    expect(encryptedState.includes(Buffer.from('99999999R'))).toBe(false);
    const reopened = await Vault.open(join(dir, 'vault'), createTestKeyProvider('integration'));
    expect((await reopened.readDocument(documents[0]!)).subarray(0, 5).toString()).toBe('%PDF-');
  } finally {
    await browser?.closeAll();
    await sede.close();
    await rm(dir, { recursive: true, force: true });
  }
});
