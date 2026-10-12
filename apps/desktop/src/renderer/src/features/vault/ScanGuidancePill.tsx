import { TriangleAlert } from 'lucide-react';
import type { ScanGuidance } from '../../../../scanner';
import { Spinner, TONE_PILL } from '../../components/ui/misc';
import { useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { scanDict } from './scanI18n';

export function ScanGuidancePill({
  guidance,
  photo = false,
}: {
  guidance: ScanGuidance;
  photo?: boolean;
}) {
  const t = useT(scanDict);
  const feedback = guidance.state === 'feedback' ? guidance : undefined;
  const tone = feedback
    ? feedback.success
      ? 'done'
      : 'blocked'
    : guidance.state === 'legibility'
      ? 'blocked'
      : guidance.state === 'reading'
        ? 'research'
        : 'neutral';
  const text = feedback
    ? feedback.reason
    : guidance.state === 'legibility'
      ? t.ensureLegible
      : guidance.state === 'reading'
        ? photo
          ? t.reading
          : t.keepStill
        : photo
          ? t.nextPhoto
          : t.bringCloser;

  return (
    <div className="flex justify-center">
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="scan-guidance"
        data-state={guidance.state}
        data-success={feedback?.success}
        className={cn(
          'inline-flex max-w-full items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium ring-1 ring-inset transition-colors duration-200',
          TONE_PILL[tone],
        )}
      >
        {feedback ? (
          feedback.success ? (
            <svg
              key={feedback.reason}
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              className="scan-success-mark shrink-0"
              aria-hidden
            >
              <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.12" />
              <path
                className="scan-success-stroke"
                d="m7 12 3.2 3.2L17 8.5"
                pathLength="1"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <TriangleAlert size={18} className="shrink-0" aria-hidden />
          )
        ) : guidance.state === 'legibility' ? (
          <TriangleAlert size={18} className="shrink-0" aria-hidden />
        ) : (
          <Spinner size={18} />
        )}
        <span className="min-w-0 break-words">{text}</span>
      </div>
    </div>
  );
}
