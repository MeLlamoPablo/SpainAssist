import type { ChildProcess } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  Sidecar,
  SidecarError,
  type SidecarEvent,
  type SidecarHash,
  type SidecarOptions,
} from '../src/sidecar';
import {
  getThrough,
  makePki,
  type Site,
  sidecarBinary,
  signDigest,
  spkiOf,
  startSite,
  type TestPki,
} from './helpers';

let pki: TestPki;
let site: Site;
let binaryPath: string;
const running: Sidecar[] = [];

beforeAll(async () => {
  binaryPath = await sidecarBinary();
  pki = makePki();
  site = await startSite(pki);
}, 120_000);

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

afterAll(async () => {
  await site?.close();
});

async function start(
  events?: SidecarEvent[],
  options: Partial<SidecarOptions> = {},
): Promise<Sidecar> {
  const sidecar = await Sidecar.start({
    binaryPath,
    roots: [pki.caPem],
    onEvent: (e) => events?.push(e),
    ...options,
  });
  running.push(sidecar);
  return sidecar;
}

function phoneKey(log: string[], options: { decline?: boolean } = {}) {
  return {
    prepare: async (host: string) => {
      log.push(`prepare ${host}`);
      if (options.decline) throw new SidecarError('declined', 'not now');
    },
    sign: async (digest: Buffer, hash: SidecarHash, host: string) => {
      log.push(`sign ${hash} ${host}`);
      return signDigest(pki.client.key, hash, digest);
    },
  };
}

describe('Sidecar', () => {
  it('tunnels by default: the client sees the site itself', async () => {
    const sidecar = await start();
    const res = await getThrough(sidecar, 's1', `${site.url}/`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).cn).toBeNull();
    expect(res.spki).toBe(spkiOf(pki.server.certDer));
    expect(sidecar.launchArgs).toEqual([`--ignore-certificate-errors-spki-list=${sidecar.spki}`]);
  });

  it('signs handshakes with a remote key, once per connection', async () => {
    const events: SidecarEvent[] = [];
    const sidecar = await start(events);
    const log: string[] = [];
    await sidecar.configure('s1', [site.hostPort], {
      id: 'dnie-1',
      chain: [pki.client.certDer],
      key: phoneKey(log),
    });
    const res = await getThrough(sidecar, 's1', `${site.url}/`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ cn: 'PRUEBA DNIE', authorized: true });
    expect(res.spki).toBe(sidecar.spki);
    expect(log).toEqual(['prepare 127.0.0.1', 'sign SHA-256 127.0.0.1']);
    // A second browser connection reuses the upstream connection: no new signature.
    await getThrough(sidecar, 's1', `${site.url}/again`);
    expect(log.filter((l) => l.startsWith('sign'))).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'handshake', session: 's1', signed: true }),
    );
    // Other contexts are untouched.
    const other = await getThrough(sidecar, 's2', `${site.url}/`);
    expect(JSON.parse(other.body).cn).toBeNull();
  });

  it('presents a key held in memory (.p12)', async () => {
    const sidecar = await start();
    await sidecar.configure('s1', [site.hostPort], {
      id: 'p12-1',
      chain: [pki.client.certDer],
      key: pki.client.key,
    });
    const res = await getThrough(sidecar, 's1', `${site.url}/`);
    expect(JSON.parse(res.body).cn).toBe('PRUEBA DNIE');
  });

  it('shows why when the user declines on the phone', async () => {
    const events: SidecarEvent[] = [];
    const sidecar = await start(events);
    const log: string[] = [];
    await sidecar.configure('s1', [site.hostPort], {
      id: 'dnie-1',
      chain: [pki.client.certDer],
      key: phoneKey(log, { decline: true }),
    });
    const res = await getThrough(sidecar, 's1', `${site.url}/`);
    expect(res.status).toBe(502);
    expect(res.headers['x-sa-certificate-error']).toBe('declined');
    expect(res.body).toContain('No se ha aprobado');
    expect(log).toEqual(['prepare 127.0.0.1']);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'upstream_error', code: 'declined', message: 'not now' }),
    );
  });

  it("shows the error page in the app's language, also after a restart", async () => {
    const sidecar = await start(undefined, { language: 'en' });
    await sidecar.configure('s1', [site.hostPort], {
      id: 'dnie-1',
      chain: [pki.client.certDer],
      key: phoneKey([], { decline: true }),
    });
    const page = async () => (await getThrough(sidecar, 's1', `${site.url}/`)).body;
    let body = await page();
    expect(body).toContain('The login with the certificate wasn&#39;t approved.');
    expect(body).toContain('SpainAssist certificate error (declined): not now');

    sidecar.setLanguage('es');
    expect(await page()).toContain('No se ha aprobado');

    sidecar.setLanguage('en');
    const child = (sidecar as unknown as { child: ChildProcess }).child;
    child.kill('SIGKILL');
    body = '';
    for (let i = 0; i < 50 && !body.includes('certificate error'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      body = await page().catch(() => '');
    }
    expect(body).toContain('The certificate couldn&#39;t be used');
  });

  it('rejects a bad identity', async () => {
    const sidecar = await start();
    await expect(
      sidecar.configure('s1', [site.hostPort], {
        id: 'x',
        chain: [pki.server.certDer], // the key belongs to another certificate
        key: pki.client.key,
      }),
    ).rejects.toThrow(/doesn't match/);
  });

  it('restarts on the same port after a crash and keeps the sessions', async () => {
    const sidecar = await start();
    await sidecar.configure('s1', [site.hostPort], {
      id: 'p12-1',
      chain: [pki.client.certDer],
      key: pki.client.key,
    });
    const before = await sidecar.openSession('s1');
    const child = (sidecar as unknown as { child: ChildProcess }).child;
    child.kill('SIGKILL');
    let body = '';
    for (let i = 0; i < 50 && !body; i++) {
      await new Promise((r) => setTimeout(r, 100));
      body = await getThrough(sidecar, 's1', `${site.url}/`).then(
        (r) => r.body,
        () => '',
      );
    }
    expect(await sidecar.openSession('s1')).toBe(before);
    expect(JSON.parse(body).cn).toBe('PRUEBA DNIE');
  });

  it('gives each session its own port and says why a tunnel failed', async () => {
    const sidecar = await start();
    const a = await sidecar.openSession('s1');
    expect(await sidecar.openSession('s2')).not.toBe(a);
    expect(await sidecar.openSession('s1')).toBe(a);
    await site.close();
    try {
      await expect(getThrough(sidecar, 's1', `${site.url}/`)).rejects.toThrow(/CONNECT 502/);
      await new Promise((r) => setTimeout(r, 50));
      expect(sidecar.networkError('s1', site.hostPort)).toBe('ERR_CONNECTION_REFUSED');
      expect(sidecar.networkError('s2', site.hostPort)).toBeUndefined();
    } finally {
      site = await startSite(pki);
    }
  });

  it('fails to start without the binary', async () => {
    await expect(Sidecar.start({ binaryPath: '/nonexistent/sa-sidecar' })).rejects.toThrow();
  });
});
