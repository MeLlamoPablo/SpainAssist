import { Type } from 'typebox';
import {
  type AnyToolDefinition,
  defineSaTool,
  errorResult,
  type ToolResult,
} from '../tools/common';
import { type EngineOutcome, RESULT_CHARS, type RunEngine, unreturnedSearches } from './engine';
import type { ImageStore } from './host-ops';
import type { OutputImage } from './run';

/** The model-facing name of the only tool of codemode agents. */
const CODEMODE_TOOL_NAME = 'codemode';

export interface CodemodeToolOptions {
  engine: RunEngine;
  images: ImageStore;
  imagesSupported: boolean;
  language: 'es' | 'en';
}

/**
 * `codemode`: runs a module. Its description is short; the API's declaration and the rules are
 * in the system prompt.
 */
export function codemodeTool(options: CodemodeToolOptions): AnyToolDefinition {
  return defineSaTool({
    name: CODEMODE_TOOL_NAME,
    label: options.language === 'es' ? 'Ejecutar código' : 'Run code',
    description:
      'Runs a JavaScript module exporting `async function main(api)` (see the Api declaration in the system prompt). Returns what main returns, or that the run waits for the user (its result then comes to you as a message).',
    parameters: Type.Object({
      title: Type.Optional(
        Type.String({
          maxLength: 120,
          description: 'What it does for the user, in their language, a few words.',
        }),
      ),
      procedures: Type.Optional(
        Type.Array(Type.String({ maxLength: 64 }), {
          maxItems: 20,
          description: 'Ids of existing procedures it serves (primary first).',
        }),
      ),
      source: Type.String({ minLength: 1, maxLength: 200_000, description: 'The module source.' }),
    }),
    async execute(_id, params, signal) {
      let outcome: EngineOutcome;
      try {
        outcome = await options.engine.start(
          {
            source: params.source,
            ...(params.procedures?.length ? { procedures: params.procedures } : {}),
            ...(params.title ? { title: params.title } : {}),
          },
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        return errorResult(
          `The run could not start: ${error instanceof Error ? error.message : String(error)}`,
          { status: 'failed' },
        );
      }
      return renderOutcome(outcome, options);
    },
  });
}

function clip(text: string, max = RESULT_CHARS): string {
  return text.length > max
    ? `${text.slice(0, max)}\n… cut at ${max} characters: return less.`
    : text;
}

function pretty(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

function renderOutcome(
  outcome: EngineOutcome,
  options: Pick<CodemodeToolOptions, 'engine' | 'images' | 'imagesSupported'>,
): ToolResult {
  const details = { runId: outcome.runId, status: outcome.status };
  if (outcome.status === 'detached') {
    // The run's id: the message with its result names it, and api.runs.cancel takes it.
    const text = outcome.openUi.length
      ? `Run ${outcome.runId} is waiting for the user (interface${outcome.openUi.length > 1 ? 's' : ''}: ${outcome.openUi.join(', ')}). It keeps running on its own; its result reaches you as a message when it ends. Don't wait or poll: end your turn now (or do other work).`
      : `Run ${outcome.runId} is still running. It continues on its own; its result reaches you as a message when it ends.`;
    return { content: [{ type: 'text', text }], details };
  }
  const run = outcome.outcome;
  if (!run) return errorResult('The run ended without an outcome.', details);
  const parts: string[] = [];
  if (run.status === 'succeeded') {
    parts.push('Run succeeded.');
    parts.push(
      run.value === undefined ? 'main returned nothing.' : `Result:\n${pretty(run.value)}`,
    );
  } else if (run.status === 'failed') {
    parts.push(`Run failed:\n${run.error}`);
    parts.push(
      'Fix the module and run it again: memoized steps and closed interfaces are kept, so it continues where it stopped.',
    );
  } else {
    parts.push(`Run cancelled: ${run.reason}`);
  }
  if (run.logs.length) parts.push(`Logs:\n${run.logs.join('\n')}`);
  let text = clip(parts.join('\n\n'));
  // The model reads every search of the run: what main returned, or else here.
  if (outcome.searches.length) {
    const searches = unreturnedSearches(outcome.searches, text);
    if (searches) text = `${text}\n\n${searches}`;
    options.engine.markResearched();
  }
  const content: ToolResult['content'] = [{ type: 'text', text }];
  if (options.imagesSupported) content.push(...imageContent(run.images, options.images));
  return { content, details, ...(run.status === 'failed' ? { isError: true } : {}) };
}

/** Images one result shows at most. */
const MAX_IMAGES = 4;

/**
 * The images main showed, each after a caption (its label, and what it shows): they come in
 * the order output.image ran, which for parallel callbacks is the order they finished. What
 * doesn't fit is named, never dropped silently.
 */
function imageContent(shown: OutputImage[], store: ImageStore): ToolResult['content'] {
  const content: ToolResult['content'] = [];
  const left: string[] = [];
  shown.forEach((entry, i) => {
    const image = store.get(entry.imageId);
    const caption = [entry.label, image?.source].filter(Boolean).join(' — ');
    const name = `Image ${i + 1}${caption ? `: ${caption}` : ''}`;
    if (!image) left.push(`${name} (no longer kept: show it again from a new read)`);
    else if (content.length / 2 >= MAX_IMAGES) left.push(name);
    else
      content.push(
        { type: 'text', text: name },
        { type: 'image', data: image.dataBase64, mimeType: image.mimeType },
      );
  });
  if (left.length)
    content.push({
      type: 'text',
      text: `Not shown (at most ${MAX_IMAGES} images per run; show the rest in another run):\n${left.join('\n')}`,
    });
  return content;
}
