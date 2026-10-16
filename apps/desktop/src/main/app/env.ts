import {
  CustomApi,
  CustomModelCapabilities,
  type CustomProviderInput,
  PRODUCTION_SERVICES,
} from '@sa/shared';
import type { UserKey } from '../providers/manager';

/**
 * Environment overrides for development, demos and e2e tests. Packaged builds ignore the ones
 * that affect security (see DEV_ONLY).
 *
 *   SA_USER_DATA_DIR         userData directory (app.setPath before ready)
 *   SA_E2E=1                 e2e mode: test key provider (no OS keychain), no Touch ID
 *   SA_KEY_SERVER_URL        development only: key server base URL instead of the built-in
 *                            PRODUCTION_SERVICES (@sa/shared); e2e tests, dev:local
 *   SA_FEEDBACK_SERVER_URL   development only: feedback server base URL (same)
 *   SA_MAPS_SERVER_URL       development only: maps server base URL (same). E2e runs have no
 *                            maps server unless this points at one: lookups are unavailable
 *   SA_RELAY_SERVER_URL      development only: relay server for DNIe signatures with the phone
 *                            (same). A loopback URL is shown to the phone with this machine's
 *                            LAN address. E2e runs have none unless this points at one
 *   SA_FEATURE_FLAGS         development only: comma-separated Unleash flag names to turn on,
 *                            instead of asking Unleash (e.g. "feedback-server,dnie-phone");
 *                            "" = all off. E2e runs never ask Unleash: without it, every
 *                            feature is off. `dev:local` turns every flag on
 *   SA_EXTRA_TRUSTED_HOSTS   comma-separated host suffixes allowed for credentials (mock sede)
 *   SA_BROWSER_HEADLESS      1/0: development/e2e headless override (no visible help window)
 *   SA_BROWSER_EXECUTABLE    development only: Chromium executable for the browser (no download)
 *   SA_BROWSER_CAPTURE=1     development only: record each procedure's browsing (HAR, trace,
 *                            HTML, actions.jsonl) in procedures/<id>/capture/, with typed
 *                            secrets scrubbed but personal data kept (docs/ARCHITECTURE.md)
 *   SA_HIDE_WINDOW=1         never show the app window or Dock icon (headless e2e runs)
 *   SA_AGENT_HOST            path of the agent host script (default: @sa/agent dist/host.js)
 *   OPENROUTER_DECIDER_API_KEY Development override for scan frame screening: an OpenRouter
 *                            key used instead of the user's gateway key (voucher or ChatGPT
 *                            key, D12). Dev builds read it from apps/desktop/.env; e2e
 *                            requires a loopback endpoint.
 *   SA_DECIDER_URL          dev-only Decisions endpoint override; e2e requires loopback.
 *   SA_PROVIDER              "custom|<baseUrl>|<model>[|<api>[|<capabilities>]]": preconfigure a
 *                            custom OpenAI-compatible provider (e.g. tools/mock-llm).
 *                            Capabilities, comma-separated: images, reasoning, context=<tokens>,
 *                            max=<tokens> (default: CUSTOM_MODEL_DEFAULTS)
 *   SA_PROVIDER_API_KEY      optional API key for SA_PROVIDER
 *   SA_DEV_USER_KEY          development only: "<gateway baseUrl>|<sk-key>", the user key of a
 *                            Codex session (Codex has none of its own), e.g. the key from
 *                            redeeming a development voucher. Without it, Codex sessions are
 *                            like BYOK: no features that need a user (see UserKey)
 *   SA_LOG_LEVEL             debug | info | warn | error
 */
export interface SaEnv {
  userDataDir?: string;
  e2e: boolean;
  keyServerUrl?: string;
  feedbackServerUrl?: string;
  /** Unleash flag names turned on by SA_FEATURE_FLAGS, instead of asking Unleash. */
  featureFlags?: string[];
  /** Unleash frontend token: the production environment's in packaged builds, else development's. */
  flagsToken: string;
  extraTrustedHosts: string[];
  browserHeadless?: boolean;
  browserExecutable?: string;
  /** Development only: record browsing for offline mock sites (SA_BROWSER_CAPTURE). */
  browserCapture?: boolean;
  hideWindow?: boolean;
  agentHost?: string;
  /** Maps server for address lookups; undefined in e2e runs without an override. */
  mapsServerUrl?: string;
  /** Relay for DNIe signatures with the phone; undefined in e2e runs without an override. */
  relayServerUrl?: string;
  deciderApiKey?: string;
  deciderUrl?: string;
  provider?: { kind: 'custom' } & CustomProviderInput;
  /** The user key of a Codex session (development builds only). */
  devUserKey?: UserKey;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Problems found while parsing (logged at startup). */
  warnings: string[];
}

/** "images,reasoning,context=32768,max=4096" (any subset); undefined when malformed. */
function parseCapabilities(value: string | undefined): CustomModelCapabilities | undefined {
  const out: Record<string, unknown> = {};
  for (const token of (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [name, n] = token.split('=');
    if (name === 'images' && n === undefined) out.supportsImages = true;
    else if (name === 'reasoning' && n === undefined) out.reasoning = true;
    else if (name === 'context' && n) out.contextWindow = Number(n);
    else if (name === 'max' && n) out.maxTokens = Number(n);
    else return undefined;
  }
  const parsed = CustomModelCapabilities.safeParse(out);
  return parsed.success ? parsed.data : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function parseBool(value: string | undefined): boolean | undefined {
  const v = nonEmpty(value)?.toLowerCase();
  if (v === undefined) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

function parseUrl(name: string, value: string | undefined, warnings: string[]): string | undefined {
  const v = nonEmpty(value);
  if (!v) return undefined;
  try {
    const url = new URL(v);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http(s)');
    return v.replace(/\/+$/, '');
  } catch {
    warnings.push(`${name} is not a valid http(s) URL; ignored`);
    return undefined;
  }
}

/** Overrides that weaken security or swap code/backends: ignored by packaged builds. */
const DEV_ONLY = [
  'SA_E2E',
  'SA_EXTRA_TRUSTED_HOSTS',
  'SA_AGENT_HOST',
  'SA_PROVIDER',
  'SA_PROVIDER_API_KEY',
  'SA_DECIDER_URL',
  'SA_HIDE_WINDOW',
  'SA_BROWSER_EXECUTABLE',
  'SA_BROWSER_CAPTURE',
  'SA_KEY_SERVER_URL',
  'SA_FEEDBACK_SERVER_URL',
  'SA_MAPS_SERVER_URL',
  'SA_RELAY_SERVER_URL',
  'SA_FEATURE_FLAGS',
  'SA_DEV_USER_KEY',
] as const;

/**
 * Parses the overrides. With `packaged: true` (a shipped build) only SA_USER_DATA_DIR,
 * SA_BROWSER_HEADLESS and SA_LOG_LEVEL are honored: e.g. SA_EXTRA_TRUSTED_HOSTS would let
 * whoever launches the app make credentials typeable on any site.
 */
export function parseEnv(input: NodeJS.ProcessEnv, opts: { packaged?: boolean } = {}): SaEnv {
  const warnings: string[] = [];
  let env = input;
  if (opts.packaged) {
    const ignored = DEV_ONLY.filter((name) => nonEmpty(input[name]) !== undefined);
    if (ignored.length) warnings.push(`ignored in packaged builds: ${ignored.join(', ')}`);
    env = { ...input };
    for (const name of DEV_ONLY) delete env[name];
  }
  const out: SaEnv = {
    userDataDir: nonEmpty(env.SA_USER_DATA_DIR),
    e2e: parseBool(env.SA_E2E) === true,
    keyServerUrl:
      parseUrl('SA_KEY_SERVER_URL', env.SA_KEY_SERVER_URL, warnings) ??
      PRODUCTION_SERVICES.keyServerUrl,
    feedbackServerUrl:
      parseUrl('SA_FEEDBACK_SERVER_URL', env.SA_FEEDBACK_SERVER_URL, warnings) ??
      PRODUCTION_SERVICES.feedbackServerUrl,
    featureFlags: env.SA_FEATURE_FLAGS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    flagsToken: PRODUCTION_SERVICES.flagsTokens[opts.packaged ? 'production' : 'development'],
    extraTrustedHosts: (env.SA_EXTRA_TRUSTED_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    browserHeadless: parseBool(env.SA_BROWSER_HEADLESS),
    browserExecutable: nonEmpty(env.SA_BROWSER_EXECUTABLE),
    browserCapture: parseBool(env.SA_BROWSER_CAPTURE) === true,
    hideWindow: parseBool(env.SA_HIDE_WINDOW) === true,
    agentHost: nonEmpty(env.SA_AGENT_HOST),
    warnings,
  };
  out.mapsServerUrl =
    parseUrl('SA_MAPS_SERVER_URL', env.SA_MAPS_SERVER_URL, warnings) ??
    (out.e2e ? undefined : PRODUCTION_SERVICES.mapsServerUrl);
  out.relayServerUrl =
    parseUrl('SA_RELAY_SERVER_URL', env.SA_RELAY_SERVER_URL, warnings) ??
    (out.e2e ? undefined : PRODUCTION_SERVICES.relayServerUrl);
  const deciderUrl = parseUrl('SA_DECIDER_URL', env.SA_DECIDER_URL, warnings);
  if (out.e2e) {
    // Test runners may only send a supplied dummy key to a loopback mock.
    if (deciderUrl && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(deciderUrl).hostname)) {
      out.deciderUrl = deciderUrl;
      out.deciderApiKey = nonEmpty(env.OPENROUTER_DECIDER_API_KEY);
    }
  } else {
    out.deciderUrl = deciderUrl;
    out.deciderApiKey = nonEmpty(env.OPENROUTER_DECIDER_API_KEY);
  }

  const level = nonEmpty(env.SA_LOG_LEVEL)?.toLowerCase();
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error')
    out.logLevel = level;

  const provider = nonEmpty(env.SA_PROVIDER);
  if (provider) {
    const [kind, baseUrl, model, api, caps] = provider.split('|').map((s) => s.trim());
    const parsedApi = CustomApi.safeParse(api || 'openai-completions');
    const url = parseUrl('SA_PROVIDER baseUrl', baseUrl, warnings);
    const capabilities = parseCapabilities(caps);
    if (kind === 'custom' && url && model && parsedApi.success && capabilities) {
      out.provider = {
        kind: 'custom',
        baseUrl: url,
        model,
        api: parsedApi.data,
        apiKey: nonEmpty(env.SA_PROVIDER_API_KEY),
        ...capabilities,
      };
    } else {
      warnings.push(
        'SA_PROVIDER must be "custom|<baseUrl>|<model>[|<api>[|images,reasoning,context=<n>,max=<n>]]"; ignored',
      );
    }
  }

  const devUserKey = nonEmpty(env.SA_DEV_USER_KEY);
  if (devUserKey) {
    const [baseUrl, apiKey] = devUserKey.split('|').map((s) => s.trim());
    const url = parseUrl('SA_DEV_USER_KEY baseUrl', baseUrl, warnings);
    if (url && apiKey?.startsWith('sk-')) out.devUserKey = { baseUrl: url, apiKey };
    else warnings.push('SA_DEV_USER_KEY must be "<gateway baseUrl>|<sk-key>"; ignored');
  }
  return out;
}
