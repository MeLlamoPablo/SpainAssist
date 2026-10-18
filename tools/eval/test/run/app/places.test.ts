import { describe, expect, it } from 'vitest';
import { offlinePlaces } from '../../../src/run/app/places';

type Places = ReturnType<typeof offlinePlaces>;
type Home = Parameters<Places['home']>[0];

const home = (fields: { street?: string; postalCode?: string; municipality?: string }): Home =>
  fields as Home;

function inMainlandSpain(point: { latitude: number; longitude: number }): void {
  expect(point.latitude).toBeGreaterThanOrEqual(37);
  expect(point.latitude).toBeLessThanOrEqual(43);
  expect(point.longitude).toBeGreaterThanOrEqual(-8);
  expect(point.longitude).toBeLessThanOrEqual(2);
}

describe('offlinePlaces', () => {
  it('pins the same address on the same point, ignoring case and outer spaces', async () => {
    const places = offlinePlaces();
    const first = await places.place('Calle de Alcalá 1, Madrid');
    expect(first).toBeDefined();
    expect(await places.place('Calle de Alcalá 1, Madrid')).toEqual(first);
    expect(await places.place('  calle de alcalá 1, madrid ')).toEqual(first);
    // Another instance gives the same pins: nothing depends on state or the network.
    expect(await offlinePlaces().place('Calle de Alcalá 1, Madrid')).toEqual(first);
  });

  it('pins different addresses on different points, all inside mainland Spain', async () => {
    const places = offlinePlaces();
    const addresses = [
      'Calle de Alcalá 1, Madrid',
      'Avenida Diagonal 100, Barcelona',
      'Comisaría de Moratalaz, Madrid',
      'Plaza Mayor, Salamanca',
      'Calle Larios 5, Málaga',
    ];
    const points = await Promise.all(addresses.map((address) => places.place(address)));
    const keys = new Set(points.map((point) => `${point?.latitude},${point?.longitude}`));
    expect(keys.size).toBe(addresses.length);
    for (const point of points) inMainlandSpain(point!);
  });

  it('pins a home from its street, postal code and municipality', async () => {
    const places = offlinePlaces();
    const full = await places.home(
      home({ street: 'Calle Mayor 3', postalCode: '28013', municipality: 'Madrid' }),
    );
    expect(full).not.toBeNull();
    inMainlandSpain(full!);
    expect(
      await places.home(
        home({ street: 'Calle Mayor 3', postalCode: '28013', municipality: 'Madrid' }),
      ),
    ).toEqual(full);
    // The same text as an address lands on the same point.
    expect(await places.place('Calle Mayor 3, 28013, Madrid')).toEqual(full);
    const municipality = await places.home(home({ municipality: 'Sevilla' }));
    expect(municipality).not.toBeNull();
    expect(municipality).not.toEqual(full);
  });

  it('has no pin for an empty address or an empty home', async () => {
    const places = offlinePlaces();
    expect(await places.place('')).toBeUndefined();
    expect(await places.place('   ')).toBeUndefined();
    expect(await places.home(home({}))).toBeNull();
    expect(await places.home(home({ street: '', postalCode: '', municipality: '' }))).toBeNull();
  });

  it('rejects when the signal is already aborted', async () => {
    const places = offlinePlaces();
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(places.place('Calle de Alcalá 1, Madrid', controller.signal)).rejects.toThrow(
      'stopped',
    );
    await expect(places.home(home({ municipality: 'Madrid' }), controller.signal)).rejects.toThrow(
      'stopped',
    );
    // A live signal does not get in the way.
    expect(await places.place('Madrid', new AbortController().signal)).toBeDefined();
  });
});
