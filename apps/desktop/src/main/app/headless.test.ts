/**
 * createHeadlessApp: the real services in plain Node, driven through the renderer API. The agent
 * and the browser are the fakes of the main-process tests, so this is fast and offline; what is
 * real is the composition root, the vault (with the test key provider), the bridge server and the
 * agent manager.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserServiceOptions } from '@sa/browser';
import {
  ASSISTANT_AGENT_ID,
  credentialAllowedOn,
  PRODUCTION_SERVICES,
  type SaEvent,
  setExtraTrustedHosts,
} from '@sa/shared';
import type { Sidecar } from '@sa/sidecar';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/logger';
import { createFakeAgentLib, FakeBrowser } from '../testing/fakes';
import { createFakeFetch, jsonResponse } from '../testing/harness';
import { parseEnv } from './env';
import { createHeadlessApp, type HeadlessApp, type HeadlessOptions } from './headless';

let root: string;
let hostScript: string;
let apps: HeadlessApp[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sa-headless-'));
  // Any existing file: the fake agent lib never runs it.
  hostScript = join(root, 'host.js');
  await writeFile(hostScript, '');
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
  setExtraTrustedHosts([]);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function open(options: Partial<HeadlessOptions> = {}) {
  const agentLib = createFakeAgentLib();
  const app = await createHeadlessApp({
    userDataDir: join(root, 'userData'),
    tmpRoot: join(root, 'os-tmp'),
    agentLib,
    browserFactory: () => new FakeBrowser(),
    hostScript,
    ...options,
  });
  apps.push(app);
  return { app, agentLib };
}

/** An app with a provider, so that the chat starts an agent (a custom endpoint: no network). */
async function openWithProvider(options: Partial<HeadlessOptions> = {}) {
  const opened = await open(options);
  const set = await opened.app.invoke('providers.setCustom', {
    baseUrl: 'http://127.0.0.1:18789/v1',
    api: 'openai-completions',
    model: 'mock-model',
  });
  expect(set.ok).toBe(true);
  return opened;
}

/** One bridge call as an agent would make it (the bearer token identifies the agent). */
async function bridge(app: HeadlessApp, method: string, params: unknown, token: string) {
  const res = await fetch(`${app.services.bridge.url()}/rpc/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  return (await res.json()) as { ok: boolean; result?: unknown; error?: { code: string } };
}

describe('defaults', () => {
  it('opens a Spanish profile with every feature off, in e2e mode, with no remote services', async () => {
    const { app } = await open();
    expect(await app.invoke('app.info')).toEqual({
      name: 'Spain Assist',
      version: '0.0.0-headless',
      platform: process.platform,
      installChannel: 'dev',
      isDev: false,
      isE2E: true,
      features: { dniePhone: false, mustUpdate: false, errorReports: false },
      errorReports: false,
    });
    expect((await app.invoke('settings.get')).language).toBe('es');
    expect(app.services.companion).toBeUndefined();
    expect(app.paths.userData).toBe(join(root, 'userData'));
    expect(app.paths.tmpDir.startsWith(join(root, 'os-tmp'))).toBe(true);
    // The renderer API has every method the window has.
    expect(app.services.router.methods()).toContain('chat.respond');
    expect(app.services.router.methods()).toContain('vault.addClave');
  });

  it('takes language, features, version and capture from the options', async () => {
    const { app } = await open({
      language: 'en',
      features: { dniePhone: true },
      version: '9.9.9',
      capture: true,
    });
    expect(await app.invoke('app.info')).toMatchObject({
      version: '9.9.9',
      isDev: true,
      features: { dniePhone: true, mustUpdate: false },
    });
    expect((await app.invoke('settings.get')).language).toBe('en');
    expect(app.services.companion).toBeDefined();
  });

  it("keeps the sidecar's error pages in the app's language", async () => {
    const languages: string[] = [];
    const sidecar = {
      setLanguage: (language: string) => languages.push(language),
      close: async () => {},
    } as unknown as Sidecar;
    const { app } = await open({ language: 'en', startSidecar: async () => sidecar });
    expect(languages).toEqual(['en']);
    await app.invoke('settings.update', { language: 'es' });
    await app.invoke('settings.update', { onboardingCompleted: true });
    expect(languages).toEqual(['en', 'es']);
  });

  it('reads nothing from process.env', async () => {
    vi.stubEnv('SA_KEY_SERVER_URL', 'https://keys.attacker.test');
    vi.stubEnv('SA_FEEDBACK_SERVER_URL', 'https://feedback.attacker.test');
    vi.stubEnv('SA_FEATURE_FLAGS', 'dnie-phone');
    vi.stubEnv('SA_EXTRA_TRUSTED_HOSTS', 'localhost');
    vi.stubEnv('SA_USER_DATA_DIR', join(root, 'elsewhere'));
    const { app, agentLib } = await openWithProvider();
    expect((await app.invoke('app.info')).features).toEqual({
      dniePhone: false,
      mustUpdate: false,
      errorReports: false,
    });
    expect(credentialAllowedOn('clave_permanente', 'https://localhost/')).toBe(false);
    expect(existsSync(join(root, 'elsewhere'))).toBe(false);
    await app.invoke('chat.send', { text: 'Hola' });
    await app.services.chat.settled();
    expect(agentLib.launches).toHaveLength(1);
    expect(JSON.stringify(agentLib.launches[0]?.config)).not.toContain('attacker.test');
  });
});

describe('production services', () => {
  it('refuses what parseEnv would put in, and each production URL on its own', async () => {
    const options = { userDataDir: join(root, 'userData'), tmpRoot: join(root, 'os-tmp') };
    await expect(createHeadlessApp({ ...options, env: parseEnv({}) })).rejects.toThrow(
      /production service/,
    );
    for (const name of [
      'keyServerUrl',
      'feedbackServerUrl',
      'mapsServerUrl',
      'relayServerUrl',
    ] as const) {
      for (const url of [PRODUCTION_SERVICES[name], `${PRODUCTION_SERVICES[name]}/v1/`]) {
        await expect(createHeadlessApp({ ...options, env: { [name]: url } })).rejects.toThrow(
          new RegExp(`env\\.${name} is a production service`),
        );
      }
    }
    // Nothing was created by the refused attempts.
    expect(existsSync(options.userDataDir)).toBe(false);
  });

  it('puts no production URL in what an agent is told, and the given ones where they belong', async () => {
    const plain = await openWithProvider({ userDataDir: join(root, 'plain') });
    await plain.app.invoke('chat.send', { text: 'Hola' });
    await plain.app.services.chat.settled();
    const config = plain.agentLib.launches[0]?.config;
    expect(config?.research?.keyServerUrl).toBeUndefined();
    expect(config?.feedback).toBeUndefined();
    expect(JSON.stringify(plain.agentLib.launches)).not.toMatch(/spainassist\.es|sslip\.io/);

    const local = await openWithProvider({
      userDataDir: join(root, 'local'),
      env: { keyServerUrl: 'http://127.0.0.1:18787', feedbackServerUrl: 'http://127.0.0.1:18788' },
    });
    await local.app.invoke('chat.send', { text: 'Hola' });
    await local.app.services.chat.settled();
    expect(local.agentLib.launches[0]?.config.research?.keyServerUrl).toBe(
      'http://127.0.0.1:18787',
    );
    expect(local.agentLib.launches[0]?.config.feedback).toBeDefined();
  });

  it('keeps the backends offline unless given a fetch', async () => {
    const probe = {
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      model: 'llama3',
    } as const;
    const realFetch = vi.spyOn(globalThis, 'fetch');
    const { app } = await open();
    expect(await app.invoke('providers.probeCustom', probe)).toMatchObject({ reachable: false });
    expect(realFetch).not.toHaveBeenCalled();

    const fetch = createFakeFetch(() => jsonResponse(200, { data: [{ id: 'llama3' }] }));
    const online = await open({ userDataDir: join(root, 'online'), fetch });
    expect(await online.app.invoke('providers.probeCustom', probe)).toMatchObject({
      reachable: true,
    });
    expect(fetch.requests.length).toBeGreaterThan(0);
    expect(fetch.requests.every((r) => r.url.hostname === '127.0.0.1')).toBe(true);
  });
});

describe('the profile and the vault', () => {
  it('seeds the vault through the renderer API and reopens it with the same seed', async () => {
    const first = await open({ keySeed: 'seed-one' });
    await first.app.invoke('vault.setPersonal', [
      { key: 'givenName', value: 'Lucía' },
      { key: 'surname1', value: 'Moreno' },
    ]);
    const clave = await first.app.invoke('vault.addClave', {
      username: '12345678Z',
      password: 'correct horse battery',
    });
    expect(clave).toMatchObject({ kind: 'clave_permanente', policy: 'auto' });
    expect(JSON.stringify(await first.app.invoke('vault.overview'))).not.toContain(
      'correct horse battery',
    );
    await first.app.close();

    // Same directory, same seed: the data is there (this is how a run is restored from a copy).
    const again = await open({ keySeed: 'seed-one' });
    const overview = await again.app.invoke('vault.overview');
    expect(overview.personal.map((p) => [p.key, p.value])).toEqual(
      expect.arrayContaining([
        ['givenName', 'Lucía'],
        ['surname1', 'Moreno'],
      ]),
    );
    expect(overview.credentials.map((c) => c.id)).toEqual([clave.id]);
    await again.app.close();

    // A vault does not open with another seed, and the failed attempt leaves nothing open.
    await expect(
      createHeadlessApp({
        userDataDir: join(root, 'userData'),
        tmpRoot: join(root, 'os-tmp'),
        keySeed: 'another-seed',
        agentLib: createFakeAgentLib(),
        browserFactory: () => new FakeBrowser(),
        hostScript,
      }),
    ).rejects.toThrow();
  });

  it('opens the vault through the given function, with the key provider of the seed', async () => {
    const opened: string[] = [];
    const first = await open({
      keySeed: 'seed-given',
      openVault: async (dir, keys) => {
        opened.push(dir);
        return Vault.open(dir, keys, { now: () => new Date('2030-01-02T03:04:05.000Z') });
      },
    });
    expect(opened).toEqual([join(first.app.paths.userData, 'vault')]);
    await first.app.invoke('vault.setPersonal', [{ key: 'givenName', value: 'Lucía' }]);
    expect((await first.app.invoke('vault.overview')).personal[0]).toMatchObject({
      key: 'givenName',
      updatedAt: '2030-01-02T03:04:05.000Z',
    });
    await first.app.close();
    // It was the seed's key provider that sealed it.
    const reopened = await Vault.open(opened[0] as string, createTestKeyProvider('seed-given'));
    expect(reopened.listPersonal().map((p) => p.key)).toEqual(['givenName']);
  });

  it('validates every call like the renderer API does', async () => {
    const { app } = await open();
    await expect(
      app.invoke('vault.addClave', { username: 'not a DNI', password: 'x' }),
    ).rejects.toThrow();
    await expect(
      // @ts-expect-error a language the app does not have
      app.invoke('settings.update', { language: 'fr' }),
    ).rejects.toThrow();
    await expect(
      // @ts-expect-error not a method
      app.invoke('vault.exfiltrate'),
    ).rejects.toThrow();
  });

  it('delivers the renderer events until unsubscribed', async () => {
    const { app } = await open();
    const seen: SaEvent[] = [];
    const off = app.on((event) => seen.push(event));
    await app.invoke('settings.update', { onboardingCompleted: true });
    expect(seen.map((e) => e.type)).toContain('settings.changed');
    off();
    seen.length = 0;
    await app.invoke('settings.update', { onboardingCompleted: false });
    expect(seen).toEqual([]);
  });
});

describe('answering prompts as the user', () => {
  it('lists the pending prompt and answers it through chat.respond, saving what the UI saves', async () => {
    const { app } = await open();
    const token = app.services.tokens.issue(ASSISTANT_AGENT_ID);
    const asked = fetch(`${app.services.bridge.url()}/rpc/prompt.form`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Tu nombre',
        fields: [
          { key: 'name', label: 'Nombre', type: 'text', required: true, vaultKey: 'givenName' },
        ],
      }),
    }).then((res) => res.json() as Promise<{ ok: boolean; result?: unknown }>);
    await vi.waitFor(() => expect(app.services.prompts.pendingItems()).toHaveLength(1));

    const [pending] = app.services.prompts.pendingItems();
    expect(pending).toMatchObject({
      owner: ASSISTANT_AGENT_ID,
      item: { status: 'pending', prompt: { kind: 'form', title: 'Tu nombre' } },
    });
    await app.invoke('chat.respond', pending?.item.id ?? '', {
      kind: 'form',
      values: { name: 'Lucía' },
      dismissed: false,
      savedToVault: ['name'],
    });
    expect(await asked).toMatchObject({ ok: true, result: { values: { name: 'Lucía' } } });
    expect(app.services.prompts.pendingItems()).toEqual([]);
    expect(
      (await app.invoke('vault.overview')).personal.find((p) => p.key === 'givenName')?.value,
    ).toBe('Lucía');
  });
});

describe('the services behind the options', () => {
  const mapForm = {
    title: 'Elige un centro',
    fields: [
      {
        key: 'centre',
        label: 'Centro',
        type: 'map-options',
        options: [{ value: 'one', label: 'Centro uno', address: 'Calle Falsa 1, Sevilla' }],
      },
    ],
  };

  it('looks map forms up with the given places, and has none otherwise', async () => {
    const plain = await open();
    const token = plain.app.services.tokens.issue(ASSISTANT_AGENT_ID);
    expect(await bridge(plain.app, 'prompt.form', mapForm, token)).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });

    const place = vi.fn(async () => ({ latitude: 37.38, longitude: -5.98 }));
    const { app } = await open({
      userDataDir: join(root, 'places'),
      places: { place, home: async () => null },
    });
    const asked = bridge(
      app,
      'prompt.form',
      mapForm,
      app.services.tokens.issue(ASSISTANT_AGENT_ID),
    );
    await vi.waitFor(() => expect(app.services.prompts.pendingItems()).toHaveLength(1));
    expect(place).toHaveBeenCalledWith('Calle Falsa 1, Sevilla', expect.anything());
    const [pending] = app.services.prompts.pendingItems();
    await app.invoke('chat.respond', pending?.item.id ?? '', {
      kind: 'form',
      values: { centre: 'one' },
      dismissed: false,
      savedToVault: [],
    });
    expect(await asked).toMatchObject({ ok: true, result: { values: { centre: 'one' } } });
  });

  it('builds the browser headless, accepting invalid certificates, recording only when asked', async () => {
    const seen: BrowserServiceOptions[] = [];
    const browserFactory = (options: BrowserServiceOptions) => {
      seen.push(options);
      return new FakeBrowser();
    };
    const open1 = await open({ browserFactory });
    const procedure = await open1.app.services.procedures.create('Trámite');
    const token = open1.app.services.tokens.issue(procedure.id);
    const opened = await bridge(
      open1.app,
      'browser.open',
      { url: 'https://sede.example.gob.es/' },
      token,
    );
    expect(opened.ok).toBe(true);
    expect(seen[0]).toMatchObject({ headless: true, ignoreHTTPSErrors: true });
    expect(seen[0]?.capture).toBeUndefined();
    expect(seen[0]?.certificates).toBeUndefined();

    const recording = await open({
      userDataDir: join(root, 'capture'),
      browserFactory,
      capture: true,
    });
    const recorded = await recording.app.services.procedures.create('Trámite');
    await bridge(
      recording.app,
      'browser.open',
      { url: 'https://sede.example.gob.es/' },
      recording.app.services.tokens.issue(recorded.id),
    );
    expect(seen[1]?.capture?.dir(recorded.id)).toBe(
      join(recording.app.paths.proceduresDir, recorded.id, 'capture'),
    );
  });
});

describe('providers', () => {
  it('overrides the real provider functions by name', async () => {
    const redeemed: unknown[][] = [];
    const { app } = await open({
      env: { keyServerUrl: 'http://127.0.0.1:18787' },
      providerLib: {
        async redeemVoucher(...args) {
          redeemed.push(args);
          return {
            provider: 'litellm',
            baseUrl: 'http://127.0.0.1:18789/v1',
            apiKey: 'sk-litellm-headless-test-key',
            limitUsd: 5,
            usageUsd: 0,
            addedUsd: 5,
            searchTools: [],
          };
        },
        async getVoucherCredit() {
          return { limitUsd: 5, spendUsd: 0, maxBudgetUsd: 5, expiresAt: null };
        },
      },
    });
    expect(await app.invoke('providers.redeemVoucher', 'SA-HEADLESS')).toMatchObject({
      ok: true,
    });
    expect(redeemed).toEqual([['http://127.0.0.1:18787', 'SA-HEADLESS', undefined]]);
    // The real model tables stay.
    expect(app.services.providers.agentModel).toBeDefined();
  });

  it('keeps the development Codex login by default, and drops it when told', async () => {
    const userDataDir = join(root, 'codex');
    await mkdir(userDataDir, { recursive: true });
    await writeFile(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ language: 'es', provider: { kind: 'codex' } }),
    );
    const kept = await open({ userDataDir });
    expect((await kept.app.invoke('settings.get')).provider).toEqual({ kind: 'codex' });
    await kept.app.close();

    // ProviderManager resets a Codex session when the app has no Codex login.
    const dropped = await open({ userDataDir, providerLib: { codex: undefined } });
    expect((await dropped.app.invoke('settings.get')).provider).toBeUndefined();
  });
});

describe('the app around it', () => {
  it('trusts extra credential hosts like the app does, process-wide', async () => {
    expect(credentialAllowedOn('clave_permanente', 'https://localhost:8791/')).toBe(false);
    await open({ env: { extraTrustedHosts: ['localhost'] } });
    expect(credentialAllowedOn('clave_permanente', 'https://localhost:8791/')).toBe(true);
    await open({ userDataDir: join(root, 'other') });
    expect(credentialAllowedOn('clave_permanente', 'https://localhost:8791/')).toBe(false);
  });

  it('uses the given clock and ids', async () => {
    let n = 0;
    const { app } = await openWithProvider({
      clock: () => new Date('2026-03-14T09:30:00.000Z'),
      ids: (prefix) => `${prefix}_${(++n).toString(16).padStart(16, '0')}`,
    });
    await app.invoke('chat.send', { text: 'Hola' });
    await app.services.chat.settled();
    const first = (await app.invoke('chat.transcript'))[0];
    expect(first).toMatchObject({
      type: 'user',
      text: 'Hola',
      createdAt: '2026-03-14T09:30:00.000Z',
    });
    expect(first?.id).toMatch(/^[a-z]+_0{15}[0-9a-f]$/);
  });

  it('stops idle agents after idleMs', async () => {
    const { app, agentLib } = await openWithProvider({ idleMs: 30 });
    await app.invoke('chat.send', { text: 'Hola' });
    await app.services.chat.settled();
    const client = agentLib.clients[0];
    expect(client?.started).toBe(true);
    client?.emit({ type: 'run_start' });
    client?.emit({ type: 'run_end' });
    await vi.waitFor(() => expect(client?.stopped).toBe(true), { timeout: 3000 });
  });

  it('runs the agent with plain Node, from the host script it was given', async () => {
    const { app, agentLib } = await openWithProvider();
    await app.invoke('chat.send', { text: 'Hola' });
    await app.services.chat.settled();
    expect(agentLib.launches[0]).toMatchObject({
      nodeBinary: process.execPath,
      electronRunAsNode: false,
      hostPath: hostScript,
      config: { role: 'assistant', extraTrustedHosts: [] },
    });
    expect(agentLib.launches[0]?.cwd.startsWith(join(root, 'userData'))).toBe(true);
  });

  it('takes the host script from env.agentHost when the option is not given', async () => {
    const other = join(root, 'other-host.js');
    await writeFile(other, '');
    const { app, agentLib } = await openWithProvider({
      hostScript: undefined,
      env: { agentHost: other },
    });
    await app.invoke('chat.send', { text: 'Hola' });
    await app.services.chat.settled();
    expect(agentLib.launches[0]?.hostPath).toBe(other);
  });

  it.runIf(existsSync(join(import.meta.dirname, '../../../../../packages/agent/dist/host.js')))(
    'finds the built agent host of the workspace by default',
    async () => {
      const { app, agentLib } = await openWithProvider({ hostScript: undefined });
      await app.invoke('chat.send', { text: 'Hola' });
      await app.services.chat.settled();
      expect(agentLib.launches[0]?.hostPath).toBe(
        join(import.meta.dirname, '../../../../../packages/agent/dist/host.js'),
      );
    },
  );
});

describe('close', () => {
  it('shuts every service down, removes the scratch directory and keeps the profile', async () => {
    const { app, agentLib } = await openWithProvider();
    await app.invoke('chat.send', { text: 'Hola' });
    await app.services.chat.settled();
    const bridgeUrl = app.services.bridge.url();
    expect(agentLib.clients[0]?.started).toBe(true);
    expect(existsSync(app.paths.tmpDir)).toBe(true);
    expect((await readdir(app.paths.logsDir)).includes('main.log')).toBe(true);

    await app.close();
    await app.close();
    expect(agentLib.clients.every((client) => client.stopped)).toBe(true);
    expect(existsSync(app.paths.tmpDir)).toBe(false);
    await expect(fetch(`${bridgeUrl}/rpc/vault.read`, { method: 'POST' })).rejects.toThrow();
    // The profile (what a snapshot copies) stays.
    expect((await stat(join(app.paths.userData, 'vault'))).isDirectory()).toBe(true);
    expect(await readFile(join(app.paths.assistantDir, 'transcript.json'), 'utf8')).toContain(
      'Hola',
    );
  });

  it('writes main.log where logsDir says, instead of the profile', async () => {
    const logsDir = join(root, 'logs-elsewhere');
    const { app } = await open({ logsDir });
    app.logger.info('hello from the app');
    await app.close();
    expect(await readFile(join(logsDir, 'main.log'), 'utf8')).toContain('hello from the app');
    expect(existsSync(join(app.paths.logsDir, 'main.log'))).toBe(false);
  });

  it('writes the logs of its own logger, masking registered secrets, and leaves a given one alone', async () => {
    const { app } = await open();
    app.logger.addSecret('s3cr3t-value');
    app.logger.info('typed s3cr3t-value somewhere');
    await app.close();
    const log = await readFile(join(app.paths.logsDir, 'main.log'), 'utf8');
    expect(log).toContain('typed [secret] somewhere');
    expect(log).not.toContain('s3cr3t-value');

    const lines: string[] = [];
    const logger = {
      ...silentLogger,
      info: (message: string) => lines.push(message),
      child: () => logger,
    };
    const given = await open({ userDataDir: join(root, 'given'), logger });
    expect(given.app.logger).toBe(logger);
    await given.app.close();
    expect(lines.length).toBeGreaterThan(0);
    expect(existsSync(join(given.app.paths.logsDir, 'main.log'))).toBe(false);
  });
});
