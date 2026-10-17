import { SecretRegistry } from '../llm/redact';

/**
 * The secrets of one run (passwords of the fixture's credential answers and seeds, the model
 * credential) and the mask that keeps them out of every file the run writes: `events.jsonl`,
 * `run.json`, `result.json`, `report.md`, the notes, the bench files and the answerer's transcripts.
 * It is the shared masker of `llm/redact.ts`: every spelling a secret can have there (JSON-escaped,
 * percent- and form-encoded, HTML-escaped, base64, hex) is masked, values shorter than its minimum
 * are not registered (see there for why), and tokens, API keys and JWTs are masked by pattern too.
 */
export class RunSecrets {
  private readonly registry = new SecretRegistry();

  add(value: string | undefined | null): void {
    this.registry.add(value);
  }

  addAll(values: Iterable<string | undefined | null>): void {
    for (const value of values) this.add(value);
  }

  /** The registered values (raw form), for components that take a list (the answerer). */
  list(): string[] {
    return this.registry.list();
  }

  /** Masks registered secrets, bearer tokens, API keys and JWTs in any text. */
  scrub = (text: string): string => this.registry.redact(text);

  /** Whether the text still carries a registered secret (used by tests and sanity checks). */
  leaks(text: string): boolean {
    return this.registry.has(text);
  }
}
