import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Api, Credential, Model } from '@earendil-works/pi-ai';
import { parseAppLink } from '@sa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeClient } from '../src/bridge/client';
import { parseHostConfig } from '../src/config';
import { BridgeCredentialStore, normalizeCredential } from '../src/host/credentials';
import { templateFor } from '../src/host/model';
import { prepareSessionFile } from '../src/host/session';
import { agentHostPath, buildAgentLaunch } from '../src/launch';
import { buildAssistantPrompt, REPORT_PREFIX } from '../src/prompt/assistant';
import { buildSystemPrompt, formatToday } from '../src/prompt/system';
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';

const config = {
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
  it('injects the date (Madrid time) and the language', () => {
    const now = new Date('2026-10-03T23:30:00Z'); // already the 4th in Madrid
    const es = buildSystemPrompt({
      language: 'es',
      now,
      feedback: { submit: true, vote: true },
      dniePhone: true,
    });
    expect(es).toContain('Today is Sunday 2026-10-04 (Europe/Madrid).');
    expect(es).toContain('Write for the user in Spanish');
    expect(buildSystemPrompt({ language: 'en', now })).toContain('Write for the user in English');
    const assistant = buildAssistantPrompt({ language: 'es', now });
    expect(assistant).toContain('Today is Sunday 2026-10-04 (Europe/Madrid).');
    expect(assistant).toContain('Answer in Spanish');
    for (const tool of ['procedure_start', 'procedure_message', 'procedure_read', REPORT_PREFIX])
      expect(assistant).toContain(tool);
    expect(formatToday(now, 'Not/AZone')).toContain('Europe/Madrid');
    for (const rule of [
      'procedure_update',
      'confirm_action',
      'browser_login_clave',
      'feedback_submit',
      'request_phone_call',
      'untrusted',
    ]) {
      expect(es).toContain(rule);
    }
    expect(es).not.toContain('<cwd>');
    expect(es.length).toBeLessThan(11_900);
  });
});

describe('community learnings prompt', () => {
  it('mentions the feedback tools only when they are available', () => {
    const on = buildSystemPrompt({
      language: 'en',
      research: 'web_research',
      feedback: { submit: true, vote: true },
    });
    expect(on).toContain('Consult feedback_search');
    expect(on).toContain('call feedback_submit');
    expect(on).toContain('feedback_vote');
    const voteOnly = buildSystemPrompt({
      language: 'en',
      research: 'web_research',
      feedback: { submit: false, vote: true },
    });
    expect(voteOnly).toContain('call feedback_vote');
    expect(voteOnly).not.toContain('feedback_submit');
    const readOnly = buildSystemPrompt({
      language: 'en',
      research: 'web_research',
      feedback: { submit: false, vote: false },
    });
    expect(readOnly).toContain('Consult feedback_search');
    expect(readOnly).not.toContain('feedback_submit');
    expect(readOnly).not.toContain('feedback_vote');
    const off = buildSystemPrompt({ language: 'en', research: 'web_research' });
    expect(off).not.toContain('feedback_search');
    expect(off).not.toContain('feedback_submit');
  });
});

describe('DNI prompt', () => {
  it('offers the DNI through the phone only with its feature flag', () => {
    const on = buildSystemPrompt({ language: 'en', research: 'web_research', dniePhone: true });
    expect(on).toContain('DNI logs in and signs through the phone.');
    expect(on).toContain('request_credential with credential dnie');
    for (const off of [
      buildSystemPrompt({ language: 'en', research: 'web_research' }),
      buildSystemPrompt({ language: 'en', research: 'web_research', dniePhone: false }),
    ]) {
      expect(off).not.toContain('DNI logs in and signs through the phone.');
      expect(off).not.toContain('request_credential with credential dnie');
      expect(off).toContain('Cl@ve Permanente and Cl@ve Móvil are different capabilities');
      expect(off).toContain('browser_use_certificate is only for logins where the browser asks');
    }
  });

  it('tells TLS client-certificate logins apart from AutoFirma logins', () => {
    const prompt = buildSystemPrompt({ language: 'en', research: 'web_research', dniePhone: true });
    expect(prompt).toContain('Signatures and AutoFirma logins are the app');
    expect(prompt).toContain('browser asks for a client certificate (TLS)');
  });
});

describe('identity prompt', () => {
  it('never acts as a third party and names whose identity confirm_action sends', () => {
    const procedure = buildSystemPrompt({ language: 'es', research: 'web_research' });
    expect(procedure).toContain('Act only as the user.');
    expect(procedure).toContain(
      "Never type, register, log in or sign with a third party's identity",
    );
    expect(procedure).toContain(
      'official route for third parties, authorised users or representation',
    );
    expect(procedure).toContain('If it sends identity data, say whose');
  });
});

describe('saved data and physical-place prompts', () => {
  it('reuses known locations and checks incomplete filtered reads on resumed runs', () => {
    const procedure = buildSystemPrompt({ language: 'es', research: 'web_research' });
    expect(procedure).toContain('including on resumed runs');
    expect(procedure).toContain('addressProvince and addressMunicipality');
    expect(procedure).toContain('call vault_read without keys');
    expect(procedure).toContain('never ask to reconfirm known data, even as prefilled fields');
    const assistant = buildAssistantPrompt({ language: 'es' });
    expect(assistant).toContain('reuse saved province/municipality');
    expect(assistant).toContain('do not prescribe redundant location forms');
  });

  it('teaches the assistant only app links the app opens', () => {
    const assistant = buildAssistantPrompt({ language: 'es' });
    const links = [...assistant.matchAll(/\((sa:[^)\s]+)\)/g)].map((m) => m[1]);
    expect(links).toContain('sa:vault/documents');
    expect(links).toContain('sa:document/<id>');
    for (const link of links)
      expect(parseAppLink(link.replace('<id>', 'p_0123456789abcdef')), link).not.toBeNull();
  });

  it('lets the app locate public places while preserving ordinary select choices', () => {
    const procedure = buildSystemPrompt({ language: 'en', research: 'web_research' });
    expect(procedure).toContain('type: "map-options"');
    expect(procedure).toContain('a provincial list may include other towns');
    expect(procedure).toContain('its street address with number and municipality (address)');
    expect(procedure).toContain('every address can be found in Spain before showing the form');
    expect(procedure).toContain("the user's choice comes back as the option value");
    expect(procedure).toContain('If ask_user returns a location error, no form was shown');
    expect(procedure).toContain('find their street addresses and municipality');
    expect(procedure).toContain('Do not research coordinates');
    expect(procedure).toContain('give the user plenty of options');
    expect(procedure).toContain('The app sorts them by closest to the user.');
    expect(procedure).toContain('Ordinary choices such as methods still use select');
    expect(procedure).toContain('free slots use appointment');
    expect(buildAssistantPrompt({ language: 'en' })).toContain(
      'map-options with place names and street addresses',
    );
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

describe('procedure research workflow', () => {
  it('requires web research, then refinement, then a clear plan before questions or execution', () => {
    const prompt = buildSystemPrompt({ language: 'es', research: 'web_research' });
    expect(prompt).toContain('call web_research once');
    expect(prompt).toContain('refine it with fetch_url, boe_search');
    expect(prompt).toContain('call it once, without polling or duplicate runs');
    expect(prompt).toContain('Only after this research completes may you refine it');
    expect(prompt).toContain(
      'Formulate the complete plan before collecting user information or executing any step',
    );
    expect(prompt).toContain('no unresolved research uncertainties');
    expect(prompt).toContain('first research the relevant branches');
    // Anonymized user context goes into the research; identifying data never does.
    expect(prompt).toContain('after vault_read, call web_research once');
    expect(prompt).toContain('anonymized: age, municipality, nationality or residence status');
    expect(prompt).toContain('issue/expiry dates');
    expect(prompt).toContain(
      'Never names, ID numbers, street addresses, contact details, birth dates',
    );
    // No guidance on which research mode to use.
    expect(prompt).not.toMatch(/\b(fast|balanced|deep)\b/i);
  });

  it('reports a research blocker without web research before collecting information or executing', () => {
    const prompt = buildSystemPrompt({ language: 'en' });
    expect(prompt).toContain('Web research is not available');
    expect(prompt).toContain('Do not ask the user for information or execute the procedure');
    expect(prompt).not.toContain('call web_research');
    expect(prompt).not.toContain('exa_');
  });

  it('BYOK and custom endpoints: research first with the Exa tools, never web_research', () => {
    const prompt = buildSystemPrompt({
      language: 'es',
      research: 'exa',
      feedback: { submit: false, vote: false },
    });
    expect(prompt).not.toContain('web_research');
    expect(prompt).not.toContain('Web research is not available');
    expect(prompt).toContain('after vault_read, research the procedure with exa_search');
    expect(prompt).toContain('or with exa_fetch when fetch_url can');
    expect(prompt).toContain('official sources first');
    expect(prompt).toContain('Only after this research is done may you refine it');
    expect(prompt).toContain('Consult feedback_search for community learnings');
    expect(prompt).toContain(
      'Formulate the complete plan before collecting user information or executing any step',
    );
    // Queries leave the device: anonymized, no identifying data.
    expect(prompt).toContain('Search queries leave the device');
    expect(prompt).toContain(
      'never put names, ID numbers, street addresses, contact details, birth dates',
    );
    // A broken optional key: the blocker, and where the user fixes it.
    expect(prompt).toContain('the user replaces or removes their Exa key');
    expect(prompt).not.toContain("spends the user's own Exa credit");
    expect(prompt).toContain('Ajustes → Proveedor de IA');
    expect(prompt).toContain(
      'do not ask the user for information or execute the procedure until the research can be completed',
    );
    expect(buildSystemPrompt({ language: 'en', research: 'exa' })).toContain(
      'Settings → AI provider',
    );
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
