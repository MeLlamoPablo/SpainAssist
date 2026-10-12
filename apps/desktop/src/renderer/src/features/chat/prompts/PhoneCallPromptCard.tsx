import {
  PHONE_CALL_MAX_SECONDS,
  PHONE_CALL_TRANSCRIPT_MAX,
  type PhoneCallOutcome,
  type PhoneCallPrompt,
  type PromptItem,
  telHref,
} from '@sa/shared';
import { Check, Clock, Copy, Info, Mic, PhoneCall, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Checkbox } from '../../../components/ui/controls';
import { Textarea } from '../../../components/ui/field';
import { Callout, Spinner } from '../../../components/ui/misc';
import { useT } from '../../../i18n';
import { api, errorMessage } from '../../../lib/api';
import { type CallRecording, formatDuration, startCallRecording } from '../../../lib/call-recorder';
import { cn } from '../../../lib/cn';
import { toast } from '../../../store/toast';
import { Markdown } from '../Markdown';
import { PromptShell } from './PromptShell';
import { phoneCallDict } from './phoneCallI18n';

type Recorder =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'recording'; seconds: number; level: number }
  | { state: 'transcribing'; wav: Uint8Array }
  | { state: 'failed'; wav: Uint8Array; message: string }
  /** Transcribed: the text is in `transcript`, editable. */
  | { state: 'review' };

/**
 * The agent asks the user to phone someone. The card shows who to call and what to ask, records
 * the call from the microphone, has main transcribe it, and lets the user review the transcript
 * before it goes back to the agent with the outcome and their notes.
 */
export function PhoneCallPromptCard({
  item,
  prompt,
  embedded,
}: {
  item: PromptItem;
  prompt: PhoneCallPrompt;
  /** Shown on the procedure's card. */
  embedded?: boolean;
}) {
  const t = useT(phoneCallDict);
  const pending = item.status === 'pending';
  const [available, setAvailable] = useState<boolean | undefined>(undefined);
  const [recorder, setRecorder] = useState<Recorder>({ state: 'idle' });
  const [micError, setMicError] = useState<string | undefined>(undefined);
  const [limitReached, setLimitReached] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [notes, setNotes] = useState('');
  const [asked, setAsked] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState<PhoneCallOutcome | null>(null);
  const recording = useRef<CallRecording | null>(null);

  useEffect(() => {
    if (!pending) return;
    let live = true;
    api
      .invoke('phoneCall.transcriptionAvailable')
      .then((ok) => live && setAvailable(ok))
      .catch(() => live && setAvailable(false));
    return () => {
      live = false;
    };
  }, [pending]);

  // Leaving the card (answered elsewhere, procedure closed) drops an unfinished recording.
  useEffect(() => () => recording.current?.cancel(), []);

  const transcribe = async (wav: Uint8Array) => {
    setRecorder({ state: 'transcribing', wav });
    try {
      const { text } = await api.invoke('phoneCall.transcribe', item.id, { wav });
      setTranscript(text.slice(0, PHONE_CALL_TRANSCRIPT_MAX));
      setRecorder({ state: 'review' });
    } catch (err) {
      setRecorder({ state: 'failed', wav, message: errorMessage(err) });
    }
  };

  const finish = () => {
    const current = recording.current;
    recording.current = null;
    if (current) void transcribe(current.stop());
  };

  const start = async () => {
    setMicError(undefined);
    setLimitReached(false);
    setRecorder({ state: 'starting' });
    try {
      recording.current = await startCallRecording({
        onTick: (seconds, level) => setRecorder({ state: 'recording', seconds, level }),
        onLimit: () => {
          setLimitReached(true);
          finish();
        },
      });
      setRecorder({ state: 'recording', seconds: 0, level: 0 });
    } catch (err) {
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      setMicError(denied ? t.record.micDenied : t.record.micFailed);
      setRecorder({ state: 'idle' });
    }
  };

  const discard = () => {
    setTranscript('');
    setRecorder({ state: 'idle' });
  };

  const respond = async (outcome: PhoneCallOutcome) => {
    setBusy(outcome);
    try {
      const text = transcript.trim();
      const note = notes.trim();
      await api.invoke('chat.respond', item.id, {
        kind: 'phone_call',
        outcome,
        ...(outcome !== 'skipped' && recorder.state === 'review' && text
          ? { transcript: text }
          : {}),
        ...(note ? { notes: note } : {}),
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText(prompt.phoneNumber);
      toast.success(t.copied);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const response = item.response?.kind === 'phone_call' ? item.response : undefined;
  const capturing =
    recorder.state === 'starting' ||
    recorder.state === 'recording' ||
    recorder.state === 'transcribing';

  return (
    <PromptShell
      item={item}
      icon={PhoneCall}
      kicker={t.kicker}
      title={prompt.title}
      embedded={embedded}
      answeredSummary={
        response ? (
          <span>
            <span className="font-medium">{t.answered[response.outcome]}</span>
            {response.transcript ? (
              <span className="text-fg-subtle"> · {t.answered.transcript}</span>
            ) : null}
            {response.notes ? <span className="text-fg-subtle"> · {response.notes}</span> : null}
          </span>
        ) : null
      }
    >
      <Markdown text={prompt.purpose} className="text-[14px] text-fg" />

      <div
        className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl bg-surface-2 px-4 py-3 ring-1 ring-line ring-inset"
        data-testid="phone-number"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
          <PhoneCall size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-fg-muted">{prompt.organization}</p>
          <p className="text-[20px] font-semibold leading-tight tracking-[-0.01em] text-fg tabular-nums">
            {prompt.phoneNumber}
          </p>
          {prompt.hours ? (
            <p className="mt-0.5 flex items-center gap-1 text-[12.5px] text-fg-muted">
              <Clock size={12} aria-hidden />
              <span className="sr-only">{t.hours}: </span>
              {prompt.hours}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={Copy} onClick={() => void copyNumber()}>
            {t.copy}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={PhoneCall}
            onClick={() => void api.invoke('app.openExternal', telHref(prompt.phoneNumber))}
          >
            {t.call}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 @min-[700px]:grid-cols-[3fr_2fr]">
        <section>
          <h4 className="text-[12.5px] font-semibold text-fg-muted">{t.whatToAsk}</h4>
          <ol className="mt-2 flex flex-col gap-2">
            {prompt.questions.map((question, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: questions are a fixed, ordered list
              <li key={index}>
                <Checkbox
                  checked={asked.has(index)}
                  onCheckedChange={(checked) =>
                    setAsked((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(index);
                      else next.delete(index);
                      return next;
                    })
                  }
                  label={
                    <span className={cn(asked.has(index) && 'text-fg-subtle line-through')}>
                      {question}
                    </span>
                  }
                />
              </li>
            ))}
          </ol>
        </section>
        {prompt.haveAtHand?.length || prompt.openingScript ? (
          <div className="flex flex-col gap-4">
            {prompt.haveAtHand?.length ? (
              <section>
                <h4 className="text-[12.5px] font-semibold text-fg-muted">{t.haveAtHand}</h4>
                <ul className="mt-2 flex flex-col gap-1.5 text-[13.5px] text-fg">
                  {prompt.haveAtHand.map((thing) => (
                    <li key={thing} className="flex gap-2">
                      <Check size={14} className="mt-[3px] shrink-0 text-fg-subtle" aria-hidden />
                      {thing}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {prompt.openingScript ? (
              <section>
                <h4 className="text-[12.5px] font-semibold text-fg-muted">{t.openingTitle}</h4>
                <blockquote className="mt-2 border-l-2 border-accent-line pl-3 text-[13.5px] italic text-fg">
                  «{prompt.openingScript}»
                </blockquote>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>

      <section
        className="mt-5 rounded-xl border border-line p-4"
        data-testid="call-recorder"
        data-state={available === false ? 'unavailable' : recorder.state}
      >
        {available === false ? (
          <p className="flex gap-2 text-[13px] text-fg-muted">
            <Info size={15} className="mt-px shrink-0" aria-hidden />
            {t.record.unavailable}
          </p>
        ) : recorder.state === 'idle' || recorder.state === 'starting' ? (
          <>
            <h4 className="text-[14px] font-semibold text-fg">{t.record.title}</h4>
            <p className="mt-1 text-[13px] text-fg-muted">{t.record.hint}</p>
            <ConsentReminder text={t.record.consent} />
            {micError ? (
              <Callout tone="blocked" className="mt-3">
                {micError}
              </Callout>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                variant="secondary"
                icon={Mic}
                loading={recorder.state === 'starting' || available === undefined}
                onClick={() => void start()}
              >
                {t.record.start}
              </Button>
              <span className="text-[12.5px] text-fg-subtle">
                {t.record.limit(PHONE_CALL_MAX_SECONDS / 60)}
              </span>
            </div>
          </>
        ) : recorder.state === 'recording' ? (
          <>
            <div className="flex flex-wrap items-center gap-4">
              <span className="flex items-center gap-2 text-[14px] font-semibold text-st-blocked-fg">
                <span className="size-2.5 animate-pulse-soft rounded-full bg-st-blocked-dot" />
                {t.record.recording}
                <span className="font-medium tabular-nums text-fg" data-testid="call-timer">
                  {formatDuration(recorder.seconds)}
                </span>
              </span>
              <LevelMeter level={recorder.level} />
              <Button
                size="lg"
                variant="primary"
                icon={Square}
                className="ml-auto"
                onClick={finish}
              >
                {t.record.stop}
              </Button>
            </div>
            <ConsentReminder text={t.record.consent} />
          </>
        ) : recorder.state === 'transcribing' ? (
          <div className="flex items-center gap-3">
            <Spinner size={18} className="text-accent" />
            <div>
              <p className="text-[14px] font-medium text-fg">{t.record.transcribing}</p>
              <p className="text-[12.5px] text-fg-muted">{t.record.transcribingHint}</p>
            </div>
          </div>
        ) : recorder.state === 'failed' ? (
          <Callout
            tone="blocked"
            action={
              <Button
                size="sm"
                variant="secondary"
                icon={RotateCcw}
                onClick={() => void transcribe(recorder.wav)}
              >
                {t.record.retry}
              </Button>
            }
          >
            {recorder.message}
          </Callout>
        ) : (
          <>
            {limitReached ? (
              <p className="mb-2 text-[12.5px] text-fg-muted">{t.record.limitReached}</p>
            ) : null}
            <label htmlFor={`transcript-${item.id}`} className="text-[14px] font-semibold text-fg">
              {t.transcript.label}
            </label>
            <p className="mt-0.5 text-[12.5px] text-fg-muted">
              {transcript.trim() ? t.transcript.hint : t.transcript.empty}
            </p>
            <Textarea
              id={`transcript-${item.id}`}
              autosize
              minRows={4}
              maxRows={12}
              maxLength={PHONE_CALL_TRANSCRIPT_MAX}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              className="mt-2"
              data-testid="call-transcript"
            />
            <div className="mt-2 flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" icon={Mic} onClick={() => void start()}>
                {t.record.again}
              </Button>
              <Button size="sm" variant="ghost" icon={Trash2} onClick={discard}>
                {t.record.discard}
              </Button>
            </div>
          </>
        )}
      </section>

      <div className="mt-4">
        <label htmlFor={`notes-${item.id}`} className="text-[13px] font-medium text-fg">
          {t.notes.label}
        </label>
        <Textarea
          id={`notes-${item.id}`}
          autosize
          minRows={2}
          maxRows={6}
          maxLength={4000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t.notes.placeholder}
          className="mt-1.5"
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          disabled={busy !== null || capturing}
          loading={busy === 'skipped'}
          onClick={() => void respond('skipped')}
        >
          {t.skip}
        </Button>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="secondary"
            disabled={busy !== null || capturing}
            loading={busy === 'unreachable'}
            onClick={() => void respond('unreachable')}
          >
            {t.unreachable}
          </Button>
          <Button
            variant="primary"
            icon={Check}
            disabled={busy !== null || capturing}
            loading={busy === 'done'}
            onClick={() => void respond('done')}
          >
            {t.done}
          </Button>
        </div>
      </div>
    </PromptShell>
  );
}

/** Spanish law lets you record your own calls, but the other side should know: say it first. */
function ConsentReminder({ text }: { text: string }) {
  return (
    <p className="mt-3 flex gap-2 rounded-lg bg-st-attention-bg px-3 py-2 text-[12.5px] text-st-attention-fg">
      <Info size={14} className="mt-px shrink-0" aria-hidden />
      {text}
    </p>
  );
}

/** Five bars that light up with the microphone level. */
function LevelMeter({ level }: { level: number }) {
  return (
    <span className="flex h-5 items-end gap-[3px]" aria-hidden data-testid="call-level">
      {[0.1, 0.25, 0.45, 0.65, 0.85].map((threshold) => (
        <span
          key={threshold}
          className={cn(
            'w-1 rounded-full transition-colors duration-100',
            level >= threshold ? 'bg-st-blocked-dot' : 'bg-surface-3',
          )}
          style={{ height: `${30 + threshold * 70}%` }}
        />
      ))}
    </span>
  );
}
