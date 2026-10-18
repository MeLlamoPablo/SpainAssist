import {
  type CustomApi,
  formatVoucherCode,
  type LoginResult,
  type ModelOption,
  maskVoucherBody,
  normalizeVoucherCode,
  type ProviderOption,
  type ProviderStatus,
  VOUCHER_BODY_LENGTH,
  VOUCHER_PREFIX,
} from '@sa/shared';
import { CircleAlert, Copy, ExternalLink, KeyRound, LogOut, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { OpenAiMark } from '../../components/brand';
import { Button } from '../../components/ui/button';
import { Field, Input, PasswordInput, PrefixedInput, Select } from '../../components/ui/field';
import { Spinner } from '../../components/ui/misc';
import { useLang, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatCreditCount, formatCredits, formatDate } from '../../lib/format';
import { useAppStore } from '../../store/app';
import { toast } from '../../store/toast';
import { chatDict } from '../chat/i18n';
import { CustomCapabilities, useCustomCapabilities } from './custom-model';
import { settingsDict } from './i18n';

function applyResult(result: LoginResult): ProviderStatus | null {
  if (!result.ok) return null;
  useAppStore.setState({ provider: result.status });
  return result.status;
}

/** Current provider at a glance, with credit meter and disconnect (not for vouchers). */
export function ProviderStatusCard() {
  const t = useT(settingsDict);
  const lang = useLang();
  const provider = useAppStore((s) => s.provider);
  const [busy, setBusy] = useState(false);

  if (!provider?.configured) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-st-attention-bg px-4 py-3 text-[13.5px] font-medium text-st-attention-fg ring-1 ring-st-attention-line ring-inset">
        <CircleAlert size={17} className="shrink-0" aria-hidden />
        {t.provider.notConfigured}
      </div>
    );
  }

  const credit = provider.credit;
  const hasCredit = credit && credit.limitUsd !== null && credit.remainingUsd !== null;
  const ratio = hasCredit ? Math.max(0, Math.min(1, credit.remainingUsd! / credit.limitUsd!)) : 0;

  const logout = async () => {
    setBusy(true);
    try {
      const { status, chatgptStillConnected } = await api.invoke('providers.logout');
      useAppStore.setState({ provider: status });
      if (chatgptStillConnected) {
        toast.info(t.provider.disconnected, t.provider.chatgptStillConnected);
      } else {
        toast.success(t.provider.disconnected);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="provider-status">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-fg-subtle">{t.provider.connectedTo}</p>
          <p className="truncate text-[14.5px] font-semibold text-fg">
            {provider.label ?? provider.kind}
          </p>
        </div>
        {/* A voucher key still holds credit: nobody needs to throw it away. */}
        {provider.kind !== 'voucher' ? (
          <Button
            size="sm"
            variant="ghost"
            icon={LogOut}
            loading={busy}
            onClick={() => void logout()}
          >
            {t.provider.disconnect}
          </Button>
        ) : null}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-3 border-t border-line pt-3 text-[13px] @min-[640px]:grid-cols-3">
        {/* Only BYOK and custom providers let the user pick the model. */}
        {provider.model && (provider.kind === 'byok' || provider.kind === 'custom') ? (
          <div className="min-w-0">
            <dt className="text-fg-subtle">{t.provider.model}</dt>
            <dd className="truncate font-medium text-fg">{provider.model}</dd>
          </div>
        ) : null}
        {provider.account ? (
          <div className="min-w-0">
            <dt className="text-fg-subtle">{t.provider.account}</dt>
            <dd className="truncate font-medium text-fg">{provider.account}</dd>
          </div>
        ) : null}
        {hasCredit ? (
          <div className="min-w-0 @min-[640px]:col-span-2">
            <dt className="text-fg-subtle">{t.provider.credit}</dt>
            <dd className="font-medium text-fg">
              {t.provider.creditOf(
                formatCreditCount(credit.remainingUsd!, lang),
                formatCredits(credit.limitUsd!, lang),
              )}
            </dd>
            <div
              className="mt-1.5 h-1.5 w-full max-w-72 overflow-hidden rounded-full bg-line"
              aria-hidden
            >
              <div
                className={cn('h-full rounded-full', ratio < 0.2 ? 'bg-danger' : 'bg-st-done-dot')}
                style={{ width: `${ratio * 100}%` }}
              />
            </div>
            {ratio < 0.2 ? (
              <p className="mt-1 text-[12.5px] text-danger">{t.provider.lowCredit}</p>
            ) : null}
          </div>
        ) : null}
        {provider.expiresAt ? (
          <div className="min-w-0">
            <dt className="text-fg-subtle">{t.provider.expires}</dt>
            <dd className="font-medium text-fg">{formatDate(provider.expiresAt, lang)}</dd>
          </div>
        ) : null}
      </dl>
      {provider.error ? (
        <p className="mt-3 flex items-center gap-2 text-[13px] font-medium text-danger">
          <CircleAlert size={15} aria-hidden />
          {t.provider.error}: {provider.error}
        </p>
      ) : null}
    </div>
  );
}

/** ChatGPT browser login: opens the browser and waits; main reports progress meanwhile. */
export function useChatGptLogin(onConnected?: () => void) {
  const t = useT(settingsDict);
  const progress = useAppStore((s) => s.loginProgress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    useAppStore.setState({ loginProgress: null });
    try {
      const result = await api.invoke('providers.loginChatGPT');
      if (applyResult(result)) {
        toast.success(t.provider.chatgpt.success);
        onConnected?.();
      } else if (!result.ok) {
        setError(result.error);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      useAppStore.setState({ loginProgress: null });
    }
  };

  const cancel = () => void api.invoke('providers.cancelLogin');

  return { busy, error, progress, start: () => void start(), cancel };
}

export function ChatGptConnect({ onConnected }: { onConnected?: () => void }) {
  const t = useT(settingsDict);
  const { busy, error, progress, start, cancel } = useChatGptLogin(onConnected);

  if (busy) {
    return (
      <div
        className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 ring-1 ring-line ring-inset"
        aria-live="polite"
      >
        <Spinner size={18} className="text-accent" />
        <span className="min-w-0 flex-1 text-[13.5px] font-medium text-fg">
          {progress?.message ?? t.provider.chatgpt.waiting}
        </span>
        {progress?.url ? (
          <Button
            size="sm"
            variant="ghost"
            icon={ExternalLink}
            onClick={() => void api.invoke('app.openExternal', progress.url!)}
          >
            {t.provider.chatgpt.openLink}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" onClick={cancel}>
          {t.provider.chatgpt.cancel}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* The onboarding splash's white pill (fixed colours: it looks the same in dark mode). */}
      <button
        type="button"
        onClick={start}
        data-testid="login-chatgpt"
        className="inline-flex h-12 w-full select-none items-center justify-center gap-3 rounded-full bg-(--sa-white) px-6 text-[15px] font-medium whitespace-nowrap text-[#161012] shadow-[0_2px_6px_rgba(0,0,0,0.18)] ring-1 ring-black/8 ring-inset transition-colors duration-150 ease-out hover:bg-[#f3ece6] focus-visible:ring-4 focus-visible:ring-ring/40 focus-visible:outline-none active:bg-[#eae2db]"
      >
        <OpenAiMark size={20} />
        {t.provider.chatgpt.button}
      </button>
      {error ? <p className="text-[13px] font-medium text-danger">{error}</p> : null}
    </div>
  );
}

/**
 * Development builds only (rendered behind `import.meta.env.DEV`): legacy Codex device-code login.
 * Main shows the user code through `providers.loginProgress`.
 */
export function CodexDeviceConnect() {
  const t = useT(settingsDict);
  const progress = useAppStore((s) => s.loginProgress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    useAppStore.setState({ loginProgress: null });
    try {
      const result = await api.invoke('providers.loginCodexDevice');
      if (applyResult(result)) toast.success(t.provider.advanced.codexSuccess);
      else if (!result.ok) setError(result.error);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      useAppStore.setState({ loginProgress: null });
    }
  };

  const copyAndOpen = async (code: string, url: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(t.provider.advanced.codexCopied);
    } catch {
      // The code stays on screen: the user can type it.
    }
    void api.invoke('app.openExternal', url);
  };

  if (!busy) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <Button
            variant="secondary"
            icon={KeyRound}
            onClick={() => void start()}
            data-testid="login-codex"
          >
            {t.provider.advanced.codexButton}
          </Button>
        </div>
        {error ? (
          <p className="text-[13px] font-medium text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const code = progress?.userCode;
  return (
    <div
      className="flex flex-col gap-3 rounded-xl bg-surface-2 px-4 py-3 ring-1 ring-line ring-inset"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <Spinner size={18} className="text-accent" />
        <span className="min-w-0 flex-1 text-[13.5px] font-medium text-fg">
          {progress?.message ?? t.provider.chatgpt.waiting}
        </span>
      </div>
      {code ? (
        <p
          className="font-mono text-[22px] font-semibold tracking-[0.12em] text-fg select-all"
          data-testid="codex-user-code"
        >
          {code}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {code && progress?.url ? (
          <Button
            size="sm"
            variant="primary"
            icon={Copy}
            onClick={() => void copyAndOpen(code, progress.url!)}
          >
            {t.provider.advanced.codexCopy}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void api.invoke('providers.cancelLogin')}
        >
          {t.provider.chatgpt.cancel}
        </Button>
      </div>
    </div>
  );
}

export function VoucherRedeem({
  onConnected,
  autoFocus,
  naked,
}: {
  onConnected?: () => void;
  autoFocus?: boolean;
  /** Borderless input, for a row without a frame of its own. */
  naked?: boolean;
}) {
  const t = useT(settingsDict);
  const lang = useLang();
  // Only the 6 characters after the fixed `SA-`.
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = body.length === VOUCHER_BODY_LENGTH;

  const redeem = async () => {
    if (!complete) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.invoke('providers.redeemVoucher', formatVoucherCode(body));
      if (applyResult(result) && result.ok) {
        toast.success(t.provider.voucher.success(formatCredits(result.addedUsd, lang)));
        setBody('');
        onConnected?.();
      } else if (!result.ok) {
        setError(result.error);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const update = (next: string) => {
    setBody(maskVoucherBody(next));
    setError(null);
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void redeem();
      }}
    >
      <div className="flex gap-2">
        {/* `SA-` is fixed: the person types only the 6 characters. Pasting a whole code
            ("sa-7k3q9x") replaces the value, prefix and all. */}
        <PrefixedInput
          prefix={`${VOUCHER_PREFIX}-`}
          naked={naked}
          value={body}
          onChange={(e) => update(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (normalizeVoucherCode(pasted) === null) return; // partial paste: insert as usual
            e.preventDefault();
            update(pasted);
          }}
          placeholder={t.provider.voucher.placeholder}
          aria-label={t.provider.voucher.label}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-medium tracking-wider uppercase"
          autoFocus={autoFocus}
          data-testid="voucher-input"
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!complete}>
          {t.provider.voucher.button}
        </Button>
      </div>
      {error ? (
        <p className="text-[13px] font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function useByokProviders(): ProviderOption[] | null {
  const [list, setList] = useState<ProviderOption[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .invoke('providers.listByok')
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, []);
  return list;
}

export function ByokForm() {
  const t = useT(settingsDict);
  const tc = useT(chatDict);
  const providers = useByokProviders();
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provider = providers?.find((p) => p.id === providerId);
  useEffect(() => {
    if (!providerId && providers?.length) setProviderId(providers[0]!.id);
  }, [providers, providerId]);
  useEffect(() => {
    setModel(provider?.models[0]?.id ?? '');
  }, [provider]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.invoke('providers.setByok', { provider: providerId, model, apiKey });
      if (applyResult(result)) {
        toast.success(t.provider.advanced.saved);
        setApiKey('');
      } else if (!result.ok) setError(result.error);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label={t.provider.advanced.provider}>
        {({ id }) => (
          <Select
            id={id}
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            disabled={!providers}
          >
            {(providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t.provider.advanced.model}>
        {({ id }) => (
          <Select
            id={id}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={!provider}
          >
            {(provider?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label={t.provider.advanced.apiKey}
        help={t.provider.advanced.apiKeyHint}
        error={error}
        className="@min-[640px]:col-span-2"
      >
        {({ id, describedBy, invalid }) => (
          <PasswordInput
            id={id}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider?.envVar ?? ''}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            revealLabel={tc.prompt.reveal}
            hideLabel={tc.prompt.hide}
          />
        )}
      </Field>
      <div className="@min-[640px]:col-span-2">
        <Button
          type="submit"
          variant="secondary"
          loading={busy}
          disabled={!providerId || !model || !apiKey}
        >
          {t.provider.advanced.save}
        </Button>
      </div>
    </form>
  );
}

/** Where people create an Exa API key. */
const EXA_KEYS_URL = 'https://dashboard.exa.ai/api-keys';

/**
 * BYOK and custom endpoints: the user's optional Exa key, which raises the limits of Exa's free
 * keyless tier that their web research uses.
 * Main keeps the key; the renderer only learns whether one is saved (`ProviderStatus.exaKey`).
 */
export function ExaKeyForm() {
  const t = useT(settingsDict);
  const tc = useT(chatDict);
  const saved = useAppStore((s) => s.provider?.exaKey ?? false);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tx = t.provider.exa;

  const submit = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const status = await api.invoke('providers.setExaKey', value);
      useAppStore.setState({ provider: status });
      toast.success(value ? tx.stored : tx.removed);
      setApiKey('');
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="exa-key">
      <p className="flex items-center gap-2 text-[14px] font-semibold text-fg">
        <Search size={15} className="text-accent-text" aria-hidden />
        {tx.title}
      </p>
      <p className="mt-0.5 mb-3 text-[13px] text-fg-muted">{tx.body}</p>
      {saved && !editing ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2/60 px-3 py-2">
          <p className="flex min-w-0 items-center gap-2 text-[13px] text-fg-muted">
            <KeyRound size={15} className="text-st-done-fg" aria-hidden />
            <span className="font-medium text-fg">{tx.label}</span>
            {tx.saved}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {tx.change}
            </Button>
            <Button variant="ghost" size="sm" loading={busy} onClick={() => void submit(null)}>
              {tx.remove}
            </Button>
          </div>
          {error ? (
            <p className="w-full text-[13px] font-medium text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (apiKey.trim()) void submit(apiKey.trim());
          }}
        >
          <Field label={tx.label} error={error}>
            {({ id, describedBy, invalid }) => (
              <PasswordInput
                id={id}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setError(null);
                }}
                maxLength={200}
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                revealLabel={tc.prompt.reveal}
                hideLabel={tc.prompt.hide}
                data-testid="exa-key-input"
              />
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="secondary" loading={busy} disabled={!apiKey.trim()}>
              {tx.save}
            </Button>
            {editing ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setApiKey('');
                  setError(null);
                }}
              >
                {tx.cancel}
              </Button>
            ) : (
              <Button
                variant="ghost"
                icon={ExternalLink}
                onClick={() => void api.invoke('app.openExternal', EXA_KEYS_URL)}
              >
                {tx.getKey}
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

const APIS: CustomApi[] = ['openai-completions', 'openai-responses', 'anthropic-messages'];

export function CustomProviderForm() {
  const t = useT(settingsDict);
  const tc = useT(chatDict);
  const tcom = useT(common);
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434/v1');
  const [apiKind, setApiKind] = useState<CustomApi>('openai-completions');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modelsId = useId();

  const validUrl = useMemo(() => {
    try {
      return ['http:', 'https:'].includes(new URL(baseUrl).protocol);
    } catch {
      return false;
    }
  }, [baseUrl]);
  const capabilities = useCustomCapabilities(
    validUrl ? { baseUrl, api: apiKind, model: model.trim(), ...(apiKey ? { apiKey } : {}) } : null,
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.invoke('providers.setCustom', {
        baseUrl,
        api: apiKind,
        model,
        apiKey: apiKey || undefined,
        ...capabilities.value,
      });
      if (applyResult(result)) toast.success(t.provider.advanced.saved);
      else if (!result.ok) setError(result.error);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field
        label={t.provider.advanced.baseUrl}
        className="@min-[640px]:col-span-2"
        error={baseUrl && !validUrl ? t.provider.advanced.invalidUrl : null}
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            spellCheck={false}
          />
        )}
      </Field>
      <Field label={t.provider.advanced.api}>
        {({ id }) => (
          <Select id={id} value={apiKind} onChange={(e) => setApiKind(e.target.value as CustomApi)}>
            {APIS.map((a) => (
              <option key={a} value={a}>
                {t.provider.advanced.apiNames[a]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t.provider.advanced.model}>
        {({ id }) => (
          <>
            <Input
              id={id}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="llama3.1:8b"
              spellCheck={false}
              list={capabilities.models.length ? modelsId : undefined}
            />
            <ModelSuggestions id={modelsId} models={capabilities.models} />
          </>
        )}
      </Field>
      <Field
        label={t.provider.advanced.apiKeyOptional}
        optionalLabel={tcom.optional}
        error={error}
        className="@min-[640px]:col-span-2"
      >
        {({ id, describedBy }) => (
          <PasswordInput
            id={id}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            aria-describedby={describedBy}
            revealLabel={tc.prompt.reveal}
            hideLabel={tc.prompt.hide}
          />
        )}
      </Field>
      <div className="@min-[640px]:col-span-2">
        <CustomCapabilities state={capabilities} />
      </div>
      <div className="@min-[640px]:col-span-2">
        <Button
          type="submit"
          variant="secondary"
          loading={busy}
          disabled={!validUrl || !model || !capabilities.valid}
        >
          {t.provider.advanced.save}
        </Button>
      </div>
    </form>
  );
}

/** Model ids a custom server lists, as suggestions for a free-text model field. */
function ModelSuggestions({ id, models }: { id: string; models: readonly string[] }) {
  if (models.length === 0) return null;
  return (
    <datalist id={id}>
      {models.map((m) => (
        <option key={m} value={m} />
      ))}
    </datalist>
  );
}

/**
 * Change the model of a BYOK or custom provider: a list of the models it offers, or free text for
 * custom servers (they may serve models they don't list), with the listed ones as suggestions.
 * A custom model's capabilities are detected again. ChatGPT and vouchers use the app's model.
 */
export function ModelPicker() {
  const t = useT(settingsDict);
  const provider = useAppStore((s) => s.provider);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [model, setModel] = useState(provider?.model ?? '');
  const [busy, setBusy] = useState(false);
  const modelsId = useId();
  const configured = provider?.kind === 'byok' || provider?.kind === 'custom';
  const source = `${provider?.kind}|${provider?.label}`;

  useEffect(() => setModel(provider?.model ?? ''), [provider?.model]);
  useEffect(() => {
    if (!configured || !source) return;
    let alive = true;
    setModels(null);
    api
      .invoke('providers.listModels')
      .then((list) => alive && setModels(list))
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [configured, source]);

  if (!configured || !provider) return null;
  const freeText = provider.kind === 'custom' || models?.length === 0;

  const save = async () => {
    setBusy(true);
    try {
      const status = await api.invoke('providers.setModel', model.trim());
      useAppStore.setState({ provider: status });
      toast.success(t.provider.advanced.modelSaved);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label={t.provider.advanced.changeModel} className="min-w-64 flex-1">
        {({ id }) =>
          freeText ? (
            <>
              <Input
                id={id}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                spellCheck={false}
                list={models?.length ? modelsId : undefined}
              />
              <ModelSuggestions id={modelsId} models={(models ?? []).map((m) => m.id)} />
            </>
          ) : (
            <Select
              id={id}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={!models}
              data-testid="model-select"
            >
              {(models ?? [{ provider: '', id: model, name: model }]).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name === m.id ? m.id : `${m.name} (${m.id})`}
                </option>
              ))}
            </Select>
          )
        }
      </Field>
      <Button
        type="submit"
        variant="secondary"
        loading={busy}
        disabled={!model.trim() || model.trim() === provider.model}
      >
        {t.provider.advanced.apply}
      </Button>
    </form>
  );
}
