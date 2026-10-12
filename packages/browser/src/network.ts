import type { Page, Request } from 'playwright-core';

/** Request types that can change what the page shows. Images, fonts, media, beacons don't count. */
const TRACKED_TYPES = new Set(['document', 'script', 'xhr', 'fetch', 'stylesheet']);
/** In-flight requests older than this are treated as long-polling and ignored. */
const LONG_REQUEST_MS = 3000;

/**
 * Tracks the requests of one page to decide when it has "settled" (network-idle-ish). Main-frame
 * navigations always count as busy; other requests only while they are young.
 */
export class NetworkTracker {
  private readonly inflight = new Map<Request, { at: number; mainDoc: boolean }>();
  /** Last time a request started or ended, or the main frame navigated. */
  lastActivity = Date.now();
  /** Number of main-frame navigations (committed). */
  navigations = 0;

  constructor(private readonly page: Page) {
    page.on('request', (req) => {
      const type = req.resourceType();
      if (!TRACKED_TYPES.has(type)) return;
      let mainDoc = false;
      try {
        mainDoc = type === 'document' && req.frame() === page.mainFrame();
      } catch {
        // service-worker requests have no frame
      }
      this.inflight.set(req, { at: Date.now(), mainDoc });
      this.lastActivity = Date.now();
    });
    const done = (req: Request): void => {
      if (this.inflight.delete(req)) this.lastActivity = Date.now();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    page.on('download', () => {
      // A navigation that turned into a download may never "finish".
      for (const [req, info] of this.inflight) if (info.mainDoc) this.inflight.delete(req);
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.navigations++;
        this.lastActivity = Date.now();
      }
    });
  }

  /** Requests that should be waited for. */
  busy(now = Date.now()): number {
    let n = 0;
    for (const info of this.inflight.values()) {
      if (info.mainDoc || now - info.at < LONG_REQUEST_MS) n++;
    }
    return n;
  }

  get closed(): boolean {
    return this.page.isClosed();
  }
}
