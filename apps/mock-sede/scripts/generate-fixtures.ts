/**
 * (Re)generates the committed test fixtures:
 *   fixtures/client-ca/*.pem     mock "FNMT-like" client CA (only with --new-ca or when missing)
 *   fixtures/demo-identity.p12   demo certificate "ESPAÑOLA ESPAÑOLA CARMEN - 99999999R", pass 1234
 *   fixtures/demo-identity.crt.pem
 *
 * Usage: corepack pnpm --filter @sa/mock-sede fixtures [--new-ca]
 * A new CA invalidates every .p12 issued before, so only rotate it on purpose.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createTestIdentity,
  DEMO_IDENTITY_PASSPHRASE,
  DEMO_PERSON,
  FIXTURE_PATHS,
  generateClientCa,
} from '../src/identities';

const newCa = process.argv.includes('--new-ca');

if (newCa || !existsSync(FIXTURE_PATHS.clientCaRootCert)) {
  const ca = generateClientCa();
  mkdirSync(dirname(FIXTURE_PATHS.clientCaRootCert), { recursive: true });
  writeFileSync(FIXTURE_PATHS.clientCaRootCert, ca.root.certPem);
  writeFileSync(FIXTURE_PATHS.clientCaRootKey, ca.root.keyPem);
  writeFileSync(FIXTURE_PATHS.clientCaIntermediateCert, ca.intermediate.certPem);
  writeFileSync(FIXTURE_PATHS.clientCaIntermediateKey, ca.intermediate.keyPem);
  console.log('New mock client CA written to', dirname(FIXTURE_PATHS.clientCaRootCert));
}

const demo = createTestIdentity({
  ...DEMO_PERSON,
  passphrase: DEMO_IDENTITY_PASSPHRASE,
  // 3DES imports everywhere (macOS Keychain, Windows, Firefox, Node/OpenSSL 3).
  encryption: '3des',
  email: 'carmen.espanola@example.com',
  notAfter: new Date(Date.now() + 10 * 365 * 86_400_000),
});
writeFileSync(FIXTURE_PATHS.demoIdentityP12, demo.p12);
writeFileSync(FIXTURE_PATHS.demoIdentityCert, demo.certPem);
console.log(`Demo identity "${demo.commonName}" written to ${FIXTURE_PATHS.demoIdentityP12}`);
