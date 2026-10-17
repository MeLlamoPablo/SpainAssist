import { matchProvince, postalCodeProvince } from '@sa/shared';
import type { DocumentFields } from '../../scanner';

/**
 * Postal codes for scanned addresses from Catastro, the official property registry (free reuse
 * with attribution; 7,200 requests per hour per IP). The DNI street line is used as printed:
 * Catastro itself confirms which words are the street and that the house number exists, so
 * there is no abbreviation table. Queries are personal data: never log them, and never let a
 * service error (which can contain the URL) escape.
 */

const ENDPOINT = 'https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/json/';
/** Catastro spells these provinces differently; the foral ones keep their own registries. */
const CATASTRO_PROVINCE: Record<string, string> = {
  '03': 'ALACANT',
  '12': 'CASTELLO',
  '38': 'S.C. TENERIFE',
};
const NOT_COVERED = new Set(['01', '20', '31', '48']);
const PARTICLES = new Set('DE DEL LA LAS LOS EL DA DO DOS DAS DELS LES ELS'.split(' '));
/** A DNI line has few candidate splits; this bounds the worst case at a few seconds. */
const MAX_REQUESTS = 40;

export interface PostalCodeDiagnostic {
  outcome:
    | 'existing_code'
    | 'foreign_address'
    | 'not_covered'
    | 'incomplete_address'
    | 'lookup_failed'
    | 'not_found'
    | 'ambiguous'
    | 'resolved';
  requests?: number;
}

interface Street {
  type: string;
  name: string;
}

/** Upper case without accents, except Ñ and Ç, which Catastro keeps (IBAÑEZ, PROVENÇA). */
function plain(value: string) {
  return [...value.toUpperCase()]
    .map((ch) => (ch === 'Ñ' || ch === 'Ç' ? ch : ch.normalize('NFD').replace(/\p{M}/gu, '')))
    .join('');
}

/** Catastro's name without "(DE LA)", ", DE" or a trailing particle: "BUHAIRA (DE LA)" → "BUHAIRA". */
function core(name: string) {
  const words = name
    .replace(/\s*\([^)]*\)$/, '')
    .replace(/,\s*[^,]*$/, '')
    .trim()
    .split(/\s+/);
  while (words.length > 1 && PARTICLES.has(words.at(-1)!)) words.pop();
  return words.join(' ');
}

/** Keep streets of the printed type: "PZ." → PZ, else the same first letter ("C." → CL). */
function ofType(streets: Street[], printed: string) {
  const two = streets.filter((s) => s.type === printed.slice(0, 2));
  return two.length ? two : streets.filter((s) => s.type[0] === printed[0]);
}

/** Catastro returns one item as an object and several as a list. */
const list = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** Every unit address ({dir, dp}) in a parcel response, at any depth. */
function units(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const item of value) units(item, out);
  else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (typeof object.dp === 'string' && object.dir) out.push(object);
    else for (const item of Object.values(object)) units(item, out);
  }
  return out;
}

export interface CatastroOptions {
  fetch?: typeof fetch;
  /** Spacing between requests, to stay well under Catastro's hourly limit. */
  minIntervalMs?: number;
}

export function createCatastro({
  fetch: fetchImpl = (...args) => fetch(...args),
  minIntervalMs = 350,
}: CatastroOptions = {}) {
  let nextSlot = 0;
  async function waitTurn(signal?: AbortSignal) {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minIntervalMs;
    if (!wait) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('Address lookup unavailable.'));
        },
        { once: true },
      );
    });
  }

  /** One lookup: shares a request budget across its calls. */
  function session(province: string, municipality: string, signal?: AbortSignal) {
    let requests = 0;
    async function call(operation: string, params: Record<string, string>) {
      if (++requests > MAX_REQUESTS) throw new Error('Address lookup unavailable.');
      const url = new URL(operation, ENDPOINT);
      url.searchParams.set('Provincia', province);
      url.searchParams.set('Municipio', municipality);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      let response: Response;
      try {
        signal?.throwIfAborted();
        await waitTurn(signal);
        response = await fetchImpl(url, {
          headers: { Accept: 'application/json' },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
            : AbortSignal.timeout(20_000),
          redirect: 'error',
        });
      } catch {
        // Fetch errors can include the request URL and therefore the personal address.
        throw new Error('Address lookup unavailable.');
      }
      if (!response.ok) throw new Error('Address lookup unavailable.');
      try {
        return record(await response.json());
      } catch {
        throw new Error('Invalid address lookup response.');
      }
    }

    const streetCache = new Map<string, Street[]>();
    return {
      requests: () => requests,
      /** Streets whose name contains `name`, of any type. */
      async streets(name: string): Promise<Street[]> {
        const cached = streetCache.get(name);
        if (cached) return cached;
        const data = record(
          (await call('ObtenerCallejero', { TipoVia: '', NomVia: name })).consulta_callejeroResult,
        );
        const streets = list(record(data.callejero).calle).map((item) => {
          const dir = record(record(item).dir);
          return { type: str(dir.tv), name: str(dir.nv) };
        });
        streetCache.set(name, streets);
        return streets;
      },
      /** The parcel at this exact number, or undefined (Catastro lists neighbours instead). */
      async parcel(street: Street, number: string): Promise<string | undefined> {
        const data = record(
          (
            await call('ObtenerNumerero', {
              TipoVia: street.type,
              NomVia: street.name,
              Numero: number,
            })
          ).consulta_numereroResult,
        );
        if (record(data.control).cuerr !== undefined) return;
        const atNumber = list(data.nump)
          .map(record)
          .filter((n) => str(record(n.num).pnp) === number);
        // "100" and "100 A" are separate parcels; a plain number means the one without a letter.
        const plainNumber = atNumber.filter((n) => !str(record(n.num).plp).trim());
        const parcels = new Set(
          (plainNumber.length ? plainNumber : atNumber)
            .map((n) => `${str(record(n.pc).pc1)}${str(record(n.pc).pc2)}`)
            .filter((rc) => /^[0-9A-Z]{14}$/.test(rc)),
        );
        return parcels.size === 1 ? [...parcels][0] : undefined;
      },
      /**
       * The postal code of the parcel's units at this address, if they agree on one. A block
       * can have entrances on several streets, each with its own code.
       */
      async postcode(parcel: string, street: Street, number: string): Promise<string | undefined> {
        const all = units(await call('Consulta_DNPRC', { RefCat: parcel }));
        const here = all.filter((unit) => {
          const dir = record(unit.dir);
          return (
            str(dir.tv) === street.type && str(dir.nv) === street.name && str(dir.pnp) === number
          );
        });
        const codes = new Set(
          (here.length ? here : all).map((unit) => str(unit.dp).padStart(5, '0')),
        );
        return codes.size === 1 ? [...codes][0] : undefined;
      },
    };
  }

  return {
    /**
     * The postal code of a scanned Spanish address. Only answers when Catastro confirms one
     * parcel at that number; anything uncertain is left for the user to type.
     */
    async postalCode(
      fields: DocumentFields,
      signal?: AbortSignal,
      diagnostic?: (result: PostalCodeDiagnostic) => void,
    ): Promise<string | undefined> {
      const report = (result: PostalCodeDiagnostic) => {
        // Diagnostics contain only fixed categories and counts, never addresses or service errors.
        try {
          diagnostic?.(result);
        } catch {
          /* Logging must not affect scanning. */
        }
      };
      if (fields.addressPostalCode) return void report({ outcome: 'existing_code' });
      if (
        !['ESPAÑA', 'ESPANA', 'SPAIN', 'ES'].includes(
          plain(fields.addressCountry ?? 'España').trim(),
        )
      )
        return void report({ outcome: 'foreign_address' });
      const municipality = plain(fields.addressMunicipality ?? '').trim();
      const province = matchProvince(fields.addressProvince ?? fields.addressMunicipality ?? '');
      if (province && NOT_COVERED.has(province.code))
        return void report({ outcome: 'not_covered' });
      const tokens = plain(fields.addressStreet ?? '')
        .replace(/,/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
      if (!municipality || !province || !tokens.some((t, i) => i > 0 && /^\d+$/.test(t)))
        return void report({ outcome: 'incomplete_address' });

      const lookup = session(
        CATASTRO_PROVINCE[province.code] ?? plain(province.value),
        municipality,
        signal,
      );
      const done = (outcome: PostalCodeDiagnostic['outcome'], code?: string) => {
        report({ outcome, requests: lookup.requests() });
        return code;
      };
      try {
        // Each number after the first word may be the house number; the words before it, with
        // leading words (the street type, "DE LA") dropped one by one, may be the street name.
        for (const [index, token] of tokens.entries()) {
          if (index === 0 || !/^\d+$/.test(token)) continue;
          const number = String(Number(token));
          const words = tokens.slice(0, index);
          for (let start = 0; start < words.length; start++) {
            const name = words.slice(start).join(' ');
            const letters = name.match(/[A-ZÑÇ]/g)?.length ?? 0;
            if (!letters) break;
            if (letters < 2) continue;
            let streets = await lookup.streets(name);
            if (start > 0) streets = ofType(streets, words[0]!);
            const exact = streets.filter((s) => s.name === name || core(s.name) === name);
            const partial = streets.filter((s) => !exact.includes(s));
            // Exact names first; a partial name ("SANTA ANA" in "PZ SANTA ANA") is a last resort.
            for (const [candidates, last] of [
              [exact, false],
              [partial, true],
            ] as const) {
              if (!candidates.length || (last && letters < 3)) continue;
              const parcels = new Map<string, Street>();
              for (const street of candidates.slice(0, 10)) {
                const parcel = await lookup.parcel(street, number);
                if (parcel) parcels.set(parcel, street);
              }
              if (parcels.size === 1) {
                const [[parcel, street]] = [...parcels];
                const code = await lookup.postcode(parcel!, street!, number);
                // A code from another province means a wrong match: leave it blank.
                if (code && postalCodeProvince(code)?.code === province.code)
                  return done('resolved', code);
                return done('not_found');
              }
              if (parcels.size > 1 && last) return done('ambiguous');
            }
          }
        }
        return done('not_found');
      } catch (error) {
        if (signal?.aborted) throw error;
        report({ outcome: 'lookup_failed', requests: lookup.requests() });
        throw error;
      }
    },
  };
}

/** One instance per app, so every lookup shares the request spacing. */
export const catastro = createCatastro();
