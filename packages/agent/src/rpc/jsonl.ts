/**
 * Strict JSONL framing for pi's RPC protocol: records are separated by "\n" only (an optional
 * trailing "\r" is stripped). Never use node:readline here: it also splits on U+2028/U+2029,
 * which are valid inside JSON strings.
 */
export class JsonlSplitter {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void) {}

  /** Feed decoded text (use a UTF-8 decoder upstream so multi-byte characters stay intact). */
  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  /** Flush a final record without a trailing newline. */
  end(): void {
    const rest = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = '';
    if (rest.length > 0) this.onLine(rest);
  }
}

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
