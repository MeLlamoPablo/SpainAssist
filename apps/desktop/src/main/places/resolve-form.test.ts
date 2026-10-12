import { FormPrompt } from '@sa/shared';
import { describe, expect, it, vi } from 'vitest';
import { MapQuotaError } from './maps';
import { locateMapForm, pendingFormPins } from './resolve-form';

const prompt = FormPrompt.parse({
  kind: 'form',
  title: 'Choose',
  fields: [
    {
      key: 'centre',
      label: 'Centre',
      type: 'map-options',
      options: [
        { value: 'one', label: 'Clinic', address: 'Calle Feria 1, Sevilla' },
        { value: 'two', label: 'Second clinic', address: 'Demo 10, Sevilla' },
      ],
    },
  ],
});
const match = { latitude: 37.38, longitude: -5.98 };

describe('check map form', () => {
  it('looks up each street address once, returns the pins and leaves the form untouched', async () => {
    const before = structuredClone(prompt);
    const lookup = vi.fn().mockResolvedValue(match);
    const pins = await locateMapForm(prompt, lookup, new AbortController().signal);
    expect(pins.get('centre')).toEqual([match, match]);
    expect(lookup.mock.calls.map(([address]) => address)).toEqual([
      'Calle Feria 1, Sevilla',
      'Demo 10, Sevilla',
    ]);
    expect(prompt).toEqual(before);
  });

  it('returns failed place identifiers and address-research instructions instead of a partial form', async () => {
    const lookup = vi.fn().mockResolvedValueOnce(match).mockResolvedValueOnce(undefined);
    await expect(locateMapForm(prompt, lookup, new AbortController().signal)).rejects.toThrow(
      /centre\/two.*No form was shown.*street addresses.*retry ask_user/s,
    );
  });

  it('sanitizes service failures and stops after an abort', async () => {
    await expect(
      locateMapForm(
        prompt,
        vi.fn().mockRejectedValue(new Error('raw URL')),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Place lookup unavailable. No form was shown.');
    const controller = new AbortController();
    const lookup = vi.fn(async () => {
      controller.abort();
      return match;
    });
    await expect(locateMapForm(prompt, lookup, controller.signal)).rejects.toThrow();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('reuses the pins of a pending form, and looks up a restored one only once', async () => {
    const lookup = vi.fn().mockResolvedValue(match);
    const known = new Map([['centre', [match, null]]]);
    expect(await pendingFormPins(prompt, known, 'centre', lookup)).toEqual([match, null]);
    expect(lookup).not.toHaveBeenCalled();
    const restored = new Map();
    expect(await pendingFormPins(prompt, restored, 'centre', lookup)).toEqual([match, match]);
    expect(await pendingFormPins(prompt, restored, 'centre', lookup)).toEqual([match, match]);
    expect(lookup).toHaveBeenCalledTimes(2);
    await expect(pendingFormPins(prompt, restored, 'other', lookup)).rejects.toThrow();
  });

  it('reuses the results of an earlier attempt and keeps the new ones', async () => {
    const known = new Map([['Calle Feria 1, Sevilla', match]]);
    const lookup = vi.fn().mockResolvedValue(undefined);
    await expect(
      locateMapForm(prompt, lookup, new AbortController().signal, known),
    ).rejects.toThrow(/centre\/two/);
    expect(lookup.mock.calls.map(([address]) => address)).toEqual(['Demo 10, Sevilla']);
    expect([...known]).toEqual([
      ['Calle Feria 1, Sevilla', match],
      ['Demo 10, Sevilla', undefined],
    ]);
  });

  it('shows the form without maps when the lookups are used up', async () => {
    const lookup = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new MapQuotaError());
    const pins = await locateMapForm(prompt, lookup, new AbortController().signal);
    expect([...pins]).toEqual([['centre', null]]);
    const restored = new Map();
    expect(await pendingFormPins(prompt, restored, 'centre', lookup)).toBeNull();
    expect(await pendingFormPins(prompt, restored, 'centre', lookup)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(4);
  });
});
