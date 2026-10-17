import { existsSync } from 'node:fs';
import { getVoucherCredit, KeyServerError } from '@sa/agent';
import { type CodexStatus, codexStatus } from './codex-auth';
import { readCooldown } from './codex-cooldown';
import { EvalHomeError, homePaths, loadVoucherCredential } from './home';
import { Ledger, type LedgerSummary } from './ledger';
import { type MeterLimits, type MeterLimitsInput, resolveLimits } from './limits';

/**
 * `eval budget`: the voucher key's balance (from the key server, `GET /v1/vouchers/credit`), the
 * ledger's totals and the caps the meter applies. Never contains a key or a token.
 */

export type VoucherBalance =
  | {
      status: 'ok';
      baseUrl: string;
      keyServerUrl: string;
      /** What the vouchers add up to. */
      limitUsd: number;
      spendUsd: number;
      /** The gateway's cap of the key (the limit minus web research charges). */
      maxBudgetUsd: number;
      /** `maxBudgetUsd - spendUsd`: pass it to `createMeter({ keyRemainingUsd })`. */
      remainingUsd: number;
      expiresAt: string | null;
    }
  | { status: 'unavailable'; error: string }
  | { status: 'not_configured'; error: string };

export interface BudgetStatus {
  home: string;
  /** The kill-switch file exists: every meter answers "out of budget". */
  stopped: boolean;
  voucher: VoucherBalance;
  ledger: LedgerSummary;
  limits: MeterLimits;
  codex: CodexStatus & { cooldownUntil?: string };
}

export interface BudgetStatusOptions {
  home?: string;
  /** Tests: a fake key server. */
  fetchImpl?: typeof fetch;
  /** Skip the key server (offline): the voucher balance is `unavailable`. */
  offline?: boolean;
  /** Caps to show instead of the defaults (the ones the run will use). */
  limits?: MeterLimitsInput;
  now?: () => Date;
}

async function voucherBalance(options: BudgetStatusOptions): Promise<VoucherBalance> {
  let credential: ReturnType<typeof loadVoucherCredential>;
  try {
    credential = loadVoucherCredential({ ...(options.home ? { home: options.home } : {}) });
  } catch (error) {
    if (error instanceof EvalHomeError) {
      return {
        status: error.code === 'missing' ? 'not_configured' : 'unavailable',
        error: error.message,
      };
    }
    throw error;
  }
  if (options.offline)
    return { status: 'unavailable', error: 'offline: the key server was not asked' };
  try {
    const credit = await getVoucherCredit(credential.keyServerUrl, credential.apiKey, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      timeoutMs: 15_000,
    });
    return {
      status: 'ok',
      baseUrl: credential.baseUrl,
      keyServerUrl: credential.keyServerUrl,
      limitUsd: credit.limitUsd,
      spendUsd: credit.spendUsd,
      maxBudgetUsd: credit.maxBudgetUsd,
      remainingUsd: credit.maxBudgetUsd - credit.spendUsd,
      expiresAt: credit.expiresAt,
    };
  } catch (error) {
    const message =
      error instanceof KeyServerError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return { status: 'unavailable', error: message };
  }
}

export async function budgetStatus(options: BudgetStatusOptions = {}): Promise<BudgetStatus> {
  const paths = homePaths(options.home);
  const now = options.now ?? (() => new Date());
  const ledger = new Ledger(paths.ledgerDir, now);
  let codex: CodexStatus;
  try {
    codex = codexStatus({
      ...(options.home ? { home: options.home } : {}),
      now: () => now().getTime(),
    });
  } catch (error) {
    if (!(error instanceof EvalHomeError)) throw error;
    codex = { loggedIn: false };
  }
  const cooldown = readCooldown(paths.codexCooldown, now().getTime());
  return {
    home: paths.home,
    stopped: existsSync(paths.stopFile),
    voucher: await voucherBalance(options),
    ledger: ledger.summary(),
    limits: resolveLimits(options.limits),
    codex: {
      ...codex,
      ...(cooldown ? { cooldownUntil: new Date(cooldown.untilMs).toISOString() } : {}),
    },
  };
}

const usd = (value: number) => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

/** The text of `eval budget`. */
export function formatBudgetStatus(status: BudgetStatus): string {
  const lines: string[] = [];
  const { voucher, ledger, limits, codex } = status;
  lines.push(`Credentials home: ${status.home}`);
  if (status.stopped)
    lines.push('KILL SWITCH ON: every model call is refused until the STOP file is removed.');

  lines.push('', 'Voucher key');
  if (voucher.status === 'ok') {
    lines.push(
      `  gateway ${voucher.baseUrl}`,
      `  balance ${usd(voucher.remainingUsd)} left (spent ${usd(voucher.spendUsd)} of ${usd(voucher.maxBudgetUsd)}; vouchers ${usd(voucher.limitUsd)})`,
      `  expires ${voucher.expiresAt ?? 'never'}`,
    );
  } else {
    lines.push(
      `  ${voucher.status === 'not_configured' ? 'not configured' : 'balance unavailable'}: ${voucher.error}`,
    );
  }

  lines.push('', 'Ledger (real voucher spend; cache replays are free)');
  lines.push(
    `  since the last epoch ${usd(ledger.sinceEpochUsd)}${ledger.lastEpochAt ? ` (epoch ${ledger.lastEpochAt})` : ''}, all time ${usd(ledger.allTimeUsd)}`,
    `  requests: ${ledger.requests.forward} forwarded, ${ledger.requests.replay} replayed (${ledger.looseReplays} loose; would have cost ${usd(ledger.replayedUsd)}), ${ledger.requests.reject} refused`,
  );
  if (ledger.pending.requests > 0) {
    lines.push(
      `  in flight or never settled: ${ledger.pending.requests} request(s), up to ${usd(ledger.pending.usd)} reserved (oldest ${ledger.pending.oldest}); counted as spent until they settle`,
    );
  }
  const days = Object.entries(ledger.byDay).sort().slice(-7);
  if (days.length > 0)
    lines.push(`  by day: ${days.map(([day, value]) => `${day} ${usd(value)}`).join(', ')}`);
  const models = Object.entries(ledger.byModel);
  if (models.length > 0) {
    lines.push(
      `  by model: ${models.map(([model, m]) => `${model} ${usd(m.usd)} (${m.requests})`).join(', ')}`,
    );
  }
  const agents = Object.entries(ledger.byAgent);
  if (agents.length > 0) {
    lines.push(
      `  by agent: ${agents.map(([agent, a]) => `${agent} ${usd(a.usd)} (${a.requests})`).join(', ')}`,
    );
  }
  if (ledger.lastKey) {
    lines.push(
      `  last gateway headers: spend ${usd(ledger.lastKey.spendUsd)} of ${usd(ledger.lastKey.maxBudgetUsd)} (${ledger.lastKey.at}; one call behind)`,
    );
  }

  const v = limits;
  lines.push('', 'Caps (voucher runs)');
  lines.push(
    `  per run ${v.perRunRequests} requests and the cost limit of its fixture (--max-cost overrides it; ${usd(v.perRunUsd)} for a run without one)`,
    `  per agent ${usd(v.perAgentUsd)} and ${v.perAgentRequests} requests (answerer ${usd(v.perAgentUsdByRole.answerer ?? v.perAgentUsd)}); largest request ${v.maxInputTokensPerRequest} input tokens`,
    `  per day ${usd(v.dailyUsd)}${v.lifetimeUsd !== undefined ? `, lifetime ${usd(v.lifetimeUsd)}` : ''} (UTC, all runs and processes); reserve ${usd(v.reserveUsd)} of the key's balance, also the floor under which a run does not start`,
    '  A request is refused by the first cap it reaches; each one counts the worst case of the requests in flight, its own included.',
  );

  lines.push('', 'Codex (ChatGPT plan, no eval cap)');
  if (codex.loggedIn) {
    lines.push(
      `  logged in; access token ${(codex.expiresInMs ?? 0) > 0 ? `valid for ${Math.round((codex.expiresInMs ?? 0) / 60_000)} min` : 'expired (refreshed on use)'}`,
    );
  } else {
    lines.push('  not logged in (eval login codex)');
  }
  lines.push(
    `  used: ${ledger.codex.total} requests in total; a run gets the per-run and per-agent request caps above`,
  );
  if (codex.cooldownUntil) lines.push(`  USAGE LIMIT: paused until ${codex.cooldownUntil}`);
  return lines.join('\n');
}
