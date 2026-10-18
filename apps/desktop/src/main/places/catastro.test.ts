import { describe, expect, it, vi } from 'vitest';
import { createCatastro, type PostalCodeDiagnostic } from './catastro';

type Street = [type: string, name: string];
interface Fake {
  /** Streets whose name contains the searched text. */
  streets: Street[];
  /** "TYPE NAME NUMBER" → parcels at that number ([parcel, letter]). */
  numbers?: Record<string, [string, string?][]>;
  /** Parcel → its units' addresses ([type, name, number, postcode]). */
  parcels?: Record<string, [string, string, string, string][]>;
}

/** A fake Catastro JSON service, answering by operation and parameters. */
function catastroService(fake: Fake) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    const p = (key: string) => url.searchParams.get(key) ?? '';
    const operation = url.pathname.split('/').at(-1);
    let body: unknown;
    if (operation === 'ObtenerCallejero') {
      const calle = fake.streets
        .filter(([, name]) => name.includes(p('NomVia')))
        .map(([tv, nv]) => ({ dir: { tv, nv } }));
      body = {
        consulta_callejeroResult: calle.length
          ? { control: { cuca: calle.length }, callejero: { calle } }
          : { control: { cuerr: 1 }, lerr: { err: [{ cod: '10' }] } },
      };
    } else if (operation === 'ObtenerNumerero') {
      const parcels = fake.numbers?.[`${p('TipoVia')} ${p('NomVia')} ${p('Numero')}`];
      body = {
        consulta_numereroResult: parcels
          ? {
              control: { cunum: parcels.length },
              nump: parcels.map(([rc, letter]) => ({
                pc: { pc1: rc.slice(0, 7), pc2: rc.slice(7) },
                num: { pnp: p('Numero'), plp: letter ?? ' ' },
              })),
            }
          : { control: { cunum: 1, cuerr: 1 }, nump: { pc: { pc1: '9999999', pc2: 'AA0000A' } } },
      };
    } else {
      const units = (fake.parcels?.[p('RefCat')] ?? []).map(([tv, nv, pnp, dp]) => ({
        dt: { locs: { lous: { lourb: { dir: { tv, nv, pnp }, dp } } } },
      }));
      body = {
        consulta_dnprcResult:
          units.length === 1 ? { bico: { bi: units[0] } } : { lrcdnp: { rcdnp: units } },
      };
    }
    return new Response(JSON.stringify(body));
  });
}
const calls = (fetchImpl: ReturnType<typeof catastroService>) =>
  fetchImpl.mock.calls.map(([input]) => {
    const url = new URL(String(input));
    return `${url.pathname.split('/').at(-1)} ${url.searchParams.get('NomVia') ?? url.searchParams.get('RefCat')}`;
  });
const lookup = (fetchImpl: typeof fetch, fields: Record<string, string>) => {
  const diagnostic = vi.fn<(result: PostalCodeDiagnostic) => void>();
  const result = createCatastro({ fetch: fetchImpl, minIntervalMs: 0 }).postalCode(
    fields,
    undefined,
    diagnostic,
  );
  return { result, diagnostic };
};

const SAN_JACINTO = 'AAAAAAABBBBBBB';
const sevilla: Fake = {
  streets: [
    ['HT', 'SAN JACINTO'],
    ['CL', 'SAN JACINTO'],
    ['AV', 'BUHAIRA (DE LA)'],
    ['PL', 'POLIGONO LA BUHAIRA'],
  ],
  numbers: {
    'CL SAN JACINTO 12': [[SAN_JACINTO]],
    'AV BUHAIRA (DE LA) 15': [['CCCCCCCDDDDDDD']],
  },
  parcels: {
    [SAN_JACINTO]: [['CL', 'SAN JACINTO', '12', '41010']],
    CCCCCCCDDDDDDD: [['AV', 'BUHAIRA (DE LA)', '15', '41018']],
  },
};
const dni = (addressStreet: string, extra: Record<string, string> = {}) => ({
  addressStreet,
  addressMunicipality: 'SEVILLA',
  addressProvince: 'Sevilla',
  ...extra,
});

describe('catastro postal codes', () => {
  it('lets Catastro confirm the street in the printed line and the house number', async () => {
    const fetchImpl = catastroService(sevilla);
    const { result, diagnostic } = lookup(fetchImpl, dni('C. SAN JACINTO 12 P2 44'));
    expect(await result).toBe('41010');
    // The printed type word is dropped by asking Catastro, not by an abbreviation table; the
    // hermitage (HT) of the same name is not a street of the printed type.
    expect(calls(fetchImpl)).toEqual([
      'ObtenerCallejero C. SAN JACINTO',
      'ObtenerCallejero SAN JACINTO',
      'ObtenerNumerero SAN JACINTO',
      `Consulta_DNPRC ${SAN_JACINTO}`,
    ]);
    const first = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(first.searchParams.get('Provincia')).toBe('SEVILLA');
    expect(first.searchParams.get('Municipio')).toBe('SEVILLA');
    expect(fetchImpl.mock.calls[0]![1]?.redirect).toBe('error');
    expect(diagnostic).toHaveBeenCalledWith({ outcome: 'resolved', requests: 4 });
  });

  it('matches names Catastro writes with particles last, and numbers in street names', async () => {
    expect(await lookup(catastroService(sevilla), dni('AV. DE LA BUHAIRA 15 P3 B')).result).toBe(
      '41018',
    );
    const marzo: Fake = {
      streets: [['CL', '8 DE MARZO']],
      numbers: { 'CL 8 DE MARZO 5': [['EEEEEEEFFFFFFF']] },
      parcels: { EEEEEEEFFFFFFF: [['CL', '8 DE MARZO', '5', '41006']] },
    };
    expect(await lookup(catastroService(marzo), dni('C. 8 DE MARZO 5')).result).toBe('41006');
  });

  it('prefers the parcel without a letter, and the units at this entrance', async () => {
    const block: Fake = {
      streets: [['RD', 'MURALLA (DA)']],
      numbers: { 'RD MURALLA (DA) 50': [['GGGGGGGHHHHHHH', 'A'], ['IIIIIIIJJJJJJJ']] },
      parcels: {
        IIIIIIIJJJJJJJ: [
          ['RD', 'MURALLA (DA)', '50', '27001'],
          ['CL', 'OTRA', '3', '27002'],
        ],
      },
    };
    const fields = dni('RDA. DA MURALLA 50 P3', {
      addressMunicipality: 'LUGO',
      addressProvince: 'Lugo',
    });
    expect(await lookup(catastroService(block), fields).result).toBe('27001');
  });

  it('leaves the code blank for a missing number, an ambiguous street or another province', async () => {
    const missing = lookup(catastroService(sevilla), dni('C. SAN JACINTO 997'));
    expect(await missing.result).toBeUndefined();
    expect(missing.diagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'not_found' }),
    );
    const twins: Fake = {
      streets: [
        ['CL', 'SANTA ANA ALTA'],
        ['CL', 'SANTA ANA BAJA'],
      ],
      numbers: {
        'CL SANTA ANA ALTA 3': [['KKKKKKKLLLLLLL']],
        'CL SANTA ANA BAJA 3': [['MMMMMMMNNNNNNN']],
      },
    };
    const ambiguous = lookup(catastroService(twins), dni('C. SANTA ANA 3'));
    expect(await ambiguous.result).toBeUndefined();
    expect(ambiguous.diagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'ambiguous' }),
    );
    const foreignCode: Fake = {
      ...sevilla,
      parcels: { [SAN_JACINTO]: [['CL', 'SAN JACINTO', '12', '28001']] },
    };
    expect(
      await lookup(catastroService(foreignCode), dni('C. SAN JACINTO 12')).result,
    ).toBeUndefined();
  });

  it('uses Catastro province names and skips provinces it does not cover', async () => {
    const alicante = catastroService({ streets: [] });
    await lookup(alicante, dni('C. MAYOR 1', { addressProvince: 'Alicante' })).result;
    expect(new URL(String(alicante.mock.calls[0]![0])).searchParams.get('Provincia')).toBe(
      'ALACANT',
    );
    const bizkaia = catastroService(sevilla);
    const basque = lookup(bizkaia, dni('C. NUEVA 1', { addressProvince: 'Bizkaia' }));
    expect(await basque.result).toBeUndefined();
    expect(basque.diagnostic).toHaveBeenCalledWith({ outcome: 'not_covered' });
    expect(bizkaia).not.toHaveBeenCalled();
  });

  it.each([
    dni('C. SAN JACINTO 12', { addressPostalCode: '41010' }),
    dni('C. SAN JACINTO 12', { addressCountry: 'Portugal' }),
    dni('C. SAN JACINTO'),
    dni('C. SAN JACINTO 12', { addressMunicipality: '' }),
  ])('skips the lookup when a code is present or the address is unsuitable', async (fields) => {
    const fetchImpl = catastroService(sevilla);
    expect(await lookup(fetchImpl, fields).result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never exposes the address in errors or diagnostics', async () => {
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new Error('?NomVia=SAN+JACINTO'));
    const { result, diagnostic } = lookup(failing, dni('C. SAN JACINTO 12'));
    await expect(result).rejects.toThrow(/^Address lookup unavailable\.$/);
    expect(diagnostic).toHaveBeenLastCalledWith({ outcome: 'lookup_failed', requests: 1 });
    const garbled = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>'));
    await expect(lookup(garbled, dni('C. SAN JACINTO 12')).result).rejects.toThrow(
      'Invalid address lookup response.',
    );
  });

  it('spaces requests to stay under the service limit', async () => {
    const times: number[] = [];
    const fetchImpl = catastroService(sevilla);
    fetchImpl.mockImplementation(async () => {
      times.push(Date.now());
      return new Response('{}');
    });
    // A fake clock: real timers fire a few ms off `Date.now()` under load, which made this flaky.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const done = createCatastro({ fetch: fetchImpl, minIntervalMs: 60 }).postalCode(
        dni('C. SAN JACINTO 12'),
      );
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(times.length).toBeGreaterThan(1);
    for (const [i, time] of times.slice(1).entries()) expect(time - times[i]!).toBe(60);
  });
});
