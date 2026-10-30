import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CrlSetComponent } from '@sa/browser';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/util';
import type { FetchFn } from '../remote/http';
import { unpackCrx } from './crx';

/** Chrome's CRLSet component and the update server Chrome gets it from. */
export const CRLSET_ID = 'hfnkpimlhhgieaddgfemjhofmfblmnib';
export const CRLSET_UPDATE_URL = 'https://update.googleapis.com/service/update2/json';
/** Chrome's own CRLSets change a few times a day. */
const REFRESH_MS = 6 * 60 * 60 * 1000;
/** How long a browser launch waits for the first CRLSet when none is saved yet. */
const FIRST_FETCH_WAIT_MS = 15_000;

interface Installed extends CrlSetComponent {
  /** Base64 SHA-256 hashes of the keys the CRLSet blocks (SubjectPublicKeyInfo, DER). */
  blocked: ReadonlySet<string>;
}

export interface CrlSetStoreDeps {
  /** Where the unpacked component lives: `<dir>/<version>/crl-set`. */
  dir: string;
  fetch: FetchFn;
  logger: Logger;
}

/**
 * Chrome's CRLSet (revoked certificates and blocked CA keys), downloaded from Google's update
 * server at startup and every few hours, the way Chrome gets it, and kept unpacked for the agent's
 * browser (`@sa/browser`'s `crlSet`). Its blocked keys also guard the app's own connections
 * (`tls.ts`). Requests carry no user data: only the component's id and the version we have.
 */
export class CrlSetStore {
  private current?: Installed;
  private ready?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;

  constructor(private readonly deps: CrlSetStoreDeps) {}

  /** Loads the saved CRLSet, then fetches a newer one now and every few hours. */
  start(): void {
    this.ready ??= this.load().then(() => this.refresh());
    this.timer ??= setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The CRLSet for a browser launch; waits a little for the first download when none is saved. */
  async component(): Promise<CrlSetComponent | undefined> {
    if (!this.current && this.ready)
      await Promise.race([this.ready, new Promise((r) => setTimeout(r, FIRST_FETCH_WAIT_MS))]);
    const current = this.current;
    return current && { version: current.version, dir: current.dir };
  }

  /** The keys the current CRLSet blocks (base64 SHA-256 of the DER SubjectPublicKeyInfo). */
  blockedKeys(): ReadonlySet<string> {
    return this.current?.blocked ?? EMPTY;
  }

  version(): string | undefined {
    return this.current?.version;
  }

  /** The newest valid CRLSet saved by an earlier run. */
  async load(): Promise<void> {
    const versions = await readdir(this.deps.dir).catch(() => [] as string[]);
    for (const version of versions.filter(isVersion).sort(byVersion).reverse()) {
      const dir = join(this.deps.dir, version);
      try {
        this.current = {
          version,
          dir,
          blocked: blockedKeysOf(await readFile(join(dir, 'crl-set'))),
        };
        return;
      } catch (err) {
        this.deps.logger.warn('ignoring a saved CRLSet', { version, error: errorMessage(err) });
      }
    }
  }

  /** Asks Google's update server for a newer CRLSet and installs it. Never throws. */
  refresh(): Promise<void> {
    this.refreshing ??= this.update()
      .catch((err) =>
        this.deps.logger.warn('could not update the CRLSet', { error: errorMessage(err) }),
      )
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  private async update(): Promise<void> {
    const have = this.current?.version ?? '0.0.0.0';
    const res = await this.deps.fetch(CRLSET_UPDATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: {
          protocol: '3.1',
          acceptformat: 'crx3',
          app: [{ appid: CRLSET_ID, version: have, updatecheck: {} }],
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`update check: HTTP ${res.status}`);
    const check = parseUpdateCheck(await res.text());
    if (!check) return;
    if (this.current && byVersion(check.version, this.current.version) <= 0) return;
    const download = await this.deps.fetch(check.url, { signal: AbortSignal.timeout(60_000) });
    if (!download.ok) throw new Error(`download: HTTP ${download.status}`);
    const crx = Buffer.from(await download.arrayBuffer());
    if (createHash('sha256').update(crx).digest('hex') !== check.sha256.toLowerCase())
      throw new Error('download: wrong SHA-256');
    await this.install(check.version, unpackCrx(crx, CRLSET_ID));
  }

  private async install(version: string, files: Map<string, Buffer>): Promise<void> {
    const crlSet = files.get('crl-set');
    if (!crlSet || !files.has('manifest.json')) throw new Error('CRLSet package without its files');
    const blocked = blockedKeysOf(crlSet);
    const dir = join(this.deps.dir, version);
    const staging = `${dir}.partial`;
    await rm(staging, { recursive: true, force: true });
    for (const [name, data] of files) {
      await mkdir(dirname(join(staging, name)), { recursive: true });
      await writeFile(join(staging, name), data);
    }
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
    this.current = { version, dir, blocked };
    this.deps.logger.info('CRLSet updated', { version, blockedKeys: blocked.size });
    // Older versions: a browser launched earlier copied its own already.
    for (const name of await readdir(this.deps.dir).catch(() => [] as string[]))
      if (name !== version && (isVersion(name) || name.endsWith('.partial')))
        await rm(join(this.deps.dir, name), { recursive: true, force: true }).catch(() => {});
  }
}

const EMPTY: ReadonlySet<string> = new Set();

function isVersion(name: string): boolean {
  return /^\d+(\.\d+)*$/.test(name);
}

function byVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The update server's answer: a new version to download, or none. */
function parseUpdateCheck(
  text: string,
): { version: string; url: string; sha256: string } | undefined {
  const json = JSON.parse(text.replace(/^\)\]\}'/, '')) as {
    response?: { app?: Array<{ appid?: string; updatecheck?: UpdateCheck }> };
  };
  const check = json.response?.app?.find((a) => a.appid === CRLSET_ID)?.updatecheck;
  if (!check || check.status === 'noupdate') return undefined;
  if (check.status !== 'ok') throw new Error(`update check: ${check.status ?? 'no status'}`);
  const pkg = check.manifest?.packages?.package?.[0];
  const base = check.urls?.url?.map((u) => u.codebase).find((u) => u?.startsWith('https://'));
  const version = check.manifest?.version;
  if (!pkg?.name || !pkg.hash_sha256 || !base || !version || !isVersion(version))
    throw new Error('update check: incomplete answer');
  return { version, url: new URL(pkg.name, base).toString(), sha256: pkg.hash_sha256 };
}

interface UpdateCheck {
  status?: string;
  urls?: { url?: Array<{ codebase?: string }> };
  manifest?: {
    version?: string;
    packages?: { package?: Array<{ name?: string; hash_sha256?: string }> };
  };
}

/** The blocked keys of a CRLSet file: a little-endian length, a JSON header, then the parents. */
export function blockedKeysOf(crlSet: Buffer): ReadonlySet<string> {
  if (crlSet.length < 2) throw new Error('Truncated CRLSet');
  const length = crlSet.readUInt16LE(0);
  if (crlSet.length < 2 + length) throw new Error('Truncated CRLSet');
  const header = JSON.parse(crlSet.toString('utf8', 2, 2 + length)) as {
    ContentType?: string;
    BlockedSPKIs?: unknown;
  };
  if (header.ContentType !== 'CRLSet') throw new Error('Not a CRLSet');
  const keys = Array.isArray(header.BlockedSPKIs) ? header.BlockedSPKIs : [];
  return new Set(keys.filter((k): k is string => typeof k === 'string'));
}
