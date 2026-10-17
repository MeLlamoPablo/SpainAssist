/** Small text helpers shared by the commands: wrapping, aligned columns, times and amounts. */

/** Wraps `text` into lines of at most `width` characters; lines after the first start with `indent`. */
export function wrap(text: string, width: number, indent = ''): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

/** Rows of cells as aligned columns (two spaces apart); the last column is not padded. */
export function columns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      if (index < row.length - 1) widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index < row.length - 1 ? cell.padEnd(widths[index] ?? 0) : cell))
      .join('  ')
      .trimEnd(),
  );
}

export function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function percent(score: number): string {
  return `${(Math.round(score * 1000) / 10).toFixed(1)}%`;
}

/** `2026-10-17 04:42 UTC` for an ISO instant; the text itself when it is not one. */
export function utcMinute(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `12 s`, `3 min 5 s`. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
