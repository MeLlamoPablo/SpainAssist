/**
 * The model provider of a run, set up through the app's own flow.
 *
 * In the product, a user redeems a voucher (or signs in), the app stores what it gets in the vault,
 * and the real `ProviderManager` hands the credential to every agent host that asks for it
 * (`agent.credential` over the bridge) and refreshes it. A run does the same, with only the
 * network calls replaced:
 *
 *   voucher, mock  `providers.redeemVoucher` with a stubbed `redeemVoucher` that answers with the
 *                  run's credential (`deps.credentials`) and the meter as the gateway. The pi
 *                  provider stays `litellm`, as for every voucher user.
 *   codex          `providers.loginCodexDevice` with the app's development Codex lib stubbed to
 *                  answer with the Codex login of the credentials home.
 *
 * Every other provider function (ChatGPT sign-in, key server calls) fails: nothing in the app's
 * process may reach a service outside the network layer.
 */
import { BUNDLED_MODEL_LISTS, type FixedModel, type PiCredential } from '@sa/agent';
import type { HeadlessApp, HeadlessOptions } from '@sa/desktop/headless';
import type { EvalAppDeps, EvalModelChoice, EvalProvider } from '../../contracts';

type ProviderLibOverrides = NonNullable<HeadlessOptions['providerLib']>;

/** The provider functions a run replaces, all of them there; `codex` is the app's development login. */
type RunProviderLib = Required<
  Pick<
    ProviderLibOverrides,
    | 'loginChatGPT'
    | 'refreshOAuthCredential'
    | 'revokeChatGPTCredential'
    | 'getChatGPTKey'
    | 'redeemVoucher'
    | 'getVoucherCredit'
    | 'modelLists'
  >
> &
  Pick<ProviderLibOverrides, 'codex'>;

/** The agent key of requests the app itself makes with the user's key (not an agent's). */
const APP_AGENT_KEY = 'app';

/** A voucher code in the right shape: the stubbed redemption ignores it. */
const EVAL_VOUCHER_CODE = 'SA-EVAL01';
/** What the UI shows as the voucher's balance. A run's real caps are the meter's. */
const DISPLAY_LIMIT_USD = 100;

const unavailable = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not available in evaluation runs`);
};

function apiKeyOf(credential: PiCredential | null): string {
  if (credential?.type !== 'api_key' || typeof credential.key !== 'string' || !credential.key) {
    throw new Error('The credential source has no API key for the voucher provider');
  }
  return credential.key;
}

/** A role's product list, or only the model `id` a run asks for at the effort of its first. */
function listFor(list: FixedModel[], id: string | undefined): FixedModel[] {
  return id ? [{ ...(list[0] as FixedModel), id }] : list;
}

/**
 * The `providerLib` overrides of a run: the stubbed flows above, and the product's models file
 * with the models of `choice` (undefined: the product defaults of the role).
 */
export function createProviderLib(
  provider: EvalProvider,
  choice: EvalModelChoice,
  deps: EvalAppDeps,
): RunProviderLib {
  const usedUsd = () => deps.meter.usage().costUsd;
  const lib: RunProviderLib = {
    loginChatGPT: unavailable('Signing in with ChatGPT'),
    refreshOAuthCredential: unavailable('Refreshing a ChatGPT sign-in'),
    revokeChatGPTCredential: unavailable('Ending a ChatGPT session'),
    getChatGPTKey: unavailable('The ChatGPT scan key'),
    async redeemVoucher() {
      const apiKey = apiKeyOf(await deps.credentials.credential(deps.credentials.providerId));
      return {
        provider: 'litellm',
        // Whatever the app does with the user's key itself goes through the meter too.
        baseUrl: deps.meter.agentBaseUrl(APP_AGENT_KEY),
        apiKey,
        limitUsd: DISPLAY_LIMIT_USD,
        usageUsd: usedUsd(),
        addedUsd: DISPLAY_LIMIT_USD,
        searchTools: [],
      };
    },
    async getVoucherCredit() {
      return {
        limitUsd: DISPLAY_LIMIT_USD,
        spendUsd: usedUsd(),
        maxBudgetUsd: DISPLAY_LIMIT_USD,
        expiresAt: null,
      };
    },
    modelLists: {
      chatgpt: {
        ...BUNDLED_MODEL_LISTS.chatgpt,
        procedures: listFor(BUNDLED_MODEL_LISTS.chatgpt.procedures, choice.procedureModel),
        assistant: listFor(BUNDLED_MODEL_LISTS.chatgpt.assistant, choice.assistantModel),
      },
      voucher: {
        ...BUNDLED_MODEL_LISTS.voucher,
        procedures: listFor(BUNDLED_MODEL_LISTS.voucher.procedures, choice.procedureModel),
        assistant: listFor(BUNDLED_MODEL_LISTS.voucher.assistant, choice.assistantModel),
      },
    },
  };
  if (provider === 'codex') {
    const noLogin = () => new Error('The credential source has no Codex login');
    lib.codex = {
      login: async () => {
        const credential = await deps.credentials.credential(deps.credentials.providerId);
        if (!credential) throw noLogin();
        return { credential, account: 'eval' };
      },
      // Tokens rotate: the source refreshes under its lock and persists before answering.
      refresh: async () => {
        const credential = await deps.credentials.refreshCredential(deps.credentials.providerId);
        if (!credential) throw noLogin();
        return credential;
      },
    };
  } else {
    // A Codex session in a restored profile is never used by a voucher run.
    lib.codex = undefined;
  }
  return lib;
}

/**
 * Turns the provider on in the app, through the flow a user goes through. Called on every start,
 * restored profiles included: the credential never reaches the profile directory, so there is
 * nothing to restore it from.
 */
export async function activateProvider(app: HeadlessApp, provider: EvalProvider): Promise<void> {
  const result =
    provider === 'codex'
      ? await app.invoke('providers.loginCodexDevice')
      : await app.invoke('providers.redeemVoucher', EVAL_VOUCHER_CODE);
  if (!result.ok) {
    throw new Error(`The model provider could not be set up: ${result.error}`);
  }
}
