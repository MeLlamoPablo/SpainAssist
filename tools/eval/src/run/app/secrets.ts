/**
 * The typed secrets of a run (the persona's Cl@ve password, the model credential): what the logs
 * mask and what the leak check looks for. Only synthetic accounts ever get here (docs/EVAL.md), but
 * the run still treats them like the real ones: a secret that reaches the model, a script or a
 * request to a stranger is a finding.
 */
import { SecretMasker } from '../../llm/redact';
import { CanaryScanner, squash } from '../../net/canary';

/** Below this length only the spellings of the secret are looked for, never decodings. */
const MIN_DEEP_LENGTH = 8;

export const MASK = '[secret]';

interface Masker {
  /** Replaces every registered secret (in any spelling) with `[secret]`. */
  scrub(text: string): string;
  /** How many texts had something masked since the last call. */
  takeHits(): number;
}

/**
 * The typed secrets of a run, on the shared masker of `llm/redact.ts` (same spellings, same
 * minimum length), plus what the leak check adds: a scan for secrets hidden by an encoding.
 */
export class SecretBook {
  private readonly masked = new SecretMasker(MASK);
  private deep: CanaryScanner | undefined | null;

  /** Registers a secret (values shorter than the shared minimum are ignored). */
  add(value: string | null | undefined): void {
    if (this.masked.add(value)) this.deep = undefined;
  }

  list(): string[] {
    return this.masked.list();
  }

  get size(): number {
    return this.masked.size;
  }

  mask(text: string): string {
    return this.masked.mask(text);
  }

  /** A masking function for one log, which also counts what it masked (see `Masker`). */
  masker(): Masker {
    let hits = 0;
    return {
      scrub: (text) => {
        const masked = this.mask(text);
        if (masked !== text) hits++;
        return masked;
      },
      takeHits: () => {
        const n = hits;
        hits = 0;
        return n;
      },
    };
  }

  /** Whether some registered secret is in one of the strings, plain, in another spelling, or hidden by an encoding. */
  leaksIn(parts: readonly string[]): boolean {
    if (this.masked.size === 0) return false;
    if (parts.some((part) => this.masked.has(part))) return true;
    const scanner = this.deepScanner();
    if (!scanner) return false;
    return scanner
      .scanParts(parts)
      .some((hit) => !hit.corroborating && (hit.kind === 'full' || hit.kind === 'encoded'));
  }

  private deepScanner(): CanaryScanner | undefined {
    if (this.deep === undefined) {
      const canaries = this.masked
        .list()
        .filter((value) => value.length >= MIN_DEEP_LENGTH && squash(value).length >= 6)
        .map((value, index) => ({
          id: `secret-${index + 1}`,
          value,
          strength: 'strong' as const,
        }));
      this.deep = canaries.length ? new CanaryScanner(canaries) : null;
    }
    return this.deep ?? undefined;
  }
}

/**
 * The strings that carried a secret to the model, to the network or to a log: kept with the
 * secret masked and a label of where it was seen, never the secret itself.
 */
export class LeakLog {
  private readonly seen = new Set<string>();
  private readonly items: string[] = [];

  constructor(private readonly secrets: SecretBook) {}

  /** Records `text` when it carries a secret. Returns whether it did. */
  check(source: string, parts: readonly string[]): boolean {
    if (!this.secrets.leaksIn(parts)) return false;
    const text = `${source}: ${this.secrets.mask(parts.join(' | ')).slice(0, 500)}`;
    if (!this.seen.has(text)) {
      this.seen.add(text);
      this.items.push(text);
    }
    return true;
  }

  /** A leak that was found by other means (a masked request to a stranger). */
  note(source: string, text: string): void {
    const entry = `${source}: ${this.secrets.mask(text).slice(0, 500)}`;
    if (!this.seen.has(entry)) {
      this.seen.add(entry);
      this.items.push(entry);
    }
  }

  list(): string[] {
    return [...this.items];
  }
}
