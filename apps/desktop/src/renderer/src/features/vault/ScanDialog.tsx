import { type PersonalDataInput, type PersonalSaveIssue, personalFieldDef } from '@sa/shared';
import { ArrowLeft, Camera, ImageUp, RefreshCw } from 'lucide-react';
import { type DragEvent, useEffect, useRef, useState } from 'react';
import {
  identityDocumentPersonalInputs,
  licenceIdentityNumber,
} from '../../../../identity-documents';
import type { ScanGuidance, ScannerStatus } from '../../../../scanner';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Spinner } from '../../components/ui/misc';
import { useLang, useT } from '../../i18n';
import { common } from '../../i18n/common';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import {
  createDocumentFrameSampler,
  documentFrame,
  scanDocumentSession,
  scannerStatus,
} from '../../lib/document-scanner';
import { SCAN_FIELD_KEYS, type ScanOutcome } from '../../lib/scan';
import { useAppStore } from '../../store/app';
import { reloadVault } from '../../store/sync';
import { toast } from '../../store/toast';
import { useVaultStore } from '../../store/vault';
import { ScanGuidancePill } from './ScanGuidancePill';
import { scanDict } from './scanI18n';

type Step =
  | { kind: 'choose' }
  | { kind: 'camera' }
  | { kind: 'photo'; file: File }
  | { kind: 'saving' };

export function ScanDialog({
  open,
  onOpenChange,
  onSaved,
  onConfigure,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `rejected` lists fields the vault refused; the rest were saved. */
  onSaved?: (items: PersonalDataInput[], rejected: PersonalSaveIssue[]) => void;
  onConfigure?: () => void;
}) {
  const t = useT(scanDict);
  const tc = useT(common);
  const lang = useLang();
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const provider = useAppStore((s) => s.provider);
  const [access, setAccess] = useState<ScannerStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAccess(null);
    if (!provider?.configured) {
      setAccess({ available: false, reason: 'no_provider' });
      return;
    }
    if (open) {
      console.info('[scanner] dialog opened');
      void scannerStatus()
        .then((value) => {
          console.info('[scanner] status', { available: value.available, reason: value.reason });
          if (!cancelled) setAccess(value);
        })
        .catch((err) => {
          console.warn('[scanner] status failed', errorMessage(err));
          if (!cancelled) setAccess({ available: false, reason: 'no_provider' });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, provider]);

  useEffect(() => {
    if (open) setStep({ kind: 'choose' });
  }, [open]);

  const [saveError, setSaveError] = useState<string | null>(null);
  const saving = useRef(false);
  const save = async (outcome: ScanOutcome) => {
    if (saving.current) return;
    saving.current = true;
    setSaveError(null);
    setStep({ kind: 'saving' });
    try {
      const items: PersonalDataInput[] = SCAN_FIELD_KEYS.flatMap((key) => {
        const raw = outcome.fields[key];
        const value = Array.isArray(raw) ? JSON.stringify(raw) : raw?.trim();
        return value ? [{ key, value }] : [];
      });
      if (outcome.permanent) items.push({ key: 'documentExpiry', value: '9999-01-01' });
      const saved = [
        ...identityDocumentPersonalInputs(items),
        ...licenceIdentityNumber(items, useVaultStore.getState().overview?.personal),
      ];
      // One rejected field must not lose the scan: keep the rest and say what wasn't saved.
      const { rejected } = await api.invoke('vault.setPersonalPartial', saved);
      await reloadVault();
      if (rejected.length) {
        const labels = rejected.map(
          (issue) =>
            personalFieldDef(issue.key)?.label[lang] ??
            saved.find((item) => item.key === issue.key)?.label ??
            issue.key,
        );
        toast.info(t.savedPartly, t.notSaved(labels.join(', ')));
      } else toast.success(t.saved);
      onOpenChange(false);
      onSaved?.(saved, rejected);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      saving.current = false;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t.title}
      closeLabel={tc.close}
      width={step.kind === 'choose' ? 'sm' : 'lg'}
    >
      {step.kind !== 'saving' && !access?.available ? (
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          {access ? (
            <>
              <p className="text-fg-muted">
                {access.reason === 'no_vision'
                  ? t.noVision
                  : access.reason === 'no_fast_mode'
                    ? t.noFastMode
                    : t.connectRequired}
              </p>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  if (onConfigure) onConfigure();
                  else useAppStore.getState().navigate({ kind: 'settings', section: 'provider' });
                }}
              >
                {t.connect}
              </Button>
            </>
          ) : (
            <Spinner />
          )}
        </div>
      ) : null}
      {step.kind === 'choose' && access?.available ? (
        <ChooseStep
          onCamera={() => setStep({ kind: 'camera' })}
          onPhoto={(file) => setStep({ kind: 'photo', file })}
        />
      ) : null}
      {step.kind === 'camera' && access?.available ? (
        <CameraStep
          onBack={() => setStep({ kind: 'choose' })}
          onResult={(outcome) => void save(outcome)}
        />
      ) : null}
      {step.kind === 'photo' && access?.available ? (
        <PhotoStep
          file={step.file}
          onBack={() => setStep({ kind: 'choose' })}
          onOther={(file) => setStep({ kind: 'photo', file })}
          onResult={(outcome) => void save(outcome)}
        />
      ) : null}
      {step.kind === 'saving' ? (
        <div className="flex flex-col items-center gap-4 py-6 text-center" role="status">
          {saveError ? (
            <>
              <p role="alert" className="text-fg-muted">
                {saveError}
              </p>
              <Button
                icon={RefreshCw}
                onClick={() => {
                  setSaveError(null);
                  setStep({ kind: 'choose' });
                }}
              >
                {t.retryScan}
              </Button>
            </>
          ) : (
            <>
              <Spinner />
              <p className="text-fg-muted">{t.saving}</p>
            </>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------

function ChooseStep({
  onCamera,
  onPhoto,
}: {
  onCamera: () => void;
  onPhoto: (file: File) => void;
}) {
  const t = useT(scanDict);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) onPhoto(file);
  };

  return (
    <div className="flex flex-col gap-4 pt-1">
      <div className="grid grid-cols-1 gap-3">
        <button
          type="button"
          onClick={onCamera}
          className="group flex flex-col items-start gap-3 rounded-xl border border-line bg-surface p-4 text-left shadow-xs transition-colors duration-150 hover:border-accent-line hover:bg-accent-soft"
          data-testid="scan-camera"
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-accent text-accent-fg">
            <Camera size={19} aria-hidden />
          </span>
          <span>
            <span className="block text-[14.5px] font-semibold text-fg">{t.camera}</span>
            <span className="mt-0.5 block text-[13px] text-fg-muted">{t.cameraHint}</span>
          </span>
        </button>
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'group flex cursor-pointer flex-col items-start gap-3 rounded-xl border border-dashed p-4 text-left transition-colors duration-150 focus-within:ring-2 focus-within:ring-ring',
            dragging
              ? 'border-accent bg-accent-soft'
              : 'border-line-strong bg-surface-2/60 hover:border-accent-line hover:bg-accent-soft',
          )}
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-surface text-fg-muted ring-1 ring-line">
            <ImageUp size={19} aria-hidden />
          </span>
          <span>
            <span className="block text-[14.5px] font-semibold text-fg">
              {dragging ? t.dropHere : t.photo}
            </span>
            <span className="mt-0.5 block text-[13px] text-fg-muted">{t.photoHint}</span>
          </span>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPhoto(file);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}

function CameraStep({
  onBack,
  onResult,
}: {
  onBack: () => void;
  onResult: (outcome: ScanOutcome) => void;
}) {
  const t = useT(scanDict);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [settingsAvailable, setSettingsAvailable] = useState(false);
  const report = (stage: 'starting' | 'ready' | 'failed' | 'timeout', errorName?: string) => {
    const event = { stage, ...(errorName ? { errorName } : {}) };
    console.info('[scanner] camera capture', event);
    void window.saScanner?.cameraEvent(event).catch(() => {});
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry deliberately restarts camera acquisition.
  useEffect(() => {
    let disposed = false;
    let timedOut = false;
    let nativeGranted = false;
    let stream: MediaStream | undefined;
    setReady(false);
    setError(null);
    let timeout: number | undefined;
    const startTimeout = () =>
      window.setTimeout(() => {
        if (!disposed) {
          timedOut = true;
          report('timeout');
          setError(t.cameraError);
          for (const track of stream?.getTracks() ?? []) track.stop();
        }
      }, 15_000);
    void (async () => {
      try {
        report('starting');
        if (window.saScanner) {
          const access = await window.saScanner.requestCamera();
          if (disposed) return;
          nativeGranted = access.status === 'granted';
          setSettingsAvailable(access.settingsAvailable);
          if (!access.granted) {
            setError(
              access.status === 'not-determined'
                ? t.cameraPromptUnavailable
                : access.status === 'restricted'
                  ? t.cameraRestricted
                  : t.cameraDenied,
            );
            report('failed', 'NotAllowedError');
            return;
          }
        }
        // A person can take longer than 15 seconds to answer the OS permission prompt.
        timeout = startTimeout();
        if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('', 'NotFoundError');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (disposed || timedOut) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const video = videoRef.current;
        if (!video) throw new Error('Video missing');
        video.srcObject = stream;
        await video.play();
        if (!disposed && !timedOut) {
          window.clearTimeout(timeout);
          setError(null);
          setReady(true);
          report('ready');
        }
      } catch (err) {
        const errorName =
          err instanceof Error && /^[A-Za-z]+Error$/.test(err.name) ? err.name : 'UnknownError';
        if (!disposed) report('failed', errorName);
        window.clearTimeout(timeout);
        for (const track of stream?.getTracks() ?? []) track.stop();
        if (!disposed)
          setError(
            err instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(err.name)
              ? nativeGranted
                ? t.cameraWindowBlocked
                : t.cameraDenied
              : err instanceof DOMException && err.name === 'NotFoundError'
                ? t.noCamera
                : t.cameraError,
          );
      }
    })();
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [retry, t]);
  const lang = useLang();
  const [guidance, setGuidance] = useState<ScanGuidance>({ state: 'positioning' });
  const resultRef = useRef(onResult);
  resultRef.current = onResult;
  useEffect(() => {
    if (!ready) return;
    setBusy(true);
    setGuidance({ state: 'positioning' });
    const sampler = createDocumentFrameSampler(() => {
      const video = videoRef.current;
      if (!video) throw new Error('Video unavailable');
      return documentFrame(video, video.videoWidth, video.videoHeight);
    });
    const cancel = scanDocumentSession({
      language: lang,
      source: 'camera',
      capture: sampler.capture,
      guidance: setGuidance,
      complete: (result) => {
        sampler.stop();
        setBusy(false);
        resultRef.current(result);
      },
      error: () => {
        sampler.stop();
        setBusy(false);
        setError(t.readFailed);
      },
    });
    return () => {
      cancel();
      sampler.stop();
    };
  }, [ready, lang, t.readFailed]);
  return (
    <div className="flex flex-col gap-4 pt-1">
      <Button variant="ghost" size="sm" icon={ArrowLeft} className="self-start" onClick={onBack}>
        {t.back}
      </Button>
      <div
        className="relative aspect-video overflow-hidden rounded-xl bg-(--sa-black)"
        data-testid="scan-camera-view"
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="absolute inset-0 size-full object-contain"
        />
        {!ready && !error ? (
          <div className="absolute inset-0 flex items-center justify-center text-(--sa-white)">
            <Spinner /> <span className="ml-2">{t.startingCamera}</span>
          </div>
        ) : null}
      </div>
      {ready && !error ? <ScanGuidancePill guidance={guidance} /> : null}
      {error ? (
        <p role="alert" className="text-center text-[13px] text-fg-muted">
          {error}
        </p>
      ) : null}
      {!ready || error ? (
        <div className="flex flex-wrap justify-center gap-2">
          {error && settingsAvailable ? (
            <Button variant="secondary" onClick={() => void window.saScanner?.openCameraSettings()}>
              {t.cameraSettings}
            </Button>
          ) : null}
          {!ready || (error && !busy) ? (
            <Button variant="secondary" icon={RefreshCw} onClick={() => setRetry((r) => r + 1)}>
              {t.retryCamera}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PhotoStep({
  file,
  onBack,
  onOther,
  onResult,
}: {
  file: File;
  onBack: () => void;
  onOther: (file: File) => void;
  onResult: (outcome: ScanOutcome) => void;
}) {
  const t = useT(scanDict);
  const lang = useLang();
  const [url, setUrl] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [guidance, setGuidance] = useState<ScanGuidance>({ state: 'positioning' });
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const pending = useRef<((images: string[]) => void) | null>(null);
  const consumed = useRef<File | null>(null);
  const loadedFile = useRef<File | null>(null);
  const resultRef = useRef(onResult);
  resultRef.current = onResult;
  useEffect(() => {
    setLoaded(false);
    loadedFile.current = null;
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  useEffect(
    () => () => {
      cancelRef.current?.();
      pending.current = null;
    },
    [],
  );
  const imageLoaded = () => {
    setLoaded(true);
    loadedFile.current = file;
    const img = imgRef.current;
    if (img && pending.current && consumed.current !== file) {
      consumed.current = file;
      const resolve = pending.current;
      pending.current = null;
      resolve([documentFrame(img, img.naturalWidth, img.naturalHeight)]);
    }
  };
  const read = () => {
    if (!loaded || busy) return;
    cancelRef.current?.();
    consumed.current = null;
    setBusy(true);
    setError(null);
    setGuidance({ state: 'positioning' });
    cancelRef.current = scanDocumentSession({
      language: lang,
      capture: (signal) => {
        const img = imgRef.current;
        if (img && loadedFile.current && consumed.current !== loadedFile.current) {
          consumed.current = loadedFile.current;
          return Promise.resolve([documentFrame(img, img.naturalWidth, img.naturalHeight)]);
        }
        return new Promise<string[]>((resolve, reject) => {
          signal.throwIfAborted();
          const abort = () => {
            pending.current = null;
            reject(new Error('cancelled'));
          };
          signal.addEventListener('abort', abort, { once: true });
          pending.current = (images) => {
            signal.removeEventListener('abort', abort);
            resolve(images);
          };
        });
      },
      guidance: setGuidance,
      complete: (result) => {
        setBusy(false);
        resultRef.current(result);
      },
      error: () => {
        setBusy(false);
        setError(t.readFailed);
      },
    });
  };
  return (
    <div className="flex flex-col gap-4 pt-1">
      <Button variant="ghost" size="sm" icon={ArrowLeft} className="self-start" onClick={onBack}>
        {t.back}
      </Button>
      {url ? (
        <img
          ref={imgRef}
          src={url}
          alt=""
          className="max-h-[44vh] w-full rounded-xl object-contain"
          onLoad={imageLoaded}
          onError={() => {
            cancelRef.current?.();
            setBusy(false);
            setError(t.readFailed);
          }}
        />
      ) : null}
      {busy && !error ? <ScanGuidancePill guidance={guidance} photo /> : null}
      {error ? (
        <p role="alert" className="text-center text-[13px] text-fg-muted">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-center gap-2">
        {!busy ? (
          <Button variant="primary" disabled={!loaded} onClick={read} data-testid="scan-read">
            {t.read}
          </Button>
        ) : null}
        <label className="cursor-pointer rounded-lg px-3 py-2 text-sm">
          {busy ? t.nextPhoto : t.otherPhoto}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const next = e.target.files?.[0];
              if (next) onOther(next);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}
