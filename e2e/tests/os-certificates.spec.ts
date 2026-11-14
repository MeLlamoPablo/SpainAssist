import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDemoIdentity } from '@sa/mock-sede';
import { expect, invoke, test } from '../fixtures';
import { connect } from '../helpers';

/**
 * External certificates (macOS): the built app against a throwaway keychain file
 * (SA_OS_KEYCHAIN), never the user's keychains, with the mock sede's CAs standing in for FNMT's
 * (SA_OS_CERTIFICATE_CA). `security create-keychain` doesn't add the file to the search list.
 */
const dir = mkdtempSync(join(tmpdir(), 'sa-e2e-keychain-'));
const keychain = join(dir, 'e2e.keychain-db');
const authorities = join(dir, 'authorities.pem');
const demo = loadDemoIdentity();

test.skip(process.platform !== 'darwin', 'the macOS keychain');
test.use({ appEnv: { SA_OS_KEYCHAIN: keychain, SA_OS_CERTIFICATE_CA: authorities } });

test.beforeAll(() => {
  const password = randomBytes(12).toString('hex');
  execFileSync('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
  execFileSync('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
  // No auto-lock while the test runs.
  execFileSync('/usr/bin/security', ['set-keychain-settings', keychain]);
  writeFileSync(authorities, demo.chainPem.join('\n'));
});
test.afterAll(() => {
  try {
    execFileSync('/usr/bin/security', ['delete-keychain', keychain]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a certificate moves from Mis datos to the keychain and comes back as external, also after a restart', async ({
  harness: h,
}) => {
  await connect(h);
  const saved = await invoke(h.page, 'vault.addCertificate', {
    fileName: 'demo.p12',
    bytes: new Uint8Array(demo.p12),
    passphrase: demo.passphrase,
  });
  await h.page.reload();
  await h.page.getByTestId('tab-vault').click();
  await h.page.getByTestId('vault-tab-credentials').click();
  const card = h.page.getByTestId('credential-certificate');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('certificate-external')).toHaveCount(0);

  await card.getByTestId('certificate-menu').click();
  await expect(h.page.getByRole('menuitem', { name: 'Descargar .p12' })).toBeVisible();
  await h.page.getByRole('menuitem', { name: 'Mover al sistema operativo' }).click();
  await expect(h.page.getByRole('dialog')).toContainText('lo borro de Spain Assist');
  await h.page.getByTestId('certificate-move-submit').click();

  // Out of the vault, in the keychain, and listed from there.
  await expect(card.getByTestId('certificate-external')).toBeVisible();
  await expect(card.getByTestId('certificate-menu')).toHaveCount(0);
  const fingerprint = saved.certificate?.fingerprint;
  const external = async () =>
    (await invoke(h.page, 'vault.overview')).credentials.filter((c) => c.kind === 'certificate');
  expect(await external()).toMatchObject([
    { id: `os-${fingerprint}`, external: true, certificate: { fingerprint } },
  ]);
  expect(
    execFileSync('/usr/bin/security', ['find-identity', keychain], { encoding: 'utf8' }),
  ).toContain(demo.commonName);

  // A fresh start finds it by itself.
  await h.restart();
  await expect.poll(external).toMatchObject([{ id: `os-${fingerprint}`, external: true }]);
});
