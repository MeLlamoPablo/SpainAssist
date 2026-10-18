import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  ExternalLink,
  Lock,
  ScanLine,
  Ticket,
} from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { BrandLogo, OpenAiMark } from '../../components/brand';
import { LiquidGradient } from '../../components/LiquidGradient';
import { Button } from '../../components/ui/button';
import { SegmentedControl } from '../../components/ui/controls';
import { Spinner } from '../../components/ui/misc';
import { defineDict, useT } from '../../i18n';
import { api, errorMessage, isMockApi } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useAppStore } from '../../store/app';
import { toast } from '../../store/toast';
import { usePersonal } from '../../store/vault';
import { settingsDict } from '../settings/i18n';
import { useChatGptLogin, VoucherRedeem } from '../settings/provider';
import { ScanDialog } from '../vault/ScanDialog';

const dict = defineDict({
  es: {
    back: 'Atrás',
    splash: {
      voucher: 'Continuar con código de invitación',
      chatgpt: 'Continuar con ChatGPT',
      plans: 'Plus o Pro',
      skip: 'Saltar',
    },
    voucher: {
      title: 'Tu código de invitación',
      lead: 'Spain Assist funciona con proveedores de IA de pago. Tu código de invitación contiene créditos para tus primeros trámites.',
    },
    data: {
      title: 'Añade tus datos',
      lead: 'Escanea tu DNI, TIE o pasaporte y guarda tus datos para agilizar trámites.',
      scan: 'Escanear documento',
      skip: 'Ahora no',
      start: 'Empezar',
      saved: (n: number) =>
        n === 1 ? 'He guardado 1 dato tuyo.' : `He guardado ${n} datos tuyos.`,
      privacy:
        'Tus datos se guardan cifrados en tu ordenador. Tu proveedor de IA tendrá acceso para completar trámites, solo cuando sea necesario.',
      notKept: 'Tu proveedor de IA no los guarda.',
    },
    language: 'Idioma',
  },
  en: {
    back: 'Back',
    splash: {
      voucher: 'Continue with invitation code',
      chatgpt: 'Continue with ChatGPT',
      plans: 'Plus or Pro',
      skip: 'Skip',
    },
    voucher: {
      title: 'Your invitation code',
      lead: 'Spain Assist works with paid AI providers. Your invitation code includes credit for your first procedures.',
    },
    data: {
      title: 'Add your details',
      lead: 'Scan your DNI, TIE or passport and save your details to speed up procedures.',
      scan: 'Scan document',
      skip: 'Not now',
      start: 'Start',
      saved: (n: number) => (n === 1 ? 'I saved 1 detail.' : `I saved ${n} details.`),
      privacy:
        'Your details are stored encrypted on your computer. Your AI provider can see them to complete procedures, only when needed.',
      notKept: 'Your AI provider doesn’t keep them.',
    },
    language: 'Language',
  },
});

/** The splash has no card; the other steps sit in a card under the wordmark. */
type Step = 'splash' | 'voucher' | 'data';
const CARD_STEPS: readonly Step[] = ['voucher', 'data'];

/** Exit choreography: the content leaves first, then the gradient dissolves into the app. */
const EXIT_MS = 900;
/** The wordmark glides between its splash and card positions. */
const GLIDE = { duration: 760, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' } as const;
/** The card follows its content's height when the step changes. */
const RESIZE = { duration: 380, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' } as const;

/**
 * With cold GPU caches (first launch, after an Electron or macOS update), the first splash → card
 * switch compiles dozens of GPU pipelines and every frame stalls for 100–400 ms while it does.
 * So the splash replays the switch under the gradient, where it is never seen, until it runs
 * without a stall. Meanwhile the window stays invisible (see `app.reveal`), so no one sees the
 * splash itself stall either.
 *
 * Several copies play at once, each a step further into the switch: every frame asks the GPU for
 * many pipelines at once (it compiles them in parallel), and a short stall-free window proves the
 * whole switch is ready.
 */
const REHEARSAL_LOOP_MS = 1000;
const REHEARSAL_COPIES = 16;
const REHEARSAL_STEP_MS = REHEARSAL_LOOP_MS / REHEARSAL_COPIES;
/** Stall-free time that proves the switch is ready: every step of it, drawn twice. */
const REHEARSAL_CALM_MS = 2 * REHEARSAL_STEP_MS;
const REHEARSAL_MAX_MS = 5000;
/** A frame longer than this means the GPU was still compiling. */
const STALL_MS = 50;

const SKIP_CLASS =
  'no-drag absolute right-6 bottom-6 inline-flex h-[34px] items-center gap-1.5 rounded-lg px-3 text-[15px] font-medium text-(--sa-white)/85 transition-colors duration-150 hover:bg-(--sa-white)/12 hover:text-(--sa-white) focus-visible:ring-3 focus-visible:ring-(--sa-white)/40 focus-visible:outline-none';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function initialStep(): Step {
  if (!isMockApi()) return 'splash';
  const step = new URLSearchParams(location.search).get('onboarding') as Step | null;
  return step && CARD_STEPS.includes(step) ? step : 'splash';
}

/** What is leaving during a splash ↔ card switch, drawn where it was until it has faded out. */
type Ghost = { id: number; step: Step; rect: { top: number; left: number; width: number } };

export function Onboarding({
  exiting = false,
  onExited,
}: {
  /** Onboarding is done and the app is already mounted underneath: play the exit. */
  exiting?: boolean;
  onExited?: () => void;
}) {
  const t = useT(dict);
  const [step, setStep] = useState<Step>(initialStep);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [warmUp, setWarmUp] = useState<'pending' | 'rehearsing' | 'done'>('pending');
  const revealed = warmUp === 'done';
  const settings = useAppStore((s) => s.settings);
  const still = isMockApi() && new URLSearchParams(location.search).has('freeze');
  const rootRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const glideFrom = useRef<{ from: DOMRect; delay: number } | null>(null);
  const splash = step === 'splash';
  const finish = useFinish();

  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => onExited?.(), reducedMotion() ? 0 : EXIT_MS);
    return () => clearTimeout(timer);
  }, [exiting, onExited]);

  // The rehearsal starts two frames in, once the gradient has drawn over it.
  useEffect(() => {
    if (reducedMotion()) return setWarmUp('done');
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setWarmUp((w) => (w === 'pending' ? 'rehearsing' : w)));
    });
    const timer = setTimeout(() => setWarmUp('done'), REHEARSAL_MAX_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (revealed) void api.invoke('app.reveal');
  }, [revealed]);

  // FLIP: after a splash ↔ card switch, the wordmark starts where it was and glides to its new
  // place (and size). Runs after every commit; `go` arms it.
  useLayoutEffect(() => {
    const glide = glideFrom.current;
    const el = logoRef.current;
    glideFrom.current = null;
    if (!glide || !el) return;
    animateGlide(el, glide.from, glide.delay);
  });

  const go = (next: Step) => {
    if (next === step) return;
    const switchesCard = (step === 'splash') !== (next === 'splash');
    if (switchesCard && !reducedMotion()) {
      const from = logoRef.current?.getBoundingClientRect();
      // Back to the splash, the white wordmark waits for the white card to fade before crossing it.
      glideFrom.current = from ? { from, delay: next === 'splash' ? 140 : 0 } : null;
      const root = rootRef.current?.getBoundingClientRect();
      const box = contentRef.current?.getBoundingClientRect();
      if (root && box) {
        setGhost({
          id: Date.now(),
          step,
          rect: { top: box.top - root.top, left: box.left - root.left, width: box.width },
        });
      }
    }
    setStep(next);
  };

  const changeLanguage = async (language: 'es' | 'en') => {
    try {
      useAppStore.setState({ settings: await api.invoke('settings.update', { language }) });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const render = (s: Step, ref?: RefObject<HTMLDivElement | null>) =>
    s === 'splash' ? (
      // Remounted on reveal, so its entrance plays when the window shows.
      <SplashActions
        key={String(revealed)}
        ref={ref}
        hidden={!revealed}
        onVoucher={() => go('voucher')}
        onConnected={() => go('data')}
      />
    ) : (
      <OnboardingCard ref={ref} step={s} go={go} />
    );

  return (
    <div
      ref={rootRef}
      className={cn(
        'relative isolate flex h-full flex-col bg-[#3a1a14]',
        exiting && 'pointer-events-none animate-onboarding-exit',
      )}
      data-testid="onboarding"
      inert={exiting}
    >
      <LiquidGradient animate={!still} className="absolute inset-0 -z-10" />
      <div className="drag flex h-[52px] shrink-0 items-center justify-end gap-3 px-5 controls-right:pr-[calc(var(--sa-controls-width)+12px)]">
        <SegmentedControl
          size="sm"
          label={t.language}
          value={settings?.language ?? 'es'}
          onValueChange={(v) => void changeLanguage(v)}
          options={[
            { value: 'es', label: 'ES' },
            { value: 'en', label: 'EN' },
          ]}
          className={cn(exiting && 'animate-onboarding-card-exit')}
        />
      </div>
      {warmUp === 'rehearsing' && splash ? (
        <Rehearsal logoFrom={logoRef} onDone={() => setWarmUp('done')}>
          {render('voucher')}
        </Rehearsal>
      ) : null}
      {ghost ? (
        <div
          key={ghost.id}
          className={cn(
            'pointer-events-none absolute [&_*]:animate-none!',
            ghost.step === 'splash'
              ? 'animate-onboarding-splash-leave'
              : 'animate-onboarding-card-leave',
          )}
          style={{ top: ghost.rect.top, left: ghost.rect.left, width: ghost.rect.width }}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) setGhost(null);
          }}
          inert
          aria-hidden
        >
          {render(ghost.step)}
        </div>
      ) : null}
      {/* Positioned after the ghost, so what arrives paints over what leaves. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            'mx-auto flex min-h-full w-full max-w-[720px] flex-col items-center justify-center px-8',
            // The splash centres in the whole window, like the design; the card sits a bit higher.
            splash ? 'pb-[52px]' : 'pb-14',
            exiting && 'animate-onboarding-card-exit',
          )}
        >
          <div ref={logoRef} className={cn('w-fit', splash ? 'mb-12' : 'mb-8')}>
            <BrandLogo
              size={splash ? 64 : 44}
              className="text-(--sa-white) drop-shadow-[0_4px_16px_rgba(30,8,4,0.55)]"
            />
          </div>
          {render(step, contentRef)}
        </div>
      </div>
      {splash || ghost?.step === 'splash' ? (
        <button
          type="button"
          onClick={() => void finish.run()}
          disabled={finish.busy || !splash}
          className={cn(
            SKIP_CLASS,
            !splash
              ? 'animate-onboarding-splash-leave'
              : ghost
                ? 'animate-onboarding-splash-enter'
                : null,
            exiting && 'animate-onboarding-card-exit',
          )}
          data-testid="onboarding-skip"
        >
          {t.splash.skip}
          <ArrowRight size={16} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** Glides the wordmark `el` from `from` to where it is now. */
function animateGlide(el: HTMLElement, from: DOMRect, delay = 0) {
  const to = el.getBoundingClientRect();
  if (!to.width) return;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const scale = from.width / to.width;
  el.animate(
    [
      { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
      { transformOrigin: 'top left', transform: 'none' },
    ],
    { ...GLIDE, delay, fill: 'backwards' },
  );
}

/**
 * The splash → card switch, replayed in a loop under the gradient (the canvas isn't flagged opaque,
 * so the compositor still draws what is under it). The first loops stall while the GPU compiles;
 * the later ones draw the frames they skipped. Same layout and classes as the real switch.
 */
function Rehearsal({
  logoFrom,
  onDone,
  children,
}: {
  logoFrom: RefObject<HTMLDivElement | null>;
  /** The whole switch ran without a stall. */
  onDone: () => void;
  /** The card. */
  children: ReactNode;
}) {
  // Copy i starts i steps in and restarts on its own, so at any moment the copies are one step
  // apart all around the switch.
  const [replays, setReplays] = useState(() => Array<number>(REHEARSAL_COPIES).fill(0));
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    let last = start;
    let calmSince = start;
    const tick = (now: number) => {
      if (now - last > STALL_MS) calmSince = now;
      last = now;
      if (now - calmSince >= REHEARSAL_CALM_MS) return done.current();
      const next = replayCounts(now - start);
      setReplays((current) => (current.every((n, i) => n === next[i]) ? current : next));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 -z-20" inert aria-hidden>
      {replays.map((replay, i) => (
        <RehearsalCopy
          // biome-ignore lint/suspicious/noArrayIndexKey: one slot per copy; a replay remounts it
          key={`${i}-${replay}`}
          index={i}
          startAt={replay ? 0 : i * REHEARSAL_STEP_MS}
          logoFrom={logoFrom}
        >
          {children}
        </RehearsalCopy>
      ))}
    </div>
  );
}

/** How many times each copy has restarted, `elapsed` ms into the rehearsal. */
const replayCounts = (elapsed: number) =>
  Array.from({ length: REHEARSAL_COPIES }, (_, i) =>
    Math.floor((elapsed + i * REHEARSAL_STEP_MS) / REHEARSAL_LOOP_MS),
  );

/** One replay of the switch from `startAt` ms in, moved aside so the copies don't cover each other. */
function RehearsalCopy({
  index,
  startAt,
  logoFrom,
  children,
}: {
  index: number;
  startAt: number;
  logoFrom: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const t = useT(dict);
  const ref = useRef<HTMLDivElement>(null);
  const angle = (2 * Math.PI * index) / REHEARSAL_COPIES;
  const dx = Math.round(200 * Math.cos(angle));
  const dy = Math.round(150 * Math.sin(angle));

  useLayoutEffect(() => {
    for (const animation of ref.current?.getAnimations({ subtree: true }) ?? []) {
      animation.currentTime = Number(animation.currentTime ?? 0) + startAt;
    }
  }, [startAt]);

  return (
    <div
      ref={ref}
      className="absolute flex flex-col"
      style={{ top: dy, bottom: -dy, left: dx, right: -dx }}
    >
      <div className="h-[52px] shrink-0" />
      <div className="absolute inset-x-0 top-1/2 flex justify-center animate-onboarding-splash-leave [&_*]:animate-none!">
        <div className="flex w-fit flex-col gap-4">
          <SplashButton tabIndex={-1}>
            <Ticket size={24} strokeWidth={1.5} aria-hidden />
            {t.splash.voucher}
          </SplashButton>
          <SplashButton tabIndex={-1} className="gap-2">
            <span className="flex items-center gap-3">
              <OpenAiMark size={20} />
              {t.splash.chatgpt}
            </span>
            <span className="text-[12px] text-[#79736e]">{t.splash.plans}</span>
          </SplashButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col items-center justify-center px-8 pb-14">
          <div
            ref={(el) => {
              const from = logoFrom.current?.getBoundingClientRect();
              if (el && from) animateGlide(el, from);
            }}
            className="mb-8 w-fit"
          >
            <BrandLogo
              size={44}
              className="text-(--sa-white) drop-shadow-[0_4px_16px_rgba(30,8,4,0.55)]"
            />
          </div>
          {/* The card can't take focus here: give its field the focused look a frame in. */}
          <div
            ref={(el) => {
              requestAnimationFrame(() => el?.setAttribute('data-focus', ''));
            }}
            className="contents [&[data-focus]_label]:border-accent [&[data-focus]_label]:ring-3 [&[data-focus]_label]:ring-ring/40"
          >
            {children}
          </div>
        </div>
      </div>
      {/* Like the real one, it is drawn still first and starts leaving later. */}
      <button
        ref={(el) => {
          setTimeout(() => el?.classList.add('animate-onboarding-splash-leave'), 150);
        }}
        type="button"
        disabled
        tabIndex={-1}
        className={SKIP_CLASS}
      >
        {t.splash.skip}
        <ArrowRight size={16} aria-hidden />
      </button>
    </div>
  );
}

function useFinish() {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const settings = await api.invoke('settings.update', { onboardingCompleted: true });
      useAppStore.setState({ settings, view: { kind: 'procedures' } });
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };
  return { busy, run };
}

function SplashActions({
  ref,
  hidden,
  onVoucher,
  onConnected,
}: {
  ref?: RefObject<HTMLDivElement | null>;
  /** Laid out but not drawn (before the window shows). */
  hidden?: boolean;
  onVoucher: () => void;
  onConnected: () => void;
}) {
  const t = useT(dict);
  const ts = useT(settingsDict);
  const login = useChatGptLogin(onConnected);

  return (
    <div
      ref={ref}
      className={cn(
        'relative flex w-fit flex-col gap-4 animate-onboarding-splash-enter',
        hidden && 'invisible',
      )}
    >
      <SplashButton onClick={onVoucher} disabled={login.busy} data-testid="onboarding-voucher">
        <Ticket size={24} strokeWidth={1.5} aria-hidden />
        {t.splash.voucher}
      </SplashButton>
      <SplashButton
        onClick={login.start}
        disabled={login.busy}
        aria-busy={login.busy || undefined}
        className={cn('gap-2', login.busy && 'cursor-progress disabled:opacity-100')}
        data-testid="onboarding-chatgpt"
      >
        <span className="flex items-center gap-3">
          {login.busy ? <Spinner size={20} /> : <OpenAiMark size={20} />}
          {t.splash.chatgpt}
        </span>
        <span className="text-[12px] text-[#79736e]">{t.splash.plans}</span>
      </SplashButton>
      <div
        className="absolute inset-x-0 top-full mt-5 flex justify-center text-center"
        aria-live="polite"
      >
        {login.busy ? (
          <div className="flex items-center gap-1 whitespace-nowrap text-[13.5px] font-medium text-(--sa-white)/85">
            <span className="px-1">{login.progress?.message ?? ts.provider.chatgpt.waiting}</span>
            {login.progress?.url ? (
              <OnShaderButton
                onClick={() => void api.invoke('app.openExternal', login.progress!.url!)}
              >
                <ExternalLink size={14} aria-hidden />
                {ts.provider.chatgpt.openLink}
              </OnShaderButton>
            ) : null}
            <OnShaderButton onClick={login.cancel}>{ts.provider.chatgpt.cancel}</OnShaderButton>
          </div>
        ) : login.error ? (
          <p
            className="max-w-[420px] rounded-xl bg-[#1e0804]/55 px-4 py-2 text-[13.5px] font-medium text-(--sa-white) backdrop-blur-md"
            role="alert"
          >
            {login.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The splash's white pill buttons (fixed colours: the splash looks the same in dark mode). */
function SplashButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'no-drag inline-flex w-full select-none items-center justify-center gap-3 rounded-full bg-(--sa-white) px-[30px] py-[18px] text-[16px] font-medium leading-[1.2] whitespace-nowrap text-[#161012]',
        'shadow-[0_14px_34px_rgba(200,16,46,0.35),0_2px_6px_rgba(0,0,0,0.18)] transition-[background-color,opacity] duration-150 ease-out',
        // Colour only: the pills stay put, and a lift or a bigger shadow would fall on the pill below.
        'hover:bg-[#f3ece6] active:bg-[#eae2db]',
        'focus-visible:ring-4 focus-visible:ring-(--sa-white)/45 focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-60',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Small ghost button for text over the gradient: the app's ghost style, in white. */
function OnShaderButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-semibold text-(--sa-white) transition-colors duration-150 hover:bg-(--sa-white)/12 focus-visible:ring-3 focus-visible:ring-(--sa-white)/40 focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

function OnboardingCard({
  ref,
  step,
  go,
}: {
  ref?: RefObject<HTMLDivElement | null>;
  step: Step;
  go: (step: Step) => void;
}) {
  const t = useT(dict);
  const innerRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLDivElement>(null);
  const outerRef = ref ?? localRef;
  // The first step rises in with the card, so its content waits a little; later ones slide in.
  const [firstStep, setFirstStep] = useState<Step | null>(step);
  if (firstStep && step !== firstStep) setFirstStep(null);
  // The caret is a layer of its own: drawing it scaled compiles one more GPU pipeline (a stall
  // with cold caches), and it would wobble anyway. It shows once the card is in place.
  const [entering, setEntering] = useState(true);
  useAnimatedHeight(outerRef, innerRef);

  const back: Step | null = step === 'voucher' ? 'splash' : null;
  const stepStyle: CSSProperties | undefined =
    step === firstStep ? { animationDelay: '220ms' } : undefined;

  return (
    <div
      ref={outerRef}
      className={cn(
        'w-full animate-onboarding-card-enter overflow-hidden rounded-2xl bg-surface shadow-pop ring-1 ring-(--sa-black-10)',
        entering && '[&_input]:caret-transparent',
      )}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setEntering(false);
      }}
    >
      <div ref={innerRef} className={cn('px-10 pb-10', back ? 'pt-6' : 'pt-10')}>
        <div key={step} className="animate-onboarding-step" style={stepStyle}>
          {back ? (
            <div className="mb-6">
              <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => go(back)}>
                {t.back}
              </Button>
            </div>
          ) : null}
          {step === 'voucher' ? <Voucher onNext={() => go('data')} /> : null}
          {step === 'data' ? <AddData onConfigure={() => go('splash')} /> : null}
        </div>
      </div>
    </div>
  );
}

/** Animates `outer`'s height whenever `inner` (its only child) changes size. */
function useAnimatedHeight(
  outerRef: RefObject<HTMLDivElement | null>,
  innerRef: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    let last = inner.offsetHeight;
    let running: Animation | null = null;
    const observer = new ResizeObserver(() => {
      const next = inner.offsetHeight;
      if (next === last) return;
      const from = running ? Number.parseFloat(getComputedStyle(outer).height) : last;
      last = next;
      running?.cancel();
      running = null;
      if (reducedMotion()) return;
      const animation = outer.animate([{ height: `${from}px` }, { height: `${next}px` }], RESIZE);
      running = animation;
      animation.onfinish = () => {
        if (running === animation) running = null;
      };
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [outerRef, innerRef]);
}

function Voucher({ onNext }: { onNext: () => void }) {
  const t = useT(dict);
  return (
    <div>
      <div className="flex items-center gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
          <Ticket size={22} aria-hidden />
        </span>
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-fg">{t.voucher.title}</h1>
      </div>
      <p className="mt-4 text-[15px] text-fg-muted">{t.voucher.lead}</p>
      <div className="mt-7">
        <VoucherRedeem onConnected={onNext} autoFocus />
      </div>
    </div>
  );
}

/** The last step: either button finishes the onboarding. */
function AddData({ onConfigure }: { onConfigure: () => void }) {
  const t = useT(dict);
  const personal = usePersonal();
  const finish = useFinish();
  // Only voucher traffic goes through our gateway (LiteLLM stores no prompts) to a
  // zero-data-retention OpenRouter account. Other providers follow the user's own account
  // settings (e.g. ChatGPT's "Improve the model for everyone").
  const zdr = useAppStore((s) => s.settings?.provider?.kind === 'voucher');
  const [scan, setScan] = useState(false);
  const count = personal.length;

  return (
    <div>
      <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-fg">{t.data.title}</h1>
      <p className="mt-2 text-[15px] text-fg-muted">{t.data.lead}</p>

      <div className="mt-7 rounded-2xl border border-line bg-surface px-6 py-10 shadow-card">
        <div className="flex flex-col items-center text-center">
          <DocumentArt />
          {count > 0 ? (
            <p className="mt-5 flex items-center gap-2 text-[14.5px] font-semibold text-st-done-fg">
              <CircleCheck size={18} aria-hidden />
              {t.data.saved(count)}
            </p>
          ) : (
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button variant="primary" size="lg" icon={ScanLine} onClick={() => setScan(true)}>
                {t.data.scan}
              </Button>
            </div>
          )}
        </div>
      </div>
      <p className="mt-8 flex items-center gap-1.5 text-[12.5px] leading-[19px] text-fg-subtle">
        <Lock size={13} className="shrink-0" aria-hidden />
        <span>
          {t.data.privacy}
          {zdr ? ` ${t.data.notKept}` : null}
        </span>
      </p>

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" disabled={finish.busy} onClick={() => void finish.run()}>
          {t.data.skip}
        </Button>
        <Button
          variant="primary"
          iconRight={ArrowRight}
          loading={finish.busy}
          onClick={() => void finish.run()}
          data-testid="onboarding-finish"
        >
          {t.data.start}
        </Button>
      </div>
      <ScanDialog open={scan} onOpenChange={setScan} onConfigure={onConfigure} />
    </div>
  );
}

function DocumentArt() {
  return (
    <svg width="148" height="96" viewBox="0 0 148 96" aria-hidden className="text-fg-subtle">
      <rect
        x="10"
        y="8"
        width="128"
        height="80"
        rx="10"
        fill="var(--sa-surface-2)"
        stroke="var(--sa-line-strong)"
      />
      <rect
        x="22"
        y="20"
        width="26"
        height="32"
        rx="4"
        fill="var(--sa-accent-soft)"
        stroke="var(--sa-accent-line)"
      />
      <rect x="56" y="22" width="50" height="5" rx="2.5" fill="currentColor" opacity="0.35" />
      <rect x="56" y="33" width="64" height="4" rx="2" fill="currentColor" opacity="0.22" />
      <rect x="56" y="42" width="40" height="4" rx="2" fill="currentColor" opacity="0.22" />
      <rect
        x="18"
        y="60"
        width="112"
        height="20"
        rx="4"
        fill="none"
        stroke="var(--sa-accent)"
        strokeDasharray="4 3"
      />
      <rect x="24" y="65" width="98" height="3" rx="1.5" fill="currentColor" opacity="0.4" />
      <rect x="24" y="72" width="88" height="3" rx="1.5" fill="currentColor" opacity="0.4" />
    </svg>
  );
}
