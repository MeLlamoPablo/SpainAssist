import { FormPrompt } from '@sa/shared';
import { describe, expect, it, vi } from 'vitest';
import { MapQuotaError } from './maps';
import { pendingFormPins } from './resolve-form';

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

describe('pins of a pending map form', () => {
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

  it('shows the form without maps when the lookups are used up', async () => {
    const lookup = vi.fn().mockRejectedValue(new MapQuotaError());
    const restored = new Map();
    expect(await pendingFormPins(prompt, restored, 'centre', lookup)).toBeNull();
    expect(await pendingFormPins(prompt, restored, 'centre', lookup)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
