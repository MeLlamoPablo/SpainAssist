import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { createBrowserService } from '@sa/browser';
import { expect, it } from 'vitest';
import { createLogger } from '../core/logger';
import { CrlSetStore } from './store';
import { blockKeysInNodeTls } from './tls';

/**
 * Live check, separate from the suite (it downloads Chrome's CRLSet from Google and opens a real
 * site): a host whose certificate comes from eMudhra's compromised "EM DV TLS CA - G3B",
 * published by the researcher who reported it, must be refused by the agent's browser and by
 * Node. Run on a desktop with
 * `SA_TEST_LIVE_CRLSET=1 corepack pnpm --filter @sa/desktop exec vitest run src/main/crlset/live.test.ts`.
 */
const REVOKED_SITE = 'https://dv-g3b-emudhra.we-have-a-problem.com/';

it.skipIf(process.env.SA_TEST_LIVE_CRLSET !== '1')(
  "refuses a site signed with a key Chrome's CRLSet blocks",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sa-crlset-live-'));
    const logger = createLogger({ level: 'error', console: false });
    const store = new CrlSetStore({ dir, fetch, logger });
    const downloads = await mkdtemp(join(tmpdir(), 'sa-crlset-live-downloads-'));
    const browser = createBrowserService({
      headless: true,
      downloadsDir: downloads,
      crlSet: () => store.component(),
      onDownload: async () => {
        throw new Error('no downloads');
      },
    });
    const check = tls.checkServerIdentity;
    try {
      await store.refresh();
      expect(store.version()).toMatch(/^\d+/);

      // The site's page says "Your client successfully connected to the site. That's bad!".
      const opened = await browser.open('live', REVOKED_SITE).then(
        (obs) => `opened: ${obs.snapshot}`,
        (err: Error) => err.message,
      );
      expect(opened).toMatch(/ERR_CERT_REVOKED/);

      blockKeysInNodeTls(() => store.blockedKeys());
      const fetched = await fetch(REVOKED_SITE).then(
        (res) => `HTTP ${res.status}`,
        (err: Error & { cause?: Error }) => err.cause?.message ?? err.message,
      );
      expect(fetched).toMatch(/Blocked certificate authority in the chain: .*EM DV TLS CA - G3B/);
    } finally {
      tls.checkServerIdentity = check;
      await browser.closeAll();
      await rm(dir, { recursive: true, force: true });
      await rm(downloads, { recursive: true, force: true });
    }
  },
  120_000,
);
