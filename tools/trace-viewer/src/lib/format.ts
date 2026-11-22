/** Durations, money and axis ticks, the way the waterfall shows them. */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1) return '<1ms';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(2).replace(/\.?0+$/, '')}s`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1).replace(/\.0$/, '')}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1_000);
    return s === 60 ? `${m + 1}m` : s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** A tick label: offsets from the start of the window, in the unit of the step. */
export function formatTick(ms: number, step: number): string {
  if (ms === 0) return '0';
  if (step < 1_000) return `${Math.round(ms)}ms`;
  if (step < 60_000) {
    const s = ms / 1_000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  }
  return formatDuration(ms);
}

export function formatCost(dollars: number | undefined): string {
  if (!dollars) return '';
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000,
  120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000,
  43_200_000, 86_400_000,
];

/** A round step giving at most `max` ticks over `span` ms. */
export function tickStep(span: number, max: number): number {
  const target = span / Math.max(1, max);
  return STEPS.find((s) => s >= target) ?? Math.ceil(target / 86_400_000) * 86_400_000;
}

/** Tick offsets (from the window's start) within [from, to], every `step`. */
export function ticks(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to + 1e-6; t += step) out.push(t);
  return out;
}
