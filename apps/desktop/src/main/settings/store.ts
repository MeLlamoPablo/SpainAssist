import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  DEFAULT_SETTINGS,
  type Language,
  ProviderConfig,
  Settings,
  type SettingsPatch,
} from '@sa/shared';
import type { EventBus } from '../core/events';
import { readJsonFile, writeFileAtomic } from '../core/fs';
import type { Logger } from '../core/logger';
import { Mutex } from '../core/util';

type SettingsListener = (next: Settings, prev: Settings) => void;

/**
 * settings.json: validated with zod, merged over DEFAULT_SETTINGS field by field (an invalid
 * field falls back to its default instead of discarding the whole file). Emits
 * `settings.changed` with the new settings.
 */
export class SettingsStore {
  private stored: Settings;
  private readonly listeners = new Set<SettingsListener>();
  private readonly mutex = new Mutex();

  private constructor(
    private readonly file: string,
    initial: Settings,
    private readonly defaults: Settings,
    private readonly events: EventBus | undefined,
    private readonly logger: Logger,
  ) {
    this.stored = initial;
  }

  static async open(
    file: string,
    opts: {
      events?: EventBus;
      logger: Logger;
      /** Language when settings.json stores none (first run, after a wipe): the OS language. */
      language?: Language;
    },
  ): Promise<SettingsStore> {
    const defaults: Settings = {
      ...DEFAULT_SETTINGS,
      language: opts.language ?? DEFAULT_SETTINGS.language,
    };
    let raw: unknown;
    try {
      raw = await readJsonFile(file);
    } catch (err) {
      opts.logger.warn('settings.json is not valid JSON; using defaults', err);
    }
    const stored = normalizeSettings(raw, opts.logger, defaults);
    return new SettingsStore(file, stored, defaults, opts.events, opts.logger);
  }

  get(): Settings {
    return { ...this.stored };
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: SettingsPatch): Promise<Settings> {
    return this.mutate((s) => ({
      ...s,
      ...(patch.language !== undefined ? { language: patch.language } : {}),
      ...(patch.onboardingCompleted !== undefined
        ? { onboardingCompleted: patch.onboardingCompleted }
        : {}),
      ...(patch.shareLearnings !== undefined ? { shareLearnings: patch.shareLearnings } : {}),
      ...(patch.dnieEarlyAccess !== undefined ? { dnieEarlyAccess: patch.dnieEarlyAccess } : {}),
    }));
  }

  /** Provider configuration is not part of SettingsPatch (only ProviderManager changes it). */
  setProvider(provider: ProviderConfig | undefined): Promise<Settings> {
    return this.mutate((s) => {
      const next: Settings = { ...s };
      if (provider) next.provider = ProviderConfig.parse(provider);
      else delete next.provider;
      return next;
    });
  }

  /** Deletes settings.json and goes back to defaults (wipe). */
  async reset(): Promise<void> {
    await this.mutex.run(async () => {
      await rm(this.file, { force: true });
      this.stored = structuredClone(this.defaults);
    });
  }

  private mutate(fn: (s: Settings) => Settings): Promise<Settings> {
    return this.mutex.run(async () => {
      const prev = this.get();
      const next = Settings.parse(fn(structuredClone(this.stored)));
      await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.stored = next;
      const current = this.get();
      this.events?.emit({ type: 'settings.changed', settings: current });
      for (const l of this.listeners) {
        try {
          l(current, prev);
        } catch (err) {
          this.logger.error('settings listener failed', err);
        }
      }
      return current;
    });
  }
}

/**
 * The app language for the OS's preferred languages (`app.getPreferredSystemLanguages()`, most
 * preferred first): the first one the app speaks wins, Spain's co-official languages count as
 * Spanish, and English is the fallback for everything else.
 */
export function languageForLocales(locales: readonly string[]): Language {
  if (locales.length === 0) return DEFAULT_SETTINGS.language;
  for (const locale of locales) {
    const primary = locale.toLowerCase().split(/[-_]/)[0];
    if (primary === 'es' || primary === 'ca' || primary === 'eu' || primary === 'gl') return 'es';
    if (primary === 'en') return 'en';
  }
  return 'en';
}

/** Field-by-field merge of an untrusted object over the defaults. */
export function normalizeSettings(
  raw: unknown,
  logger?: Logger,
  defaults: Settings = DEFAULT_SETTINGS,
): Settings {
  const out: Settings = structuredClone(defaults);
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const shape = Settings.shape;
  const keys = ['language', 'onboardingCompleted', 'shareLearnings', 'dnieEarlyAccess'] as const;
  for (const key of keys) {
    if (r[key] === undefined) continue;
    const parsed = shape[key].safeParse(r[key]);
    if (parsed.success) (out as Record<string, unknown>)[key] = parsed.data;
    else logger?.warn(`settings: invalid "${key}", using default`);
  }
  if (r.provider !== undefined) {
    const parsed = ProviderConfig.safeParse(r.provider);
    if (parsed.success) out.provider = parsed.data;
    else logger?.warn('settings: invalid provider configuration, dropped');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// App-internal state (not user settings)
// ---------------------------------------------------------------------------------------------

interface AppStateData {
  /** Stable per-install UUID (ChatGPT sign-in `ext_agent_host_id`). */
  deviceId?: string;
  chatgptClientId?: string;
  /** Base URL returned by the key server with the voucher key (our LiteLLM gateway, or the mock LLM). */
  voucherBaseUrl?: string;
}

export class AppStateStore {
  private data: AppStateData = {};
  private readonly mutex = new Mutex();

  private constructor(private readonly file: string) {}

  static async open(file: string, logger: Logger): Promise<AppStateStore> {
    const store = new AppStateStore(file);
    try {
      const raw = await readJsonFile(file);
      if (raw && typeof raw === 'object') {
        const { deviceId, chatgptClientId, voucherBaseUrl } = raw as AppStateData;
        if (typeof deviceId === 'string' && /^[0-9a-f-]{36}$/i.test(deviceId))
          store.data.deviceId = deviceId;
        if (typeof chatgptClientId === 'string' && chatgptClientId.length > 0)
          store.data.chatgptClientId = chatgptClientId;
        if (typeof voucherBaseUrl === 'string' && /^https?:\/\//.test(voucherBaseUrl))
          store.data.voucherBaseUrl = voucherBaseUrl;
      }
    } catch (err) {
      logger.warn('state.json unreadable; starting fresh', err);
    }
    return store;
  }

  private persist(): Promise<void> {
    return writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  deviceId(): Promise<string> {
    return this.mutex.run(async () => {
      if (!this.data.deviceId) {
        this.data.deviceId = randomUUID();
        await this.persist();
      }
      return this.data.deviceId;
    });
  }

  async chatgptClientId(): Promise<string | undefined> {
    return this.data.chatgptClientId;
  }

  setChatgptClientId(clientId: string): Promise<void> {
    return this.mutex.run(async () => {
      this.data.chatgptClientId = clientId;
      await this.persist();
    });
  }

  async voucherBaseUrl(): Promise<string | undefined> {
    return this.data.voucherBaseUrl;
  }

  setVoucherBaseUrl(url: string): Promise<void> {
    return this.mutex.run(async () => {
      this.data.voucherBaseUrl = url;
      await this.persist();
    });
  }

  async reset(): Promise<void> {
    await this.mutex.run(async () => {
      this.data = {};
      await rm(this.file, { force: true });
    });
  }
}
