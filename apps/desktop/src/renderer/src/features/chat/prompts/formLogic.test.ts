import type { FormField } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import {
  buildResponse,
  displayValue,
  documentScanChoice,
  fillDocumentFields,
  hasMissingDocumentFields,
  initialValues,
  validate,
} from './formLogic';

describe('form response privacy', () => {
  const fields: FormField[] = [
    {
      key: 'password',
      label: 'Password',
      type: 'secret',
      required: false,
      vaultKey: 'custom.password',
    },
    { key: 'name', label: 'Name', type: 'text', required: false, vaultKey: 'givenName' },
    { key: 'file', label: 'File', type: 'document', required: false, vaultKey: 'custom.file' },
  ];

  it('preserves password whitespace and always saves vault fields except secrets and documents', () => {
    expect(buildResponse(fields, { password: ' secret ', name: ' Ada ', file: 'doc-1' })).toEqual({
      kind: 'form',
      values: { password: ' secret ', name: 'Ada', file: 'doc-1' },
      dismissed: false,
      savedToVault: ['name'],
    });
  });

  it('masks secret answers even if the transcript contains an unredacted value', () => {
    expect(
      displayValue(
        fields[0]!,
        'private',
        { yes: 'yes', no: 'no', hidden: 'hidden', moreAppointments: 'more' },
        () => undefined,
      ),
    ).toBe('•••• (hidden)');
  });

  it('validates required multiselect answers and email shape before sending', () => {
    expect(
      validate(
        [
          { key: 'choices', label: 'Choices', type: 'multiselect', required: true },
          { key: 'email', label: 'Email', type: 'email', required: false },
        ],
        { choices: [], email: 'bad address' },
      ),
    ).toEqual({ choices: 'required', email: 'email' });
  });
});

describe('province fields', () => {
  const field: FormField = {
    key: 'province',
    label: 'Provincia',
    type: 'province',
    required: true,
    vaultKey: 'addressProvince',
  };

  it('prefills from saved data, matching common spellings', () => {
    const saved = (value: string) => [
      {
        key: 'addressProvince',
        label: 'Provincia',
        value,
        source: 'manual' as const,
        updatedAt: '',
      },
    ];
    expect(initialValues([field], saved('la coruña'))).toEqual({ province: 'A Coruña' });
    expect(initialValues([field], saved('Vizcaya'))).toEqual({ province: 'Bizkaia' });
    expect(initialValues([field], saved('Narnia'))).toEqual({ province: '' });
  });
});

describe('conditional inputs', () => {
  const fields: FormField[] = [
    {
      key: 'access',
      label: 'Acceso',
      type: 'select',
      required: true,
      defaultValue: 'clave',
      options: [
        { value: 'clave', label: 'Cl@ve Permanente' },
        { value: 'sms', label: 'SMS' },
      ],
    },
    {
      key: 'phone',
      label: 'Móvil',
      type: 'phone',
      required: true,
      vaultKey: 'phone',
      visibleWhen: { field: 'access', values: ['sms'] },
    },
  ];

  it('requires and validates conditional fields only for their applicable options', () => {
    expect(validate(fields, { access: 'clave', phone: 'invalid' })).toEqual({});
    expect(validate(fields, { access: 'sms' })).toEqual({ phone: 'required' });
    expect(validate(fields, { access: 'sms', phone: 'invalid' })).toEqual({ phone: 'phone' });
    expect(validate(fields, { access: 'sms', phone: '600000000' })).toEqual({});
  });

  it('omits hidden prefilled answers and vault saves after changing the dropdown', () => {
    const values = initialValues(fields, [
      { key: 'phone', value: '600000000', label: 'Móvil', source: 'manual', updatedAt: '' },
    ]);
    expect(buildResponse(fields, values)).toMatchObject({
      values: { access: 'clave' },
      savedToVault: [],
    });
    expect(buildResponse(fields, { ...values, access: 'sms' })).toMatchObject({
      values: { access: 'sms', phone: '600000000' },
      savedToVault: ['phone'],
    });
    expect(buildResponse(fields, { ...values, access: 'clave' }).values).toEqual({
      access: 'clave',
    });
  });
});

describe('document scanning in forms', () => {
  const fields: FormField[] = [
    { key: 'first', label: 'Nombre', type: 'text', required: true, vaultKey: 'givenName' },
    { key: 'birthDate', label: 'Nacimiento', type: 'date', required: false },
    { key: 'email', label: 'Correo', type: 'email', required: true, vaultKey: 'email' },
  ];
  it('offers scanning for empty required or optional document fields', () => {
    expect(hasMissingDocumentFields(fields, { first: ' ', birthDate: '' })).toBe(true);
    expect(
      hasMissingDocumentFields(fields, { first: 'Carmen', birthDate: '1990-01-01', email: '' }),
    ).toBe(false);
    expect(
      hasMissingDocumentFields(
        fields,
        initialValues(fields, [
          { key: 'givenName', label: 'Nombre', value: 'Carmen', source: 'scan', updatedAt: '' },
          {
            key: 'birthDate',
            label: 'Nacimiento',
            value: '1990-01-01',
            source: 'scan',
            updatedAt: '',
          },
        ]),
      ),
    ).toBe(false);
  });
  it('ignores hidden fields, secrets, files and unrelated explicit vault keys', () => {
    expect(
      hasMissingDocumentFields(
        [
          { ...fields[0]!, visibleWhen: { field: 'access', values: ['scan'] } },
          { ...fields[1]!, type: 'secret' },
          { ...fields[1]!, key: 'file', type: 'document', vaultKey: 'dniNumber' },
          { ...fields[1]!, vaultKey: 'custom.appointment_date' },
        ],
        {},
      ),
    ).toBe(false);
  });
  it('fills only missing answers present in this scan, keeping user edits', () => {
    const values = { first: 'Typed name', birthDate: '', email: '' };
    expect(
      fillDocumentFields(fields, values, [
        { key: 'givenName', value: 'Scanned name' },
        { key: 'birthDate', value: '1990-01-01' },
      ]),
    ).toEqual({ first: 'Typed name', birthDate: '1990-01-01', email: '' });
    expect(values.birthDate).toBe('');
  });
  it('matches select options and provinces, leaving unmatched selections empty', () => {
    const options: FormField[] = [
      {
        key: 'sex',
        label: 'Sexo',
        type: 'select',
        required: false,
        options: [{ value: 'female', label: 'F' }],
      },
      {
        key: 'province',
        label: 'Provincia',
        type: 'province',
        required: false,
        vaultKey: 'addressProvince',
      },
      {
        key: 'nation',
        label: 'Nacionalidad',
        type: 'select',
        required: false,
        vaultKey: 'nationality',
        options: [{ value: 'FR', label: 'Francia' }],
      },
    ];
    expect(
      fillDocumentFields(options, {}, [
        { key: 'sex', value: 'F' },
        { key: 'addressProvince', value: 'la coruña' },
        { key: 'nationality', value: 'ESP' },
      ]),
    ).toEqual({ sex: 'female', province: 'A Coruña' });
  });
  it('supports licence requests without mixing document fields', () => {
    const licence: FormField[] = [
      {
        key: 'licence',
        label: 'Permiso',
        type: 'text',
        required: true,
        vaultKey: 'drivingLicenceExpiry',
      },
    ];
    expect(hasMissingDocumentFields(licence, {})).toBe(true);
    expect(fillDocumentFields(licence, {}, [{ key: 'dniExpiry', value: 'TEST' }])).toEqual({});
    expect(
      fillDocumentFields(licence, {}, [{ key: 'drivingLicenceExpiry', value: 'LICENCE' }]),
    ).toEqual({ licence: 'LICENCE' });
  });
});

describe('document scan labels', () => {
  const field = (key: string): FormField => ({ key, label: key, type: 'text', required: false });
  it('uses the requested document for document-specific missing fields', () => {
    expect(documentScanChoice([field('tieNumber')], {})).toBe('dniTie');
    expect(documentScanChoice([field('passportNumber')], {})).toBe('passport');
    expect(documentScanChoice([field('drivingLicenceExpiry')], {})).toBe('drivingLicence');
  });
  it('applies priority and changes the choice as higher-priority answers are filled', () => {
    const fields = [field('passportNumber'), field('drivingLicenceExpiry'), field('dniNumber')];
    expect(documentScanChoice(fields, {})).toBe('dniTie');
    expect(documentScanChoice(fields, { dniNumber: 'TEST' })).toBe('drivingLicence');
    expect(documentScanChoice(fields, { dniNumber: 'TEST', drivingLicenceExpiry: 'TEST' })).toBe(
      'passport',
    );
    expect(documentScanChoice([field('givenName')], {})).toBe('dniTie');
  });
  it('ignores hidden, completed and unsupported fields', () => {
    const hidden = { ...field('dniNumber'), visibleWhen: { field: 'type', values: ['dni'] } };
    expect(documentScanChoice([hidden, field('passportNumber')], {})).toBe('passport');
    expect(
      documentScanChoice([field('passportNumber'), field('email')], { passportNumber: 'TEST' }),
    ).toBeUndefined();
  });
});
