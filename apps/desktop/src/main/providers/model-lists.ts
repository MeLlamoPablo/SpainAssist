import type { ModelLists } from '@sa/agent';
import type { Logger } from '../core/logger';
import type { Clock } from '../core/util';
import type { ProviderLib } from '../ports';
import { type FetchFn, requestJson } from '../remote/http';

/** A downloaded models file is kept this long. */
const MODEL_LISTS_TTL_MS = 60 * 60_000;
/** After a failed download, the app does not ask again for this long. */
const MODEL_LISTS_RETRY_MS = 60_000;
/** Agents wait for the download: past this, they run on the models the app already has. */
const MODEL_LISTS_TIMEOUT_MS = 5_000;

/**
 * The models file the app runs (see ModelLists): with a `url` (packaged builds), the latest one
 * there, downloaded at most once an hour and shared by callers at the same time; when it can't be
 * downloaded or read, the last one read, else the one bundled with the app. Without a `url`
 * (development builds, e2e runs), always the bundled one: the working copy's file.
 */
export class ModelListsSource {
  private latest?: { lists: ModelLists; at: number };
  private failedAt = Number.NEGATIVE_INFINITY;
  private download?: Promise<ModelLists>;

  constructor(
    private readonly deps: {
      url?: string;
      fetch: FetchFn;
      lib: Pick<ProviderLib, 'modelLists' | 'parseModelLists'>;
      logger: Logger;
      clock: Clock;
    },
  ) {}

  /** The lists in use now, without downloading. */
  current(): ModelLists {
    return this.latest?.lists ?? this.deps.lib.modelLists;
  }

  /** The latest lists, downloaded when the last ones are over an hour old. */
  async get(): Promise<ModelLists> {
    const { url } = this.deps;
    if (!url) return this.current();
    const now = this.deps.clock().getTime();
    if (this.latest && now - this.latest.at < MODEL_LISTS_TTL_MS) return this.latest.lists;
    if (now - this.failedAt < MODEL_LISTS_RETRY_MS) return this.current();
    if (this.download) return this.download;
    const download = (async () => {
      try {
        const json = await requestJson(this.deps.fetch, url, { timeoutMs: MODEL_LISTS_TIMEOUT_MS });
        const lists = this.deps.lib.parseModelLists(json, this.deps.lib.modelLists);
        this.latest = { lists, at: this.deps.clock().getTime() };
        return lists;
      } catch (err) {
        this.deps.logger.warn('models file unavailable: running the last models read', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.failedAt = this.deps.clock().getTime();
        return this.current();
      }
    })().finally(() => {
      if (this.download === download) this.download = undefined;
    });
    this.download = download;
    return download;
  }
}
