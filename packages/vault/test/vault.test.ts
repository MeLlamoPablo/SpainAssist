import { link, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestKeyProvider, Vault, VaultError } from '../src/index';
import { tempVaultDir } from './helpers/tmp';

const keys = () => createTestKeyProvider('vault-tests');

async function openVault(dir?: string) {
  const d = dir ?? (await tempVaultDir());
  return { dir: d, vault: await Vault.open(d, keys()) };
}

async function expectVaultError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(VaultError);
  expect((error as VaultError).code).toBe(code);
  return error as VaultError;
}

describe('opening', () => {
  it('creates an empty vault with private permissions', async () => {
    const { dir, vault } = await openVault();
    expect(vault.overview()).toEqual({
      personal: [],
      documents: [],
      credentials: [],
      storage: { backend: 'test', secure: false, biometricAvailable: false },
    });
    expect(vault.overview({ biometricAvailable: true }).storage.biometricAvailable).toBe(true);
    expect(vault.storageInfo()).toEqual({ backend: 'test', secure: false });
    expect((await readdir(dir)).sort()).toEqual(['documents', 'key.bin', 'vault.bin']);
    if (process.platform !== 'win32') {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, 'documents'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, 'key.bin'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, 'vault.bin'))).mode & 0o777).toBe(0o600);
    }
  });

  it('never writes plaintext', async () => {
    const { dir, vault } = await openVault();
    await vault.setPersonal([{ key: 'givenName', value: 'Carmencita' }], 'manual');
    await vault.addClave({ username: '99999999R', password: 'SuperSecreta1' });
    await vault.setSecret('provider.openrouter', 'Clave de OpenRouter', 'sk-or-v1-abcdef');
    await vault.addDocument({
      name: 'padron.pdf',
      mimeType: 'application/pdf',
      source: 'user',
      bytes: Buffer.from('%PDF-1.7 Carmencita'),
    });
    const files = [join(dir, 'vault.bin'), join(dir, 'key.bin')];
    for (const name of await readdir(join(dir, 'documents')))
      files.push(join(dir, 'documents', name));
    for (const file of files) {
      const text = (await readFile(file)).toString('latin1');
      for (const secret of ['Carmencita', '99999999R', 'SuperSecreta1', 'sk-or-v1', 'PDF']) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('persists everything across reopen', async () => {
    const { dir, vault } = await openVault();
    await vault.setPersonal(
      [
        { key: 'givenName', value: 'Carmen' },
        { key: 'custom.mascota', value: 'Toby', label: 'Nombre de la mascota' },
      ],
      'manual',
    );
    const doc = await vault.addDocument({
      name: 'dni.jpg',
      mimeType: 'image/jpeg',
      source: 'scan',
      bytes: Buffer.from([1, 2, 3, 4]),
      procedureId: 'proc-1',
    });
    const clave = await vault.addClave({ username: '99999999R', password: 'pw' });
    await vault.setSecret('oauth.chatgpt', 'Sesión de ChatGPT', '{"token":"x"}');

    const reopened = await Vault.open(dir, keys());
    expect(reopened.overview()).toEqual(vault.overview());
    expect(await reopened.readDocument(doc.id)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(await reopened.getCredentialSecret(clave.id)).toEqual({
      kind: 'clave_permanente',
      username: '99999999R',
      password: 'pw',
    });
    expect(await reopened.getSecret('oauth.chatgpt')).toBe('{"token":"x"}');
  });

  it('reports a wrong key as corrupted', async () => {
    const { dir } = await openVault();
    await expectVaultError(Vault.open(dir, createTestKeyProvider('another seed')), 'corrupted');
  });

  it('reports a key provider that cannot encrypt as key_unavailable', async () => {
    const broken = {
      backend: 'broken',
      secure: true,
      encrypt: async () => {
        throw new Error('keychain locked');
      },
      decrypt: async () => Buffer.alloc(0),
    };
    await expectVaultError(Vault.open(await tempVaultDir(), broken), 'key_unavailable');
  });

  it('refuses to open when the key file is missing but data exists', async () => {
    const { dir } = await openVault();
    await rename(join(dir, 'key.bin'), join(dir, 'key.old'));
    await expectVaultError(Vault.open(dir, keys()), 'corrupted');
  });
});

describe('tamper detection', () => {
  it('detects a modified vault file', async () => {
    const { dir, vault } = await openVault();
    await vault.setPersonal([{ key: 'givenName', value: 'Carmen' }], 'manual');
    const file = join(dir, 'vault.bin');
    const bytes = await readFile(file);
    for (const position of [5, 10, 20, 40, bytes.length - 1]) {
      const copy = Buffer.from(bytes);
      copy[position]! ^= 0x01;
      await writeFile(file, copy);
      await expectVaultError(Vault.open(dir, keys()), 'corrupted');
    }
    await writeFile(file, bytes.subarray(0, bytes.length - 10)); // truncated
    await expectVaultError(Vault.open(dir, keys()), 'corrupted');
    await writeFile(file, bytes);
    expect((await Vault.open(dir, keys())).getPersonal('givenName')?.value).toBe('Carmen');
  });

  it('detects modified and swapped documents', async () => {
    const { dir, vault } = await openVault();
    const add = (text: string) =>
      vault.addDocument({
        name: `${text}.txt`,
        mimeType: 'text/plain',
        source: 'user',
        bytes: Buffer.from(text),
      });
    const a = await add('alpha');
    const b = await add('bravo');
    const pathA = join(dir, 'documents', `${a.id}.bin`);
    const pathB = join(dir, 'documents', `${b.id}.bin`);
    const original = await readFile(pathA);

    const modified = Buffer.from(original);
    modified[30]! ^= 0xff;
    await writeFile(pathA, modified);
    await expectVaultError(vault.readDocument(a.id), 'corrupted');

    // A valid file of another document must not be accepted under a different id.
    await writeFile(pathA, await readFile(pathB));
    await expectVaultError(vault.readDocument(a.id), 'corrupted');

    await writeFile(pathA, original);
    expect((await vault.readDocument(a.id)).toString()).toBe('alpha');
  });
});

describe('personal data', () => {
  it('saves, labels, orders, updates and deletes', async () => {
    const now = { t: new Date('2026-10-03T10:00:00Z') };
    const vault = await Vault.open(await tempVaultDir(), keys(), { now: () => now.t });
    const saved = await vault.setPersonal(
      [
        { key: 'custom.mascota', value: ' Toby ', label: 'Mascota' },
        { key: 'surname1', value: 'Española' },
        { key: 'givenName', value: 'Carmen' },
        { key: 'birthDate', value: '1980-01-01' },
        { key: 'dniNumber', value: '99.999.999-r' },
        { key: 'iban', value: 'es91 2100 0418 4502 0005 1332' },
      ],
      'scan',
    );
    expect(saved.map((i) => i.key)).toEqual([
      'givenName',
      'surname1',
      'birthDate',
      'dniNumber',
      'iban',
      'custom.mascota',
    ]);
    expect(vault.getPersonal('givenName')).toEqual({
      key: 'givenName',
      label: 'Nombre',
      value: 'Carmen',
      source: 'scan',
      updatedAt: '2026-10-03T10:00:00.000Z',
    });
    expect(vault.getPersonal('custom.mascota')).toMatchObject({ label: 'Mascota', value: 'Toby' });
    expect(vault.getPersonal('dniNumber')?.value).toBe('99999999R');
    expect(vault.getPersonal('iban')?.value).toBe('ES9121000418450200051332');

    now.t = new Date('2026-10-04T10:00:00Z');
    await vault.setPersonal([{ key: 'custom.mascota', value: 'Rex' }], 'agent'); // keeps label
    expect(vault.getPersonal('custom.mascota')).toMatchObject({
      label: 'Mascota',
      value: 'Rex',
      source: 'agent',
      updatedAt: '2026-10-04T10:00:00.000Z',
    });

    await vault.setPersonal([{ key: 'givenName', value: '   ' }], 'manual'); // empty = delete
    expect(vault.getPersonal('givenName')).toBeUndefined();
    await vault.deletePersonal(['surname1', 'not-there']);
    expect(vault.listPersonal().map((i) => i.key)).toEqual([
      'birthDate',
      'dniNumber',
      'iban',
      'custom.mascota',
    ]);
  });

  it('stores the option value of a select given its value or label', async () => {
    const { vault } = await openVault();
    await vault.setPersonal(
      [
        { key: 'nationality', value: 'España' },
        { key: 'sex', value: 'mujer' },
      ],
      'manual',
    );
    expect(vault.getPersonal('nationality')?.value).toBe('ESP');
    expect(vault.getPersonal('sex')?.value).toBe('F');
    await vault.setPersonal([{ key: 'nationality', value: 'morocco' }], 'manual');
    expect(vault.getPersonal('nationality')?.value).toBe('MAR');
  });

  it('stores driving licence categories as normalized JSON rows', async () => {
    const { vault } = await openVault();
    const row = (category: string) => ({
      category,
      issueDate: '2016-11-30',
      expiry: '2026-11-30',
      restrictions: '01.06',
    });
    await vault.setPersonal(
      [{ key: 'drivingLicenceCategories', value: JSON.stringify([row(' b ')]) }],
      'manual',
    );
    expect(vault.getPersonal('drivingLicenceCategories')?.value).toBe(JSON.stringify([row('B')]));
  });

  it('validates keys and values without echoing values', async () => {
    const { vault } = await openVault();
    const cases: Array<[unknown, string]> = [
      [{ key: 'favouriteColour', value: 'x' }, 'Unknown'],
      [{ key: 'custom.Bad Key', value: 'x', label: 'L' }, 'key'],
      [{ key: 'custom.nolabel', value: 'x' }, 'label'],
      [{ key: 'birthDate', value: '31/01/1980' }, 'date'],
      [{ key: 'birthDate', value: '1980-02-30' }, 'date'],
      [{ key: 'sex', value: 'Femenino' }, 'one of'],
      [{ key: 'nationality', value: 'Española' }, 'one of'],
      [{ key: 'email', value: 'carmen at example' }, 'email'],
      [{ key: 'phone', value: '12' }, 'phone'],
      [{ key: 'iban', value: 'ES00 2100 0418 4502 0005 1332' }, 'IBAN'],
      [{ key: 'givenName', value: 'a\u0000b' }, 'characters'],
      [{ key: 'givenName', value: 'x'.repeat(2001) }, 'long'],
      [{ key: 'givenName', value: 42 }, 'text'],
      [{ key: 'drivingLicenceNumber', value: '12345678Z' }, 'Unknown'],
      [{ key: 'drivingLicenceCategories', value: 'B: 2016-11-30' }, 'JSON list'],
      [
        { key: 'drivingLicenceCategories', value: '[{"category":"B","expiry":"30/11/2026"}]' },
        'JSON list',
      ],
    ];
    for (const [input, fragment] of cases) {
      const error = await expectVaultError(
        vault.setPersonal([input as never], 'manual'),
        'invalid_input',
      );
      expect(error.message).toContain(fragment);
      for (const secret of ['31/01/1980', 'carmen at example', 'ES00', '30/11/2026']) {
        expect(error.message).not.toContain(secret);
      }
    }
    await expectVaultError(vault.setPersonal([], 'telepathy' as never), 'invalid_input');
    // All or nothing: one bad item rejects the batch.
    await expectVaultError(
      vault.setPersonal(
        [
          { key: 'givenName', value: 'Carmen' },
          { key: 'birthDate', value: 'yesterday' },
        ],
        'manual',
      ),
      'invalid_input',
    );
    expect(vault.listPersonal()).toEqual([]);
  });
});

describe('documents', () => {
  it('adds, lists, filters, reads and deletes', async () => {
    const now = { t: new Date('2026-10-03T10:00:00Z') };
    const { dir } = await openVault();
    const vault = await Vault.open(dir, keys(), { now: () => now.t });
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const a = await vault.addDocument({
      name: 'C:\\Users\\carmen\\justificante.pdf',
      mimeType: 'Application/PDF',
      source: 'download',
      bytes: big,
      procedureId: 'renovar-dni',
    });
    now.t = new Date('2026-10-03T11:00:00Z');
    const b = await vault.addDocument({
      name: 'foto.png',
      mimeType: 'image/png',
      source: 'user',
      bytes: new Uint8Array([9, 8, 7]),
    });
    expect(a).toEqual({
      id: a.id,
      name: 'justificante.pdf',
      mimeType: 'application/pdf',
      size: big.length,
      source: 'download',
      procedureId: 'renovar-dni',
      createdAt: '2026-10-03T10:00:00.000Z',
    });
    expect(vault.listDocuments().map((d) => d.id)).toEqual([b.id, a.id]);
    expect(vault.listDocuments({ procedureId: 'renovar-dni' }).map((d) => d.id)).toEqual([a.id]);
    expect(vault.getDocument(a.id)?.name).toBe('justificante.pdf');
    expect((await vault.readDocument(a.id)).equals(big)).toBe(true);
    expect([...(await vault.readDocument(b.id))]).toEqual([9, 8, 7]);

    await vault.deleteDocument(a.id);
    expect(vault.getDocument(a.id)).toBeUndefined();
    await expectVaultError(vault.readDocument(a.id), 'not_found');
    await expectVaultError(vault.deleteDocument(a.id), 'not_found');
    expect(await readdir(join(dir, 'documents'))).toEqual([`${b.id}.bin`]);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'documents', `${b.id}.bin`))).mode & 0o777).toBe(0o600);
    }
  });

  it('validates document input', async () => {
    const { vault } = await openVault();
    const base = {
      name: 'a.pdf',
      mimeType: 'application/pdf',
      source: 'user' as const,
      bytes: Buffer.from('x'),
    };
    await expectVaultError(vault.addDocument({ ...base, name: '  ' }), 'invalid_input');
    await expectVaultError(vault.addDocument({ ...base, mimeType: 'pdf' }), 'invalid_input');
    await expectVaultError(vault.addDocument({ ...base, source: 'nsa' as never }), 'invalid_input');
    await expectVaultError(vault.addDocument({ ...base, bytes: 'x' as never }), 'invalid_input');
    await expectVaultError(vault.readDocument('../vault'), 'not_found');
    expect(vault.listDocuments()).toEqual([]);
  });
});

describe('credentials', () => {
  it('stores Cl@ve Permanente and Cl@ve Móvil with default policies', async () => {
    const now = { t: new Date('2026-10-03T10:00:00Z') };
    const vault = await Vault.open(await tempVaultDir(), keys(), { now: () => now.t });
    const clave = await vault.addClave({ username: ' 99999999-r ', password: 'Secreta 1' });
    expect(clave).toEqual({
      id: clave.id,
      kind: 'clave_permanente',
      label: 'Cl@ve Permanente',
      policy: 'auto',
      createdAt: '2026-10-03T10:00:00.000Z',
      usernameHint: '•••••999R',
    });
    const movil = await vault.addClaveMovil({ label: 'Móvil de Carmen' });
    expect(movil).toMatchObject({ kind: 'clave_movil', label: 'Móvil de Carmen', policy: 'auto' });
    expect(vault.listCredentials().map((c) => c.id)).toEqual([clave.id, movil.id]);
    expect(JSON.stringify(vault.overview())).not.toContain('Secreta');

    expect(await vault.getCredentialSecret(clave.id)).toEqual({
      kind: 'clave_permanente',
      username: '99999999R',
      password: 'Secreta 1',
    });
    expect(await vault.getCredentialSecret(movil.id)).toEqual({ kind: 'clave_movil' });

    expect((await vault.setCredentialPolicy(clave.id, 'ask')).policy).toBe('ask');
    now.t = new Date('2026-10-05T08:00:00Z');
    await vault.markCredentialUsed(clave.id);
    expect(vault.getCredential(clave.id)).toMatchObject({
      policy: 'ask',
      lastUsedAt: '2026-10-05T08:00:00.000Z',
    });

    await vault.deleteCredential(clave.id);
    expect(vault.getCredential(clave.id)).toBeUndefined();
    await expectVaultError(vault.getCredentialSecret(clave.id), 'not_found');
    await expectVaultError(vault.markCredentialUsed(clave.id), 'not_found');
    await expectVaultError(vault.setCredentialPolicy(movil.id, 'never' as never), 'invalid_input');
  });

  it('keeps one DNIe credential, with its certificate details once read, across reopen', async () => {
    const { dir, vault } = await openVault();
    const dnie = await vault.addDnie();
    expect(dnie).toMatchObject({ kind: 'dnie', label: 'DNIe con el móvil', policy: 'ask' });
    expect((await vault.addDnie()).id).toBe(dnie.id);
    expect(await vault.getCredentialSecret(dnie.id)).toEqual({ kind: 'dnie' });
    const info = {
      subject: 'CN=ESPAÑOL ESPAÑOL, JUAN (FIRMA)',
      issuer: 'CN=AC DNIE 004',
      serialNumber: '01',
      validFrom: '2024-01-01T00:00:00.000Z',
      validTo: '2029-01-01T00:00:00.000Z',
      holderName: 'JUAN ESPAÑOL ESPAÑOL',
      fingerprint: 'ab'.repeat(32),
    };
    expect((await vault.setDnieCertificate(dnie.id, info)).certificate).toEqual(info);
    const movil = await vault.addClaveMovil();
    await expectVaultError(vault.setDnieCertificate(movil.id, info), 'invalid_input');
    await expectVaultError(
      vault.setDnieCertificate(dnie.id, { ...info, fingerprint: 1 } as never),
      'invalid_input',
    );
    const reopened = await Vault.open(dir, keys());
    expect(reopened.getCredential(dnie.id)?.certificate?.holderName).toBe('JUAN ESPAÑOL ESPAÑOL');
  });

  it('saves, changes and forgets the DNIe PIN, never in a summary', async () => {
    const { dir, vault } = await openVault();
    const dnie = await vault.addDnie();
    expect(dnie.hasPin).toBe(false);
    const saved = await vault.setDniePin(dnie.id, 'abcd1234');
    expect(saved.hasPin).toBe(true);
    expect(JSON.stringify(vault.listCredentials())).not.toContain('abcd1234');
    expect(vault.knownSensitiveValues()).toContain('abcd1234');
    await vault.setDniePin(dnie.id, 'efgh5678');
    const reopened = await Vault.open(dir, keys());
    expect(await reopened.getCredentialSecret(dnie.id)).toEqual({ kind: 'dnie', pin: 'efgh5678' });
    expect((await reopened.setDniePin(dnie.id, null)).hasPin).toBe(false);
    expect(await reopened.getCredentialSecret(dnie.id)).toEqual({ kind: 'dnie' });
    await expectVaultError(reopened.setDniePin(dnie.id, 'short'), 'invalid_input');
    const movil = await reopened.addClaveMovil();
    await expectVaultError(reopened.setDniePin(movil.id, 'abcd1234'), 'invalid_input');
  });

  it('rejects Cl@ve usernames that are not a DNI/NIE', async () => {
    const { vault } = await openVault();
    await expectVaultError(
      vault.addClave({ username: '99999999A', password: 'x' }),
      'invalid_input',
    );
    await expectVaultError(
      vault.addClave({ username: '99999999R', password: '' }),
      'invalid_input',
    );
    expect((await vault.addClave({ username: 'x1234567l', password: 'x' })).usernameHint).toBe(
      '•••••567L',
    );
  });
});

describe('secrets', () => {
  it('sets, gets, lists (labels only) and deletes', async () => {
    const now = { t: new Date('2026-10-03T10:00:00Z') };
    const vault = await Vault.open(await tempVaultDir(), keys(), { now: () => now.t });
    await vault.setSecret('provider.openrouter', 'Clave de OpenRouter (bono)', 'sk-or-1');
    now.t = new Date('2026-10-03T11:00:00Z');
    await vault.setSecret('browser.state:proc-1', 'Sesión del navegador', '{"cookies":[]}');
    await vault.setSecret('provider.openrouter', 'Clave de OpenRouter', 'sk-or-2');
    expect(vault.listSecrets()).toEqual([
      {
        id: 'provider.openrouter',
        label: 'Clave de OpenRouter',
        createdAt: '2026-10-03T10:00:00.000Z',
      },
      {
        id: 'browser.state:proc-1',
        label: 'Sesión del navegador',
        createdAt: '2026-10-03T11:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(vault.overview())).not.toContain('sk-or');
    expect(await vault.getSecret('provider.openrouter')).toBe('sk-or-2');
    expect(await vault.getSecret('constructor')).toBeUndefined();
    await vault.deleteSecret('provider.openrouter');
    await vault.deleteSecret('provider.openrouter'); // idempotent
    expect(await vault.getSecret('provider.openrouter')).toBeUndefined();
    await expectVaultError(vault.setSecret('../x', 'L', 'v'), 'invalid_input');
    await expectVaultError(vault.setSecret('ok', ' ', 'v'), 'invalid_input');
  });
});

describe('concurrency', () => {
  it('serializes concurrent writes without losing any', async () => {
    const { dir, vault } = await openVault();
    await Promise.all([
      ...Array.from({ length: 40 }, (_, i) =>
        vault.setPersonal([{ key: `custom.k${i}`, value: `v${i}`, label: `Campo ${i}` }], 'agent'),
      ),
      ...Array.from({ length: 10 }, (_, i) => vault.setSecret(`s${i}`, `Secreto ${i}`, `${i}`)),
      ...Array.from({ length: 10 }, (_, i) =>
        vault.addDocument({
          name: `${i}.txt`,
          mimeType: 'text/plain',
          source: 'agent',
          bytes: Buffer.from(String(i)),
        }),
      ),
    ]);
    const reopened = await Vault.open(dir, keys());
    expect(reopened.listPersonal()).toHaveLength(40);
    expect(reopened.listSecrets()).toHaveLength(10);
    expect(reopened.listDocuments()).toHaveLength(10);
    expect(await readdir(join(dir, 'documents'))).toHaveLength(10);
  });

  it('keeps going after a failed operation', async () => {
    const { vault } = await openVault();
    const results = await Promise.allSettled([
      vault.setPersonal([{ key: 'givenName', value: 'Ana' }], 'manual'),
      vault.setPersonal([{ key: 'birthDate', value: 'nope' }], 'manual'),
      vault.setPersonal([{ key: 'surname1', value: 'Pérez' }], 'manual'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(vault.listPersonal().map((i) => i.key)).toEqual(['givenName', 'surname1']);
  });
});

describe('wipe and destroy', () => {
  it('overwrites and deletes every file, then starts over with a new key', async () => {
    const { dir, vault } = await openVault();
    await vault.setPersonal([{ key: 'givenName', value: 'Carmen' }], 'manual');
    await vault.addClave({ username: '99999999R', password: 'pw' });
    await vault.setSecret('s', 'Secreto', 'v');
    const doc = await vault.addDocument({
      name: 'a.txt',
      mimeType: 'text/plain',
      source: 'user',
      bytes: Buffer.alloc(4096, 0x41),
    });
    const docPath = join(dir, 'documents', `${doc.id}.bin`);
    const before = await readFile(docPath);
    const oldKey = await readFile(join(dir, 'key.bin'));
    // A hard link shares the inode: it shows whether the bytes were overwritten in place.
    const witness = join(dir, '..', 'witness.bin');
    await link(docPath, witness);

    await vault.wipe();

    const after = await readFile(witness);
    expect(after.length).toBe(before.length);
    expect(after.equals(before)).toBe(false);
    expect(await readdir(join(dir, 'documents'))).toEqual([]);
    expect((await readFile(join(dir, 'key.bin'))).equals(oldKey)).toBe(false);
    expect(vault.overview()).toMatchObject({
      personal: [],
      documents: [],
      credentials: [],
    });
    expect(vault.knownSensitiveValues()).toEqual([]);

    // Still usable, and reopens with the same key provider.
    await vault.setPersonal([{ key: 'givenName', value: 'Ana' }], 'manual');
    expect((await Vault.open(dir, keys())).getPersonal('givenName')?.value).toBe('Ana');
  });

  it('destroy() removes a vault that cannot be opened', async () => {
    const { dir, vault } = await openVault();
    await vault.addDocument({
      name: 'a.txt',
      mimeType: 'text/plain',
      source: 'user',
      bytes: Buffer.from('a'),
    });
    await writeFile(join(dir, 'unrelated.txt'), 'keep me');
    await expectVaultError(Vault.open(dir, createTestKeyProvider('wrong')), 'corrupted');
    await Vault.destroy(dir);
    expect((await readdir(dir)).sort()).toEqual(['unrelated.txt']);
    const fresh = await Vault.open(dir, createTestKeyProvider('wrong'));
    expect(fresh.listDocuments()).toEqual([]);
  });
});

describe('independent identity documents', () => {
  it('persists several documents, edits and deletes only the selected document', async () => {
    const dir = await tempVaultDir();
    const keyProvider = keys();
    const vault = await Vault.open(dir, keyProvider);
    await vault.setPersonal(
      [
        { key: 'givenName', value: 'Carmen' },
        { key: 'dniNumber', value: '12345678Z' },
        { key: 'dniExpiry', value: '2031-01-01' },
      ],
      'scan',
    );
    await vault.setPersonal(
      [
        { key: 'passportNumber', value: 'ABC123456' },
        { key: 'passportExpiry', value: '2036-01-01' },
        { key: 'tieNumber', value: 'X1234567L' },
      ],
      'scan',
    );
    await vault.setPersonal([{ key: 'passportExpiry', value: '2037-01-01' }], 'manual');
    await vault.deletePersonal(['tieNumber']);
    const reopened = await Vault.open(dir, keyProvider);
    expect(reopened.getPersonal('dniNumber')?.value).toBe('12345678Z');
    expect(reopened.getPersonal('dniExpiry')?.value).toBe('2031-01-01');
    expect(reopened.getPersonal('passportNumber')?.value).toBe('ABC123456');
    expect(reopened.getPersonal('passportExpiry')?.value).toBe('2037-01-01');
    expect(reopened.getPersonal('tieNumber')).toBeUndefined();
    expect(reopened.getPersonal('givenName')?.value).toBe('Carmen');
    expect(reopened.getPersonal('documentNumber')).toBeUndefined();
  });
});
