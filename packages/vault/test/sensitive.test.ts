import { describe, expect, it } from 'vitest';
import { createTestKeyProvider, Vault } from '../src/index';
import { FIXTURE_PASSPHRASE, fixture } from './helpers/certs';
import { tempVaultDir } from './helpers/tmp';

describe('knownSensitiveValues', () => {
  it('returns personal values with useful variants, longest first', async () => {
    const vault = await Vault.open(await tempVaultDir(), createTestKeyProvider('pii'));
    await vault.setPersonal(
      [
        { key: 'givenName', value: 'Carmen' },
        { key: 'surname1', value: 'Española' },
        { key: 'surname2', value: 'Pérez' },
        { key: 'dniNumber', value: '01234567L' },
        { key: 'dniSupportNumber', value: 'CAA000000' },
        { key: 'birthDate', value: '1980-05-07' },
        { key: 'dniExpiry', value: '9999-01-01' },
        { key: 'sex', value: 'F' },
        { key: 'nationality', value: 'ESP' },
        { key: 'phone', value: '+34 612 345 678' },
        { key: 'email', value: 'Carmen.Espanola@Example.com' },
        { key: 'iban', value: 'ES91 2100 0418 4502 0005 1332' },
        { key: 'nuss', value: '28 12345678 40' },
        { key: 'addressStreet', value: 'Calle Mayor 5, 3º B' },
        { key: 'addressPostalCode', value: '28013' },
        { key: 'addressMunicipality', value: 'Alcobendas' },
        { key: 'addressProvince', value: 'Madrid' },
        { key: 'addressCountry', value: 'España' },
        { key: 'custom.apodo', value: 'Ca', label: 'Apodo' },
      ],
      'manual',
    );
    await vault.addClave({ username: 'X1234567L', password: 'not included' });
    await vault.addCertificate({
      fileName: 'c.p12',
      p12: fixture('ec-p256-openssl3.p12'),
      passphrase: FIXTURE_PASSPHRASE,
    });

    const values = vault.knownSensitiveValues();
    const expected = [
      // names
      'Carmen',
      'Española',
      'Pérez',
      'Española Pérez',
      'Carmen Española',
      'Española, Carmen',
      'Carmen Española Pérez',
      'Española Pérez Carmen',
      'Española Pérez, Carmen',
      // DNI with and without letter / separators / leading zero
      '01234567L',
      '01234567',
      '01234567-L',
      '01234567 L',
      '1234567L',
      'CAA000000',
      // dates
      '1980-05-07',
      '07/05/1980',
      '07-05-1980',
      '07051980',
      // phone
      '+34 612 345 678',
      '612345678',
      '+34612345678',
      '0034612345678',
      '612 345 678',
      '612 34 56 78',
      // email, IBAN, NUSS
      'Carmen.Espanola@Example.com',
      'carmen.espanola@example.com',
      'ES9121000418450200051332',
      'ES91 2100 0418 4502 0005 1332',
      '21000418450200051332',
      '281234567840',
      '28 12345678 40',
      '28/12345678/40',
      // address parts
      'Calle Mayor 5, 3º B',
      'Calle Mayor 5',
      '3º B',
      '28013',
      'Alcobendas',
      // Cl@ve username and certificate holder
      'X1234567L',
      'X1234567',
      'X-1234567-L',
      'JUAN MUESTRA SAMPLE',
    ];
    for (const value of expected) expect(values).toContain(value);
    for (const value of [
      'DNI',
      'ESP',
      'F',
      'Madrid',
      'España',
      'Ca',
      'not included',
      '9999-01-01',
    ]) {
      expect(values).not.toContain(value);
    }
    expect(values.every((v) => v.length >= 3)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
    for (let i = 1; i < values.length; i++) {
      expect(values[i - 1]!.length).toBeGreaterThanOrEqual(values[i]!.length);
    }
  });
});
