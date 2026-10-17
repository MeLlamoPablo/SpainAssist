import { describe, expect, it } from 'vitest';
import {
  findOption,
  type PromptField,
  resolveFormAction,
  selectValues,
  validateFormValues,
} from '../../src/answers/form';

const fields: PromptField[] = [
  { key: 'nombre', type: 'text', label: 'Nombre' },
  { key: 'notas', type: 'textarea', label: 'Notas' },
  { key: 'edad', type: 'number', label: 'Edad' },
  { key: 'nacimiento', type: 'date', label: 'Nacimiento' },
  { key: 'correo', type: 'email', label: 'Correo' },
  { key: 'telefono', type: 'phone', label: 'Teléfono' },
  { key: 'provincia', type: 'province', label: 'Provincia' },
  { key: 'acepto', type: 'boolean', label: 'Acepto' },
  {
    key: 'metodo',
    type: 'select',
    label: 'Método',
    options: [
      { value: 'cp', label: 'Cl@ve Permanente' },
      { value: 'cm', label: 'Cl@ve Móvil' },
    ],
  },
  {
    key: 'canales',
    type: 'multiselect',
    label: 'Canales',
    options: [
      { value: 'email', label: 'Correo electrónico' },
      { value: 'sms', label: 'SMS' },
    ],
  },
  { key: 'codigo', type: 'secret', label: 'Código', secret: true },
  { key: 'dni', type: 'document', label: 'DNI escaneado' },
];

describe('validateFormValues', () => {
  it('accepts valid values and normalises them', () => {
    const result = validateFormValues(fields, {
      nombre: '  Lucía ',
      notas: 'Sin notas',
      edad: 35,
      nacimiento: '23/05/1991',
      correo: 'lucia@example.com',
      telefono: '+34 600 123 456',
      provincia: 'málaga',
      acepto: 'sí',
      metodo: 'Cl@ve Permanente',
      canales: ['SMS', 'correo electronico'],
    });
    expect(result.issues).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.values).toEqual({
      nombre: 'Lucía',
      notas: 'Sin notas',
      edad: '35',
      nacimiento: '1991-05-23',
      correo: 'lucia@example.com',
      telefono: '+34 600 123 456',
      provincia: 'Málaga',
      acepto: true,
      metodo: 'cp',
      canales: ['sms', 'email'],
    });
  });

  it('never fills secret or document fields and drops unknown keys', () => {
    const result = validateFormValues(fields, {
      codigo: '123456',
      dni: 'doc-1',
      inventado: 'x',
      nombre: 'Lucía',
    });
    expect(result.values).toEqual({ nombre: 'Lucía' });
    expect(result.ignored.sort()).toEqual(['codigo', 'dni', 'inventado']);
  });

  it('flags values that do not fit their field', () => {
    const result = validateFormValues(fields, {
      edad: 'treinta',
      nacimiento: '31/02/2020',
      correo: 'sin-arroba',
      telefono: '123',
      provincia: 'Atlantis',
      acepto: 'quizá',
      metodo: 'certificado',
      canales: ['sms', 'paloma'],
      nombre: 'x'.repeat(501),
    });
    expect(result.values).toEqual({});
    expect(result.issues.map((i) => i.split(':')[0]).sort()).toEqual([
      'acepto',
      'canales',
      'correo',
      'edad',
      'metodo',
      'nacimiento',
      'nombre',
      'provincia',
      'telefono',
    ]);
    expect(result.issues.find((i) => i.startsWith('metodo'))).toContain('not one of the options');
  });

  it('skips empty answers instead of flagging them', () => {
    const result = validateFormValues(fields, { nombre: '', edad: null, correo: undefined });
    expect(result).toEqual({ values: {}, issues: [], ignored: [] });
  });

  it('accepts dates written as dd/mm/yyyy, dd-mm-yyyy and ISO, only if they exist', () => {
    const date = (raw: string) => validateFormValues(fields, { nacimiento: raw }).values.nacimiento;
    expect(date('1991-05-23')).toBe('1991-05-23');
    expect(date('3-1-2000')).toBe('2000-01-03');
    expect(date('1991-13-01')).toBeUndefined();
    expect(date('29/02/2024')).toBe('2024-02-29');
    expect(date('29/02/2023')).toBeUndefined();
  });

  it('accepts booleans in several spellings', () => {
    const flag = (raw: unknown) => validateFormValues(fields, { acepto: raw }).values.acepto;
    expect(flag(true)).toBe(true);
    expect(flag('Sí')).toBe(true);
    expect(flag('yes')).toBe(true);
    expect(flag('No')).toBe(false);
    expect(flag(false)).toBe(false);
    expect(flag(0)).toBeUndefined();
  });

  it('accepts a comma separated string for a multiselect', () => {
    expect(validateFormValues(fields, { canales: 'sms, email' }).values.canales).toEqual([
      'sms',
      'email',
    ]);
    expect(validateFormValues(fields, { canales: [] }).issues).toHaveLength(1);
  });
});

describe('findOption', () => {
  const select = fields.find((f) => f.key === 'metodo')!;
  it('finds an option by value or label, ignoring case and accents', () => {
    expect(findOption(select, 'cp')).toBe('cp');
    expect(findOption(select, 'CL@VE MOVIL')).toBe('cm');
    expect(findOption(select, 'nope')).toBeUndefined();
    expect(findOption({ key: 'x', type: 'text', label: 'x' }, 'cp')).toBeUndefined();
  });
});

describe('selectValues', () => {
  it('sets the first field with a matching option, as its value', () => {
    expect(selectValues(fields, 'cl@ve\\s*permanente')).toEqual({ metodo: 'cp' });
    expect(selectValues(fields, 'cl@ve movil')).toEqual({ metodo: 'cm' });
  });

  it('wraps the value for a multiselect', () => {
    expect(selectValues(fields, '^sms$')).toEqual({ canales: ['sms'] });
  });

  it('is undefined when no option matches and skips secret fields', () => {
    expect(selectValues(fields, 'certificado')).toBeUndefined();
    expect(
      selectValues(
        [
          {
            key: 's',
            type: 'secret',
            label: 's',
            secret: true,
            options: [{ value: 'a', label: 'a' }],
          },
        ],
        'a',
      ),
    ).toBeUndefined();
  });
});

describe('resolveFormAction', () => {
  it('turns a select action into the option value', () => {
    expect(
      resolveFormAction({ type: 'select', optionLabel: 'cl[@a]ve\\s*permanente' }, { fields }),
    ).toEqual({
      values: { metodo: 'cp' },
      issues: [],
      ignored: [],
    });
  });

  it('explains a select action that matches no option', () => {
    const result = resolveFormAction({ type: 'select', optionLabel: 'certificado' }, { fields });
    expect(result.values).toEqual({});
    expect(result.issues).toEqual(['no option matches /certificado/']);
    expect(resolveFormAction({ type: 'select', optionLabel: 'x' }, {}).issues).toHaveLength(1);
  });

  it('validates a values action against the fields', () => {
    const result = resolveFormAction(
      { type: 'values', values: { nombre: 'Lucía', metodo: 'cm', extra: 'x', edad: 'mucha' } },
      { fields },
    );
    expect(result.values).toEqual({ nombre: 'Lucía', metodo: 'cm' });
    expect(result.ignored).toEqual(['extra']);
    expect(result.issues).toHaveLength(1);
  });
});
