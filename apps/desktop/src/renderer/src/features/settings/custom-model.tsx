import {
  CUSTOM_MODEL_DEFAULTS,
  CustomModelCapabilities,
  type CustomProbeInput,
  type CustomProbeResult,
} from '@sa/shared';
import { ChevronDown, ImageOff } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useEffect, useState } from 'react';
import { Switch } from '../../components/ui/controls';
import { Field, Input } from '../../components/ui/field';
import { Callout, Pill, Spinner } from '../../components/ui/misc';
import { useLang, useT } from '../../i18n';
import { api } from '../../lib/api';
import { settingsDict } from './i18n';

/** Wait this long after the last keystroke before asking the server. */
const PROBE_DELAY_MS = 700;

type Source = 'detected' | 'assumed' | 'edited';

/** The user's changes to the capability fields; token counts as typed. */
interface Edits {
  supportsImages?: boolean;
  reasoning?: boolean;
  contextWindow?: string;
  maxTokens?: string;
}

const LIMITS = {
  contextWindow: CustomModelCapabilities.shape.contextWindow.unwrap(),
  maxTokens: CustomModelCapabilities.shape.maxTokens.unwrap(),
};

/** A typed token count: undefined when empty, NaN when not a valid one. */
function parseTokens(text: string, field: keyof typeof LIMITS): number | undefined {
  const digits = text.replace(/[\s.,_]/g, '');
  if (!digits) return undefined;
  const parsed = LIMITS[field].safeParse(/^\d+$/.test(digits) ? Number(digits) : Number.NaN);
  return parsed.success ? parsed.data : Number.NaN;
}

/**
 * Capabilities of the custom endpoint being set up: asks main what the server reports (once the
 * fields settle; `input` null while they are invalid) and merges the user's changes on top.
 * `value` is what to save: unset fields mean the app defaults (CUSTOM_MODEL_DEFAULTS).
 */
export function useCustomCapabilities(input: CustomProbeInput | null) {
  const [result, setResult] = useState<CustomProbeResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [edits, setEdits] = useState<Edits>({});
  const key = input ? JSON.stringify(input) : '';

  useEffect(() => {
    if (!key) {
      setResult(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      setChecking(true);
      api
        .invoke('providers.probeCustom', JSON.parse(key) as CustomProbeInput)
        .then((r) => alive && setResult(r))
        .catch(() => alive && setResult({ reachable: false, models: [], detected: {} }))
        .finally(() => alive && setChecking(false));
    }, PROBE_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [key]);

  const detected = result?.detected ?? {};
  const contextText = edits.contextWindow ?? detected.contextWindow?.toString() ?? '';
  const maxTokensText = edits.maxTokens ?? detected.maxTokens?.toString() ?? '';
  const contextWindow = parseTokens(contextText, 'contextWindow');
  const maxTokens = parseTokens(maxTokensText, 'maxTokens');
  const supportsImages = edits.supportsImages ?? detected.supportsImages;
  const reasoning = edits.reasoning ?? detected.reasoning;
  const value: CustomModelCapabilities = {
    ...(supportsImages !== undefined ? { supportsImages } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(contextWindow !== undefined && !Number.isNaN(contextWindow) ? { contextWindow } : {}),
    ...(maxTokens !== undefined && !Number.isNaN(maxTokens) ? { maxTokens } : {}),
  };
  const sourceOf = (field: keyof Edits): Source =>
    edits[field] !== undefined && edits[field] !== ''
      ? 'edited'
      : detected[field] !== undefined
        ? 'detected'
        : 'assumed';

  return {
    result,
    checking,
    models: result?.models ?? [],
    value,
    valid: !Number.isNaN(contextWindow) && !Number.isNaN(maxTokens),
    fields: { edits, setEdits, contextText, maxTokensText, contextWindow, maxTokens, sourceOf },
  };
}

type CapabilitiesState = ReturnType<typeof useCustomCapabilities>;

function SourceTag({ source }: { source: Source }) {
  const t = useT(settingsDict);
  return (
    <Pill
      size="sm"
      tone={source === 'detected' ? 'done' : source === 'edited' ? 'brand' : 'neutral'}
    >
      {t.provider.capabilities.source[source]}
    </Pill>
  );
}

/**
 * What the custom endpoint's model can do: the probe's outcome, a warning without images, and
 * the fields (collapsed, with a one-line summary), each marked detected, default or changed.
 */
export function CustomCapabilities({ state }: { state: CapabilitiesState }) {
  const t = useT(settingsDict).provider.capabilities;
  const lang = useLang();
  const { result, checking, value, fields } = state;
  const { setEdits, contextWindow, maxTokens, sourceOf } = fields;
  const images = value.supportsImages ?? CUSTOM_MODEL_DEFAULTS.supportsImages;
  const reasoning = value.reasoning ?? CUSTOM_MODEL_DEFAULTS.reasoning;
  const tokens = (n: number) => n.toLocaleString(lang === 'en' ? 'en-GB' : 'es-ES');
  const minimum = (field: keyof typeof LIMITS) => tokens(LIMITS[field].minValue ?? 1);

  return (
    <div className="flex flex-col gap-3">
      <p
        className="flex min-h-5 items-center gap-2 text-[12.5px] text-fg-muted"
        aria-live="polite"
        data-testid="custom-probe-status"
      >
        {checking ? (
          <>
            <Spinner size={13} />
            {t.checking}
          </>
        ) : result?.reachable && result.server ? (
          t.detected(t.servers[result.server])
        ) : result ? (
          t.notReachable
        ) : null}
      </p>
      {images ? null : (
        <Callout tone="attention" icon={ImageOff} title={t.noImagesTitle}>
          {t.noImages}
        </Callout>
      )}
      <Collapsible.Root className="rounded-xl border border-line">
        <Collapsible.Trigger className="group flex w-full items-center gap-2 rounded-xl px-3.5 py-2.5 text-left text-[13.5px] focus-visible:ring-4 focus-visible:ring-ring/40 focus-visible:outline-none">
          <ChevronDown
            size={16}
            className="shrink-0 text-fg-subtle transition-transform duration-150 group-data-[state=closed]:-rotate-90"
            aria-hidden
          />
          <span className="shrink-0 font-medium text-fg">{t.title}</span>
          <span className="min-w-0 truncate text-fg-muted">
            {t.summary(
              images,
              reasoning,
              tokens(value.contextWindow ?? CUSTOM_MODEL_DEFAULTS.contextWindow),
            )}
          </span>
        </Collapsible.Trigger>
        <Collapsible.Content className="grid grid-cols-1 gap-4 border-t border-line px-3.5 pt-3 pb-4 @min-[640px]:grid-cols-2">
          <Switch
            className="@min-[640px]:col-span-2"
            checked={images}
            onCheckedChange={(v) => setEdits((e) => ({ ...e, supportsImages: v }))}
            label={
              <span className="inline-flex items-center gap-2">
                {t.images}
                <SourceTag source={sourceOf('supportsImages')} />
              </span>
            }
            description={t.imagesBody}
          />
          <Switch
            className="@min-[640px]:col-span-2"
            checked={reasoning}
            onCheckedChange={(v) => setEdits((e) => ({ ...e, reasoning: v }))}
            label={
              <span className="inline-flex items-center gap-2">
                {t.reasoning}
                <SourceTag source={sourceOf('reasoning')} />
              </span>
            }
            description={t.reasoningBody}
          />
          <Field
            label={t.contextWindow}
            aside={<SourceTag source={sourceOf('contextWindow')} />}
            help={t.contextWindowHelp}
            error={Number.isNaN(contextWindow) ? t.invalidNumber(minimum('contextWindow')) : null}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                inputMode="numeric"
                value={fields.contextText}
                onChange={(e) => setEdits((x) => ({ ...x, contextWindow: e.target.value }))}
                placeholder={String(CUSTOM_MODEL_DEFAULTS.contextWindow)}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
              />
            )}
          </Field>
          <Field
            label={t.maxTokens}
            aside={<SourceTag source={sourceOf('maxTokens')} />}
            help={t.maxTokensHelp}
            error={Number.isNaN(maxTokens) ? t.invalidNumber(minimum('maxTokens')) : null}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                inputMode="numeric"
                value={fields.maxTokensText}
                onChange={(e) => setEdits((x) => ({ ...x, maxTokens: e.target.value }))}
                placeholder={String(CUSTOM_MODEL_DEFAULTS.maxTokens)}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
              />
            )}
          </Field>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  );
}
