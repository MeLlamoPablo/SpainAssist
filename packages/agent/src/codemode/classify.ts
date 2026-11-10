import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

/**
 * `api.classify`: one quick model call that picks one of the options. No tools, no
 * history; the lowest reasoning the model allows. The answer must be exactly one option (one
 * retry), so a workflow can switch on it.
 *
 * It exists for deterministic branches on a non-deterministic judgement: each option is a code
 * path of the same workflow. A result the model only reads back in its next turn is wasted (the
 * model could have judged it there). Every call should offer an "unknown" option with a path of
 * its own: without one, an unclear case is forced into a real option, and then none of the
 * answers can be trusted. Both rules are in the API's declaration (`declarations.ts`).
 */
export function createClassifier(runtime: Pick<ModelRuntime, 'streamSimple'>, model: Model<Api>) {
  return async (prompt: string, options: string[], signal: AbortSignal): Promise<string> => {
    const systemPrompt = `You classify. Read the user's message and answer with exactly one of these options and nothing else:\n${options.map((o) => `- ${o}`).join('\n')}`;
    let last = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await runtime
        .streamSimple(
          model,
          {
            systemPrompt,
            messages: [
              {
                role: 'user',
                content:
                  attempt === 0
                    ? prompt
                    : `${prompt}\n\n(Answer with exactly one option: ${options.join(' | ')})`,
                timestamp: Date.now(),
              },
            ],
          },
          { signal, ...(model.reasoning ? { reasoning: 'minimal' as const } : {}) },
        )
        .result();
      if (response.stopReason === 'aborted') signal.throwIfAborted();
      if (response.stopReason === 'error')
        throw new Error(response.errorMessage || 'The classification failed.');
      last = response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim();
      const match = pick(last, options);
      if (match) return match;
    }
    throw new Error(
      `The classifier answered "${last.slice(0, 80)}", which is none of the options.`,
    );
  };
}

/** The option the answer names: exact, then without quotes/punctuation, then the only one it contains. */
export function pick(answer: string, options: string[]): string | undefined {
  const clean = (s: string) => s.toLowerCase().replace(/^[\s"'`*.-]+|[\s"'`*.]+$/g, '');
  const a = clean(answer);
  const exact = options.find((o) => clean(o) === a);
  if (exact) return exact;
  const contained = options.filter((o) => a.includes(clean(o)));
  return contained.length === 1 ? contained[0] : undefined;
}
