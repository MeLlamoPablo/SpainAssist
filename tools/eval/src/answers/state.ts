import type { PromptResponse } from '@sa/shared';
import type {
  Answer,
  AnswerAction,
  AnswerGroup,
  CheckpointManifest,
  Fixture,
  PendingPrompt,
} from '../contracts';
import { describePrompt, matchesPrompt } from './matcher';

/** What a checkpoint stores of the answer script (`CheckpointManifest.answerState`). */
export type AnswerStateSnapshot = CheckpointManifest['answerState'];

/** Fixture policy for prompts that no unlocked answer matches. */
export type UnexpectedPromptPolicy = Fixture['unexpectedPrompt'];

/** What to do with one pending prompt. */
export type PromptDecision =
  /** A scripted answer matched and is now used. Apply `answer.action`. */
  | { type: 'answer'; answer: Answer; by: 'structured' | 'answerer' }
  /** Unmatched form: the answerer model improvises with the persona and these instructions. */
  | { type: 'improvise'; instructions: string; by: 'answerer' }
  /** Unmatched prompt: send this response as is. */
  | { type: 'default'; response: PromptResponse; reason: string; by: 'default' }
  /** Unmatched prompt under the `fail` policy: end the run (`endedBy: 'unexpected-prompt'`). */
  | { type: 'fail'; reason: string };

/** Instructions of the answerer when no scripted answer covers a form. */
export const DEFAULT_IMPROVISE_INSTRUCTIONS =
  'Answer as this person would: briefly, in Spanish and only with the facts you have. ' +
  'Leave out what you do not know. Never invent data.';

/**
 * The state machine of the answer groups.
 *
 * - Answers of a group are used in any order and each only once, unless it is `repeatable`.
 * - Group `k` unlocks when every non-optional answer of groups before it has been used (group 0
 *   always is unlocked), so an optional answer may be skipped and the next group still opens.
 * - An unused optional answer stays answerable until the conversation moves on, that is until an
 *   answer of a later group has been used. Without that, a script such as "group 1: optional
 *   methods question, group 2: credential request" could never answer the methods question,
 *   because group 2 is already unlocked at the start.
 */
export class AnswerState {
  private readonly used = new Set<string>();
  private readonly groupOf = new Map<string, number>();

  constructor(
    private readonly groups: readonly AnswerGroup[],
    snapshot?: AnswerStateSnapshot,
  ) {
    groups.forEach((group, index) => {
      for (const answer of group.answers) {
        if (this.groupOf.has(answer.id)) throw new Error(`Duplicate answer id "${answer.id}"`);
        this.groupOf.set(answer.id, index);
      }
    });
    if (snapshot) this.restore(snapshot);
  }

  /** Index of the latest unlocked group. */
  get unlockedGroup(): number {
    let unlocked = 0;
    for (let g = 0; g < this.groups.length - 1; g++) {
      const done = this.groups[g]!.answers.every((a) => a.optional || this.used.has(a.id));
      if (!done) break;
      unlocked = g + 1;
    }
    return unlocked;
  }

  isUsed(answerId: string): boolean {
    return this.used.has(answerId);
  }

  /** The answers a prompt may be answered with now, in group and declaration order. */
  answerable(): Answer[] {
    const unlocked = this.unlockedGroup;
    const moved = this.latestUsedGroup();
    const out: Answer[] = [];
    for (let g = 0; g <= unlocked && g < this.groups.length; g++) {
      for (const answer of this.groups[g]!.answers) {
        if (this.used.has(answer.id) && !answer.repeatable) continue;
        if (answer.optional && g < moved) continue;
        out.push(answer);
      }
    }
    return out;
  }

  /** The first answerable answer that matches the prompt (does not use it). */
  select(prompt: PendingPrompt): Answer | undefined {
    return this.answerable().find((answer) => matchesPrompt(answer.match, prompt));
  }

  /** Selects the answer for the prompt and marks it used, in one step. */
  claim(prompt: PendingPrompt): Answer | undefined {
    const answer = this.select(prompt);
    if (answer) this.used.add(answer.id);
    return answer;
  }

  /**
   * Decides how to answer a prompt: a scripted answer (which is then used) or, when none matches,
   * what the fixture's `unexpectedPrompt` policy says.
   */
  decide(prompt: PendingPrompt, policy: UnexpectedPromptPolicy): PromptDecision {
    const answer = this.claim(prompt);
    if (answer) return { type: 'answer', answer, by: answerSource(answer.action) };
    return decideUnmatched(prompt, policy);
  }

  /** Ids of the non-optional answers that were never used: the script did not complete. */
  unusedRequired(): string[] {
    return this.groups.flatMap((group) =>
      group.answers.filter((a) => !a.optional && !this.used.has(a.id)).map((a) => a.id),
    );
  }

  snapshot(): AnswerStateSnapshot {
    return { unlockedGroup: this.unlockedGroup, used: [...this.used] };
  }

  private latestUsedGroup(): number {
    let latest = -1;
    for (const id of this.used) latest = Math.max(latest, this.groupOf.get(id) ?? -1);
    return latest;
  }

  private restore(snapshot: AnswerStateSnapshot): void {
    for (const id of snapshot.used) {
      if (!this.groupOf.has(id)) throw new Error(`Answer state mentions unknown answer "${id}"`);
      this.used.add(id);
    }
    if (
      this.latestUsedGroup() > this.unlockedGroup ||
      snapshot.unlockedGroup !== this.unlockedGroup
    ) {
      throw new Error('Answer state is inconsistent with the answer groups');
    }
  }
}

/** Who answers: structured actions are programmatic, `freeform` goes to the answerer model. */
export function answerSource(action: AnswerAction): 'structured' | 'answerer' {
  return action.type === 'freeform' ? 'answerer' : 'structured';
}

/** The decision for a prompt that no scripted answer matches. */
export function decideUnmatched(
  prompt: PendingPrompt,
  policy: UnexpectedPromptPolicy,
): PromptDecision {
  if (policy === 'fail') {
    return { type: 'fail', reason: `unexpected prompt: ${describePrompt(prompt)}` };
  }
  if (policy === 'answerer' && prompt.kind === 'form') {
    return { type: 'improvise', instructions: DEFAULT_IMPROVISE_INSTRUCTIONS, by: 'answerer' };
  }
  return {
    type: 'default',
    response: defaultResponse(prompt, policy === 'answerer'),
    reason: `unmatched ${describePrompt(prompt)} under policy "${policy}"`,
    by: 'default',
  };
}

/**
 * The response that declines a prompt: the form is dismissed, the credential is "none", the
 * phone call skipped, the user action not done. A confirmation is approved or declined.
 */
export function defaultResponse(prompt: PendingPrompt, approveConfirm: boolean): PromptResponse {
  switch (prompt.kind) {
    case 'form':
      return { kind: 'form', dismissed: true, savedToVault: [] };
    case 'confirm':
      return { kind: 'confirm', approved: approveConfirm };
    case 'user_action':
      return { kind: 'user_action', done: false, note: 'No puedo hacer eso.' };
    case 'credential':
      return { kind: 'credential' };
    case 'phone_call':
      return { kind: 'phone_call', outcome: 'skipped' };
  }
}

/** The action with secrets masked, safe to log. */
export function redactAction(action: AnswerAction): AnswerAction {
  if (action.type === 'credential') return { ...action, password: '••••' };
  return action;
}
