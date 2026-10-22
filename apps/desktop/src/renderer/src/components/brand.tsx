import { useId } from 'react';
import { cn } from '../lib/cn';

/** Flag and typography from Framer's Design page, without the splash background. */
export function BrandMark({
  size = 28,
  className,
  development = false,
}: {
  size?: number;
  className?: string;
  development?: boolean;
}) {
  const id = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 58 58"
      className={cn('shrink-0', className)}
      role="img"
      aria-label={development ? 'Spain Assist Dev' : 'Spain Assist'}
    >
      <defs>
        <clipPath id={`${id}-flag`}>
          <rect x="1" y="10" width="56" height="38" rx="7" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-flag)`}>
        <path fill={development ? '#1554c9' : 'var(--sa-flag-red)'} d="M0 9h58v40H0z" />
        <path fill={development ? '#369ffc' : 'var(--sa-flag-yellow)'} d="M0 19h58v20H0z" />
      </g>
      <rect
        x="1"
        y="10"
        width="56"
        height="38"
        rx="7"
        fill="none"
        stroke="var(--sa-flag-outline)"
        strokeWidth="2"
      />
    </svg>
  );
}

export function BrandName({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'brand-name inline-flex items-center gap-[0.25em] whitespace-nowrap font-normal text-fg',
        className,
      )}
    >
      <span>Spain</span> <i>Assist</i>
    </span>
  );
}

/** OpenAI's mark, for "Continue with ChatGPT". */
export function OpenAiMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn('shrink-0', className)}
      aria-hidden
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.041l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

export function BrandLogo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <div
      className={cn('flex w-fit shrink-0 items-center text-fg', className)}
      style={{ height: size, gap: size / 4, fontSize: size }}
    >
      <BrandMark size={(size * 58) / 64} />
      <BrandName className="text-inherit" />
    </div>
  );
}
