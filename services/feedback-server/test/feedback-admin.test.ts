import { createHash } from 'node:crypto';
import {
  FeedbackAdminDetail,
  FeedbackAdminList,
  FeedbackAdminSearchResponse,
  FeedbackAdminStats,
  FeedbackEditResponse,
  FeedbackSubmitResponse,
} from '@sa/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/types';
import { adminList } from '../src/feedback/admin';
import { addVote } from '../src/feedback/repo';
import { type CastVote, DEFAULT_VOTE_POLICY, voteWeight } from '../src/feedback/votes';
import { AUTHOR, makeApp, makeDb, postJson, submission, truncate } from './helpers';

const TOKEN = 's3cret-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const DAY = 86_400_000;
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

let db: Db;
beforeAll(async () => {
  db = await makeDb();
});
afterAll(() => db.close());
beforeEach(() => truncate(db));

type App = ReturnType<typeof makeApp>;
const adminApp = () => makeApp(db, { adminToken: TOKEN });

async function create(app: App, overrides: Record<string, unknown> = {}) {
  const res = await postJson(app, '/v1/feedback', submission(overrides));
  expect(res.status).toBe(201);
  return FeedbackSubmitResponse.parse(await res.json()).id;
}

const get = (app: App, path: string) => Promise.resolve(app.request(path, { headers: AUTH }));

async function list(app: App, params: Record<string, string> = {}) {
  const res = await get(app, `/admin/feedback?${new URLSearchParams(params)}`);
  expect(res.status).toBe(200);
  return FeedbackAdminList.parse(await res.json());
}

const put = (app: App, id: string, body: unknown) =>
  Promise.resolve(
    app.request(`/admin/feedback/${id}`, {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const edit = (overrides: Record<string, unknown> = {}) => {
  const { author: _a, ...base } = submission();
  return { ...base, ...overrides };
};

describe('admin access', () => {
  it('is disabled when ADMIN_TOKEN is not set', async () => {
    const app = makeApp(db);
    for (const path of ['/admin', '/admin/feedback', '/admin/feedback/stats']) {
      expect((await app.request(path)).status).toBe(404);
      expect((await app.request(path, { headers: AUTH })).status).toBe(404);
    }
  });

  it('requires the bearer token for the API, not for the page', async () => {
    const app = adminApp();
    expect((await app.request('/admin')).status).toBe(200);
    expect((await app.request('/admin/feedback')).status).toBe(401);
    const wrong = await app.request('/admin/feedback/stats', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe('Bearer');
    const ok = await get(app, '/admin/feedback');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /admin (page)', () => {
  const inlineHash = (html: string, tag: 'script' | 'style') => {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html);
    expect(match, `inline <${tag}>`).not.toBeNull();
    return `'sha256-${createHash('sha256').update(match![1]!).digest('base64')}'`;
  };

  it('is served with a strict CSP matching its inline code, and holds no data', async () => {
    const app = adminApp();
    await create(app, { title: 'Un título que no debe salir en la página' });
    const res = await app.request('/admin');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await res.text();
    const csp = Object.fromEntries(
      (res.headers.get('content-security-policy') ?? '').split(';').map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values.join(' ')];
      }),
    );
    expect(csp).toEqual({
      'default-src': "'none'",
      'script-src': inlineHash(html, 'script'),
      'style-src': inlineHash(html, 'style'),
      'connect-src': "'self'",
      'img-src': "'self' data:",
      'base-uri': "'none'",
      'form-action': "'none'",
      'frame-ancestors': "'none'",
    });
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain('Un título que no debe salir');
  });
});

describe('GET /admin/feedback', () => {
  it('pages through entries with a total, newest first by default', async () => {
    const app = adminApp();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await create(app, { title: `Aprendizaje número ${i} sobre citas` }));
    }
    const first = await list(app, { limit: '2' });
    expect(first.total).toBe(5);
    expect(first.results.map((e) => e.id)).toEqual([ids[4], ids[3]]);
    const last = await list(app, { limit: '2', offset: '4' });
    expect(last.results.map((e) => e.id)).toEqual([ids[0]]);
    const oldest = await list(app, { sort: 'oldest', limit: '1' });
    expect(oldest.results[0]!.id).toBe(ids[0]);
    expect(first.results[0]).toMatchObject({
      chance: 0.5,
      upVotes: 0,
      downVotes: 0,
      humanVotes: 0,
      votes: 0,
    });
    expect(first.results[0]!.updatedAt).toBeUndefined();
  });

  it('rejects bad queries', async () => {
    const app = adminApp();
    for (const q of ['limit=0', 'limit=501', 'offset=-1', 'sort=random', 'kind=rumor']) {
      expect((await get(app, `/admin/feedback?${q}`)).status).toBe(400);
    }
  });

  it('filters by author, exactly', async () => {
    const app = adminApp();
    const agent = await create(app);
    const human = await create(app, { author: 'anthropic/claude-haiku-5.5 · high' });
    expect((await put(app, human, edit({ author: 'human' }))).status).toBe(200);
    const ids = async (author: string) => (await list(app, { author })).results.map((e) => e.id);
    expect(await ids(AUTHOR)).toEqual([agent]);
    expect(await ids('human')).toEqual([human]);
    expect(await ids('gpt-6.1-sol')).toEqual([]);
    expect((await list(app)).results.find((e) => e.id === agent)!.author).toBe(AUTHOR);
  });

  it('filters by text, kind, procedure, tag, votes and review', async () => {
    const app = adminApp();
    const dni = await create(app);
    const padron = await create(app, {
      procedure: 'Empadronamiento',
      kind: 'gotcha',
      title: 'El padrón pide el contrato de alquiler entero',
      body: 'Lleva todas las páginas del contrato, no solo la primera, o te harán volver.',
      tags: ['padrón', 'alquiler'],
      urls: [],
    });
    const nie = await create(app, {
      procedure: 'Solicitud de NIE',
      kind: 'friction',
      title: 'La sede del NIE se cae por las mañanas',
      body: 'Por la tarde la sede de extranjería responde mucho mejor que a primera hora.',
      tags: ['nie'],
      urls: [],
    });
    await addVote(db, dni, 1, 'agent');
    await addVote(db, padron, -1, 'human');

    const ids = async (params: Record<string, string>) =>
      (await list(app, params)).results.map((e) => e.id).sort();

    // words (stemmed, accent-insensitive), substrings and id prefixes
    expect(await ids({ q: 'renovacion' })).toEqual([dni]);
    expect(await ids({ q: 'extranjer' })).toEqual([nie]);
    expect(await ids({ q: padron.slice(0, 8) })).toEqual([padron]);
    expect(await ids({ q: '100%_' })).toEqual([]); // LIKE wildcards are literal
    expect(await ids({ kind: 'gotcha' })).toEqual([padron]);
    expect(await ids({ procedure: 'empadronamiento' })).toEqual([padron]);
    expect(await ids({ tag: 'NIE' })).toEqual([nie]);
    expect(await ids({ votes: 'up' })).toEqual([dni]);
    expect(await ids({ votes: 'down' })).toEqual([padron]);
    expect(await ids({ votes: 'neutral' })).toEqual([nie]);
    expect(await ids({ reviewed: 'yes' })).toEqual([padron]);
    expect(await ids({ reviewed: 'no' })).toEqual([dni, nie].sort());
    expect(await ids({ reviewed: 'no', kind: 'tip' })).toEqual([dni]);
    expect((await list(app, { votes: 'down' })).total).toBe(1);

    const sorted = await list(app, { sort: 'votes' });
    expect(sorted.results.map((e) => e.id)).toEqual([dni, nie, padron]);
    expect(sorted.results[2]).toMatchObject({ votes: -5, chance: 0, downVotes: 1, humanVotes: 1 });
  });

  it('weighs votes in SQL exactly like votes.ts, decay included', async () => {
    const policy = { threshold: 4, decayStartDays: 10, decayEndDays: 30 };
    const now = Date.UTC(2026, 5, 1);
    const id = await create(adminApp());
    const cast: CastVote[] = [
      { value: 1, voter: 'agent', createdAt: new Date(now - 2 * DAY) },
      { value: 1, voter: 'human', createdAt: new Date(now - 15 * DAY) },
      { value: -1, voter: 'agent', createdAt: new Date(now - 25 * DAY) },
      { value: 1, voter: 'human', createdAt: new Date(now - 40 * DAY) },
    ];
    for (const v of cast) await addVote(db, id, v.value, v.voter, v.createdAt);
    const expected = voteWeight(cast, now, policy);
    const [entry] = (
      await adminList(
        db,
        { sort: 'newest', limit: 10, offset: 0 },
        {
          policy,
          now,
        },
      )
    ).results;
    expect(entry!.votes).toBeCloseTo(expected, 2);
    expect(entry).toMatchObject({ upVotes: 3, downVotes: 1, humanVotes: 2 });
  });
});

describe('GET /admin/feedback/:id', () => {
  it('returns the entry with its votes, newest first, and what each is worth now', async () => {
    const app = adminApp();
    const id = await create(app, { appVersion: '1.4.0' });
    await addVote(db, id, 1, 'agent', new Date(Date.now() - 2 * DAY));
    await addVote(db, id, -1, 'human', new Date(Date.now() - DAY));
    await addVote(db, id, 1, 'agent', new Date(Date.now() - 400 * DAY)); // expired
    const res = await get(app, `/admin/feedback/${id}`);
    expect(res.status).toBe(200);
    const detail = FeedbackAdminDetail.parse(await res.json());
    expect(detail.entry).toMatchObject({ id, appVersion: '1.4.0', votes: -4, chance: 0.1 });
    expect(detail.votes.map((v) => [v.vote, v.voter, v.weight])).toEqual([
      ['down', 'human', -5],
      ['up', 'agent', 1],
      ['up', 'agent', 0],
    ]);
    expect((await get(app, `/admin/feedback/${UNKNOWN}`)).status).toBe(404);
    expect((await get(app, '/admin/feedback/not-a-uuid')).status).toBe(404);
  });
});

describe('PUT /admin/feedback/:id', () => {
  it('replaces the editable fields, marks the edit and updates search', async () => {
    const app = adminApp();
    const id = await create(app, { region: 'Comunidad de Madrid' });
    const res = await put(
      app,
      id,
      edit({
        kind: 'gotcha',
        title: 'La renovación exige llevar el DNI caducado',
        body: 'Aunque esté caducado, lleva el DNI anterior: lo recogen en la oficina al renovar.',
        tags: ['DNI', 'renovación', 'dni'],
        urls: ['https://www.citapreviadnie.es/'],
      }),
    );
    expect(res.status).toBe(200);
    const { entry, redactions } = FeedbackEditResponse.parse(await res.json());
    expect(redactions).toBe(0);
    expect(entry).toMatchObject({
      id,
      kind: 'gotcha',
      title: 'La renovación exige llevar el DNI caducado',
      tags: ['dni', 'renovación'],
    });
    expect(entry.region).toBeUndefined(); // omitted optional fields are cleared
    expect(entry.updatedAt).toBeDefined();
    expect(entry.author).toBeUndefined(); // omitted: unknown
    expect((await list(app, { sort: 'edited' })).results[0]!.id).toBe(id);
    expect((await list(app, { q: 'caducado' })).results.map((e) => e.id)).toEqual([id]);
  });

  it('sets the author: "human", an agent author, or unknown; nothing else', async () => {
    const app = adminApp();
    const id = await create(app);
    const author = async (value?: string) => {
      const res = await put(app, id, edit(value === undefined ? {} : { author: value }));
      return res.status === 200
        ? FeedbackEditResponse.parse(await res.json()).entry.author
        : res.status;
    };
    expect(await author('human')).toBe('human');
    expect(await author('gpt-6.1-sol · xhigh')).toBe('gpt-6.1-sol · xhigh');
    expect(await author()).toBeUndefined();
    expect(await author('Pablo')).toBe(400);
    expect(await author('gpt-6.1-sol · turbo')).toBe(400);
    expect(await author('')).toBe(400);
  });

  it('scrubs personal data from edits and rejects mostly personal text', async () => {
    const app = adminApp();
    const id = await create(app);
    const scrubbed = await put(
      app,
      id,
      edit({
        body: 'Si te piden el DNI 12345678Z en la cita, es solo para comprobar la identidad.',
        urls: ['https://sede.policia.gob.es/cita?dni=12345678Z'],
      }),
    );
    expect(scrubbed.status).toBe(200);
    const { entry, redactions } = FeedbackEditResponse.parse(await scrubbed.json());
    expect(redactions).toBeGreaterThanOrEqual(2);
    expect(entry.body).not.toContain('12345678Z');
    expect(entry.urls).toEqual(['https://sede.policia.gob.es/cita']);

    const rejected = await put(app, id, edit({ body: 'DNI 12345678Z, móvil 612345678.' }));
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ error: { code: 'pii_detected' } });
  });

  it('validates the body and answers 404 for unknown entries', async () => {
    const app = adminApp();
    const id = await create(app);
    expect((await put(app, id, edit({ title: 'no' }))).status).toBe(400);
    expect((await put(app, id, edit({ kind: 'rumor' }))).status).toBe(400);
    expect((await put(app, UNKNOWN, edit())).status).toBe(404);
    const notJson = await app.request(`/admin/feedback/${id}`, {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: '{',
    });
    expect(notJson.status).toBe(400);
  });
});

describe('votes and deletion', () => {
  it('removes a single vote', async () => {
    const app = adminApp();
    const id = await create(app);
    await postJson(app, `/admin/feedback/${id}/vote`, { vote: 'up' }, AUTH);
    const detail = FeedbackAdminDetail.parse(
      await (await get(app, `/admin/feedback/${id}`)).json(),
    );
    const voteId = detail.votes[0]!.id;
    const del = (path: string) => app.request(path, { method: 'DELETE', headers: AUTH });
    expect((await del(`/admin/feedback/${UNKNOWN}/votes/${voteId}`)).status).toBe(404);
    expect((await del(`/admin/feedback/${id}/votes/abc`)).status).toBe(404);
    const res = await del(`/admin/feedback/${id}/votes/${voteId}`);
    expect(await res.json()).toEqual({ id: voteId, deleted: true });
    expect((await del(`/admin/feedback/${id}/votes/${voteId}`)).status).toBe(404);
    const after = FeedbackAdminDetail.parse(await (await get(app, `/admin/feedback/${id}`)).json());
    expect(after.votes).toEqual([]);
    expect(after.entry.votes).toBe(0);
  });

  it('deletes entries, which then leave search', async () => {
    const app = adminApp();
    const id = await create(app);
    await create(app);
    const del = () => app.request(`/admin/feedback/${id}`, { method: 'DELETE', headers: AUTH });
    expect(await (await del()).json()).toEqual({ id, deleted: true });
    expect((await del()).status).toBe(404);
    const search = await app.request('/v1/feedback/search?q=cita%20previa');
    const ids = ((await search.json()) as { results: { id: string }[] }).results.map((r) => r.id);
    expect(ids).not.toContain(id);
  });
});

describe('GET /admin/feedback/stats', () => {
  it('counts kinds, votes, reviews and facets', async () => {
    const app = adminApp();
    const a = await create(app, { tags: ['dni', 'cita previa'] });
    const b = await create(app, { kind: 'gotcha', tags: ['dni'] });
    const c = await create(app, { procedure: 'Empadronamiento', tags: [] });
    await db.query('UPDATE feedback SET author = NULL WHERE id = $1::uuid', [c]);
    await addVote(db, a, 1, 'human');
    await addVote(db, b, -1, 'agent');
    const res = await get(app, '/admin/feedback/stats');
    const stats = FeedbackAdminStats.parse(await res.json());
    expect(stats).toEqual({
      total: 3,
      kinds: { tip: 2, friction: 0, gotcha: 1 },
      votes: { up: 1, down: 1, neutral: 1 },
      reviewed: 1,
      procedures: [
        { value: 'Renovación del DNI', count: 2 },
        { value: 'Empadronamiento', count: 1 },
      ],
      tags: [
        { value: 'dni', count: 2 },
        { value: 'cita previa', count: 1 },
      ],
      authors: [{ value: AUTHOR, count: 2 }], // unknown authors (NULL) are not listed
      policy: DEFAULT_VOTE_POLICY,
    });
  });
});

describe('GET /admin/feedback/search', () => {
  it('shows every candidate with its score and chance, without the serving draw', async () => {
    // A draw of 0.99 would hide everything below a 99% chance from agents.
    const app = makeApp(db, { adminToken: TOKEN, random: () => 0.99 });
    const id = await create(app);
    await addVote(db, id, -1, 'agent');
    expect(
      (
        (await (await app.request('/v1/feedback/search?q=cita%20previa')).json()) as {
          results: unknown[];
        }
      ).results,
    ).toEqual([]);
    const res = await get(app, '/admin/feedback/search?q=cita%20previa');
    const { results } = FeedbackAdminSearchResponse.parse(await res.json());
    expect(results.map((e) => e.id)).toEqual([id]);
    expect(results[0]!.score).toBeGreaterThan(0.6);
    expect(results[0]).toMatchObject({ votes: -1, chance: 0.4 });
    expect((await get(app, '/admin/feedback/search?q=a')).status).toBe(400);
  });
});
