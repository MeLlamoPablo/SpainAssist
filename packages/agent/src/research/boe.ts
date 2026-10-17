/**
 * BOE open-data API (keyless): search of consolidated state legislation.
 * Docs: https://www.boe.es/datosabiertos/documentos/APIconsolidada.pdf
 *   GET {base}/legislacion-consolidada?query=<json>&limit=N   (Accept: application/json)
 */

const BOE_API_BASE = 'https://www.boe.es/datosabiertos/api';

export interface BoeLaw {
  id: string;
  title: string;
  rank?: string;
  department?: string;
  scope?: string;
  /** YYYY-MM-DD */
  publishedAt?: string;
  /** YYYY-MM-DD */
  enactedAt?: string;
  inForce: boolean;
  consolidation?: string;
  url: string;
  eli?: string;
}

export interface BoeSearchParams {
  query: string;
  /** Where to look for the words: the title (default) or the full text. */
  field?: 'titulo' | 'texto';
  /** Only legislation still in force (default true). */
  inForceOnly?: boolean;
  /** 1–20, default 8. */
  limit?: number;
  newestFirst?: boolean;
}

export interface BoeSearchOptions {
  baseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const STOPWORDS = new Set([
  'a',
  'al',
  'con',
  'de',
  'del',
  'el',
  'en',
  'la',
  'las',
  'lo',
  'los',
  'o',
  'para',
  'por',
  'que',
  'se',
  'su',
  'sus',
  'un',
  'una',
  'unos',
  'unas',
  'y',
  'e',
  'u',
  'and',
  'or',
  'not',
]);

/** Build the BOE query_string: words joined with "and" inside the chosen field. */
export function buildBoeQuery(
  text: string,
  field: 'titulo' | 'texto' = 'titulo',
  inForceOnly = true,
): string {
  const phrases: string[] = [];
  const withoutPhrases = text.replace(/"([^"]{2,120})"/g, (_m, phrase: string) => {
    const clean = phrase
      .replace(/[^\p{L}\p{N}\s/.-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean) phrases.push(`"${clean}"`);
    return ' ';
  });
  const words = withoutPhrases
    .replace(/[^\p{L}\p{N}\s/.-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !STOPWORDS.has(w.toLowerCase()));
  const terms = [...phrases, ...words].slice(0, 12);
  if (terms.length === 0) throw new Error('The search needs at least one meaningful word');
  const clause = `${field}:(${terms.join(' and ')})`;
  return inForceOnly ? `${clause} and vigencia_agotada:N` : clause;
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{8}/.test(value)) return undefined;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'texto' in value) {
    const t = (value as { texto?: unknown }).texto;
    return typeof t === 'string' ? t : undefined;
  }
  return undefined;
}

export async function searchBoe(
  params: BoeSearchParams,
  options: BoeSearchOptions = {},
): Promise<BoeLaw[]> {
  const base = (options.baseUrl ?? BOE_API_BASE).replace(/\/+$/, '');
  const query: Record<string, unknown> = {
    query: {
      query_string: {
        query: buildBoeQuery(params.query, params.field ?? 'titulo', params.inForceOnly ?? true),
      },
    },
  };
  if (params.newestFirst) query.sort = [{ fecha_publicacion: 'desc' }];
  const limit = Math.min(20, Math.max(1, params.limit ?? 8));
  const url = `${base}/legislacion-consolidada?query=${encodeURIComponent(JSON.stringify(query))}&limit=${limit}`;
  const signal = AbortSignal.any(
    [options.signal, AbortSignal.timeout(options.timeoutMs ?? 20_000)].filter(
      (s): s is AbortSignal => !!s,
    ),
  );
  const res = await (options.fetchImpl ?? fetch)(url, {
    headers: { accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`BOE API returned HTTP ${res.status}`);
  const body = (await res.json()) as { status?: { code?: string; text?: string }; data?: unknown };
  if (body.status?.code && body.status.code !== '200') {
    throw new Error(`BOE API error: ${body.status.text ?? body.status.code}`);
  }
  const data = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
  return data
    .map((raw): BoeLaw | undefined => {
      const item = raw as Record<string, unknown>;
      const id = typeof item.identificador === 'string' ? item.identificador : undefined;
      const title = typeof item.titulo === 'string' ? item.titulo : undefined;
      if (!id || !title) return undefined;
      return {
        id,
        title,
        rank: text(item.rango),
        department: text(item.departamento),
        scope: text(item.ambito),
        publishedAt: isoDate(item.fecha_publicacion),
        enactedAt: isoDate(item.fecha_disposicion),
        inForce: item.vigencia_agotada !== 'S',
        consolidation: text(item.estado_consolidacion),
        url:
          typeof item.url_html_consolidada === 'string'
            ? item.url_html_consolidada
            : `https://www.boe.es/buscar/act.php?id=${encodeURIComponent(id)}`,
        eli: typeof item.url_eli === 'string' ? item.url_eli : undefined,
      };
    })
    .filter((law): law is BoeLaw => law !== undefined);
}
