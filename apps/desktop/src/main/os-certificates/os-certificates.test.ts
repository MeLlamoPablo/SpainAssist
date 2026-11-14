import { execFileSync } from 'node:child_process';
import {
  constants,
  createHash,
  createVerify,
  type KeyObject,
  privateEncrypt,
  publicDecrypt,
  randomBytes,
  X509Certificate,
} from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestIdentity,
  loadDemoIdentity,
  type MockSede,
  startMockSede,
  type TestIdentity,
  verifyCadesSignature,
} from '@sa/mock-sede';
import type { SignatureDigest } from '@sa/shared';
import { afirmaHandler } from '@sa/signer';
import { certificateInfo, createTestKeyProvider, readPkcs12, Vault } from '@sa/vault';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import { createLogger } from '../core/logger';
import type { Biometric } from '../ports';
import { createTestApp, type TestApp } from '../testing/harness';
import { VaultService } from '../vault/service';
import { openKeychain } from './keychain';
import { OsCertificates } from './service';
import { type OsKeyStore, OsKeyStoreError } from './store';
import { withOsCertificates } from './vault';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sa-os-cert-test-'));
  dirs.push(dir);
  return dir;
}

const DIGEST_INFO: Record<SignatureDigest, string> = {
  sha1: '3021300906052b0e03021a05000414',
  sha256: '3031300d060960864801650304020105000420',
  sha384: '3041300d060960864801650304020205000430',
  sha512: '3051300d060960864801650304020305000440',
};

/** An OS store in memory. `deny` makes signatures fail as when the user refuses the prompt. */
class FakeStore implements OsKeyStore {
  readonly identities: { der: Buffer; key: KeyObject }[] = [];
  deny = false;
  signatures = 0;

  async add(identity: TestIdentity): Promise<void> {
    await this.importPkcs12(identity.p12, identity.passphrase);
  }
  async list(): Promise<Buffer[]> {
    return this.identities.map((i) => i.der);
  }
  async sign(certificate: Uint8Array, digest: Uint8Array, hash: SignatureDigest): Promise<Buffer> {
    const found = this.identities.find((i) => i.der.equals(Buffer.from(certificate)));
    if (!found) throw new OsKeyStoreError('not_found', 'gone');
    if (this.deny) throw new OsKeyStoreError('denied', 'refused', -128);
    this.signatures++;
    return privateEncrypt(
      { key: found.key, padding: constants.RSA_PKCS1_PADDING },
      Buffer.concat([Buffer.from(DIGEST_INFO[hash], 'hex'), digest]),
    );
  }
  async importPkcs12(p12: Uint8Array, passphrase: string): Promise<void> {
    const contents = await readPkcs12(p12, passphrase);
    const der = contents.certificate.raw;
    if (!this.identities.some((i) => i.der.equals(der)))
      this.identities.push({ der, key: contents.privateKey });
  }
}

const demo = loadDemoIdentity();
/** The mock sede's CAs stand in for FNMT's. */
const authorities = demo.chainPem.map((pem) => new X509Certificate(pem).raw);
const info = (der: Uint8Array) => certificateInfo(new X509Certificate(der));

function osCertificates(store: OsKeyStore, now?: () => number): OsCertificates {
  return new OsCertificates({
    store,
    authorities,
    certificateInfo: info,
    logger: createLogger({ level: 'error', sinks: [] }),
    ...(now ? { now } : {}),
  });
}

function person(overrides: Partial<Parameters<typeof createTestIdentity>[0]> = {}): TestIdentity {
  return createTestIdentity({
    givenName: 'Lucía',
    surname1: 'Externa',
    surname2: 'Llavero',
    dni: '12345678Z',
    passphrase: 'x',
    encryption: '3des',
    ...overrides,
  });
}

const signal = new AbortController().signal;

describe('external certificates', () => {
  it('finds the certificates of its authorities, and only those still valid', async () => {
    const store = new FakeStore();
    const lucia = person();
    await store.add(lucia);
    await store.add(person({ dni: '00000000T', issuer: 'untrusted' }));
    const expired = person({
      dni: '00000001R',
      notBefore: new Date(Date.now() - 3 * 86_400_000),
      notAfter: new Date(Date.now() - 86_400_000),
    });
    await store.add(expired);
    const os = osCertificates(store);

    expect(os.list()).toEqual([]);
    expect(await os.refresh()).toBe(true);
    expect(await os.refresh()).toBe(false);
    const fingerprint = info(lucia.certDer).fingerprint;
    expect(os.list()).toEqual([
      {
        id: `os-${fingerprint}`,
        kind: 'certificate',
        label: `Certificado de ${info(lucia.certDer).holderName}`,
        policy: 'ask',
        createdAt: info(lucia.certDer).validFrom,
        certificate: info(lucia.certDer),
        external: true,
      },
    ]);
    expect(os.eligible(lucia.certDer)).toBe(true);
    expect(os.eligible(new X509Certificate(demo.chainPem[0]!).raw)).toBe(false);
  });

  it('keeps the last list when the store cannot be read', async () => {
    const store = new FakeStore();
    await store.add(person());
    const os = osCertificates(store);
    await os.refresh();
    store.list = async () => {
      throw new Error('locked');
    };
    expect(await os.refresh()).toBe(false);
    expect(os.list()).toHaveLength(1);
  });

  it('signs logins through the sidecar identity, asking the OS once before the first one', async () => {
    const store = new FakeStore();
    const lucia = person();
    await store.add(lucia);
    const os = osCertificates(store);
    await os.refresh();
    const identity = os.sidecarIdentity(os.list()[0]!.id);
    expect(identity.chain.map((der) => Buffer.from(der).toString('hex'))).toEqual([
      lucia.certDer.toString('hex'),
      authorities[0]!.toString('hex'),
    ]);
    if (!('prepare' in identity.key)) throw new Error('expected a remote key');

    await identity.key.prepare('sede.example', signal);
    await identity.key.prepare('sede.example', signal);
    expect(store.signatures).toBe(1);

    const digest = createHash('sha384').update('handshake').digest();
    const signature = await identity.key.sign(digest, 'SHA-384', 'sede.example', signal);
    const signed = publicDecrypt(
      { key: new X509Certificate(lucia.certDer).publicKey, padding: constants.RSA_PKCS1_PADDING },
      signature,
    );
    expect(signed.subarray(-digest.length).equals(digest)).toBe(true);
  });

  it('fails the login as declined when the user refuses the OS prompt, and asks again next time', async () => {
    const store = new FakeStore();
    await store.add(person());
    const os = osCertificates(store);
    await os.refresh();
    const identity = os.sidecarIdentity(os.list()[0]!.id);
    if (!('prepare' in identity.key)) throw new Error('expected a remote key');

    store.deny = true;
    await expect(identity.key.prepare('sede.example', signal)).rejects.toMatchObject({
      code: 'declined',
    });
    store.deny = false;
    await identity.key.prepare('sede.example', signal);
    expect(store.signatures).toBe(1);
  });

  it('signs documents as an external signing key', async () => {
    const store = new FakeStore();
    const lucia = person();
    await store.add(lucia);
    const os = osCertificates(store);
    await os.refresh();
    const key = os.signingKey(os.list()[0]!.id);
    expect(Buffer.from(key.certificates[0]!).equals(lucia.certDer)).toBe(true);

    const data = Buffer.from('signed attributes');
    const signature = await key.sign(data, 'sha256');
    expect(createVerify('sha256').update(data).verify(lucia.certPem, Buffer.from(signature))).toBe(
      true,
    );
  });

  it('stops using a certificate that left the store', async () => {
    const store = new FakeStore();
    await store.add(person());
    const os = osCertificates(store);
    await os.refresh();
    const id = os.list()[0]!.id;
    store.identities.length = 0;
    await os.refresh();
    expect(os.list()).toEqual([]);
    expect(() => os.sidecarIdentity(id)).toThrow(OsKeyStoreError);
  });
});

describe('the vault with external certificates', () => {
  async function setup() {
    const dir = await tempDir();
    const own = await Vault.open(join(dir, 'vault'), createTestKeyProvider('os'));
    const store = new FakeStore();
    const os = osCertificates(store);
    const vault = withOsCertificates(own, os);
    const events: string[] = [];
    const bus = new EventBus();
    bus.on((e) => events.push(e.type));
    const biometric: Biometric & { ok: boolean; reasons: string[] } = {
      ok: true,
      reasons: [],
      available: () => true,
      async prompt(reason) {
        this.reasons.push(reason);
        return this.ok;
      },
    };
    let closedBrowsers = 0;
    let managerOpened = 0;
    const service = new VaultService({
      vault,
      events: bus,
      logger: createLogger({ level: 'error', sinks: [] }),
      biometric,
      tmpDir: join(dir, 'tmp'),
      downloadsDir: join(dir, 'Downloads'),
      openPath: async () => '',
      lang: () => 'es',
      dniePhone: true,
      osCertificates: os,
      onCredentialDeleted: async () => {
        closedBrowsers++;
      },
      openSystemCertificates: async () => {
        managerOpened++;
      },
    });
    return {
      own,
      store,
      os,
      vault,
      service,
      events,
      biometric,
      closed: () => closedBrowsers,
      managerOpened: () => managerOpened,
    };
  }

  it('opens the system’s certificate manager, where there is one', async () => {
    const { service, managerOpened } = await setup();
    await service.openSystemCertificates();
    expect(managerOpened()).toBe(1);

    const a = await createTestApp();
    try {
      await expect(a.services.vault.openSystemCertificates()).rejects.toThrow();
    } finally {
      await a.close();
    }
  });

  it('lists them as external certificates that cannot be changed, exported or deleted', async () => {
    const { store, os, vault, service } = await setup();
    await store.add(person());
    await os.refresh();

    const [external] = service.overview().credentials;
    expect(external).toMatchObject({ kind: 'certificate', external: true, policy: 'ask' });
    const id = external!.id;
    expect(vault.getCredential(id)).toEqual(external);
    await expect(service.setCredentialPolicy(id, 'auto')).rejects.toThrow();
    await expect(service.deleteCredential(id)).rejects.toThrow();
    await expect(service.exportCertificate(id, 'una-contraseña')).rejects.toThrow();
    await expect(service.moveCertificateToSystem(id)).rejects.toThrow();
    await expect(vault.getCredentialSecret(id)).rejects.toThrow();
    await vault.markCredentialUsed(id);
    expect(vault.listCredentials()).toHaveLength(1);
  });

  it('shows a certificate that is in both places once, as the app’s', async () => {
    const { store, os, vault } = await setup();
    await store.add(demo);
    await os.refresh();
    expect(vault.listCredentials()).toMatchObject([{ external: true }]);

    const saved = await vault.addCertificate({
      fileName: 'demo.p12',
      p12: demo.p12,
      passphrase: demo.passphrase,
    });
    const listed = vault.listCredentials();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: saved.id, inSystem: true });
    expect(listed[0]?.external).toBeUndefined();
    // Nothing to move: it is already there.
    expect(listed[0]?.canMoveToSystem).toBeUndefined();
  });

  it('tells the renderer when a certificate appears in the OS store', async () => {
    const { store, service, events } = await setup();
    await store.add(person());
    await expect.poll(() => events).toEqual([]);
    // Mis datos opens again later: the app looks once more.
    Object.assign(service, { osCertificatesReadAt: 0 });
    service.overview();
    await expect.poll(() => events).toEqual(['vault.changed']);
    expect(service.overview().credentials).toHaveLength(1);
  });

  it('moves a certificate to the OS store: out of the vault once the app can sign from there', async () => {
    const { own, store, service, biometric, closed } = await setup();
    const saved = await own.addCertificate({
      fileName: 'demo.p12',
      p12: demo.p12,
      passphrase: demo.passphrase,
    });

    const overview = await service.moveCertificateToSystem(saved.id);
    expect(biometric.reasons).toEqual(['mover tu certificado digital al sistema operativo']);
    expect(own.listCredentials()).toEqual([]);
    expect(store.identities.map((i) => i.der.toString('hex'))).toEqual([
      demo.certDer.toString('hex'),
    ]);
    expect(overview?.credentials).toMatchObject([
      { external: true, certificate: { fingerprint: saved.certificate?.fingerprint } },
    ]);
    expect(closed()).toBe(1);
  });

  it('keeps the certificate in the vault when Touch ID is cancelled or the OS refuses', async () => {
    const { own, store, service, biometric } = await setup();
    const saved = await own.addCertificate({
      fileName: 'demo.p12',
      p12: demo.p12,
      passphrase: demo.passphrase,
    });

    biometric.ok = false;
    expect(await service.moveCertificateToSystem(saved.id)).toBeNull();
    expect(store.identities).toEqual([]);

    biometric.ok = true;
    store.deny = true;
    await expect(service.moveCertificateToSystem(saved.id)).rejects.toThrow(
      'El sistema no ha permitido añadir el certificado. Sigue guardado en Spain Assist.',
    );
    expect(own.listCredentials()).toHaveLength(1);
  });

  it('refuses to move a certificate the app would not find afterwards', async () => {
    const { own, store, service } = await setup();
    const stranger = person({ issuer: 'untrusted' });
    const saved = await own.addCertificate({
      fileName: 'otro.p12',
      p12: stranger.p12,
      passphrase: stranger.passphrase,
    });
    expect(service.overview().credentials[0]?.canMoveToSystem).toBeUndefined();
    await expect(service.moveCertificateToSystem(saved.id)).rejects.toThrow(/solo usa/);
    expect(store.identities).toEqual([]);
    expect(own.listCredentials()).toHaveLength(1);
  });

  it('drops the vault’s copy of a certificate that is also in the OS store, installing nothing', async () => {
    const { own, store, os, service, biometric, closed } = await setup();
    await store.add(demo);
    await os.refresh();
    const saved = await own.addCertificate({
      fileName: 'demo.p12',
      p12: demo.p12,
      passphrase: demo.passphrase,
    });
    expect(service.overview().credentials).toMatchObject([{ id: saved.id, inSystem: true }]);
    store.importPkcs12 = async () => {
      throw new Error('nothing to install');
    };

    const overview = await service.moveCertificateToSystem(saved.id);
    expect(biometric.reasons).toEqual(['usar el certificado digital del sistema operativo']);
    expect(own.listCredentials()).toEqual([]);
    expect(store.identities).toHaveLength(1);
    expect(overview?.credentials).toMatchObject([
      { id: `os-${saved.certificate?.fingerprint}`, external: true },
    ]);
    expect(closed()).toBe(1);
  });

  it('keeps the vault’s copy unless the OS store’s certificate proves to be the same', async () => {
    const { own, store, os, service } = await setup();
    await store.add(demo);
    await os.refresh();
    const saved = await own.addCertificate({
      fileName: 'demo.p12',
      p12: demo.p12,
      passphrase: demo.passphrase,
    });
    const kept = () => expect(own.listCredentials()).toMatchObject([{ id: saved.id }]);

    // The user refuses the system's prompt.
    store.deny = true;
    await expect(service.moveCertificateToSystem(saved.id)).rejects.toThrow(
      'El sistema no ha permitido usar su certificado. El tuyo sigue guardado en Spain Assist.',
    );
    kept();
    store.deny = false;

    // The system's certificate is paired with another key.
    const key = store.identities[0]!.key;
    store.identities[0]!.key = (await readPkcs12(person().p12, 'x')).privateKey;
    await expect(service.moveCertificateToSystem(saved.id)).rejects.toThrow(
      /No he podido comprobar que el certificado del sistema operativo es el mismo/,
    );
    kept();
    store.identities[0]!.key = key;

    // It left the system between the listing and the click.
    store.identities.length = 0;
    await expect(service.moveCertificateToSystem(saved.id)).rejects.toThrow(/es el mismo/);
    kept();
  });
});

describe('the app with an external certificate', () => {
  let app: TestApp | undefined;
  let sede: MockSede | undefined;
  afterEach(async () => {
    await app?.close();
    await sede?.close();
    app = undefined;
    sede = undefined;
  });

  async function start() {
    const store = new FakeStore();
    await store.add(demo);
    app = await createTestApp({ osKeyStore: store, osCertificateAuthorities: authorities });
    const a = app;
    // The app's own vault port doesn't know them: the services see the wrapped one.
    const credentials = () => a.services.vault.overview().credentials;
    await a.waitFor(() => credentials().some((c) => c.external));
    const external = credentials().find((c) => c.external)!;
    return { a, store, external, ...(await a.procedureWithToken()) };
  }

  it('asks before a login, like a certificate of the app, and tells the agent nothing new', async () => {
    const { a, external, procedureId, token } = await start();
    const read = await a.rpc('vault.read', {}, token);
    expect(read.body.result).toMatchObject({
      credentials: [{ id: external.id, kind: 'certificate', policy: 'ask' }],
    });

    const call = a.rpc('browser.useCertificate', { credentialId: external.id }, token);
    await a.waitFor(() => !!a.pendingPrompt(procedureId));
    const prompt = a.pendingPrompt(procedureId)!;
    expect(prompt.prompt).toMatchObject({ kind: 'confirm', confirmKind: 'credential' });
    await a.invoke('chat.respond', prompt.id, { kind: 'confirm', approved: true });
    expect((await call).body.result).toMatchObject({ enabled: true });
    expect(a.browser.certificates).toHaveLength(1);
  });

  it('signs an AutoFirma XML batch with the key in the OS store, end to end', async () => {
    sede = await startMockSede({ publicHost: '127.0.0.1' });
    const site = sede;
    const { a, store, procedureId } = await start();
    const challenge = Buffer.from('CHALLENGE-0123456789ABCDEF').toString('base64');
    const batch = `<signbatch stoponerror="true" algorithm="SHA256withRSA"><singlesign Id="tx-os"><datasource>${challenge}</datasource><format>CAdES</format><suboperation>sign</suboperation><extraparams>${Buffer.from('mode=implicit\n').toString('base64')}</extraparams></singlesign></signbatch>`;
    const reply = afirmaHandler(
      {
        method: 'signBatch',
        args: [
          Buffer.from(batch).toString('base64'),
          `${site.url}/gsede/clientsigner/BatchPresigner/service/ABC`,
          `${site.url}/gsede/clientsigner/BatchPostsigner/service/ABC`,
          'mode=implicit\n',
        ],
        origin: site.url,
        url: `${site.url}/gsede/acceso`,
      },
      {
        procedureId,
        approveSignature: (summary) => a.services.browser.approveSignature(procedureId, summary),
        report: () => {},
        fetch: site.fetch,
      },
    );

    // The app asks first; the OS store signs only after the user approves.
    await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'confirm');
    expect(store.signatures).toBe(0);
    await a.invoke('chat.respond', a.pendingPrompt(procedureId)!.id, {
      kind: 'confirm',
      approved: true,
    });
    const result = await reply;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(store.signatures).toBe(1);

    const stored = await (
      await site.fetch(`${site.url}/gsede/clientsigner/RetrieveService?op=get&v=1_0&id=tx-os`)
    ).text();
    const [cert, signature] = stored.split('|');
    const verification = verifyCadesSignature({
      signature: signature!,
      expectedContent: Buffer.from(challenge, 'base64'),
      certificateArgument: cert,
    });
    expect(verification.error).toBeUndefined();
    expect(verification.valid).toBe(true);
  });
});

/**
 * The real Security.framework calls, against a throwaway keychain file: `security
 * create-keychain` doesn't add it to the user's search list, and every call names it.
 */
describe.skipIf(process.platform !== 'darwin')('the macOS keychain', () => {
  it('imports a .p12, lists its identity and signs with its key', async () => {
    const dir = await tempDir();
    const keychainPath = join(dir, 'test.keychain-db');
    const password = randomBytes(12).toString('hex');
    execFileSync('/usr/bin/security', ['create-keychain', '-p', password, keychainPath]);
    execFileSync('/usr/bin/security', ['unlock-keychain', '-p', password, keychainPath]);
    try {
      const keychain = await openKeychain({ keychainPath });
      expect(await keychain.list()).toEqual([]);
      expect(keychain.importPath()).toBe(await realpath(keychainPath));

      const lucia = person();
      await keychain.importPkcs12(lucia.p12, lucia.passphrase);
      await keychain.importPkcs12(lucia.p12, lucia.passphrase);
      const listed = await keychain.list();
      expect(listed.map((der) => der.toString('hex'))).toEqual([lucia.certDer.toString('hex')]);

      for (const hash of ['sha1', 'sha256', 'sha384', 'sha512'] as const) {
        const data = randomBytes(64);
        const signature = await keychain.sign(
          lucia.certDer,
          createHash(hash).update(data).digest(),
          hash,
        );
        expect(createVerify(hash).update(data).verify(lucia.certPem, signature)).toBe(true);
      }
      await expect(keychain.sign(demo.certDer, randomBytes(32), 'sha256')).rejects.toMatchObject({
        code: 'not_found',
      });

      // The whole flow on the real store: found, usable, and what `install` checks.
      const os = osCertificates(keychain);
      await os.install(lucia.p12, lucia.passphrase, lucia.certDer);
      expect(os.list()).toMatchObject([{ external: true }]);
    } finally {
      execFileSync('/usr/bin/security', ['delete-keychain', keychainPath]);
    }
  });

  // The app names no keychain: a .p12 must then go to the user's default one, since
  // SecItemImport stores it nowhere otherwise. Only looked up here, never written to.
  it('adds to the user’s default keychain when none is named', async () => {
    const keychain = await openKeychain();
    const expected = execFileSync('/usr/bin/security', ['default-keychain'], { encoding: 'utf8' })
      .trim()
      .replace(/^"|"$/g, '');
    expect(keychain.importPath()).toBe(expected);
  });
});
