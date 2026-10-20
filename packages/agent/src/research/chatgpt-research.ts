import type { Api, JsonValue, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ResearchMode } from '@sa/shared';
import { Type } from 'typebox';
import { BUNDLED_MODEL_LISTS, type FixedModel } from '../providers/defaults';
import { defineSaTool, errorResult, StringEnum, textResult } from '../tools/common';
import { WEB_RESEARCH_TOOL_NAME } from '../tools/names';

const MAX_WAIT_MS = 30 * 60_000;

/** pi providers that spend a ChatGPT plan when signed in with OAuth (an API key pays per call). */
export const CHATGPT_PLAN_PROVIDERS: readonly string[] = ['openai', 'openai-codex'];

/**
 * Model and reasoning effort of each research mode on a ChatGPT plan, by default the first of
 * each mode's bundled list (the app passes the ones the account's plan offers). Every mode
 * searches with OpenAI's hosted `web_search` tool at high effort; deeper modes use larger models.
 */
export const CHATGPT_RESEARCH_MODELS: Readonly<Record<ResearchMode, FixedModel>> =
  Object.fromEntries(
    ResearchMode.options.map((mode) => [
      mode,
      BUNDLED_MODEL_LISTS.chatgpt.research[mode][0] as FixedModel,
    ]),
  ) as Record<ResearchMode, FixedModel>;

const INSTRUCTIONS = `You research Spanish administrative procedures on the web for an assistant that will carry them out for a user. Search the web as much as the question needs. Prefer official sources (gob.es, boe.es, regional and municipal sites, sede electrónica pages) and say when a fact comes only from an unofficial source. Answer in the language of the question. Report eligibility, national, regional and local variations, requirements, documents, fees, deadlines, official entry points, authentication, signatures, online and in-person steps, exceptions and common blockers, as far as the question asks for them. Cite the official URL of every fact. List gaps and conflicting information instead of guessing.`;

export interface ChatGPTResearchOptions {
  runtime: Pick<ModelRuntime, 'streamSimple'>;
  /** The research model of a mode, configured on the agent's provider. */
  model: (id: string) => Model<Api>;
  language: 'es' | 'en';
  models?: Readonly<Record<ResearchMode, FixedModel>>;
}

type Citation = { url: string; title?: string };

/** A Responses stream event, as far as this tool reads it. */
interface StreamEvent {
  type?: string;
  item?: {
    type?: string;
    action?: { type?: string; query?: string; url?: string };
    content?: { type?: string; annotations?: { type?: string; url?: string; title?: string }[] }[];
  };
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  } catch {
    return undefined;
  }
}

/**
 * Web research on a ChatGPT plan: one Responses request with OpenAI's hosted `web_search` tool,
 * through the agent's own provider (pi's `openai` or `openai-codex`), so it spends the plan's
 * usage and needs no other key. Progress comes from the stream's web search calls; the result
 * carries the answer and its URL citations, in the same shape as the key server's research.
 */
export function createChatGPTResearchTool(options: ChatGPTResearchOptions) {
  const models = options.models ?? CHATGPT_RESEARCH_MODELS;
  return defineSaTool({
    name: WEB_RESEARCH_TOOL_NAME,
    label: options.language === 'es' ? 'Investigación en la web' : 'Web research',
    description:
      "Research a procedure on the web using official sources. This call waits for the final result and streams progress to the app; do not poll or start duplicate research while waiting. Each call uses the user's ChatGPT plan. Include everything known about the user that may matter, anonymized: never names, ID or document numbers, street addresses, phone numbers, emails or exact birth dates.",
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description:
          "What to research, with all the user's possibly relevant context, anonymized (e.g. age instead of date of birth, municipality instead of street address).",
      }),
      mode: StringEnum(ResearchMode.options),
      outputSchema: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'Optional JSON Schema (type "object") for a structured answer.',
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      const timeout = AbortSignal.timeout(MAX_WAIT_MS);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const choice = models[params.mode];
      const citations = new Map<string, Citation>();
      let searches = 0;
      const progress = () =>
        onUpdate?.(
          textResult(options.language === 'es' ? 'Investigando fuentes…' : 'Researching sources…', {
            status: 'running',
            searches,
          }),
        );
      try {
        requestSignal.throwIfAborted();
        const model = options.model(choice.id);
        const schema = params.outputSchema
          ? `\n\nAnswer only with one JSON value that matches this JSON Schema, with the source URLs inside it:\n${JSON.stringify(params.outputSchema)}`
          : '';
        progress();
        const response = await options.runtime
          .streamSimple(
            model,
            {
              systemPrompt: INSTRUCTIONS,
              messages: [
                { role: 'user', content: `${params.query}${schema}`, timestamp: Date.now() },
              ],
            },
            {
              // pi has no "off" option: leaving it out sends no reasoning effort.
              ...(choice.thinkingLevel === 'off' ? {} : { reasoning: choice.thinkingLevel }),
              signal: requestSignal,
              onPayload: (payload: unknown) => {
                const body = payload as Record<string, unknown>;
                const include = Array.isArray(body.include) ? body.include : [];
                return {
                  ...body,
                  tools: [{ type: 'web_search' }],
                  include: [...include, 'web_search_call.action.sources'],
                };
              },
              onProviderStreamEvent: (raw: unknown) => {
                const event = raw as StreamEvent;
                if (event.type !== 'response.output_item.done') return;
                if (event.item?.type === 'web_search_call') {
                  searches++;
                  progress();
                }
                for (const part of event.item?.type === 'message' ? (event.item.content ?? []) : [])
                  for (const note of part.annotations ?? [])
                    if (note.type === 'url_citation' && note.url && !citations.has(note.url))
                      citations.set(note.url, {
                        url: note.url,
                        ...(note.title ? { title: note.title } : {}),
                      });
              },
            },
          )
          .result();
        if (response.stopReason === 'aborted') requestSignal.throwIfAborted();
        if (response.stopReason === 'error') {
          throw new Error(response.errorMessage || 'The research request failed.');
        }
        const text = response.content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('')
          .trim();
        if (!text) throw new Error('The research returned no answer.');
        const json = params.outputSchema ? parseJson(text) : undefined;
        const output = {
          type: json === undefined ? 'text' : 'json',
          content: json ?? text,
          basis: [...citations.values()],
        };
        const result = { success: true, status: 'completed', outputReady: true, output };
        return { ...textResult(JSON.stringify(result)), structuredContent: result };
      } catch (error) {
        // Propagate user cancellation so pi stops the run instead of asking the model to retry.
        if (signal?.aborted) throw error;
        const reason = timeout.aborted
          ? 'Research exceeded the 30-minute waiting limit.'
          : error instanceof Error
            ? error.message
            : 'Research failed.';
        return errorResult(`${reason} Do not automatically start a replacement run.`);
      }
    },
  });
}
