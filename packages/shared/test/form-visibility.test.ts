import { describe, expect, it } from 'vitest';
import { BridgeParams } from '../src/bridge';
import { FormPrompt, visibleFormFields } from '../src/chat';

const prompt = {
  kind: 'form',
  title: 'Acceso',
  fields: [
    {
      key: 'access',
      label: 'Acceso',
      type: 'select',
      options: [
        { value: 'sms', label: 'SMS' },
        { value: 'clave', label: 'Cl@ve' },
      ],
    },
    {
      key: 'phone',
      label: 'Móvil',
      type: 'phone',
      visibleWhen: { field: 'access', values: ['sms'] },
    },
  ],
};

describe('form visibility contracts', () => {
  it('accepts legacy forms and preserves conditional rules through bridge schemas', () => {
    expect(FormPrompt.parse({ ...prompt, fields: [prompt.fields[0]] }).fields).toHaveLength(1);
    expect(BridgeParams['prompt.form'].parse(prompt).fields[1]?.visibleWhen).toEqual({
      field: 'access',
      values: ['sms'],
    });
  });

  it.each([
    { field: 'missing', values: ['sms'] },
    { field: 'phone', values: ['sms'] },
    { field: 'access', values: ['SMS'] },
    { field: 'access', values: [] },
  ])('rejects invalid rules: %j', (visibleWhen) => {
    expect(
      FormPrompt.safeParse({
        ...prompt,
        fields: [prompt.fields[0], { ...prompt.fields[1], visibleWhen }],
      }).success,
    ).toBe(false);
  });

  it('rejects circular dependencies and duplicate keys', () => {
    const fields = ['a', 'b'].map((key, i) => ({
      key,
      label: key,
      type: 'select',
      options: [{ value: 'yes', label: 'Sí' }],
      visibleWhen: { field: i ? 'a' : 'b', values: ['yes'] },
    }));
    expect(FormPrompt.safeParse({ ...prompt, fields }).success).toBe(false);
    expect(
      FormPrompt.safeParse({ ...prompt, fields: [prompt.fields[0], prompt.fields[0]] }).success,
    ).toBe(false);
  });

  it('supports multiple applicable options and nested dropdowns without stale hidden values', () => {
    const fields = FormPrompt.parse({
      ...prompt,
      fields: [
        prompt.fields[0],
        {
          key: 'channel',
          label: 'Canal',
          type: 'select',
          options: [{ value: 'phone', label: 'Móvil' }],
          visibleWhen: { field: 'access', values: ['sms'] },
        },
        { ...prompt.fields[1], visibleWhen: { field: 'channel', values: ['phone'] } },
        {
          key: 'document',
          label: 'DNI',
          type: 'text',
          visibleWhen: { field: 'access', values: ['sms', 'clave'] },
        },
      ],
    }).fields;
    expect(
      visibleFormFields(fields, { access: 'sms', channel: 'phone' }).map((f) => f.key),
    ).toEqual(['access', 'channel', 'phone', 'document']);
    expect(
      visibleFormFields(fields, { access: 'clave', channel: 'phone' }).map((f) => f.key),
    ).toEqual(['access', 'document']);
    expect(visibleFormFields(fields, {}).map((f) => f.key)).toEqual(['access']);
  });
});
