import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ingest, sign } from '../src/ingester.ts';
import { createIngester, loadConfig, type ServerConfig } from '../src/main.ts';

const secret = 'test-secret-0123456789';
const repository = 'MeLlamoPablo/SpainAssist';
const after = 'a'.repeat(40);

function push(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'refs/heads/master',
    before: 'b'.repeat(40),
    after,
    repository: { full_name: repository, id: 1, private: true, owner: { login: 'MeLlamoPablo' } },
    pusher: { name: 'someone', email: 'someone@example.com' },
    head_commit: { id: after, message: 'Head' },
    commits: [
      {
        id: after,
        message: 'Key server: fix',
        author: { name: 'someone' },
        added: ['services/key-server/src/new.ts'],
        removed: [],
        modified: ['services/key-server/src/app.ts', 'pnpm-lock.yaml'],
      },
      {
        id: 'c'.repeat(40),
        message: 'Docs',
        added: [],
        removed: ['docs/old.md'],
        modified: ['services/key-server/src/app.ts'],
      },
    ],
    ...overrides,
  };
}

function delivery(payload: unknown, opts: { event?: string; signWith?: string } = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    event: opts.event ?? 'push',
    signature: sign(opts.signWith ?? secret, body),
    contentType: 'application/json',
    body,
  };
}

const config = { secret, repository };

describe('ingest', () => {
  it('forwards only what Coolify reads, re-signed', () => {
    const outcome = ingest(config, delivery(push()));
    expect(outcome.kind).toBe('forward');
    if (outcome.kind !== 'forward') return;
    expect(JSON.parse(outcome.body)).toEqual({
      ref: 'refs/heads/master',
      after,
      repository: { full_name: repository },
      commits: [
        {
          message: '',
          added: [],
          removed: [],
          modified: [
            'services/key-server/src/new.ts',
            'services/key-server/src/app.ts',
            'pnpm-lock.yaml',
            'docs/old.md',
          ],
        },
      ],
    });
    expect(outcome.signature).toBe(sign(secret, outcome.body));
  });

  it('keeps [skip ci] only when every commit asks for it', () => {
    const skipped = (messages: string[]) => {
      const commits = messages.map((message) => ({
        message,
        added: [],
        removed: [],
        modified: [],
      }));
      const outcome = ingest(config, delivery(push({ commits })));
      if (outcome.kind !== 'forward') throw new Error('not forwarded');
      return JSON.parse(outcome.body).commits[0].message;
    };
    expect(skipped(['Fix [skip ci]', 'Docs [SKIP CD]'])).toBe('[skip ci]');
    expect(skipped(['Fix [skip ci]', 'Deploy this'])).toBe('');
    expect(skipped([''])).toBe('');
  });

  it('forwards a push without commits as one without commits', () => {
    const outcome = ingest(config, delivery(push({ commits: [] })));
    if (outcome.kind !== 'forward') throw new Error('not forwarded');
    expect(JSON.parse(outcome.body).commits).toEqual([]);
  });

  it('rejects anything not signed with the secret', () => {
    const body = Buffer.from(JSON.stringify(push()));
    for (const signature of [undefined, '', 'sha256=zz', `sha1=${'0'.repeat(40)}`]) {
      expect(
        ingest(config, { event: 'push', signature, contentType: 'application/json', body }),
      ).toEqual({ kind: 'reply', status: 401, message: 'Invalid signature' });
    }
    expect(ingest(config, delivery(push(), { signWith: 'another-secret-012345' }))).toMatchObject({
      status: 401,
    });
  });

  it('answers pings and ignores other events without forwarding', () => {
    expect(ingest(config, delivery({ zen: 'hi' }, { event: 'ping' }))).toEqual({
      kind: 'reply',
      status: 200,
      message: 'pong',
    });
    expect(ingest(config, delivery(push(), { event: 'pull_request' }))).toMatchObject({
      kind: 'reply',
      status: 200,
    });
  });

  it('refuses other repositories, tags, deletions and malformed pushes', () => {
    const status = (payload: unknown) => {
      const outcome = ingest(config, delivery(payload));
      return outcome.kind === 'reply' ? outcome.status : 'forward';
    };
    expect(status(push({ repository: { full_name: 'someone/else' } }))).toBe(422);
    expect(status(push({ repository: { full_name: 'mellamopablo/spainassist' } }))).toBe('forward');
    expect(status(push({ ref: 'refs/tags/v1' }))).toBe(200);
    expect(status(push({ ref: 'refs/heads/a b' }))).toBe(200);
    expect(status(push({ deleted: true }))).toBe(200);
    expect(status(push({ after: 'HEAD' }))).toBe(400);
    expect(status(push({ commits: 'x' }))).toBe(400);
    expect(status(push({ commits: [{ message: 1, added: [], removed: [], modified: [] }] }))).toBe(
      400,
    );
    expect(
      status(push({ commits: [{ message: '', added: ['a\nb'], removed: [], modified: [] }] })),
    ).toBe(400);
    expect(
      status(push({ commits: [{ message: '', added: [{}], removed: [], modified: [] }] })),
    ).toBe(400);
    expect(status([])).toBe(400);
  });

  it('needs a JSON body', () => {
    const outcome = ingest(config, {
      ...delivery(push()),
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(outcome).toMatchObject({ status: 415 });
    const body = Buffer.from('{not json');
    expect(
      ingest(config, {
        event: 'push',
        signature: sign(secret, body),
        contentType: 'application/json',
        body,
      }),
    ).toMatchObject({ status: 400 });
  });
});

describe('server', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** A stand-in for Coolify that records what reaches it. */
  async function fakeCoolify() {
    const received: { headers: Record<string, unknown>; body: string; url: string }[] = [];
    const url = await listen(
      createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          received.push({
            headers: req.headers,
            body: Buffer.concat(chunks).toString(),
            url: req.url ?? '',
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[{"status":"success","message":"Deployment queued."}]');
        });
      }),
    );
    return { received, url };
  }

  async function ingester(coolifyUrl: string) {
    const config: ServerConfig = {
      ...loadConfig({ GITHUB_WEBHOOK_SECRET: secret, GITHUB_REPOSITORY: repository }),
      coolifyUrl,
      maxBodyBytes: 64 * 1024,
      forwardTimeoutMs: 2000,
    };
    return listen(createIngester(config));
  }

  it('forwards a signed push with only the headers Coolify reads', async () => {
    const coolify = await fakeCoolify();
    const url = await ingester(`${coolify.url}/webhooks/source/github/events/manual`);
    const body = JSON.stringify(push());
    const res = await fetch(`${url}/github?x=1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
        'x-hub-signature-256': sign(secret, body),
        cookie: 'laravel_session=evil',
        'x-forwarded-for': '1.2.3.4',
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ status: 'success', message: 'Deployment queued.' }]);

    expect(coolify.received).toHaveLength(1);
    const [forwarded] = coolify.received;
    expect(forwarded!.url).toBe('/webhooks/source/github/events/manual');
    expect(Object.keys(forwarded!.headers).sort()).toEqual(
      [
        'accept',
        'accept-encoding',
        'accept-language',
        'connection',
        'content-length',
        'content-type',
        'host',
        'sec-fetch-mode',
        'user-agent',
        'x-github-event',
        'x-hub-signature-256',
      ].sort(),
    );
    expect(forwarded!.headers['x-hub-signature-256']).toBe(sign(secret, forwarded!.body));
    expect(JSON.parse(forwarded!.body).after).toBe(after);
  });

  it('answers everything else itself', async () => {
    const coolify = await fakeCoolify();
    const url = await ingester(coolify.url);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/github`)).status).toBe(404);
    expect(
      (await fetch(`${url}/webhooks/source/github/events/manual`, { method: 'POST' })).status,
    ).toBe(404);
    expect((await fetch(`${url}/login`)).status).toBe(404);
    const unsigned = await fetch(`${url}/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: JSON.stringify(push()),
    });
    expect(unsigned.status).toBe(401);
    const big = await fetch(`${url}/github`, { method: 'POST', body: 'x'.repeat(65 * 1024) });
    expect(big.status).toBe(413);
    expect(coolify.received).toHaveLength(0);
  });

  it('reports an unreachable Coolify as 502', async () => {
    const url = await ingester('http://127.0.0.1:1/');
    const body = JSON.stringify(push());
    const res = await fetch(`${url}/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': sign(secret, body),
      },
      body,
    });
    expect(res.status).toBe(502);
  });
});

describe('loadConfig', () => {
  it('needs a secret and a repository', () => {
    expect(() => loadConfig({ GITHUB_REPOSITORY: repository })).toThrow();
    expect(() => loadConfig({ GITHUB_WEBHOOK_SECRET: secret, GITHUB_REPOSITORY: 'x' })).toThrow();
  });
});
