import type { FormPrompt } from '@sa/shared';
import { expect, it } from 'vitest';
import { sanitizeResponse } from './prompts';

it('only accepts declared map place values from the renderer', () => {
  const prompt: FormPrompt = {
    kind: 'form',
    title: 'Centre',
    allowDismiss: false,
    fields: [
      {
        key: 'place',
        label: 'Place',
        type: 'map-options',
        required: true,
        options: [{ value: 'one', label: 'One', address: 'Demo' }],
      },
    ],
  };
  expect(
    sanitizeResponse(prompt, {
      kind: 'form',
      dismissed: false,
      savedToVault: [],
      values: { place: 'one' },
    }),
  ).toMatchObject({ values: { place: 'one' } });
  expect(() =>
    sanitizeResponse(prompt, {
      kind: 'form',
      dismissed: false,
      savedToVault: [],
      values: { place: 'invented' },
    }),
  ).toThrow();
});

it('ignores hidden map selections and enforces required visible selections', () => {
  const prompt: FormPrompt = {
    kind: 'form',
    title: 'Centre',
    allowDismiss: false,
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        required: true,
        options: [
          { value: 'online', label: 'Online' },
          { value: 'office', label: 'Office' },
        ],
      },
      {
        key: 'place',
        label: 'Place',
        type: 'map-options',
        required: true,
        visibleWhen: { field: 'mode', values: ['office'] },
        options: [{ value: 'one', label: 'One', address: 'Demo' }],
      },
    ],
  };
  expect(
    sanitizeResponse(prompt, {
      kind: 'form',
      dismissed: false,
      savedToVault: [],
      values: { mode: 'online', place: 'invented' },
    }),
  ).toMatchObject({ values: { mode: 'online' } });
  expect(() =>
    sanitizeResponse(prompt, {
      kind: 'form',
      dismissed: false,
      savedToVault: [],
      values: { mode: 'office' },
    }),
  ).toThrow();
});
