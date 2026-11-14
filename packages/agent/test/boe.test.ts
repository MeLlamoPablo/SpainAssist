import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostOps, createImageStore } from '../src/codemode/host-ops';
import { buildBoeQuery, searchBoe } from '../src/research/boe';

let server: Server;
let base: string;
const requests: { url: URL; accept?: string }[] = [];
let reply: unknown = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ url: new URL(req.url ?? '/', 'http://x'), accept: req.headers.accept });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/datosabiertos/api`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sample = {
  status: { code: '200', text: 'ok' },
  data: [
    {
      identificador: 'BOE-A-2005-21163',
      titulo:
        'Real Decreto 1553/2005, de 23 de diciembre, por el que se regula la expedición del documento nacional de identidad y sus certificados de firma electrónica.',
      rango: { codigo: '1340', texto: 'Real Decreto' },
      departamento: { codigo: '7723', texto: 'Ministerio del Interior' },
      ambito: { codigo: '1', texto: 'Estatal' },
      fecha_publicacion: '20051224',
      fecha_disposicion: '20051223',
      vigencia_agotada: 'N',
      estado_consolidacion: { codigo: '3', texto: 'Finalizado' },
      url_eli: 'https://www.boe.es/eli/es/rd/2005/12/23/1553',
      url_html_consolidada: 'https://www.boe.es/buscar/act.php?id=BOE-A-2005-21163',
    },
    { identificador: 'BOE-A-1999-1', titulo: 'Derogada', vigencia_agotada: 'S' },
  ],
};

describe('BOE open-data search', () => {
  it('builds query_string clauses from plain words and quoted phrases', () => {
    expect(buildBoeQuery('documento nacional de identidad')).toBe(
      'titulo:(documento and nacional and identidad) and vigencia_agotada:N',
    );
    expect(buildBoeQuery('"firma electrónica" DNI', 'texto', false)).toBe(
      'texto:("firma electrónica" and DNI)',
    );
    expect(() => buildBoeQuery('de la')).toThrow();
  });

  it('calls the consolidated-legislation endpoint and normalizes results', async () => {
    reply = sample;
    const laws = await searchBoe(
      { query: 'documento nacional identidad', limit: 5 },
      { baseUrl: base },
    );
    const request = requests.at(-1);
    expect(request?.url.pathname).toBe('/datosabiertos/api/legislacion-consolidada');
    expect(request?.accept).toBe('application/json');
    expect(request?.url.searchParams.get('limit')).toBe('5');
    expect(JSON.parse(request?.url.searchParams.get('query') ?? '{}')).toEqual({
      query: {
        query_string: {
          query: 'titulo:(documento and nacional and identidad) and vigencia_agotada:N',
        },
      },
    });
    expect(laws[0]).toMatchObject({
      id: 'BOE-A-2005-21163',
      rank: 'Real Decreto',
      department: 'Ministerio del Interior',
      publishedAt: '2005-12-24',
      inForce: true,
      url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2005-21163',
    });
    expect(laws[1]).toMatchObject({
      inForce: false,
      url: 'https://www.boe.es/buscar/act.php?id=BOE-A-1999-1',
    });
  });

  it('sorts newest first on request and reports API errors', async () => {
    reply = sample;
    await searchBoe({ query: 'dni', newestFirst: true }, { baseUrl: base });
    expect(JSON.parse(requests.at(-1)?.url.searchParams.get('query') ?? '{}').sort).toEqual([
      { fecha_publicacion: 'desc' },
    ]);
    reply = { status: { code: '400', text: 'Consulta no válida' } };
    await expect(searchBoe({ query: 'dni' }, { baseUrl: base })).rejects.toThrow(
      'Consulta no válida',
    );
  });

  it('api.boe.search returns the laws to a workflow', async () => {
    const call = createHostOps({
      bridge: { call: async () => ({}) as never },
      images: createImageStore(),
      runId: () => 'run_1',
      procedures: () => [],
      imagesSupported: true,
      boeBaseUrl: base,
    });
    reply = sample;
    const laws = (await call(
      'boe.search',
      { query: 'dni', field: 'texto' },
      { signal: new AbortController().signal },
    )) as { id: string }[];
    expect(laws.map((law) => law.id)).toEqual(['BOE-A-2005-21163', 'BOE-A-1999-1']);
    expect(JSON.parse(requests.at(-1)?.url.searchParams.get('query') ?? '{}').query).toEqual({
      query_string: { query: 'texto:(dni) and vigencia_agotada:N' },
    });
  });
});
