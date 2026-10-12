/**
 * CLI: corepack pnpm --filter @sa/mock-sede start
 * Env: MOCK_SEDE_PORT (8790), MOCK_SEDE_CERT_PORT (8791), MOCK_SEDE_DATA_DIR (<repo>/.data/mock-sede),
 *      MOCK_SEDE_TEST_API=0 to disable /__test/*, MOCK_SEDE_AUTOFIRMA_RETRIES (15).
 */
import { fileURLToPath } from 'node:url';
import { startMockSede } from './server';

const env = process.env;
const dataDir =
  env.MOCK_SEDE_DATA_DIR ?? fileURLToPath(new URL('../../../.data/mock-sede/', import.meta.url));

const sede = await startMockSede({
  port: Number(env.MOCK_SEDE_PORT ?? 8790),
  certPort: Number(env.MOCK_SEDE_CERT_PORT ?? 8791),
  dataDir,
  autofirma: env.MOCK_SEDE_AUTOFIRMA_RETRIES
    ? { retries: Number(env.MOCK_SEDE_AUTOFIRMA_RETRIES) }
    : undefined,
  log: (message) => console.log(message),
});

console.log(`
Mock sede (SpainAssist test site) is running
  Sede + Cl@ve-like gateway:  ${sede.url}/
  Certificate login IdP:      ${sede.certUrl}/   (asks for a TLS client certificate)
  TLS CA (trust it or accept the browser warning): ${sede.caCertPath}
  Cl@ve Permanente demo user: DNI ${sede.demo.dni}, password "${sede.demo.clavePassword}"
                              (SMS codes are printed here and served at ${sede.url}/__test/sms)
  Demo certificate:           ${sede.demo.certificateP12Path} (password "${sede.demo.certificatePassphrase}")
  Test API:                   ${sede.config.testApi ? `${sede.url}/__test/state` : 'disabled'}
Press Ctrl+C to stop.
`);

const stop = async () => {
  await sede.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
