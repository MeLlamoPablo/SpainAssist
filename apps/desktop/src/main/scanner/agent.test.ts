import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { IDENTITY_DOCUMENT_FIELDS, identityDocumentPersonalInputs } from '../../identity-documents';
import {
  SCAN_DOCUMENT_KEYS_BY_TYPE,
  SCAN_PERSONAL_KEYS,
  SCAN_PERSONAL_KEYS_BY_TYPE,
  type ScanDocumentType,
  scanFieldKeys,
} from '../../scanner';
import {
  documentFieldsSchema,
  runScanAgent,
  scannerPrompt,
  scannerTools,
  validateFields,
} from './agent';

const image = 'data:image/jpeg;base64,/9j/2Q==';
const front = {
  givenName: 'Carmen',
  surname1: 'García',
  surname2: 'López',
  documentType: 'DNI',
  documentNumber: '99999999R',
  documentSupportNumber: 'CAA000000',
  birthDate: '1990-01-15',
  sex: 'F',
  nationality: 'ESP',
  documentExpiry: '2036-06-02',
  documentIssueDate: '2026-06-02',
  dniAccessNumber: '123456',
};
/** The same fields on a TIE or passport, which print no CAN for the phone. */
const { dniAccessNumber: _can, ...frontFields } = front;
const back = {
  birthPlace: 'Madrid',
  fatherName: 'Juan',
  motherName: 'Ana',
  addressStreet: 'Calle de Ejemplo, 12',
  addressMunicipality: 'Madrid',
  addressProvince: 'Madrid',
  dniIssuingTeam: '12345A6B7',
};
function reply(...calls: { name: string; arguments: unknown }[]): AssistantMessage {
  return {
    role: 'assistant',
    content: calls.map((call, i) => ({ type: 'toolCall', id: `call-${i}`, ...call })),
    api: 'openai-completions',
    provider: 'custom',
    model: 'mock',
    stopReason: 'toolUse',
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage;
}
function ports(responses: AssistantMessage[]) {
  const history: Message[] = [];
  const contexts: Context[] = [];
  return {
    history,
    contexts,
    complete: vi.fn(async (context: Context) => {
      contexts.push(structuredClone(context));
      return responses.shift()!;
    }),
    capture: vi.fn(async (_reason: string | undefined) => [image]),
    record: vi.fn(async (message: Message) => {
      history.push(structuredClone(message));
    }),
    signal: new AbortController().signal,
  };
}
const capture = () =>
  reply({
    name: 'capture_images',
    arguments: { reason: 'Show the requested document side.', success: true },
  });
const finish = (
  fields: Record<string, unknown> = { ...front, ...back },
  sides = ['front', 'back'],
  unavailable: string[] = [],
  permanent = false,
) => reply({ name: 'finish_scan', arguments: { fields, sides, unavailable, permanent } });

describe('tiny scan agent', () => {
  it('rejects passport support numbers and lets the agent correct the same scan', async () => {
    const passport = { ...frontFields, documentType: 'PASSPORT', documentNumber: 'ABC123456' };
    const { documentSupportNumber: _support, ...corrected } = passport;
    const p = ports([finish(passport, ['photo_page']), finish(corrected, ['photo_page'])]);
    const outcome = await runScanAgent('es', p);
    expect(p.complete).toHaveBeenCalledTimes(2);
    expect(outcome.fields.documentSupportNumber).toBeUndefined();
    const error = p.contexts[1]!.messages.at(-1)!;
    expect(error).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringContaining('documentSupportNumber is not available for PASSPORT'),
        },
      ],
    });
    expect(JSON.stringify(error)).not.toContain('CAA000000');
    const items = identityDocumentPersonalInputs(
      Object.entries(outcome.fields).map(([key, value]) => ({ key, value: value! })),
    );
    expect(items).toContainEqual({ key: 'passportNumber', value: 'ABC123456' });
    expect(items.some((item) => item.key === 'passportSupportNumber')).toBe(false);
    expect(validateFields(front).documentSupportNumber).toBe('CAA000000');
    expect(validateFields({ ...frontFields, documentType: 'TIE' }).documentSupportNumber).toBe(
      'CAA000000',
    );
  });
  it('requires both sides for TIE and retains the NIE as its document number', async () => {
    const tie = {
      ...frontFields,
      documentType: 'TIE',
      documentNumber: 'X1234567L',
      documentSupportNumber: 'E12345678',
    };
    const p = ports([finish(tie, ['front']), finish(tie, ['front', 'back'])]);
    expect(await runScanAgent('es', p)).toMatchObject({
      fields: { documentType: 'TIE', documentNumber: 'X1234567L' },
    });
    expect(p.contexts[1]!.messages.at(-1)).toMatchObject({
      role: 'toolResult',
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('both sides') }],
    });
  });

  it('accepts an omitted reason while waiting for the requested side', async () => {
    const p = ports([reply({ name: 'capture_images', arguments: { success: false } }), finish()]);
    await runScanAgent('es', p);
    expect(p.capture).toHaveBeenNthCalledWith(2, undefined, false);
  });

  it('samples again after guidance and retains a replayable transcript while removing old images from inference', async () => {
    const p = ports([
      reply(
        { name: 'record_fields', arguments: { fields: front, sides: ['front'] } },
        {
          name: 'capture_images',
          arguments: { reason: 'Show the requested document side.', success: true },
        },
      ),
      finish(),
    ]);
    expect(await runScanAgent('es', p)).toEqual({
      fields: { ...front, ...back },
      permanent: false,
    });
    expect(p.capture).toHaveBeenCalledTimes(2);
    expect(p.capture).toHaveBeenNthCalledWith(2, 'Show the requested document side.', true);
    const batches = p.history.filter(
      (m) =>
        (m.role === 'user' && Array.isArray(m.content)) ||
        (m.role === 'toolResult' && m.toolName === 'capture_images'),
    );
    expect(batches).toHaveLength(2);
    expect(
      batches.every((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image')),
    ).toBe(true);
    expect(JSON.stringify(p.contexts.at(-1))).toContain('Earlier sampled frames omitted');
  });
  it('sends every accepted snapshot in a batch to the next inference turn', async () => {
    const images = ['data:image/jpeg;base64,QUFB', 'data:image/jpeg;base64,QkJC', image];
    const p = ports([
      reply(
        { name: 'record_fields', arguments: { fields: {}, sides: [] } },
        { name: 'capture_images', arguments: { reason: 'Keep it still.', success: false } },
      ),
      finish(),
    ]);
    p.capture.mockResolvedValueOnce([image]).mockResolvedValueOnce(images);
    await runScanAgent('en', p);
    const batch = p.contexts[1]!.messages.at(-1)!;
    expect(Array.isArray(batch.content) && batch.content.filter((c) => c.type === 'image')).toEqual(
      images.map((dataUrl) => ({
        type: 'image',
        mimeType: 'image/jpeg',
        data: dataUrl.split(',')[1],
      })),
    );
  });
  it('passes failed-frame feedback to capture and requires an explicit boolean success', async () => {
    const p = ports([
      reply({
        name: 'capture_images',
        arguments: { reason: 'Show the original document.', success: false },
      }),
      finish(),
    ]);
    await runScanAgent('en', p);
    expect(p.capture).toHaveBeenNthCalledWith(2, 'Show the original document.', false);
    for (const success of [undefined, 'true', null]) {
      const invalid = ports([
        reply({ name: 'capture_images', arguments: { reason: 'Turn it over.', success } }),
        finish(),
      ]);
      await expect(runScanAgent('en', invalid)).resolves.toMatchObject({ fields: front });
      expect(invalid.contexts[1]!.messages.at(-1)).toMatchObject({
        role: 'toolResult',
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('retry the tool') }],
      });
      expect(invalid.capture).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects front-only completion and missing address, then permits a complete DNI', async () => {
    const p = ports([
      finish(undefined, ['front']),
      finish({ ...front, ...back, addressStreet: '' }),
      finish(),
    ]);
    await runScanAgent('es', p);
    const errors = p.history.filter((m) => m.role === 'toolResult' && m.isError);
    expect(errors).toHaveLength(2);
    expect(JSON.stringify(errors[0])).toContain('both sides');
  });
  it.each(['record_fields', 'finish_scan'])(
    'returns allowed document types after invalid %s arguments and continues the same scan',
    async (name) => {
      const { documentSupportNumber: _support, ...identity } = frontFields;
      const passport = { ...identity, documentType: 'PASSPORT' };
      const invalidFields = { ...passport, documentType: 'PASAPORTE' };
      const p = ports([
        reply({
          name,
          arguments: {
            fields: invalidFields,
            sides: ['photo_page'],
            ...(name === 'finish_scan' ? { unavailable: [], permanent: false } : {}),
          },
        }),
        finish(passport, ['photo_page']),
      ]);
      expect(await runScanAgent('es', p)).toEqual({
        fields: validateFields(passport),
        permanent: false,
      });
      expect(p.complete).toHaveBeenCalledTimes(2);
      expect(p.capture).toHaveBeenCalledTimes(1);
      const error = p.contexts[1]!.messages.at(-1)!;
      expect(error).toMatchObject({
        role: 'toolResult',
        toolName: name,
        isError: true,
        content: [
          {
            type: 'text',
            text: expect.stringContaining(
              'fields.documentType must be one of: "DNI", "TIE", "PASSPORT"',
            ),
          },
        ],
      });
      expect(JSON.stringify(error)).not.toContain('PASAPORTE');
      expect(JSON.stringify(error)).not.toContain(passport.documentNumber);
      const initial = p.contexts[1]!.messages.find((message) => message.role === 'user')!;
      expect(initial.content).toContainEqual({
        type: 'image',
        mimeType: 'image/jpeg',
        data: '/9j/2Q==',
      });
    },
  );
  it('advertises document type choices in both extraction tool schemas', () => {
    for (const name of ['record_fields', 'finish_scan']) {
      expect(scannerTools.find((tool) => tool.name === name)?.parameters).toMatchObject({
        properties: {
          fields: {
            properties: { documentType: { enum: ['DNI', 'TIE', 'PASSPORT', 'DRIVING_LICENCE'] } },
          },
        },
      });
    }
  });

  it('requires the DNI issue date to be read or explicitly confirmed absent', async () => {
    const withoutIssueDate = { ...front, ...back, documentIssueDate: undefined };
    const p = ports([finish(withoutIssueDate), finish({ documentIssueDate: '2026-06-02' })]);
    expect((await runScanAgent('es', p)).fields.documentIssueDate).toBe('2026-06-02');
    const errors = p.history.filter((m) => m.role === 'toolResult' && m.isError);
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).toContain('Still missing: documentIssueDate');

    const absent = ports([finish(withoutIssueDate, ['front', 'back'], ['documentIssueDate'])]);
    expect((await runScanAgent('es', absent)).fields.documentIssueDate).toBeUndefined();
  });
  it('requires the DNI issuing team and asks once more before accepting it as absent', async () => {
    const withoutTeam = { ...front, ...back, dniIssuingTeam: undefined };
    const missing = ports([finish(withoutTeam), finish({ dniIssuingTeam: '12345A6B7' })]);
    expect((await runScanAgent('es', missing)).fields.dniIssuingTeam).toBe('12345A6B7');
    expect(JSON.stringify(missing.history)).toContain('Still missing: dniIssuingTeam');

    const claimed = ports([
      finish(withoutTeam, ['front', 'back'], ['dniIssuingTeam']),
      finish({ dniIssuingTeam: '12345A6B7' }),
    ]);
    expect((await runScanAgent('es', claimed)).fields.dniIssuingTeam).toBe('12345A6B7');
    expect(JSON.stringify(claimed.history)).toContain('rotated 90°');

    const absent = ports([
      finish(withoutTeam, ['front', 'back'], ['dniIssuingTeam']),
      finish({}, ['front', 'back'], ['dniIssuingTeam']),
    ]);
    expect((await runScanAgent('es', absent)).fields.dniIssuingTeam).toBeUndefined();
  });
  it('reads the DNI CAN for the phone: six digits, or absent on older DNIs', async () => {
    expect(scannerPrompt('es')).toContain('dniAccessNumber is the DNI');
    const withoutCan = { ...front, ...back, dniAccessNumber: undefined };
    const missing = ports([finish(withoutCan), finish({ dniAccessNumber: '123456' })]);
    expect((await runScanAgent('es', missing)).fields.dniAccessNumber).toBe('123456');
    expect(JSON.stringify(missing.history)).toContain('Still missing: dniAccessNumber');

    const misread = ports([finish({ ...front, ...back, dniAccessNumber: '12345' }), finish()]);
    expect((await runScanAgent('es', misread)).fields.dniAccessNumber).toBe('123456');
    const errors = misread.history.filter((m) => m.role === 'toolResult' && m.isError);
    expect(JSON.stringify(errors)).toContain('dniAccessNumber');
    expect(JSON.stringify(errors)).not.toContain('12345"');

    const absent = ports([finish(withoutCan, ['front', 'back'], ['dniAccessNumber'])]);
    expect((await runScanAgent('es', absent)).fields.dniAccessNumber).toBeUndefined();
  });
  it('does not require absent address fields or a second surname on a passport', async () => {
    const fields = {
      ...frontFields,
      documentType: 'PASSPORT',
      surname2: undefined,
      documentSupportNumber: undefined,
    };
    const p = ports([finish(fields, ['photo_page'])]);
    expect((await runScanAgent('en', p)).fields.documentType).toBe('PASSPORT');
    expect(scannerPrompt('en')).toContain('photo/biodata page');
  });
  it('allows genuinely absent DNI fields and permanent expiry, but never a missing identity', async () => {
    // Issued permanent at 70+, before RD 255/2025 replaced permanent DNIs with dated ones.
    const fields = {
      ...front,
      ...back,
      fatherName: undefined,
      birthDate: '1940-01-15',
      documentIssueDate: '2015-06-02',
      documentExpiry: undefined,
    };
    const p = ports([finish(fields, ['front', 'back'], ['fatherName'], true)]);
    expect(await runScanAgent('es', p)).toMatchObject({ permanent: true });
    expect(() => validateFields({ ...front, givenName: undefined })).toThrow();
  });
  it('aborts while capture is pending without another model call', async () => {
    const controller = new AbortController();
    const p = ports([capture()]);
    p.signal = controller.signal;
    p.capture = vi.fn(async (_reason: string | undefined) => {
      controller.abort();
      return [image];
    });
    await expect(runScanAgent('es', p)).rejects.toThrow();
    expect(p.complete).not.toHaveBeenCalled();
  });
  it('remembers front fields in a checkpoint and finishes with only newly read back fields', async () => {
    const p = ports([
      reply(
        { name: 'record_fields', arguments: { fields: front, sides: ['front'] } },
        {
          name: 'capture_images',
          arguments: { reason: 'Show the requested document side.', success: true },
        },
      ),
      finish(back, ['back']),
    ]);
    expect((await runScanAgent('es', p)).fields).toEqual({ ...front, ...back });
    expect(JSON.stringify(p.contexts.at(-1))).toContain('99999999R');
  });
  it('rejects combining a different document with already recorded personal data', async () => {
    const p = ports([
      reply({ name: 'record_fields', arguments: { fields: front, sides: ['front'] } }),
      finish({ ...front, ...back, documentNumber: '12345678Z' }),
      finish(back, ['back']),
    ]);
    expect((await runScanAgent('es', p)).fields.documentNumber).toBe(front.documentNumber);
    expect(JSON.stringify(p.history)).toContain('Different document detected');
  });
  it('never returns DNI postal codes and removes only leading padding from address numbers', () => {
    expect(
      validateFields({
        ...front,
        addressStreet: 'C. Ejemplo 00026 P02 0044',
        addressPostalCode: '00026',
      }),
    ).toMatchObject({ addressStreet: 'C. Ejemplo 26 P2 44' });
    expect(validateFields({ ...front, addressPostalCode: '00026' })).not.toHaveProperty(
      'addressPostalCode',
    );
    expect(
      validateFields({ ...front, addressStreet: 'C. Ejemplo 00100 P00 0104' }).addressStreet,
    ).toBe('C. Ejemplo 100 P0 104');
    expect(validateFields({ ...front, addressStreet: 'C. Ejemplo 100 P2 44' }).addressStreet).toBe(
      'C. Ejemplo 100 P2 44',
    );
    expect(
      validateFields({
        ...frontFields,
        documentType: 'TIE',
        addressStreet: 'C. Ejemplo 00100',
        addressPostalCode: '08001',
      }).addressPostalCode,
    ).toBe('08001');
  });
  it('sanitizes postal-code mistakes in partial back-side checkpoints and final tool calls', async () => {
    const rawBack = {
      ...back,
      addressStreet: 'C. Ejemplo 00026 P02 0044',
      addressPostalCode: '00026',
    };
    const p = ports([
      reply(
        { name: 'record_fields', arguments: { fields: front, sides: ['front'] } },
        {
          name: 'capture_images',
          arguments: { reason: 'Show the requested document side.', success: true },
        },
      ),
      reply({ name: 'record_fields', arguments: { fields: rawBack, sides: ['back'] } }),
      finish(rawBack, ['back']),
    ]);
    const result = await runScanAgent('es', p);
    expect(result.fields.addressStreet).toBe('C. Ejemplo 26 P2 44');
    expect(result.fields).not.toHaveProperty('addressPostalCode');
    const records = p.history.filter(
      (m) => m.role === 'toolResult' && m.toolName === 'record_fields',
    );
    expect(JSON.stringify(records.at(-1))).not.toContain('addressPostalCode');
    expect(JSON.stringify(records.at(-1))).toContain('C. Ejemplo 26 P2 44');
    expect(JSON.stringify(p.contexts.at(-1))).not.toContain('"type":"image"');
  });
  it('normalizes printed uppercase names without changing identifiers or mixed-case spelling', () => {
    expect(
      validateFields({
        ...front,
        givenName: 'MARÍA DEL CARMEN',
        surname1: 'DE LA FUENTE',
        surname2: "O'NEILL-GARCÍA",
        fatherName: 'JOSÉ LUIS',
        motherName: 'McDonald',
      }),
    ).toMatchObject({
      givenName: 'María del Carmen',
      surname1: 'De la Fuente',
      surname2: "O'Neill-García",
      fatherName: 'José Luis',
      motherName: 'McDonald',
      documentNumber: front.documentNumber,
      documentSupportNumber: front.documentSupportNumber,
    });
    expect(validateFields({ givenName: 'ANA', motherName: 'ÉVA' }, false)).toEqual({
      givenName: 'Ana',
      motherName: 'Éva',
    });
  });
  it('normalizes uppercase names in checkpoints and completion', async () => {
    const p = ports([
      reply(
        {
          name: 'record_fields',
          arguments: {
            fields: { ...front, givenName: 'CARMEN', surname1: 'GARCÍA' },
            sides: ['front'],
          },
        },
        { name: 'capture_images', arguments: { reason: 'Dale la vuelta al DNI.', success: true } },
      ),
      finish({ ...back, fatherName: 'JUAN', motherName: 'ANA' }, ['back']),
    ]);
    expect((await runScanAgent('es', p)).fields).toEqual({ ...front, ...back });
    const checkpoints = p.history.filter(
      (m) => m.role === 'toolResult' && m.toolName === 'record_fields',
    );
    expect(JSON.stringify(checkpoints)).toContain('Carmen');
    expect(JSON.stringify(checkpoints)).not.toContain('CARMEN');
  });
  it('validates untrusted extracted fields, dates, province aliases and extra keys', () => {
    expect(validateFields({ ...front, addressProvince: 'Vizcaya' }).addressProvince).toBe(
      'Bizkaia',
    );
    expect(validateFields({ ...front, nationality: 'esp' }).nationality).toBe('ESP');
    expect(validateFields({ ...front, nationality: 'España' }).nationality).toBe('ESP');
    expect(() => validateFields({ ...front, nationality: 'Española' })).toThrow('alpha-3');
    expect(() => validateFields({ ...front, birthDate: '1990-02-31' })).toThrow();
    expect(() => validateFields({ ...front, apiKey: 'secret' })).toThrow();
    expect(() => validateFields({ ...front, documentType: 'OTHER' })).toThrow();
  });
});

/** The tool result the agent saw after its `turn`-th response (0-based). */
const toolResultAfter = (p: ReturnType<typeof ports>, turn: number) =>
  JSON.stringify(p.contexts[turn + 1]!.messages.at(-1));

describe('field validity rules', () => {
  it('rejects an invalid DNI letter and asks to read the number again, without the value', async () => {
    const p = ports([finish({ ...front, ...back, documentNumber: '99999999A' }), finish()]);
    expect((await runScanAgent('es', p)).fields.documentNumber).toBe(front.documentNumber);
    const correction = toolResultAfter(p, 0);
    expect(correction).toContain('"isError":true');
    expect(correction).toContain('documentNumber failed a validity check');
    expect(correction).toContain('bring the document closer');
    expect(correction).not.toContain('99999999A');
  });

  it('rejects DNI dates whose validity does not match the age at issue', async () => {
    // Issued at 36, so it lasts ten years, not five.
    const p = ports([finish({ ...front, ...back, documentExpiry: '2031-06-02' }), finish()]);
    expect((await runScanAgent('es', p)).fields.documentExpiry).toBe(front.documentExpiry);
    const correction = toolResultAfter(p, 0);
    expect(correction).toContain('birthDate, documentIssueDate, documentExpiry failed');
    expect(correction).not.toContain('2031-06-02');
  });

  it('rejects a checkpoint whose birth date is after the issue date', async () => {
    const misread = { ...front, birthDate: '2026-07-01' };
    const p = ports([
      reply({ name: 'record_fields', arguments: { fields: misread, sides: ['front'] } }),
      finish(),
    ]);
    await runScanAgent('es', p);
    const correction = toolResultAfter(p, 0);
    expect(correction).toContain('birthDate, documentIssueDate failed a validity check');
    expect(correction).not.toContain('2026-07-01');
  });
});

describe('Spanish driving licence scanning', () => {
  const licence = {
    documentType: 'DRIVING_LICENCE',
    givenName: 'Carmen',
    surname1: 'García',
    documentNumber: '12345678Z',
    birthDate: '1990-01-15',
    birthPlace: 'Madrid',
    documentIssueDate: '2020-01-01',
    documentExpiry: '2030-01-01',
    drivingCategories: [{ category: 'B', issueDate: '2010-01-01', expiry: '2030-01-01' }],
  };
  it('requires both sides and completes without inventing sex or nationality', async () => {
    const p = ports([capture(), finish(licence, ['front']), finish(licence, ['front', 'back'])]);
    const result = await runScanAgent('es', p);
    expect(p.complete).toHaveBeenCalledTimes(3);
    expect(result.fields.documentType).toBe('DRIVING_LICENCE');
    expect(result.fields.nationality).toBeUndefined();
  });
  it('rejects a licence number that is not a valid DNI or NIE', async () => {
    const sides = ['front', 'back'];
    const p = ports([
      finish({ ...licence, documentNumber: '12345678A' }, sides),
      finish(licence, sides),
    ]);
    expect((await runScanAgent('es', p)).fields.documentNumber).toBe('12345678Z');
    expect(toolResultAfter(p, 0)).toContain('documentNumber failed a validity check');
  });
});

describe('document field profiles', () => {
  it.each(Object.keys(SCAN_DOCUMENT_KEYS_BY_TYPE) as ScanDocumentType[])(
    'accepts only fields supported by %s and maps all accepted fields to its saved namespace',
    (type) => {
      const allowed = scanFieldKeys(type);
      for (const key of [
        ...SCAN_PERSONAL_KEYS,
        ...new Set(Object.values(SCAN_DOCUMENT_KEYS_BY_TYPE).flat()),
      ]) {
        const value = key === 'drivingCategories' ? [{ category: 'B' }] : 'PRIVATE-VALUE';
        const input = { documentType: type, [key]: value };
        // Date/sex validation is independent of document compatibility.
        if (allowed.includes(key)) {
          expect(documentFieldsSchema.safeParse(input).success).toBe(true);
          const mapped = identityDocumentPersonalInputs([
            { key: 'documentType', value: type },
            { key, value: JSON.stringify(value) },
          ]);
          // A licence number is its holder's DNI/NIE: the scanner reads it, the licence doesn't keep it.
          const dropped = type === 'DRIVING_LICENCE' && key === 'documentNumber';
          expect(mapped).toHaveLength(dropped ? 0 : 1);
          if (!dropped) expect(IDENTITY_DOCUMENT_FIELDS[type]).toContain(mapped[0]!.key);
        } else if (!(type === 'DNI' && key === 'addressPostalCode')) {
          expect(documentFieldsSchema.safeParse(input).success).toBe(false);
        }
      }
    },
  );

  it.each(['record_fields', 'finish_scan'])(
    'rejects fields in a %s checkpoint without a repeated type using the accumulated document type',
    async (name) => {
      const passport = {
        givenName: 'Carmen',
        surname1: 'García',
        birthDate: '1990-01-15',
        sex: 'F',
        nationality: 'ESP',
        documentType: 'PASSPORT',
        documentNumber: 'ABC123456',
        documentExpiry: '2036-06-02',
      };
      const p = ports([
        reply({ name: 'record_fields', arguments: { fields: passport, sides: ['photo_page'] } }),
        reply({
          name,
          arguments: {
            fields: { drivingCategories: [{ category: 'B', restrictions: 'PRIVATE-CATEGORY' }] },
            sides: ['photo_page'],
            ...(name === 'finish_scan' ? { unavailable: [], permanent: false } : {}),
          },
        }),
        finish({}, ['photo_page']),
      ]);
      const result = await runScanAgent('es', p);
      expect(result.fields).not.toHaveProperty('drivingCategories');
      const error = p.contexts[2]!.messages.at(-1)!;
      expect(error).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: expect.stringContaining('drivingCategories is not available for PASSPORT'),
          },
        ],
      });
      expect(JSON.stringify(error)).not.toContain('PRIVATE-CATEGORY');
    },
  );

  it('does not count a side from a rejected checkpoint as readable', async () => {
    const p = ports([
      reply({ name: 'record_fields', arguments: { fields: front, sides: ['front'] } }),
      reply({
        name: 'record_fields',
        arguments: {
          fields: { drivingCategories: [{ category: 'B', restrictions: 'PRIVATE-CATEGORY' }] },
          sides: ['back'],
        },
      }),
      finish({ ...front, ...back }, ['front']),
      finish({ ...front, ...back }, ['back']),
    ]);
    const result = await runScanAgent('es', p);
    expect(result.fields).not.toHaveProperty('drivingCategories');
    expect(p.contexts[3]!.messages.at(-1)).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Read both sides') }],
    });
  });

  it('requires a detected type before storing document-specific data and does not pollute a later passport', async () => {
    const passport = {
      givenName: 'Carmen',
      surname1: 'García',
      birthDate: '1990-01-15',
      sex: 'F',
      nationality: 'ESP',
      documentType: 'PASSPORT',
      documentNumber: 'ABC123456',
      documentExpiry: '2036-06-02',
    };
    const p = ports([
      reply({
        name: 'record_fields',
        arguments: { fields: { documentSupportNumber: 'PRIVATE-SUPPORT' }, sides: [] },
      }),
      finish(passport, ['photo_page']),
    ]);
    const result = await runScanAgent('es', p);
    expect(result.fields).not.toHaveProperty('documentSupportNumber');
    const error = p.contexts[1]!.messages.at(-1)!;
    expect(error).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringContaining(
            'Identify documentType before recording documentSupportNumber',
          ),
        },
      ],
    });
    expect(JSON.stringify(error)).not.toContain('PRIVATE-SUPPORT');
  });

  it('rejects unavailable fields from a different document type and permits a corrected completion', async () => {
    const passport = {
      givenName: 'Carmen',
      surname1: 'García',
      birthDate: '1990-01-15',
      sex: 'F',
      nationality: 'ESP',
      documentType: 'PASSPORT',
      documentNumber: 'ABC123456',
      documentExpiry: '2036-06-02',
    };
    const p = ports([
      finish(passport, ['photo_page'], ['documentSupportNumber']),
      finish({}, ['photo_page']),
    ]);
    await runScanAgent('es', p);
    expect(p.complete).toHaveBeenCalledTimes(2);
    expect(p.contexts[1]!.messages.at(-1)).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringContaining(
            'Unavailable fields do not belong to PASSPORT: documentSupportNumber',
          ),
        },
      ],
    });
  });

  it('advertises separate personal and document fields for each document', () => {
    const prompt = scannerPrompt('es');
    for (const type of Object.keys(SCAN_DOCUMENT_KEYS_BY_TYPE) as ScanDocumentType[]) {
      expect(prompt).toContain(
        `${type}: personal fields ${SCAN_PERSONAL_KEYS_BY_TYPE[type].join(', ')}`,
      );
    }
    for (const tool of scannerTools.filter((tool) =>
      ['record_fields', 'finish_scan'].includes(tool.name),
    )) {
      const schema = tool.parameters as {
        properties: { fields: { anyOf: { properties: Record<string, unknown> }[] } };
      };
      const passport = schema.properties.fields.anyOf[2]!;
      expect(passport.properties).toHaveProperty('passportPersonalNumber');
      expect(passport.properties).not.toHaveProperty('documentSupportNumber');
      expect(passport.properties).not.toHaveProperty('drivingCategories');
    }
  });
});
