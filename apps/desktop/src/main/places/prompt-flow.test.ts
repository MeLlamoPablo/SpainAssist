import { FormPrompt } from '@sa/shared';
import { describe, expect, it, vi } from 'vitest';
import { type BridgeHandlerDeps, createBridgeHandlers } from '../bridge/handlers';
import { MapQuotaError } from './maps';
import type { PlaceLookup } from './resolve-form';

const form = FormPrompt.parse({
  title: 'Choose a centre',
  kind: 'form',
  fields: [
    {
      key: 'centre',
      label: 'Centre',
      type: 'map-options',
      options: [{ value: 'one', label: 'Demo clinic', address: 'Calle Falsa 1, Sevilla' }],
    },
  ],
});
const ctx = { procedureId: 'demo', signal: new AbortController().signal };
function setup(placeLookup: PlaceLookup) {
  const ask = vi.fn().mockResolvedValue({
    kind: 'form',
    values: { centre: 'one' },
    dismissed: false,
    savedToVault: [],
  });
  const logger = { info: vi.fn() };
  const deps = { placeLookup, prompts: { ask }, logger } as unknown as BridgeHandlerDeps;
  return { ask, handler: createBridgeHandlers(deps)['prompt.form'] };
}

describe('map form bridge', () => {
  it('returns lookup failure to the agent without publishing a prompt', async () => {
    const { ask, handler } = setup(vi.fn().mockResolvedValue(undefined));
    await expect(handler(form, ctx)).rejects.toMatchObject({ code: 'not_found' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('publishes the agent form without map data and returns only the selected value', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ latitude: 37.38, longitude: -5.98 });
    const { ask, handler } = setup(lookup);
    await expect(handler(form, ctx)).rejects.toThrow(
      'find their street addresses and municipality',
    );
    const repaired = FormPrompt.parse({
      ...form,
      fields: [
        {
          ...form.fields[0],
          options: [{ value: 'one', label: 'Demo clinic', address: 'Demo 10, Sevilla' }],
        },
      ],
    });
    const response = await handler(repaired, ctx);
    expect(ask).toHaveBeenCalledTimes(1);
    // Mapbox results are temporary: the published (and saved) prompt is the agent's own, and
    // the pins travel separately, kept in memory with the pending prompt.
    expect(ask.mock.calls[0][1]).toEqual(repaired);
    expect(JSON.stringify(ask.mock.calls[0][1])).not.toContain('37.38');
    expect(ask.mock.calls[0][2].mapPins.get('centre')).toEqual([
      { latitude: 37.38, longitude: -5.98 },
    ]);
    expect(response.values).toEqual({ centre: 'one' });
    expect(lookup.mock.calls.map(([address]) => address)).toEqual([
      'Calle Falsa 1, Sevilla',
      'Demo 10, Sevilla',
    ]);
  });

  it('returns unavailable to the agent without publishing a prompt on a network failure', async () => {
    const { ask, handler } = setup(vi.fn().mockRejectedValue(new Error('unavailable')));
    await expect(handler(form, ctx)).rejects.toMatchObject({ code: 'unavailable' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('looks up only the changed addresses when the agent retries a form', async () => {
    const two = FormPrompt.parse({
      ...form,
      fields: [
        {
          ...form.fields[0],
          options: [
            { value: 'one', label: 'Demo clinic', address: 'Calle Falsa 1, Sevilla' },
            { value: 'two', label: 'Other clinic', address: 'C/ M.ª Demo 2, Sevilla' },
          ],
        },
      ],
    });
    const pin = { latitude: 37.38, longitude: -5.98 };
    const lookup = vi.fn(async (address: string) => (address.includes('M.ª') ? undefined : pin));
    const { ask, handler } = setup(lookup);
    await expect(handler(two, ctx)).rejects.toMatchObject({ code: 'not_found' });
    const fixed = structuredClone(two);
    fixed.fields[0]!.options![1]!.address = 'Calle María Demo 2, Sevilla';
    await handler(fixed, ctx);
    expect(lookup.mock.calls.map(([address]) => address)).toEqual([
      'Calle Falsa 1, Sevilla',
      'C/ M.ª Demo 2, Sevilla',
      'Calle María Demo 2, Sevilla',
    ]);
    expect(ask.mock.calls[0][2].mapPins.get('centre')).toEqual([pin, pin]);
    // A shown form ends the retry: the next form looks everything up again.
    await handler(fixed, ctx);
    expect(lookup).toHaveBeenCalledTimes(5);
    // Results are kept per procedure.
    await expect(handler(two, { ...ctx, procedureId: 'other' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(lookup).toHaveBeenCalledTimes(7);
  });

  it('shows the form with a list and no map when the lookups are used up', async () => {
    const { ask, handler } = setup(vi.fn().mockRejectedValue(new MapQuotaError()));
    const response = await handler(form, ctx);
    expect(response.values).toEqual({ centre: 'one' });
    expect([...ask.mock.calls[0][2].mapPins]).toEqual([['centre', null]]);
  });
});
