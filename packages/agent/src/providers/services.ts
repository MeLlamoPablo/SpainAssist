import {
  ApiError,
  ChatGPTKeyResponse,
  type ChatGPTKeyResponse as ChatGPTKeyResponseType,
  RedeemVoucherResponse,
  type RedeemVoucherResponse as RedeemVoucherResponseType,
  VoucherCreditResponse,
  type VoucherCreditResponse as VoucherCreditResponseType,
} from '@sa/shared';

/** Error from our key server ({ error: { code, message } }, see @sa/shared services.ts). */
export class KeyServerError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'KeyServerError';
    this.code = code;
    this.status = status;
  }
}

export interface ServiceCallOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function postJson(
  url: string,
  body: unknown,
  options: ServiceCallOptions,
  headers: Record<string, string> = {},
): Promise<unknown> {
  return requestJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    options,
  );
}

/** A key server call; errors never include keys or tokens. */
async function requestJson(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
  options: ServiceCallOptions,
): Promise<unknown> {
  const signal = AbortSignal.any(
    [options.signal, AbortSignal.timeout(options.timeoutMs ?? 20_000)].filter(
      (s): s is AbortSignal => !!s,
    ),
  );
  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(url, {
      ...init,
      headers: { accept: 'application/json', ...init.headers },
      signal,
    });
  } catch (error) {
    throw new KeyServerError(
      'network',
      `Could not reach the server: ${(error as Error).message}`,
      0,
    );
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const error = ApiError.safeParse(parsed);
    if (error.success) {
      throw new KeyServerError(error.data.error.code, error.data.error.message, res.status);
    }
    throw new KeyServerError('http_error', `Server returned HTTP ${res.status}`, res.status);
  }
  return parsed;
}

/**
 * POST {keyServerUrl}/v1/vouchers/redeem → capped LiteLLM key (store it in the vault). With
 * `currentKey` (the voucher key the app holds) the voucher tops that key up while it is active.
 */
export async function redeemVoucher(
  keyServerUrl: string,
  code: string,
  currentKey?: string,
  options: ServiceCallOptions = {},
): Promise<RedeemVoucherResponseType> {
  const body = await postJson(
    joinUrl(keyServerUrl, '/v1/vouchers/redeem'),
    { code: code.trim() },
    options,
    currentKey ? { authorization: `Bearer ${currentKey}` } : {},
  );
  const parsed = RedeemVoucherResponse.safeParse(body);
  if (!parsed.success) {
    throw new KeyServerError('invalid_response', 'Unexpected answer from the voucher server', 200);
  }
  return parsed.data;
}

/**
 * POST {keyServerUrl}/v1/chatgpt-keys with the OpenAI ID token from "Sign in with ChatGPT" →
 * the account's scan-decider key on our LiteLLM gateway (the same on every device). Store it in
 * the vault. Errors carry the key server's code (`invalid_identity`, `chatgpt_keys_disabled`…).
 */
export async function getChatGPTKey(
  keyServerUrl: string,
  idToken: string,
  options: ServiceCallOptions = {},
): Promise<ChatGPTKeyResponseType> {
  const body = await postJson(joinUrl(keyServerUrl, '/v1/chatgpt-keys'), { idToken }, options);
  const parsed = ChatGPTKeyResponse.safeParse(body);
  if (!parsed.success) {
    throw new KeyServerError('invalid_response', 'Unexpected answer from the key server', 200);
  }
  return parsed.data;
}

/** GET {keyServerUrl}/v1/vouchers/credit with the voucher key: its balance. */
export async function getVoucherCredit(
  keyServerUrl: string,
  apiKey: string,
  options: ServiceCallOptions = {},
): Promise<VoucherCreditResponseType> {
  const body = await requestJson(
    joinUrl(keyServerUrl, '/v1/vouchers/credit'),
    { headers: { authorization: `Bearer ${apiKey}` } },
    options,
  );
  const parsed = VoucherCreditResponse.safeParse(body);
  if (!parsed.success) {
    throw new KeyServerError('invalid_response', 'Unexpected answer from the voucher server', 200);
  }
  return parsed.data;
}

/**
 * The key's spend and cap from the headers LiteLLM sends on every LLM call
 * (`x-litellm-key-spend`, `x-litellm-key-max-budget`); undefined when either is missing (keys
 * without a cap). Header names are lower case.
 */
export function parseLiteLLMSpendHeaders(
  headers: Record<string, string>,
): { spendUsd: number; maxBudgetUsd: number } | undefined {
  if (!headers['x-litellm-key-spend'] || !headers['x-litellm-key-max-budget']) return undefined;
  const spend = Number(headers['x-litellm-key-spend']);
  const cap = Number(headers['x-litellm-key-max-budget']);
  if (!Number.isFinite(spend) || spend < 0 || !Number.isFinite(cap) || cap < 0) return undefined;
  return { spendUsd: spend, maxBudgetUsd: cap };
}
