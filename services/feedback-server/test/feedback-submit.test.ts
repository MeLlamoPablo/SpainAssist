import { KeyCheckUnavailableError } from '@sa/gateway-keys';
import { detectPii } from '@sa/pii';
import { FeedbackSubmitResponse } from '@sa/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/types';
import {
  AUTHOR,
  approve,
  ID_SECRET,
  makeApp,
  makeDb,
  postJson,
  submission,
  truncate,
  USER_KEY,
} from './helpers';

let db: Db;
beforeAll(async () => {
  db = await makeDb();
});
afterAll(() => db.close());
beforeEach(() => truncate(db));

const rows = async () =>
  (
    await db.query<Record<string, unknown>>(
      'SELECT procedure, administration, region, title, body, tags, urls, app_version, author FROM feedback',
    )
  ).rows;

describe('POST /v1/feedback', () => {
  it('stores a clean submission', async () => {
    const app = makeApp(db);
    const res = await postJson(app, '/v1/feedback', submission({ appVersion: '0.1.0' }));
    expect(res.status).toBe(201);
    const body = FeedbackSubmitResponse.parse(await res.json());
    expect(body.redactions).toBe(0);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await rows()).toEqual([
      {
        procedure: 'Renovación del DNI',
        administration: 'Policía Nacional',
        region: null,
        title: 'Los huecos de cita previa salen por tandas',
        body: 'Si no ves huecos para renovar, vuelve a mirar a primera hora de la mañana.',
        tags: ['dni', 'cita previa'],
        urls: ['https://www.citapreviadnie.es/'],
        app_version: '0.1.0',
        author: AUTHOR,
      },
    ]);
  });

  it('returns the author with search results', async () => {
    const app = makeApp(db);
    const posted = await postJson(
      app,
      '/v1/feedback',
      submission({ author: 'anthropic/claude-haiku-5.5 · high' }),
    );
    await approve(db, FeedbackSubmitResponse.parse(await posted.json()).id);
    const res = await app.request('/v1/feedback/search?q=cita%20previa');
    const { results } = (await res.json()) as { results: { author?: string }[] };
    expect(results.map((r) => r.author)).toEqual(['anthropic/claude-haiku-5.5 · high']);
  });

  it('drops an author that carries personal data', async () => {
    const res = await postJson(
      makeApp(db),
      '/v1/feedback',
      submission({ author: 'modelo-de-juan.perez@example.es · off' }),
    );
    expect(res.status).toBe(201);
    expect(FeedbackSubmitResponse.parse(await res.json()).redactions).toBeGreaterThan(0);
    expect((await rows())[0]).toMatchObject({ author: null });
  });

  it.each([
    ['missing kind', submission({ kind: undefined })],
    ['unknown kind', submission({ kind: 'rant' })],
    ['short title', submission({ title: 'DNI' })],
    ['short body', submission({ body: 'corto' })],
    ['too many tags', submission({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })],
    ['invalid url', submission({ urls: ['no es una url'] })],
    ['long body', submission({ body: 'a'.repeat(4001) })],
    ['missing author', submission({ author: undefined })],
    ['"human" author (only admin edits write it)', submission({ author: 'human' })],
    ['author without a reasoning level', submission({ author: 'gpt-6.1-sol' })],
    ['author with an unknown level', submission({ author: 'gpt-6.1-sol · max' })],
    ['author with markup', submission({ author: '<b>x</b> · high' })],
    ['long author', submission({ author: `${'m'.repeat(101)} · high` })],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await postJson(makeApp(db), '/v1/feedback', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_request' } });
    expect(await rows()).toEqual([]);
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const app = makeApp(db);
    expect((await postJson(app, '/v1/feedback', '{"procedure":')).status).toBe(400);
    const huge = await postJson(app, '/v1/feedback', submission({ body: 'x'.repeat(70_000) }));
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('scrubs personal data before storing it (it never reaches the database)', async () => {
    const res = await postJson(
      makeApp(db),
      '/v1/feedback',
      submission({
        procedure: 'Renovación del DNI',
        administration: 'Comisaría, tel. 612 34 56 78',
        title: 'Me llamo Juan Pérez y la cita falló',
        body:
          'Pedí cita para renovar el DNI 12345678Z y me escribieron a juan.perez@example.es. ' +
          'La web pedía el expediente 2026/000123 y luego no dejaba seguir. Hay que esperar ' +
          'a que el sistema libere huecos nuevos, normalmente por la mañana temprano.',
        tags: ['dni', '12345678Z', 'Cita Previa'],
        urls: [
          'https://sede.policia.gob.es/cita?dni=12345678Z&token=abc#paso2',
          'https://sede.example.gob.es/usuarios/12345678Z/perfil',
        ],
      }),
    );
    expect(res.status).toBe(201);
    const { redactions } = FeedbackSubmitResponse.parse(await res.json());
    expect(redactions).toBeGreaterThanOrEqual(7);

    const [row] = await rows();
    const stored = JSON.stringify(row);
    for (const secret of [
      '12345678Z',
      'juan.perez',
      '612 34 56 78',
      '2026/000123',
      'token=abc',
      'Juan Pérez',
    ]) {
      expect(stored).not.toContain(secret);
    }
    for (const text of [row!.procedure, row!.administration, row!.title, row!.body]) {
      expect(detectPii(String(text))).toEqual([]);
    }
    expect(row!.body).toContain('[DNI]');
    expect(row!.body).toContain('[EMAIL]');
    expect(row!.title).toBe('Me llamo [NOMBRE] y la cita falló');
    expect(row!.tags).toEqual(['dni', 'cita previa']);
    expect(row!.urls).toEqual(['https://sede.policia.gob.es/cita']);
  });

  it('rejects text that is mostly personal data (422) and stores nothing', async () => {
    const app = makeApp(db);
    const res = await postJson(
      app,
      '/v1/feedback',
      submission({
        body: 'DNI 12345678Z, móvil 612345678, correo pablo@example.es, IBAN ES9121000418450200051332',
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'pii_detected' } });

    // Client-side placeholders count as personal data too.
    const placeholders = await postJson(
      app,
      '/v1/feedback',
      submission({ body: '[DATO PERSONAL] [DATO PERSONAL] [DNI] [TELÉFONO] vino' }),
    );
    expect(placeholders.status).toBe(422);
    expect(await rows()).toEqual([]);
  });

  it('accepts some client placeholders in otherwise useful text', async () => {
    const res = await postJson(
      makeApp(db),
      '/v1/feedback',
      submission({
        body: 'Con el DNI [DNI] la sede daba error; con el NIE funcionó a la primera. Prueba otro navegador si falla.',
      }),
    );
    expect(res.status).toBe(201);
    expect(FeedbackSubmitResponse.parse(await res.json()).redactions).toBe(0);
  });

  it('never logs bodies, query strings or client addresses', async () => {
    const lines: string[] = [];
    const app = makeApp(db, { log: (l) => lines.push(l) });
    await postJson(
      app,
      '/v1/feedback',
      submission({ body: 'Mi DNI es 12345678Z y algo más de texto útil.' }),
      {
        'x-test-ip': '198.51.100.7',
      },
    );
    await app.request('/v1/feedback/search?q=dni%2012345678Z', {
      headers: { 'x-test-ip': '198.51.100.7' },
    });
    expect(lines).toEqual([
      expect.stringMatching(/^POST \/v1\/feedback 201 \d+ms$/),
      expect.stringMatching(/^GET \/v1\/feedback\/search 200 \d+ms$/),
    ]);
    expect(lines.join('\n')).not.toContain(USER_KEY);
  });
});

describe('POST /v1/feedback authentication', () => {
  const send = (app: ReturnType<typeof makeApp>, headers: Record<string, string> = {}) =>
    postJson(app, '/v1/feedback', submission(), headers);

  it('needs an active gateway key with credit', async () => {
    const app = makeApp(db);
    for (const authorization of ['', 'Bearer not-a-key', 'Bearer sk-forged-user-key']) {
      const res = await send(app, { authorization });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
    }
    const broke = await send(app, { authorization: 'Bearer sk-broke-user-key' });
    expect(broke.status).toBe(403);
    expect(await broke.json()).toMatchObject({ error: { code: 'no_credit' } });
    expect(await rows()).toEqual([]);
  });

  it('limits submissions per key per UTC day, from any address', async () => {
    const app = makeApp(db, { limits: { submitPerKeyPerDay: 2 } });
    expect((await send(app, { 'x-test-ip': '192.0.2.1' })).status).toBe(201);
    expect((await send(app, { 'x-test-ip': '192.0.2.2' })).status).toBe(201);
    const over = await send(app, { 'x-test-ip': '192.0.2.3' });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: { code: 'quota_exceeded' } });
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await send(app, { authorization: 'Bearer sk-test-another-key' })).status).toBe(201);
    expect(await rows()).toHaveLength(3);
  });

  it('answers 503 when keys cannot be checked, and stores nothing', async () => {
    const down = makeApp(db, {
      users: {
        checkKey: async () => {
          throw new KeyCheckUnavailableError();
        },
        idSecret: ID_SECRET,
      },
    });
    expect((await send(down)).status).toBe(503);
    const unconfigured = makeApp(db, { users: undefined });
    const res = await send(unconfigured);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'unavailable' } });
    expect((await unconfigured.request('/v1/feedback/search?q=dni')).status).toBe(200);
    expect(await rows()).toEqual([]);
  });
});
