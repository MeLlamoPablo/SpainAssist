import { describe, expect, it, vi } from 'vitest';
import { createMaps, MapQuotaError } from './maps';

const feature = (town: string, latitude = 37.39, extra: Record<string, unknown> = {}) => ({
  properties: {
    feature_type: 'address',
    coordinates: { latitude, longitude: -5.99 },
    context: { country: { country_code: 'ES' }, place: { name: town } },
    ...extra,
  },
});
/** A fake maps server: one Mapbox response per request, repeating the last. */
function service(...responses: unknown[][]) {
  let call = 0;
  return vi.fn<typeof fetch>().mockImplementation(async () => {
    const features = responses[Math.min(call++, responses.length - 1)];
    return new Response(JSON.stringify({ features }));
  });
}
const ENDPOINT = 'https://maps.test';
const access = async () => ({ apiKey: 'sk-user-key' });
const mapbox = (fetchImpl: typeof fetch) =>
  createMaps({ endpoint: ENDPOINT, access, fetch: fetchImpl });
const url = (fetchImpl: ReturnType<typeof service>, call = 0) =>
  new URL(String(fetchImpl.mock.calls[call]![0]));

describe('map place lookup', () => {
  it('sends the address as written to our server and picks the match in its town', async () => {
    const fetchImpl = service([feature('Cañada Rosal', 1), feature('Sevilla', 37.36)]);
    expect(await mapbox(fetchImpl).place('Calle 8 de Marzo 5, Sevilla')).toEqual({
      latitude: 37.36,
      longitude: -5.99,
    });
    const request = url(fetchImpl);
    expect(`${request.origin}${request.pathname}`).toBe(`${ENDPOINT}/v1/geocode`);
    // Only the address leaves the app; the server fixes the Mapbox parameters and token.
    expect([...request.searchParams.keys()]).toEqual(['q']);
    expect(request.searchParams.get('q')).toBe('Calle 8 de Marzo 5, Sevilla');
    const init = fetchImpl.mock.calls[0]![1];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-user-key');
    expect(init?.redirect).toBe('error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Place names are never searched: only addresses and streets.
    expect(
      await mapbox(service([])).place('CERMA Reconocimientos Médicos, Sevilla'),
    ).toBeUndefined();
  });

  it('matches towns whole and without accents, and drops foreign results', async () => {
    const malaga = service([feature('Málaga')]);
    expect(await mapbox(malaga).place('C. Larios 5, MALAGA')).toBeDefined();
    const ronda = service([feature('Ronda')]);
    expect(await mapbox(ronda).place('Rondas 5, Sevilla')).toBeUndefined();
    const foreign = feature('Sevilla');
    foreign.properties.context.country.country_code = 'PT';
    expect(await mapbox(service([foreign])).place('Rua 5, Sevilla')).toBeUndefined();
  });
});

describe('map home lookup', () => {
  it('sends the saved address unchanged and checks the municipality', async () => {
    const fetchImpl = service([feature('Sevilla', 37.3985)]);
    const home = { street: 'C. Santa Ana 26 P2 44', postalCode: '41002', municipality: 'Sevilla' };
    expect(await mapbox(fetchImpl).home(home)).toEqual({ latitude: 37.3985, longitude: -5.99 });
    expect(url(fetchImpl).searchParams.get('q')).toBe('C. Santa Ana 26 P2 44, 41002 Sevilla');
    expect(await mapbox(service([feature('Dos Hermanas')])).home(home)).toBeNull();
  });
});

describe('map lookup errors', () => {
  it('needs a server and a gateway key, and never exposes the address', async () => {
    const fetchImpl = service([feature('Sevilla')]);
    const noServer = createMaps({ access, fetch: fetchImpl });
    await expect(noServer.place('Calle 1, Sevilla')).rejects.toThrow('Map lookup unavailable.');
    const noKey = createMaps({
      endpoint: ENDPOINT,
      access: async () => undefined,
      fetch: fetchImpl,
    });
    await expect(noKey.place('Calle 1, Sevilla')).rejects.toThrow('Map lookup unavailable.');
    expect(fetchImpl).not.toHaveBeenCalled();
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new Error('?q=private'));
    await expect(mapbox(failing).place('private')).rejects.toThrow(/^Map lookup unavailable\.$/);
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(mapbox(denied).place('Calle 1, Sevilla')).rejects.toThrow(
      'Map lookup unavailable.',
    );
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ features: [{ properties: {} }] })));
    await expect(mapbox(malformed).place('Calle 1, Sevilla')).rejects.toThrow(
      'Invalid map lookup response.',
    );
  });

  it('tells used-up lookups apart from a busy server', async () => {
    const reply = (code: string) =>
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { code, message: 'x' } }), { status: 429 }),
        );
    await expect(mapbox(reply('quota_exceeded')).place('Calle 1, Sevilla')).rejects.toBeInstanceOf(
      MapQuotaError,
    );
    const busy = mapbox(reply('rate_limited')).place('Calle 1, Sevilla');
    await expect(busy).rejects.not.toBeInstanceOf(MapQuotaError);
    await expect(busy).rejects.toThrow('Map lookup unavailable.');
  });
});
