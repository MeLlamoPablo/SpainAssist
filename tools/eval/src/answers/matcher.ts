import type { AnswerMatcher, PendingPrompt } from '../contracts';
import { compilePattern, shorten, testPattern } from './text';

/** The text an `AnswerMatcher.text` regex is tested against: title and message. */
export function promptText(prompt: Pick<PendingPrompt, 'title' | 'message'>): string {
  return prompt.message ? `${prompt.title}\n${prompt.message}` : prompt.title;
}

/** `agent kind "title"`, for notes and details. */
export function describePrompt(prompt: PendingPrompt): string {
  return `${prompt.agent} ${prompt.kind} "${shorten(prompt.title, 80)}"`;
}

/**
 * Whether a pending prompt satisfies the matcher. Every field the matcher sets must hold; an
 * empty matcher matches every prompt. Regexes are case-insensitive and are tried with and without
 * accents. Throws on an invalid regex (see {@link validateMatcher}).
 */
export function matchesPrompt(matcher: AnswerMatcher, prompt: PendingPrompt): boolean {
  if (matcher.agent !== undefined && matcher.agent !== prompt.agent) return false;
  if (matcher.kind !== undefined && matcher.kind !== prompt.kind) return false;
  if (matcher.credentialKind !== undefined && matcher.credentialKind !== prompt.credentialKind) {
    return false;
  }
  if (matcher.text !== undefined) {
    if (!testPattern(compilePattern(matcher.text, 'matcher.text'), promptText(prompt))) {
      return false;
    }
  }
  if (matcher.fieldKeys !== undefined && matcher.fieldKeys.length > 0) {
    const keys = new Set((prompt.fields ?? []).map((field) => field.key));
    if (!matcher.fieldKeys.every((key) => keys.has(key))) return false;
  }
  if (matcher.optionLabel !== undefined) {
    const pattern = compilePattern(matcher.optionLabel, 'matcher.optionLabel');
    const some = (prompt.fields ?? []).some((field) =>
      (field.options ?? []).some((option) => testPattern(pattern, option.label)),
    );
    if (!some) return false;
  }
  return true;
}

/** Problems of a matcher that would make it fail at match time. Empty when it is fine. */
export function validateMatcher(matcher: AnswerMatcher, where: string): string[] {
  const issues: string[] = [];
  for (const field of ['text', 'optionLabel'] as const) {
    const source = matcher[field];
    if (source === undefined) continue;
    try {
      compilePattern(source, `${where}.${field}`);
    } catch (error) {
      issues.push((error as Error).message);
    }
  }
  return issues;
}

/** Whether the matcher restricts anything at all. */
export function isEmptyMatcher(matcher: AnswerMatcher): boolean {
  return (
    matcher.agent === undefined &&
    matcher.kind === undefined &&
    matcher.text === undefined &&
    (matcher.fieldKeys === undefined || matcher.fieldKeys.length === 0) &&
    matcher.optionLabel === undefined &&
    matcher.credentialKind === undefined
  );
}
