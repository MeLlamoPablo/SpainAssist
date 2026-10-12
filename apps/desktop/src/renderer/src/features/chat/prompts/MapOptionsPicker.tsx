import type { FormField } from '@sa/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/field';
import { useLang, useT } from '../../../i18n';
import { api } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { usePersonal, useVaultStore } from '../../../store/vault';
import { LocationMap } from './LocationMap';
import { mapDict } from './mapI18n';
import {
  ADDRESS_KEYS,
  addressValues,
  homeAddress,
  homeQuery,
  type MapPoint,
  sortedPlaces,
} from './mapLogic';

export function MapOptionsPicker({
  promptId,
  field,
  value,
  onChange,
  inputId,
  describedBy,
  invalid,
  onReadyChange,
}: {
  /** The pending prompt item, whose map pins main keeps. */
  promptId: string;
  field: FormField;
  value: string;
  onChange: (value: string) => void;
  inputId: string;
  describedBy?: string;
  invalid: boolean;
  onReadyChange: (ready: boolean) => void;
}) {
  const t = useT(mapDict);
  const lang = useLang();
  const personal = usePersonal();
  const overviewLoaded = useVaultStore((s) => s.overview !== null);
  const draftInitialized = useRef(overviewLoaded);
  const address = homeAddress(personal);
  // The home point is looked up from the saved address each time and never stored.
  const [located, setLocated] = useState<{ address: string; point: MapPoint }>();
  const home = located?.address === address ? located.point : undefined;
  // An address already in Mis datos skips the address step; it is located in the background.
  const [step, setStep] = useState<'address' | 'places'>(() =>
    homeAddress(personal) ? 'places' : 'address',
  );
  useEffect(() => {
    if (address) setStep('places');
  }, [address]);
  const [locating, setLocating] = useState<'idle' | 'busy' | 'failed'>('idle');
  const autoLocated = useRef('');
  useEffect(() => {
    if (home || !address || step !== 'places' || autoLocated.current === address) return;
    autoLocated.current = address;
    setLocating('busy');
    void (async () => {
      try {
        const point = await api.invoke('places.locateHome', homeQuery(addressValues(personal)));
        if (!point) throw new Error('Address not found.');
        setLocated({ address, point });
        setLocating('idle');
      } catch {
        setLocating('failed');
      }
    })();
  }, [home, address, personal, step]);
  useEffect(() => onReadyChange(step === 'places'), [step, onReadyChange]);
  const [draft, setDraft] = useState(() => addressValues(personal));
  useEffect(() => {
    if (!draftInitialized.current && overviewLoaded) {
      setDraft(addressValues(personal));
      draftInitialized.current = true;
    }
  }, [overviewLoaded, personal]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const groupId = useId();
  const options = field.options ?? [];
  // Pins come from main, which found them before showing the form and keeps them in memory
  // with the pending prompt (Mapbox results are never stored). null: no map, only the list.
  const [points, setPoints] = useState<(MapPoint | null)[] | null>([]);
  const [pinsFailed, setPinsFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setPinsFailed(false);
    api
      .invoke('places.pins', promptId, field.key)
      .then((found) => active && setPoints(found))
      .catch(() => active && setPinsFailed(true));
    return () => {
      active = false;
    };
  }, [promptId, field.key]);
  const noMap = points === null;
  const places = sortedPlaces(options, points ?? [], home);
  const labels = [t.street, t.postal, t.city, t.province, t.country];

  /** Find the typed address, then save it. Nothing is saved if it is not found. */
  const locate = async () => {
    setError('');
    if (!draft.addressStreet.trim() || !draft.addressMunicipality.trim()) {
      setError(t.missing);
      return;
    }
    setBusy(true);
    try {
      let point: Awaited<ReturnType<typeof api.invoke<'places.locateHome'>>>;
      try {
        point = await api.invoke('places.locateHome', homeQuery(draft));
      } catch {
        setError(t.failed);
        return;
      }
      if (!point) {
        setError(t.noResults);
        return;
      }
      const saved = ADDRESS_KEYS.map((key) => draft[key].trim())
        .filter(Boolean)
        .join(', ');
      autoLocated.current = saved;
      setLocated({ address: saved, point });
      const overview = await api.invoke(
        'vault.setPersonal',
        ADDRESS_KEYS.map((key) => ({ key, value: draft[key].trim() })),
      );
      useVaultStore.getState().set(overview);
      setStep('places');
    } catch {
      setError(t.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const editAddress = () => {
    setDraft(addressValues(personal));
    setError('');
    setStep('address');
  };

  return (
    <div
      id={inputId}
      tabIndex={-1}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      className="space-y-3"
    >
      {step === 'address' ? (
        <>
          <h4 className="text-sm font-semibold text-fg">{t.addressTitle}</h4>
          <p className="text-[13px] text-fg-muted">{t.addressHint}</p>
          <div className="grid grid-cols-1 gap-3 @min-[400px]:grid-cols-2">
            {ADDRESS_KEYS.map((key, index) => (
              <label
                key={key}
                htmlFor={`${inputId}-${key}`}
                className={cn(
                  'space-y-1 text-[13px] text-fg',
                  key === 'addressStreet' && '@min-[400px]:col-span-2',
                )}
              >
                <span>{labels[index]}</span>
                <Input
                  id={`${inputId}-${key}`}
                  value={draft[key]}
                  disabled={busy}
                  maxLength={key === 'addressStreet' ? 200 : 60}
                  autoComplete={
                    key === 'addressStreet'
                      ? 'street-address'
                      : key === 'addressPostalCode'
                        ? 'postal-code'
                        : 'off'
                  }
                  onChange={(e) => {
                    draftInitialized.current = true;
                    setDraft({ ...draft, [key]: e.target.value });
                  }}
                />
              </label>
            ))}
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={() => void locate()}>
              {t.locate}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setStep('places');
                setError('');
              }}
            >
              {t.skip}
            </Button>
          </div>
        </>
      ) : (
        <>
          {address ? (
            <p className="text-xs text-fg-muted">
              {t.home}: {address}{' '}
              <Button size="sm" variant="link" className="ml-1 text-xs" onClick={editAddress}>
                {t.edit}
              </Button>
            </p>
          ) : (
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h4 className="text-sm font-semibold text-fg">{t.chooseTitle}</h4>
              <Button size="sm" variant="link" className="text-xs" onClick={editAddress}>
                {t.add}
              </Button>
            </div>
          )}
          {noMap ? (
            <p role="status" className="text-xs text-fg-muted">
              {t.noMap}
            </p>
          ) : (
            !home && (
              <p className="text-xs text-fg-subtle">
                {address && locating === 'busy'
                  ? t.locating
                  : address && locating === 'failed'
                    ? t.notLocated
                    : t.unsorted}
              </p>
            )
          )}
          {pinsFailed && (
            <p role="status" className="text-xs text-fg-muted">
              {t.pinsFailed}
            </p>
          )}
          <div
            className={cn('grid grid-cols-1 gap-3', !noMap && '@min-[540px]:grid-cols-[3fr_2fr]')}
          >
            {points && (
              <LocationMap
                options={options}
                points={points}
                home={home}
                value={value}
                onChange={(next) => {
                  onChange(next);
                  const index = options.findIndex((o) => o.value === next);
                  document
                    .getElementById(`${inputId}-option-${index}`)
                    ?.scrollIntoView({ block: 'nearest' });
                }}
              />
            )}
            <div
              role="radiogroup"
              aria-label={field.label}
              aria-required={field.required}
              className="max-h-[320px] space-y-2 overflow-y-auto pr-1"
            >
              {places.map((place) => (
                <label
                  id={`${inputId}-option-${place.index}`}
                  key={place.value}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-xl border bg-surface p-3 text-sm transition-colors',
                    value === place.value
                      ? 'border-accent bg-accent-soft'
                      : 'border-line hover:border-line-strong',
                  )}
                >
                  <input
                    type="radio"
                    name={`${groupId}-place`}
                    checked={value === place.value}
                    onChange={() => onChange(place.value)}
                    className="mt-1 accent-accent"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="block font-medium text-fg">
                      {place.index + 1} · {place.label || place.address}
                    </span>
                    <span className="block text-xs text-fg-muted">{place.address}</span>
                    {place.distance !== undefined && (
                      <span className="block text-xs font-medium text-accent-text">
                        {place.distance < 1
                          ? `${Math.round(place.distance * 1000)} m`
                          : `${place.distance.toLocaleString(lang, { maximumFractionDigits: 1 })} km`}
                      </span>
                    )}
                  </span>
                </label>
              ))}
              {!places.length && <p className="text-sm text-fg-muted">{t.noPlaces}</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
