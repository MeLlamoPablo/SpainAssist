import { useState } from 'react';
import { formatDuration } from '../lib/format';
import type { Frame } from '../lib/model';
import { frameAt, useFrameUrl } from './data';

const THUMB_H = 48;

interface Props {
  frames: Frame[];
  from: number;
  to: number;
  /** The timeline's width in px. */
  width: number;
  hoverTime?: number;
  onPick(at: number): void;
}

/**
 * Screenshots along the timeline, as Playwright's trace viewer shows them: the timeline is cut
 * into thumbnail-wide slots, each showing what the page looked like at the slot's middle.
 */
export function Filmstrip({ frames, from, to, width, hoverTime, onPick }: Props) {
  const [preview, setPreview] = useState<{ frame: Frame; left: number }>();
  const ratio = frames[0]?.height ? frames[0].width / frames[0].height : 16 / 10;
  const thumbW = Math.round(THUMB_H * ratio);
  const slots = Math.max(1, Math.floor(width / (thumbW + 2)));
  const slotMs = (to - from) / slots;
  const first = frames[0]?.at ?? Number.POSITIVE_INFINITY;
  const last = frames.at(-1)?.at ?? 0;

  const cells: { left: number; frame: Frame; at: number }[] = [];
  for (let i = 0; i < slots; i++) {
    const at = from + (i + 0.5) * slotMs;
    // Nothing before the first screenshot, nor long after the last one.
    if (at < first || at > last + slotMs) continue;
    const frame = frameAt(frames, at);
    if (frame) cells.push({ left: i * (width / slots), frame, at });
  }
  const hoverSlot =
    hoverTime !== undefined ? Math.floor((hoverTime - from) / slotMs) * (width / slots) : undefined;

  return (
    <div className="film" onPointerLeave={() => setPreview(undefined)}>
      {cells.map((cell) => (
        <button
          type="button"
          key={cell.left}
          className={`film-cell${hoverSlot !== undefined && Math.abs(hoverSlot - cell.left) < 1 ? ' is-hover' : ''}`}
          style={{ left: cell.left, width: thumbW, height: THUMB_H }}
          onPointerEnter={() => setPreview({ frame: cell.frame, left: cell.left })}
          onClick={() => onPick(cell.at)}
          title={`+${formatDuration(cell.frame.at - from)}`}
        >
          <Thumb frame={cell.frame} />
        </button>
      ))}
      {preview && (
        <div
          className="film-preview"
          style={{ left: Math.min(Math.max(0, preview.left - 120), Math.max(0, width - 420)) }}
        >
          <Thumb frame={preview.frame} />
        </div>
      )}
    </div>
  );
}

export function Thumb({ frame, alt = '' }: { frame: Frame | undefined; alt?: string }) {
  const url = useFrameUrl(frame);
  return url ? <img src={url} alt={alt} draggable={false} /> : <span className="thumb-empty" />;
}
