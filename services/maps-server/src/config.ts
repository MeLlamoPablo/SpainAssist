export interface ServerConfig {
  host: string;
  port: number;
  /** Mapbox token (a secret `sk.` token in production). Only sent to Mapbox, never logged. */
  mapboxToken: string;
  /** LiteLLM base URL, to check users' gateway keys (`GET /key/info` with their own key). */
  litellmUrl: string;
  /** Geocoding requests per user key per UTC day. */
  dailyLimit: number;
  /** Geocoding requests per user key per UTC week (from Monday). */
  weeklyLimit: number;
  /** Requests per client IP per minute, before any key check (protects LiteLLM). */
  perIpPerMinute: number;
  /** Take the client IP from X-Forwarded-For (only behind a trusted reverse proxy). */
  trustProxy: boolean;
}

const flag = (v: string | undefined, dflt: boolean) =>
  v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const int = (v: string | undefined, dflt: number) => {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const litellmUrl = required(env, 'LITELLM_URL').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(litellmUrl)) throw new Error('LITELLM_URL must be an http(s) URL');
  return {
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 8793),
    mapboxToken: required(env, 'MAPBOX_TOKEN'),
    litellmUrl,
    dailyLimit: int(env.DAILY_LIMIT, 250),
    weeklyLimit: int(env.WEEKLY_LIMIT, 500),
    perIpPerMinute: int(env.RATE_LIMIT_PER_IP_PER_MINUTE, 60),
    trustProxy: flag(env.TRUST_PROXY, false),
  };
}
