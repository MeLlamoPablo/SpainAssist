import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';
import type { BridgeTransport } from '../bridge/client';

/**
 * pi CredentialStore backed by the app (bridge `agent.credential` / `agent.refreshCredential`).
 *
 * - Only this process's provider is served; every other provider reads as "not configured"
 *   without touching the bridge (pi checks all built-in providers at startup).
 * - Reads are cached for a few seconds only, so key rotation (vouchers) is picked up live.
 * - OAuth refresh: pi calls `modify()` when the access token is about to expire. We never refresh
 *   here (refresh tokens rotate, and several agent processes share one credential): we ask the
 *   app, which serializes refreshes across processes and persists the result.
 * - Nothing is written to disk and nothing is kept beyond the short cache.
 */
export class BridgeCredentialStore implements CredentialStore {
  private cache?: { at: number; value: Credential | undefined };
  private inflight?: Promise<Credential | undefined>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly bridge: BridgeTransport,
    private readonly providerId: string,
    private readonly ttlMs = 5_000,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (providerId !== this.providerId) return undefined;
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    this.inflight ??= this.fetch(options?.signal).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const credential = await this.read(this.providerId, options);
    return credential ? [{ providerId: this.providerId, type: credential.type }] : [];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const task = async (): Promise<Credential | undefined> => {
      if (providerId !== this.providerId) return fn(undefined);
      this.cache = undefined;
      const current = await this.read(providerId, options);
      if (current?.type === 'oauth') {
        const result = await this.bridge.call(
          'agent.refreshCredential',
          { providerId },
          { signal: options?.signal },
        );
        const fresh = normalizeCredential(result.credential);
        if (!fresh) this.log(`The app returned no credential after refreshing ${providerId}`);
        this.cache = { at: Date.now(), value: fresh };
        return fresh;
      }
      // Not an OAuth refresh (pi only writes credentials on login/logout, which the app owns):
      // let pi compute the value but keep nothing.
      return (await fn(current)) ?? current;
    };
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => {});
    return run;
  }

  async delete(providerId: string): Promise<void> {
    if (providerId === this.providerId) this.cache = undefined;
  }

  private async fetch(signal?: AbortSignal): Promise<Credential | undefined> {
    const result = await this.bridge.call(
      'agent.credential',
      { providerId: this.providerId },
      { signal },
    );
    const value = normalizeCredential(result.credential);
    this.cache = { at: Date.now(), value };
    return value;
  }
}

/** Validate the minimal pi-ai Credential shape; anything else counts as "no credential". */
export function normalizeCredential(
  raw: Record<string, unknown> | null | undefined,
): Credential | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  if (raw.type === 'api_key') {
    if (raw.key !== undefined && typeof raw.key !== 'string') return undefined;
    const env =
      raw.env && typeof raw.env === 'object' ? (raw.env as Record<string, string>) : undefined;
    return {
      type: 'api_key',
      ...(typeof raw.key === 'string' && raw.key ? { key: raw.key } : {}),
      ...(env ? { env } : {}),
    };
  }
  if (raw.type === 'oauth') {
    if (typeof raw.access !== 'string' || typeof raw.refresh !== 'string') return undefined;
    if (typeof raw.expires !== 'number' || !Number.isFinite(raw.expires)) return undefined;
    return {
      ...raw,
      type: 'oauth',
      access: raw.access,
      refresh: raw.refresh,
      expires: raw.expires,
    };
  }
  return undefined;
}
