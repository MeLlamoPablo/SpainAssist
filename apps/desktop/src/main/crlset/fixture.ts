import { createHash } from 'node:crypto';
import type { FetchFn } from '../remote/http';
import { unpackCrx } from './crx';
import fixtureDataUrl from './fixtures/crlset-10850.crx3?inline';
import { CRLSET_ID, CRLSET_UPDATE_URL } from './store';

/** Where the fixture's update check says the package is: never fetched, the fetch below has it. */
const FIXTURE_URL = 'https://crlset.fixture.invalid/crlset-10850.crx3';

/**
 * Google's CRLSet package of 21 Oct 2026 (version 10850, `fixtures/`), bundled into the app for
 * the self-test (`app/self-test.ts`) and the e2e runs that enforce a CRLSet (SA_CRLSET_FIXTURE).
 */
export function crlSetFixture(): Buffer {
  return Buffer.from(fixtureDataUrl.slice(fixtureDataUrl.indexOf(',') + 1), 'base64');
}

/**
 * A fetch for `CrlSetStore` that answers as Google's update server would, offering `crx` (a CRLSet
 * package), from memory: nothing leaves the process. Any other request fails.
 */
export function fixtureCrlSetFetch(crx: Buffer): FetchFn {
  const manifest = unpackCrx(crx, CRLSET_ID).get('manifest.json');
  const version = (JSON.parse(String(manifest)) as { version: string }).version;
  const hash = createHash('sha256').update(crx).digest('hex');
  const check = {
    status: 'ok',
    urls: { url: [{ codebase: new URL('./', FIXTURE_URL).toString() }] },
    manifest: {
      version,
      packages: { package: [{ name: new URL(FIXTURE_URL).pathname.slice(1), hash_sha256: hash }] },
    },
  };
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CRLSET_UPDATE_URL)
      return new Response(
        `)]}'\n${JSON.stringify({ response: { app: [{ appid: CRLSET_ID, status: 'ok', updatecheck: check }] } })}`,
      );
    if (url === FIXTURE_URL) return new Response(new Uint8Array(crx));
    throw new Error(`The CRLSet fixture answers only its update check, not ${url}`);
  }) as FetchFn;
}
