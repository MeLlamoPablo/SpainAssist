/**
 * In-memory fakes of the library packages. Used by the main-process tests, and TEMPORARILY as
 * runtime fallbacks while @sa/vault and @sa/pii are still stubs (see app/libs.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import type {
  AgentEvent,
  AgentLaunch,
  AgentLaunchOptions,
  PromptDisposition,
  PromptImage,
} from '@sa/agent';
import {
  BrowserError,
  type ClientCertificateUse,
  type RefInfo,
  type TypeOptions,
} from '@sa/browser';
import type { ScrubOptions, ScrubResult } from '@sa/pii';
import {
  type BrowserObservation,
  type BrowserTab,
  type CertificateInfo,
  type CredentialPolicy,
  type CredentialSummary,
  DEFAULT_CREDENTIAL_POLICY,
  type DocumentMeta,
  maskValue,
  type PersonalDataInput,
  type PersonalDataItem,
  type PersonalDataSource,
  PersonalFieldKey,
  personalFieldDef,
  type SecretSummary,
  type VaultOverview,
} from '@sa/shared';
import {
  type AddDocumentOptions,
  type CredentialSecret,
  type KeyProvider,
  VaultError,
} from '@sa/vault';
import type {
  AgentClientPort,
  AgentLib,
  BrowserPort,
  PiiLib,
  ProviderLib,
  VaultPort,
} from '../ports';

const hex = () => randomBytes(8).toString('hex');
const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------------------------

export class MemoryVault implements VaultPort {
  readonly personal = new Map<string, PersonalDataItem>();
  readonly documents = new Map<string, { meta: DocumentMeta; bytes: Buffer }>();
  readonly credentials = new Map<
    string,
    { summary: CredentialSummary; secret: CredentialSecret }
  >();
  readonly secrets = new Map<string, { label: string; value: string; createdAt: string }>();
  /** DNIe PINs by credential id; `wrong` once the card refused them. */

  constructor(private readonly storage = { backend: 'memory (temporary)', secure: false }) {}

  overview(opts?: { biometricAvailable?: boolean }): VaultOverview {
    return {
      personal: this.listPersonal(),
      documents: this.listDocuments(),
      credentials: this.listCredentials(),
      storage: { ...this.storageInfo(), biometricAvailable: !!opts?.biometricAvailable },
    };
  }

  storageInfo() {
    return { ...this.storage };
  }

  listPersonal(): PersonalDataItem[] {
    return [...this.personal.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  getPersonal(key: string): PersonalDataItem | undefined {
    return this.personal.get(key);
  }

  async setPersonal(
    items: PersonalDataInput[],
    source: PersonalDataSource,
  ): Promise<PersonalDataItem[]> {
    const out: PersonalDataItem[] = [];
    for (const item of items) {
      if (!PersonalFieldKey.safeParse(item.key).success)
        throw new VaultError('invalid_input', `Invalid key ${item.key}`);
      const saved: PersonalDataItem = {
        key: item.key,
        label: personalFieldDef(item.key)?.label.es ?? item.label ?? item.key,
        value: item.value,
        source,
        updatedAt: now(),
      };
      this.personal.set(item.key, saved);
      out.push(saved);
    }
    return out;
  }

  async deletePersonal(keys: string[]): Promise<void> {
    for (const k of keys) this.personal.delete(k);
  }

  listDocuments(): DocumentMeta[] {
    return [...this.documents.values()].map((d) => d.meta);
  }

  getDocument(id: string): DocumentMeta | undefined {
    return this.documents.get(id)?.meta;
  }

  async addDocument(opts: AddDocumentOptions): Promise<DocumentMeta> {
    const meta: DocumentMeta = {
      id: `d_${hex()}`,
      name: opts.name,
      mimeType: opts.mimeType,
      size: opts.bytes.byteLength,
      kind: opts.kind,
      source: opts.source,
      ...(opts.procedureId ? { procedureId: opts.procedureId } : {}),
      createdAt: now(),
    };
    this.documents.set(meta.id, { meta, bytes: Buffer.from(opts.bytes) });
    return meta;
  }

  async readDocument(id: string): Promise<Buffer> {
    const doc = this.documents.get(id);
    if (!doc) throw new VaultError('not_found', 'Document not found');
    return Buffer.from(doc.bytes);
  }

  async deleteDocument(id: string): Promise<void> {
    if (!this.documents.delete(id)) throw new VaultError('not_found', 'Document not found');
  }

  listCredentials(): CredentialSummary[] {
    return [...this.credentials.values()].map((c) => c.summary);
  }

  getCredential(id: string): CredentialSummary | undefined {
    return this.credentials.get(id)?.summary;
  }

  async addClave(input: {
    username: string;
    password: string;
    label?: string;
  }): Promise<CredentialSummary> {
    const summary: CredentialSummary = {
      id: `c_${hex()}`,
      kind: 'clave_permanente',
      label: input.label ?? 'Cl@ve permanente',
      policy: DEFAULT_CREDENTIAL_POLICY.clave_permanente,
      createdAt: now(),
      usernameHint: maskValue(input.username),
    };
    this.credentials.set(summary.id, {
      summary,
      secret: { kind: 'clave_permanente', username: input.username, password: input.password },
    });
    return summary;
  }

  async addClaveMovil(input?: { label?: string }): Promise<CredentialSummary> {
    const summary: CredentialSummary = {
      id: `c_${hex()}`,
      kind: 'clave_movil',
      label: input?.label ?? 'Cl@ve Móvil',
      policy: DEFAULT_CREDENTIAL_POLICY.clave_movil,
      createdAt: now(),
    };
    this.credentials.set(summary.id, { summary, secret: { kind: 'clave_movil' } });
    return summary;
  }

  async addDnie(input?: { label?: string }): Promise<CredentialSummary> {
    const existing = [...this.credentials.values()].find((c) => c.summary.kind === 'dnie');
    if (existing) return existing.summary;
    const summary: CredentialSummary = {
      id: `c_${hex()}`,
      kind: 'dnie',
      label: input?.label ?? 'DNIe con el móvil',
      policy: DEFAULT_CREDENTIAL_POLICY.dnie,
      createdAt: now(),
    };
    this.credentials.set(summary.id, { summary, secret: { kind: 'dnie' } });
    return summary;
  }

  async setDnieCertificate(id: string, certificate: CertificateInfo): Promise<CredentialSummary> {
    const entry = this.credentials.get(id);
    if (entry?.summary.kind !== 'dnie') throw new Error('Not a DNIe credential');
    entry.summary = { ...entry.summary, certificate };
    return entry.summary;
  }

  async addCertificate(input: {
    fileName: string;
    p12: Buffer;
    passphrase: string;
    label?: string;
  }): Promise<CredentialSummary> {
    if (!input.passphrase) throw new VaultError('invalid_passphrase', 'Wrong passphrase');
    if (input.p12.byteLength === 0) throw new VaultError('invalid_certificate', 'Empty file');
    const validFrom = new Date();
    const validTo = new Date(validFrom.getTime() + 365 * 86_400_000);
    const summary: CredentialSummary = {
      id: `c_${hex()}`,
      kind: 'certificate',
      label: input.label ?? input.fileName,
      policy: DEFAULT_CREDENTIAL_POLICY.certificate,
      createdAt: now(),
      certificate: {
        subject: 'CN=TEST PERSONA FISICA',
        issuer: 'Test CA',
        serialNumber: '01',
        validFrom: validFrom.toISOString(),
        validTo: validTo.toISOString(),
        holderName: 'TEST PERSONA FISICA',
        fingerprint: createHash('sha256').update(input.p12).digest('hex'),
      },
    };
    this.credentials.set(summary.id, {
      summary,
      secret: { kind: 'certificate', p12: Buffer.from(input.p12), passphrase: input.passphrase },
    });
    return summary;
  }

  async setCredentialPolicy(id: string, policy: CredentialPolicy): Promise<CredentialSummary> {
    const c = this.credentials.get(id);
    if (!c) throw new VaultError('not_found', 'Credential not found');
    c.summary = { ...c.summary, policy };
    return c.summary;
  }

  async getCredentialSecret(id: string): Promise<CredentialSecret> {
    const c = this.credentials.get(id);
    if (!c) throw new VaultError('not_found', 'Credential not found');
    return c.secret;
  }

  async markCredentialUsed(id: string): Promise<void> {
    const c = this.credentials.get(id);
    if (c) c.summary = { ...c.summary, lastUsedAt: now() };
  }

  async deleteCredential(id: string): Promise<void> {
    if (!this.credentials.delete(id)) throw new VaultError('not_found', 'Credential not found');
  }

  listSecrets(): SecretSummary[] {
    return [...this.secrets.entries()].map(([id, s]) => ({
      id,
      label: s.label,
      createdAt: s.createdAt,
    }));
  }

  async setSecret(id: string, label: string, value: string): Promise<void> {
    this.secrets.set(id, { label, value, createdAt: this.secrets.get(id)?.createdAt ?? now() });
  }

  async getSecret(id: string): Promise<string | undefined> {
    return this.secrets.get(id)?.value;
  }

  async deleteSecret(id: string): Promise<void> {
    if (!this.secrets.delete(id)) throw new VaultError('not_found', 'Secret not found');
  }

  knownSensitiveValues(): string[] {
    const values = [...this.personal.values()].map((p) => p.value);
    for (const c of this.credentials.values())
      if (c.secret.kind === 'clave_permanente') values.push(c.secret.username);
    return values.filter((v) => v.trim().length > 0);
  }

  async wipe(): Promise<void> {
    this.personal.clear();
    this.documents.clear();
    this.credentials.clear();
    this.secrets.clear();
  }
}

/** Insecure KeyProvider for tests (no OS keychain). */
export function fakeKeyProvider(): KeyProvider {
  const magic = Buffer.from('SA-TEST:');
  return {
    backend: 'test',
    secure: false,
    async encrypt(plain) {
      return Buffer.concat([magic, plain]);
    },
    async decrypt(wrapped) {
      return wrapped.subarray(magic.length);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// PII (regex subset + exact known values)
// ---------------------------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BASIC_PATTERNS: { type: 'dni' | 'nie' | 'email' | 'phone' | 'iban'; re: RegExp }[] = [
  { type: 'email', re: /[\w.+-]+@[\w-]+(\.[\w-]+)+/g },
  { type: 'iban', re: /\bES\d{2}(?:\s?\d{4}){5}\b/gi },
  { type: 'dni', re: /\b\d{8}[-\s]?[A-Z]\b/gi },
  { type: 'nie', re: /\b[XYZ][-\s]?\d{7}[-\s]?[A-Z]\b/gi },
  { type: 'phone', re: /(?:\+34[\s-]?)?\b[6789]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g },
];

export const basicPii: PiiLib = {
  scrubPii(text: string, opts?: ScrubOptions): ScrubResult {
    let out = text;
    const findings: ScrubResult['findings'] = [];
    for (const value of opts?.knownValues ?? []) {
      const v = value.trim();
      if (v.length < 3) continue;
      const re = new RegExp(escapeRegExp(v), 'gi');
      out = out.replace(re, (m, offset: number) => {
        findings.push({ type: 'known_value', start: offset, end: offset + m.length });
        return '[DATO]';
      });
    }
    for (const { type, re } of BASIC_PATTERNS) {
      out = out.replace(re, (m, ...rest) => {
        const offset = rest.find((r) => typeof r === 'number') as number;
        findings.push({ type, start: offset, end: offset + m.length });
        return `[${type.toUpperCase()}]`;
      });
    }
    return { text: out, findings };
  },
  stripUrlParams(url: string): string {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  },
};

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------

export class FakeBrowser implements BrowserPort {
  readonly calls: { method: string; procedureId: string; args: unknown[] }[] = [];
  readonly refs = new Map<string, RefInfo>();
  readonly opened = new Set<string>();
  async startScreencast(): Promise<() => Promise<void>> {
    return async () => {};
  }
  certificates: { origin: string }[] = [];
  url = 'https://sede.example.gob.es/';

  private record(method: string, procedureId: string, ...args: unknown[]): BrowserObservation {
    this.calls.push({ method, procedureId, args });
    return this.observation();
  }

  observation(): BrowserObservation {
    return {
      url: this.url,
      title: 'Página de prueba',
      snapshot: '- button "Entrar" [ref=e1]',
      truncated: false,
      tabs: [],
      downloads: [],
      signatures: [],
      dialogs: [],
      notes: [],
    };
  }

  async open(procedureId: string, url: string, opts?: { newTab?: boolean }) {
    this.opened.add(procedureId);
    this.url = url;
    return this.record('open', procedureId, url, opts);
  }
  async snapshot(procedureId: string) {
    return this.record('snapshot', procedureId);
  }
  async click(procedureId: string, ref: string) {
    return this.record('click', procedureId, ref);
  }
  async type(procedureId: string, ref: string, text: string, opts?: TypeOptions) {
    if (opts?.expect) {
      const info = this.refs.get(ref);
      if (
        !info ||
        (opts.expect.frameOrigin && new URL(info.frameUrl).origin !== opts.expect.frameOrigin) ||
        (opts.expect.inputType && info.inputType !== opts.expect.inputType)
      )
        throw new BrowserError('expectation_failed', 'The field changed before typing');
    }
    return this.record('type', procedureId, ref, text, opts);
  }
  async select(procedureId: string, ref: string, values: string[]) {
    return this.record('select', procedureId, ref, values);
  }
  async check(procedureId: string, ref: string, checked: boolean) {
    return this.record('check', procedureId, ref, checked);
  }
  async press(procedureId: string, key: string) {
    return this.record('press', procedureId, key);
  }
  async wait(procedureId: string, opts: { text?: string; textGone?: string; seconds?: number }) {
    return this.record('wait', procedureId, opts);
  }
  async back(procedureId: string) {
    return this.record('back', procedureId);
  }
  async tabs(
    procedureId: string,
    action: 'list' | 'select' | 'close',
    index?: number,
  ): Promise<BrowserTab[]> {
    this.calls.push({ method: 'tabs', procedureId, args: [action, index] });
    return [{ index: 0, url: this.url, title: 'Página de prueba', active: true }];
  }
  async screenshot(procedureId: string, opts?: { fullPage?: boolean }) {
    this.calls.push({ method: 'screenshot', procedureId, args: [opts] });
    return { mimeType: 'image/jpeg' as const, data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
  }
  async upload(
    procedureId: string,
    ref: string,
    files: { name: string; mimeType: string; buffer: Buffer }[],
  ) {
    return this.record('upload', procedureId, ref, files);
  }
  async describeRef(_procedureId: string, ref: string): Promise<RefInfo | null> {
    return this.refs.get(ref) ?? null;
  }
  async useClientCertificate(procedureId: string, use: ClientCertificateUse | null) {
    this.certificates = use?.origins.map((origin) => ({ origin })) ?? [];
    this.calls.push({
      method: 'useClientCertificate',
      procedureId,
      args: [use?.origins ?? []],
    });
  }
  currentUrl(procedureId: string) {
    return this.opened.has(procedureId) ? this.url : undefined;
  }
  isOpen(procedureId: string) {
    return this.opened.has(procedureId);
  }
  async show(procedureId: string) {
    this.calls.push({ method: 'show', procedureId, args: [] });
  }
  async hide(procedureId: string) {
    this.calls.push({ method: 'hide', procedureId, args: [] });
  }
  async exportState() {
    return null;
  }
  async importState() {}
  async close(procedureId: string) {
    this.opened.delete(procedureId);
    this.calls.push({ method: 'close', procedureId, args: [] });
  }
  async closeAll() {
    this.certificates = [];
    this.opened.clear();
    this.calls.push({ method: 'closeAll', procedureId: '', args: [] });
  }
}

// ---------------------------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------------------------

export class FakeAgentClient implements AgentClientPort {
  started = false;
  stopped = false;
  running = false;
  readonly prompts: { text: string; images?: PromptImage[] }[] = [];
  readonly steers: string[] = [];
  readonly followUps: string[] = [];
  aborts = 0;
  /** Make start() fail with this error. */
  failStart?: Error;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(readonly launch: AgentLaunch) {}

  async start(): Promise<void> {
    if (this.failStart) throw this.failStart;
    this.started = true;
  }
  async prompt(text: string, images?: PromptImage[]): Promise<PromptDisposition> {
    this.prompts.push({ text, ...(images ? { images } : {}) });
    return 'started';
  }
  async followUp(text: string): Promise<PromptDisposition> {
    this.followUps.push(text);
    return 'queued';
  }
  async steer(text: string): Promise<PromptDisposition> {
    this.steers.push(text);
    return 'queued';
  }
  async abort(): Promise<void> {
    this.aborts++;
    if (this.running) this.emit({ type: 'run_end', aborted: true });
  }
  on(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.emit({ type: 'process_exit', code: 0, signal: null, stderrTail: '' });
  }
  emit(event: AgentEvent): void {
    if (event.type === 'run_start') this.running = true;
    if (event.type === 'run_end' || event.type === 'process_exit') this.running = false;
    for (const l of [...this.listeners]) l(event);
  }
}

export function createFakeAgentLib(): AgentLib & {
  clients: FakeAgentClient[];
  launches: AgentLaunchOptions[];
} {
  const clients: FakeAgentClient[] = [];
  const launches: AgentLaunchOptions[] = [];
  return {
    clients,
    launches,
    buildAgentLaunch(opts) {
      launches.push(opts);
      return {
        command: opts.nodeBinary,
        args: [opts.hostPath ?? '/fake/agent/dist/host.js'],
        env: {
          SA_BRIDGE_URL: opts.bridge.url,
          SA_BRIDGE_TOKEN: opts.bridge.token,
          SA_PROCEDURE_ID: opts.config.procedureId,
          SA_AGENT_CONFIG: JSON.stringify(opts.config),
          ...(opts.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
        cwd: opts.cwd,
      };
    },
    createClient(launch) {
      const client = new FakeAgentClient(launch);
      clients.push(client);
      return client;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

/** An unsigned JWT-shaped ID token (header.payload.signature) that expires in an hour. */
export const FAKE_ID_TOKEN = [
  Buffer.from('{"alg":"RS256"}').toString('base64url'),
  Buffer.from(
    JSON.stringify({ sub: 'auth0|fake', exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url'),
  'fake-signature',
].join('.');

export function createFakeProviderLib(overrides: Partial<ProviderLib> = {}): ProviderLib & {
  readonly refreshCalls: number;
} {
  const counters = { refresh: 0 };
  const lib: ProviderLib = {
    defaultModels: { chatgpt: 'gpt-test', voucher: 'test/voucher-model' },
    assistantModels: {
      chatgpt: { id: 'gpt-test-assistant', thinkingLevel: 'high' },
      voucher: { id: 'test/voucher-assistant', thinkingLevel: 'high' },
    },
    async loginChatGPT() {
      return {
        credential: {
          type: 'oauth' as const,
          access: 'acc-token-1',
          refresh: 'ref-token-1',
          expires: Date.now() + 3_600_000,
        },
        account: 'user@example.com',
        idToken: FAKE_ID_TOKEN,
      };
    },
    async getChatGPTKey(_url: string, idToken: string) {
      if (idToken !== FAKE_ID_TOKEN) {
        throw Object.assign(new Error('rejected'), { code: 'invalid_identity' });
      }
      return {
        provider: 'litellm' as const,
        baseUrl: 'https://llm.example.test/v1',
        apiKey: 'sk-litellm-chatgpt-scan-key-123456',
        deciderModel: 'perplexity/pplx-decider-v1.1-27b',
        dailyLimitUsd: 0.1,
        monthlyLimitUsd: 0.5,
      };
    },
    async refreshOAuthCredential(_providerId, credential) {
      counters.refresh++;
      await new Promise((r) => setTimeout(r, 10));
      return {
        ...credential,
        type: 'oauth' as const,
        access: `acc-token-${counters.refresh + 1}`,
        expires: Date.now() + 3_600_000,
      };
    },
    listByokProviders() {
      return [
        { id: 'anthropic', name: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', models: [] },
        { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', models: [] },
      ];
    },
    listProviderModels(providerId) {
      return [
        { provider: providerId, id: `${providerId}-model-a`, name: 'Model A' },
        { provider: providerId, id: `${providerId}-model-b`, name: 'Model B' },
      ];
    },
    async redeemVoucher(_url: string, code: string, currentKey?: string) {
      if (code !== 'VALID-CODE')
        throw Object.assign(new Error('invalid'), { code: 'invalid_code' });
      // The key server tops up the key the app sends (5 more, 1 already spent).
      const topUp = currentKey === 'sk-litellm-voucher-key-123456';
      return {
        provider: 'litellm' as const,
        baseUrl: 'https://llm.example.test/v1',
        apiKey: 'sk-litellm-voucher-key-123456',
        limitUsd: topUp ? 10 : 5,
        usageUsd: topUp ? 1 : 0,
        addedUsd: 5,
        searchTools: ['parallel'],
      };
    },
    async getVoucherCredit() {
      return { limitUsd: 5, spendUsd: 1, maxBudgetUsd: 5, expiresAt: null };
    },
    ...overrides,
  };
  return Object.defineProperty(lib, 'refreshCalls', {
    get: () => counters.refresh,
  }) as ProviderLib & {
    readonly refreshCalls: number;
  };
}
