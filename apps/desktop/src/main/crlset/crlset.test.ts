import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../core/logger';
import { unpackCrx } from './crx';
import { crlSetFixture, fixtureCrlSetFetch } from './fixture';
import { blockedKeysOf, CRLSET_ID, CrlSetStore } from './store';
import { blockedInChain, electronChain, spkiHash } from './tls';

/**
 * Fixtures: Google's real CRLSet package (version 10850, 21 Oct 2026, from Chrome's update server)
 * and the public certificate of eMudhra's compromised "EM DV TLS CA - G3B", which it blocks.
 */
const fixture = (name: string) => readFile(join(import.meta.dirname, 'fixtures', name));
const EMUDHRA_DV_G3B = 'EM DV TLS CA - G3B';

const logger = createLogger({ level: 'error', console: false });

describe('unpackCrx', () => {
  it("unpacks Google's CRLSet package after checking its signature", async () => {
    const files = unpackCrx(await fixture('crlset-10850.crx3'), CRLSET_ID);
    expect([...files.keys()].sort()).toEqual([
      'LICENSE',
      '_metadata/verified_contents.json',
      'crl-set',
      'manifest.json',
    ]);
    expect(JSON.parse(String(files.get('manifest.json'))).version).toBe('10850');
  });

  it('refuses another component and a changed package', async () => {
    const crx = await fixture('crlset-10850.crx3');
    expect(() => unpackCrx(crx, 'a'.repeat(32))).toThrow(/another component/);
    const changed = Buffer.from(crx);
    changed[changed.length - 100] = (changed[changed.length - 100] as number) ^ 1;
    expect(() => unpackCrx(changed, CRLSET_ID)).toThrow(/signature/);
    expect(() => unpackCrx(Buffer.from('not a crx'), CRLSET_ID)).toThrow();
  });
});

describe('blocked keys', () => {
  it("include eMudhra's leaked intermediate, which a chain with it is refused for", async () => {
    const blocked = blockedKeysOf(
      unpackCrx(await fixture('crlset-10850.crx3'), CRLSET_ID).get('crl-set') as Buffer,
    );
    const ca = new X509Certificate(await fixture('emudhra-dv-tls-ca-g3b.pem'));
    expect(blocked.has(spkiHash(ca))).toBe(true);
    expect(blockedInChain([ca], blocked)).toContain(EMUDHRA_DV_G3B);
    expect(blockedInChain([ca], new Set())).toBeUndefined();
  });

  it("read Electron's certificates and their issuers (setCertificateVerifyProc)", async () => {
    const blocked = blockedKeysOf(
      unpackCrx(await fixture('crlset-10850.crx3'), CRLSET_ID).get('crl-set') as Buffer,
    );
    const pem = String(await fixture('emudhra-dv-tls-ca-g3b.pem'));
    const local = String(await fixture('localhost.pem'));
    const chain = electronChain({ data: local, issuerCert: { data: pem } });
    expect(chain).toHaveLength(2);
    expect(blockedInChain(chain, blocked)).toContain(EMUDHRA_DV_G3B);
    expect(blockedInChain(electronChain({ data: local }), blocked)).toBeUndefined();
  });
});

describe('CrlSetStore', () => {
  let dir: string;
  let crx: Buffer;
  let requests: string[];
  let answer: 'ok' | 'noupdate' | 'badhash';

  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('https://update.googleapis.com/')) {
      const body = JSON.parse(String(init?.body));
      expect(body.request.app[0].appid).toBe(CRLSET_ID);
      const sha = createHash('sha256').update(crx).digest('hex');
      const check =
        answer === 'noupdate'
          ? { status: 'noupdate' }
          : {
              status: 'ok',
              urls: {
                url: [{ codebase: 'http://cdn.test/x/' }, { codebase: 'https://cdn.test/x/' }],
              },
              manifest: {
                version: '10850',
                packages: {
                  package: [
                    { name: 'crlset.crx3', hash_sha256: answer === 'badhash' ? '00' : sha },
                  ],
                },
              },
            };
      return new Response(
        `)]}'\n${JSON.stringify({ response: { app: [{ appid: CRLSET_ID, status: 'ok', updatecheck: check }] } })}`,
      );
    }
    if (url === 'https://cdn.test/x/crlset.crx3') return new Response(new Uint8Array(crx));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sa-crlset-store-'));
    crx = await fixture('crlset-10850.crx3');
    requests = [];
    answer = 'ok';
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads the CRLSet over https, unpacks it and blocks its keys', async () => {
    const store = new CrlSetStore({ dir, fetch: fetchFake, logger });
    await store.refresh();
    expect(requests).toEqual([
      'https://update.googleapis.com/service/update2/json',
      'https://cdn.test/x/crlset.crx3',
    ]);
    expect(await store.component()).toEqual({ version: '10850', dir: join(dir, '10850') });
    expect(await readdir(join(dir, '10850'))).toContain('crl-set');
    const ca = new X509Certificate(await fixture('emudhra-dv-tls-ca-g3b.pem'));
    expect(store.blockedKeys().has(spkiHash(ca))).toBe(true);

    // The next run starts from the saved copy and only asks whether there is a newer one.
    const next = new CrlSetStore({ dir, fetch: fetchFake, logger });
    await next.load();
    expect(next.version()).toBe('10850');
    requests = [];
    answer = 'noupdate';
    await next.refresh();
    expect(requests).toEqual(['https://update.googleapis.com/service/update2/json']);
  });

  it('keeps nothing from a download with the wrong hash, and never throws', async () => {
    answer = 'badhash';
    const store = new CrlSetStore({ dir, fetch: fetchFake, logger });
    await store.refresh();
    expect(store.version()).toBeUndefined();
    expect(store.blockedKeys().size).toBe(0);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('installs the bundled fixture from memory, for runs that stay offline', async () => {
    expect(crlSetFixture().equals(crx)).toBe(true);
    const offline = fixtureCrlSetFetch(crlSetFixture());
    const store = new CrlSetStore({ dir, fetch: offline, logger });
    store.start();
    expect(await store.component()).toEqual({ version: '10850', dir: join(dir, '10850') });
    store.stop();
    await expect(offline('https://example.com/')).rejects.toThrow(/only its update check/);
  });

  it("doesn't hold a browser launch back for long when offline", async () => {
    const offline = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const store = new CrlSetStore({ dir, fetch: offline, logger });
    store.start();
    expect(await store.component()).toBeUndefined();
    store.stop();
  });
});
