/**
 * `eval login codex`, `eval whoami`, `eval logout codex`: the suite's own credentials. The Codex
 * login is development only and needs explicit consent. Nothing here reads the app's vault or
 * keychain, and nothing prints a token or a key.
 */
import {
  CODEX_TERMS_WARNING,
  CodexConsentError,
  codexStatus,
  forgetCodexCredential,
  hasCodexConsent,
} from '../../llm/codex-auth';
import { EvalHomeError, evalHome, loadVoucherCredential } from '../../llm/home';
import { flag, parseCommandArgs, UsageError } from '../args';
import type { CliDeps } from '../deps';
import { classifyError, EXIT_FAILED, EXIT_OK, EXIT_USAGE, messageOf } from '../exit';
import { LOGIN_SPEC, LOGOUT_SPEC, WHOAMI_SPEC } from '../specs';

/** The start of an account id: enough to tell logins apart, never the whole id. */
export function accountIdPrefix(accountId: string | undefined): string {
  if (!accountId) return 'unknown';
  return accountId.length > 8 ? `${accountId.slice(0, 8)}…` : accountId;
}

function codexArgument(command: 'login' | 'logout', positional: string): void {
  if (positional !== 'codex') {
    throw new UsageError(
      `Unknown provider "${positional}": only "codex" has a ${command} (the voucher key is a file in the credentials home).`,
      command,
    );
  }
}

export async function loginCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseCommandArgs(LOGIN_SPEC, args, { min: 1, max: 1, names: 'codex' });
  codexArgument('login', parsed.positionals[0] as string);

  const consent = hasCodexConsent({ consent: flag(parsed, 'codex-consent'), env: deps.env });
  if (!consent) {
    deps.stderr(`${CODEX_TERMS_WARNING}\n\n${new CodexConsentError().message}\n`);
    deps.stderr('Nobody was contacted and nothing was stored.\n');
    return EXIT_USAGE;
  }

  const controller = new AbortController();
  const stopListening = deps.onInterrupt((signal) =>
    controller.abort(new Error(`interrupted by ${signal}`)),
  );
  try {
    const summary = await deps.runCodexLogin({
      home: evalHome(deps.env),
      consent: true,
      env: deps.env,
      print: (line) => deps.stderr(`${line}\n`),
      signal: controller.signal,
    });
    deps.stdout(
      `Signed in to Codex: account id ${accountIdPrefix(summary.accountId)}, access token valid until ${summary.expiresAt}, stored in ${summary.file}\n`,
    );
    return EXIT_OK;
  } catch (error) {
    if (controller.signal.aborted) {
      deps.stderr('Login cancelled: nothing was stored.\n');
      return EXIT_FAILED;
    }
    const failure = classifyError(error, deps.env.SA_EVAL_DEBUG === '1');
    deps.stderr(`error: ${failure.message}\n`);
    return failure.code;
  } finally {
    stopListening();
  }
}

/** How long a date is away, for people: `in 12 days`, `3 hours ago`. */
export function relativeTime(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  const unit =
    abs >= 86_400_000
      ? `${Math.round(abs / 86_400_000)} day(s)`
      : abs >= 3_600_000
        ? `${Math.round(abs / 3_600_000)} hour(s)`
        : `${Math.max(1, Math.round(abs / 60_000))} minute(s)`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** The voucher key file in words: whether it exists and until when it is valid (no key shown). */
export function describeVoucher(
  home: string,
  now: Date,
): { line: string; ok: boolean; present: boolean; expired: boolean } {
  try {
    const voucher = loadVoucherCredential({ home });
    const gateway = new URL(voucher.baseUrl).host;
    if (!voucher.expiresAt) {
      return {
        line: `present (gateway ${gateway}), no expiry date recorded`,
        ok: true,
        present: true,
        expired: false,
      };
    }
    const at = Date.parse(voucher.expiresAt);
    if (Number.isNaN(at)) {
      return {
        line: `present (gateway ${gateway}), expiry "${voucher.expiresAt}" is not a date`,
        ok: true,
        present: true,
        expired: false,
      };
    }
    const expired = at <= now.getTime();
    return {
      line: `present (gateway ${gateway}), ${expired ? 'EXPIRED' : 'valid until'} ${voucher.expiresAt} (${relativeTime(at, now.getTime())})`,
      ok: true,
      present: true,
      expired,
    };
  } catch (error) {
    if (error instanceof EvalHomeError && error.code === 'missing') {
      return {
        line: 'none (no litellm.json in the credentials home)',
        ok: true,
        present: false,
        expired: false,
      };
    }
    return { line: `unusable: ${messageOf(error)}`, ok: false, present: true, expired: false };
  }
}

export async function whoamiCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  parseCommandArgs(WHOAMI_SPEC, args, { min: 0, max: 0, names: '' });
  const home = evalHome(deps.env);
  const now = deps.now();
  let code = EXIT_OK;
  const lines = [`Credentials home: ${home}`];

  try {
    const status = codexStatus({ home, now: () => now.getTime() });
    if (!status.loggedIn) {
      lines.push('Codex: not logged in (eval login codex --codex-consent)');
    } else {
      const expiresInMs = status.expiresInMs ?? 0;
      lines.push(
        `Codex: logged in, account id ${accountIdPrefix(status.accountId)}; access token ${
          expiresInMs > 0
            ? `valid until ${status.expiresAt} (${relativeTime(now.getTime() + expiresInMs, now.getTime())})`
            : `expired ${status.expiresAt} (refreshed when used)`
        }; signed in ${status.loginAt}`,
      );
    }
  } catch (error) {
    lines.push(`Codex: unusable: ${messageOf(error)}`);
    code = EXIT_FAILED;
  }

  const voucher = describeVoucher(home, now);
  lines.push(`Voucher key: ${voucher.line}`);
  if (!voucher.ok) code = EXIT_FAILED;

  deps.stdout(`${lines.join('\n')}\n`);
  return code;
}

export async function logoutCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseCommandArgs(LOGOUT_SPEC, args, { min: 1, max: 1, names: 'codex' });
  codexArgument('logout', parsed.positionals[0] as string);
  const removed = forgetCodexCredential(evalHome(deps.env));
  deps.stdout(
    removed
      ? 'Codex login removed from the credentials home (no token was revoked at OpenAI).\n'
      : 'There was no Codex login to remove.\n',
  );
  return EXIT_OK;
}
