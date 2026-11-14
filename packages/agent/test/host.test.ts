import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Api, Credential, Model } from '@earendil-works/pi-ai';
import { parseAppLink } from '@sa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeClient } from '../src/bridge/client';
import { parseHostConfig } from '../src/config';
import { BridgeCredentialStore, normalizeCredential } from '../src/host/credentials';
import { linkedDocumentIds, unknownDocumentsMessage } from '../src/host/document-links';
import { templateFor } from '../src/host/model';
import { prepareSessionFile } from '../src/host/session';
import { agentHostPath, buildAgentLaunch } from '../src/launch';
import { buildCoordinatorPrompt } from '../src/prompt/coordinator';
import { formatToday } from '../src/prompt/system';
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';

const config = {
  role: 'agent' as const,
  procedureId: 'p1',
  sessionFile: '/tmp/sa/sessions/p1.jsonl',
  language: 'es' as const,
  model: { provider: 'openrouter', id: 'moonshotai/kimi-k2.6', maxTokens: 8192 },
};

describe('buildAgentLaunch', () => {
  it('builds a minimal, secret-free environment', () => {
    const launch = buildAgentLaunch({
      nodeBinary: '/Applications/SpainAssist.app/Contents/MacOS/SpainAssist',
      electronRunAsNode: true,
      cwd: '/tmp/sa/work/p1',
      config,
      bridge: { url: 'http://127.0.0.1:5555', token: 'tok' },
      inheritEnv: {
        PATH: '/usr/bin',
        HOME: '/Users/x',
        OPENAI_API_KEY: 'sk-secret',
        OPENROUTER_API_KEY: 'sk-or-secret',
        NODE_OPTIONS: '--require evil.js',
        HTTPS_PROXY: 'http://proxy:8080',
      },
      extraEnv: { PI_OFFLINE: '0', DEBUG_SA: '1' },
    });
    expect(launch.command).toBe('/Applications/SpainAssist.app/Contents/MacOS/SpainAssist');
    expect(launch.args).toEqual([agentHostPath()]);
    expect(launch.cwd).toBe('/tmp/sa/work/p1');
    expect(launch.env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      HTTPS_PROXY: 'http://proxy:8080',
      ELECTRON_RUN_AS_NODE: '1',
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
      // Resolved: on Windows `/tmp/...` gains the current drive and backslashes.
      PI_CODING_AGENT_DIR: resolve('/tmp/sa/work/p1/pi-agent'),
      SA_BRIDGE_URL: 'http://127.0.0.1:5555',
      SA_BRIDGE_TOKEN: 'tok',
      SA_PROCEDURE_ID: 'p1',
      SA_LANGUAGE: 'es',
      DEBUG_SA: '1',
    });
    expect(JSON.parse(launch.env.SA_AGENT_CONFIG ?? '{}')).toMatchObject({
      ...config,
      sessionFile: resolve(config.sessionFile),
    });
    for (const name of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'NODE_OPTIONS']) {
      expect(launch.env[name]).toBeUndefined();
    }
    expect(JSON.stringify(launch)).not.toContain('secret');
  });

  it('omits ELECTRON_RUN_AS_NODE for plain node and validates the config', () => {
    const launch = buildAgentLaunch({
      nodeBinary: process.execPath,
      electronRunAsNode: false,
      cwd: '/tmp/x',
      config,
      bridge: { url: 'http://127.0.0.1:1', token: 't' },
      hostPath: '/opt/sa/host.js',
      inheritEnv: {},
    });
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(launch.args).toEqual(['/opt/sa/host.js']);
    expect(() =>
      buildAgentLaunch({
        nodeBinary: 'node',
        electronRunAsNode: false,
        cwd: '/tmp/x',
        config: { ...config, language: 'fr' as never },
        bridge: { url: 'u', token: 't' },
      }),
    ).toThrow(/Invalid agent config/);
    expect(agentHostPath().endsWith(join('agent', 'dist', 'host.js'))).toBe(true);
  });

  it('requires a base URL for custom providers', () => {
    expect(() =>
      parseHostConfig({ ...config, model: { provider: 'custom', id: 'llama' } }),
    ).toThrow(/baseUrl is required/);
    expect(parseHostConfig(JSON.stringify(config)).research).toEqual({});
  });

  it("takes every research mode's model of a ChatGPT plan, or none", () => {
    const chatgptModels = {
      fast: { id: 'gpt-6-luna', thinkingLevel: 'high' },
      balanced: { id: 'gpt-5.6-terra', thinkingLevel: 'high' },
      deep: { id: 'gpt-5.6-terra', thinkingLevel: 'max' },
    } as const;
    expect(parseHostConfig({ ...config, research: { chatgptModels } }).research).toEqual({
      chatgptModels,
    });
    const { deep: _, ...partial } = chatgptModels;
    expect(() => parseHostConfig({ ...config, research: { chatgptModels: partial } })).toThrow(
      /Invalid agent host config/,
    );
  });

  it('keeps the DNI through the phone off unless the app turns it on', () => {
    expect(parseHostConfig(config).dniePhone).toBe(false);
    expect(parseHostConfig({ ...config, dniePhone: true }).dniePhone).toBe(true);
  });
});

describe('model templates for unknown ids', () => {
  const models = [
    'gpt-4',
    'gpt-5.5',
    'gpt-6-sol',
    'gpt-6.1-sol',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2',
    'openai/gpt-6-luna',
  ].map((id) => ({ id }) as Model<Api>);
  it('clones the closest sibling, else the provider default', () => {
    expect(templateFor('openai', models, 'gpt-6.2-sol')?.id).toBe('gpt-6.1-sol');
    expect(templateFor('openrouter', models, 'moonshotai/kimi-k3')?.id).toBe(
      'moonshotai/kimi-k2.6',
    );
    expect(templateFor('openrouter', models, 'mock-model')?.id).toBe('openai/gpt-6-luna');
    expect(templateFor('openai', models, 'o9')?.id).toBe('gpt-6.1-sol');
    expect(templateFor('xai', models, 'grok-9')?.id).toBe('gpt-4');
    expect(templateFor('xai', [], 'grok-9')).toBeUndefined();
  });
});

describe('system prompt', () => {
  it('dates the prompt in Madrid time and names the language', () => {
    const now = new Date('2026-10-03T23:30:00Z'); // already the 4th in Madrid
    const prompt = buildCoordinatorPrompt({ language: 'es', now });
    expect(prompt).toContain('Today is Sunday 2026-10-04 (Europe/Madrid).');
    expect(prompt).toContain('Write for the user in Spanish');
    expect(buildCoordinatorPrompt({ language: 'en', now })).toContain(
      'Write for the user in English',
    );
    expect(formatToday(now, 'Not/AZone')).toContain('Europe/Madrid');
  });

  it('teaches the coordinator only app links the app opens', () => {
    const prompt = buildCoordinatorPrompt({ language: 'es' });
    const links = [...prompt.matchAll(/\((sa:[^)\s]+)\)/g)].map((m) => m[1]);
    expect(links).toContain('sa:vault/documents');
    expect(links).toContain('sa:document/<id>');
    for (const link of links)
      expect(parseAppLink(link.replace('<id>', 'p_0123456789abcdef')), link).not.toBeNull();
  });
});

describe('document links', () => {
  it('finds each linked document once, cards and inline links alike', () => {
    expect(
      linkedDocumentIds(
        'Mira [el impreso](sa:document/doc-1) y [la tasa](sa:document/doc-2).\n\n[Impreso](sa:document/doc-1)\n[Trámites](sa:procedures)',
      ),
    ).toEqual(['doc-1', 'doc-2']);
    expect(linkedDocumentIds('Sin enlaces.')).toEqual([]);
  });

  it('names the unknown ids and lists the saved documents', () => {
    const message = unknownDocumentsMessage(['doc-x'], [{ id: 'doc-1', name: 'Impreso.pdf' }]);
    expect(message).toContain('links sa:document/doc-x, but no saved document has that id');
    expect(message).toContain('\n- doc-1: Impreso.pdf\n');
    expect(unknownDocumentsMessage(['a', 'b'], [])).toContain('There are no saved documents.');
  });
});

describe('session file', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Windows has no POSIX modes (Node reports 0o666): the files rely on the profile folder's ACLs.
  const posix = process.platform !== 'win32';

  it('creates a private file in a private directory and tightens existing files', () => {
    dir = mkdtempSync(join(tmpdir(), 'sa-session-'));
    const file = prepareSessionFile(join(dir, 'sessions', 'p1.jsonl'));
    expect(statSync(file).isFile()).toBe(true);
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
    if (posix) expect(statSync(join(dir, 'sessions')).mode & 0o777).toBe(0o700);
    const existing = join(dir, 'sessions', 'old.jsonl');
    writeFileSync(existing, '{}\n', { mode: 0o644 });
    prepareSessionFile(existing);
    if (posix) expect(statSync(existing).mode & 0o777).toBe(0o600);
  });
});

describe('BridgeCredentialStore', () => {
  let bridge: FakeBridge | undefined;
  afterEach(async () => {
    await bridge?.close();
  });

  it('serves only its provider, with a short cache', async () => {
    let key = 'sk-or-1';
    bridge = await createFakeBridge({
      'agent.credential': () => ({ credential: { type: 'api_key', key } }),
    });
    const store = new BridgeCredentialStore(
      new BridgeClient({ url: bridge.url, token: bridge.token }),
      'openrouter',
      50,
    );
    expect(await store.read('anthropic')).toBeUndefined();
    expect(await store.read('openrouter')).toEqual({ type: 'api_key', key: 'sk-or-1' });
    expect(await store.list()).toEqual([{ providerId: 'openrouter', type: 'api_key' }]);
    expect(bridge.callsTo('agent.credential')).toHaveLength(1);
    key = 'sk-or-2';
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await store.read('openrouter')).toEqual({ type: 'api_key', key: 'sk-or-2' });
    expect(bridge.callsTo('agent.credential')[0]?.params).toEqual({ providerId: 'openrouter' });
  });

  it('delegates OAuth refreshes to the app instead of refreshing locally', async () => {
    const stale = {
      type: 'oauth',
      access: 'old',
      refresh: 'r1',
      expires: Date.now() + 1000,
      clientId: 'oaiapp_1',
    };
    const fresh = { ...stale, access: 'new', refresh: 'r2', expires: Date.now() + 3600_000 };
    bridge = await createFakeBridge({
      'agent.credential': () => ({ credential: stale }),
      'agent.refreshCredential': () => ({ credential: fresh }),
    });
    const store = new BridgeCredentialStore(
      new BridgeClient({ url: bridge.url, token: bridge.token }),
      'openai',
    );
    let localRefresh = false;
    const result = await store.modify('openai', async (current) => {
      localRefresh = true;
      return current;
    });
    expect(localRefresh).toBe(false);
    expect(result).toMatchObject({ type: 'oauth', access: 'new', refresh: 'r2' });
    expect(bridge.callsTo('agent.refreshCredential')[0]?.params).toEqual({ providerId: 'openai' });
    expect(await store.read('openai')).toMatchObject({ access: 'new' });
  });

  it('validates credential shapes', () => {
    expect(normalizeCredential(null)).toBeUndefined();
    expect(normalizeCredential({ type: 'api_key', key: 5 })).toBeUndefined();
    expect(normalizeCredential({ type: 'oauth', access: 'a', refresh: 'r' })).toBeUndefined();
    const ok = normalizeCredential({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
      clientId: 'c',
    });
    expect(ok as Credential).toMatchObject({ type: 'oauth', clientId: 'c' });
  });
});
