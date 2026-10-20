import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type SaEvent } from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import { silentLogger } from '../core/logger';
import { AppStateStore, languageForLocales, normalizeSettings, SettingsStore } from './store';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sa-settings-'));
  file = join(dir, 'settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('starts from defaults and persists updates, emitting settings.changed', async () => {
    const events = new EventBus();
    const seen: SaEvent[] = [];
    events.on((e) => seen.push(e));
    const store = await SettingsStore.open(file, { events, logger: silentLogger });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const next = await store.update({ language: 'en' });
    expect(next.language).toBe('en');
    expect(seen).toEqual([{ type: 'settings.changed', settings: next }]);
    const reopened = await SettingsStore.open(file, { logger: silentLogger });
    expect(reopened.get()).toEqual(next);
  });

  it('keeps valid fields and replaces invalid ones with defaults', async () => {
    await writeFile(
      file,
      JSON.stringify({
        language: 'fr',
        shareLearnings: false,
        // Service URLs and the browser's visibility used to be settings: old entries are dropped.
        browser: { headless: true },
        services: { keyServerUrl: 'https://keys.example.com' },
        provider: { kind: 'voucher', model: 'x' },
      }),
    );
    const store = await SettingsStore.open(file, { logger: silentLogger });
    const s = store.get();
    expect(s.language).toBe('es');
    expect(s.shareLearnings).toBe(false);
    expect(s).not.toHaveProperty('browser');
    expect(s).not.toHaveProperty('services');
    expect(s.provider).toBeUndefined();
  });

  it.each([true, false])('drops the removed error-reporting setting (%s)', async (errorReports) => {
    await writeFile(file, JSON.stringify({ language: 'en', shareLearnings: false, errorReports }));
    const store = await SettingsStore.open(file, { logger: silentLogger });
    expect(store.get()).not.toHaveProperty('errorReports');
    expect(store.get().shareLearnings).toBe(false);
    await store.update({ shareLearnings: true });
    const reopened = await SettingsStore.open(file, { logger: silentLogger });
    expect(reopened.get()).not.toHaveProperty('errorReports');
    expect(reopened.get().shareLearnings).toBe(true);
  });

  it('drops the model an older version stored for a voucher', async () => {
    const voucher = { kind: 'voucher', secretId: 'provider.voucher', limitUsd: 5 };
    await writeFile(file, JSON.stringify({ provider: { ...voucher, model: 'openai/gpt-6-luna' } }));
    const store = await SettingsStore.open(file, { logger: silentLogger });
    expect(store.get().provider).toEqual(voucher);
  });

  it('recovers from a corrupt file', async () => {
    await writeFile(file, '{not json');
    const store = await SettingsStore.open(file, { logger: silentLogger });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('sets and clears the provider; notifies listeners with previous values', async () => {
    const store = await SettingsStore.open(file, { logger: silentLogger });
    const changes: [string | undefined, string | undefined][] = [];
    store.onChange((next, prev) => changes.push([prev.provider?.kind, next.provider?.kind]));
    await store.setProvider({ kind: 'chatgpt' });
    await store.setProvider(undefined);
    expect(changes).toEqual([
      [undefined, 'chatgpt'],
      ['chatgpt', undefined],
    ]);
    await store.reset();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('normalizes untrusted input', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    // Settings from older versions (the removed search provider choice) are dropped.
    expect(normalizeSettings({ language: 'en', research: { searchProvider: 'brave' } })).toEqual({
      ...DEFAULT_SETTINGS,
      language: 'en',
    });
  });

  it('starts in the OS language until the user picks one, and again after a wipe', async () => {
    const store = await SettingsStore.open(file, { logger: silentLogger, language: 'en' });
    expect(store.get().language).toBe('en');
    await store.update({ language: 'es' });
    const reopened = await SettingsStore.open(file, { logger: silentLogger, language: 'en' });
    expect(reopened.get().language).toBe('es');
    await reopened.reset();
    expect(reopened.get().language).toBe('en');
  });
});

describe('languageForLocales', () => {
  it('picks the first language the app speaks', () => {
    expect(languageForLocales(['en-GB', 'es-ES'])).toBe('en');
    expect(languageForLocales(['es-419'])).toBe('es');
    expect(languageForLocales(['ca-ES', 'en-US'])).toBe('es');
    expect(languageForLocales(['eu', 'gl_ES'])).toBe('es');
    expect(languageForLocales(['fr-FR', 'es-ES'])).toBe('es');
  });

  it('falls back to English for other languages and to Spanish when the OS says nothing', () => {
    expect(languageForLocales(['fr-FR', 'de-DE'])).toBe('en');
    expect(languageForLocales([])).toBe('es');
  });
});

describe('AppStateStore', () => {
  it('keeps a stable device id and the voucher base URL', async () => {
    const stateFile = join(dir, 'state.json');
    const a = await AppStateStore.open(stateFile, silentLogger);
    const id = await a.deviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await a.deviceId()).toBe(id);
    await a.setVoucherBaseUrl('http://127.0.0.1:8789/v1');
    await a.setChatgptClientId('registered-client');
    const b = await AppStateStore.open(stateFile, silentLogger);
    expect(await b.deviceId()).toBe(id);
    expect(await b.chatgptClientId()).toBe('registered-client');
    expect(await b.voucherBaseUrl()).toBe('http://127.0.0.1:8789/v1');
    await b.reset();
    expect(await b.voucherBaseUrl()).toBeUndefined();
  });
});
