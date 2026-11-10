import { CodemodeSlug } from '@sa/shared';
import { Type } from 'typebox';
import {
  type AnyToolDefinition,
  defineSaTool,
  errorResult,
  type ToolResult,
} from '../tools/common';
import type { EngineOutcome, WorkflowEngine } from './engine';
import type { ImageStore } from './host-ops';

/** The model-facing name of the only tool of codemode agents. */
const CODEMODE_TOOL_NAME = 'codemode';

const MAX_RESULT_CHARS = 30_000;

export interface CodemodeToolOptions {
  engine: WorkflowEngine;
  images: ImageStore;
  imagesSupported: boolean;
  language: 'es' | 'en';
}

/**
 * `codemode`: runs a workflow module. Its description is short; the API's declaration and the
 * rules are in the system prompt.
 */
export function codemodeTool(options: CodemodeToolOptions): AnyToolDefinition {
  return defineSaTool({
    name: CODEMODE_TOOL_NAME,
    label: options.language === 'es' ? 'Flujo de trabajo' : 'Workflow',
    description:
      'Run a workflow: a JavaScript module exporting `async function main(api)` (see the Api declaration in the system prompt). The same workflow id resumes it: memoized steps and closed interfaces are reused, so fix and re-run instead of starting over. Returns what main returns, or that the workflow waits for the user (its result then comes to you as a message).',
    parameters: Type.Object({
      workflow: Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: '^[a-z0-9][a-z0-9-]*$',
        description: 'Stable id, descriptive: "renovar-dni-cita". Same id = resume.',
      }),
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
      const id = CodemodeSlug.safeParse(params.workflow);
      if (!id.success)
        return errorResult('workflow must be lower-case letters, digits and dashes.');
      let outcome: EngineOutcome;
      try {
        outcome = await options.engine.start(
          {
            workflowId: id.data,
            source: params.source,
            ...(params.procedures?.length ? { procedures: params.procedures } : {}),
            ...(params.title ? { title: params.title } : {}),
          },
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        return errorResult(
          `The workflow could not start: ${error instanceof Error ? error.message : String(error)}`,
          {
            workflowId: id.data,
            status: 'failed',
          },
        );
      }
      return renderOutcome(outcome, options);
    },
  });
}

function clip(text: string, max = MAX_RESULT_CHARS): string {
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
  options: Pick<CodemodeToolOptions, 'images' | 'imagesSupported'>,
): ToolResult {
  const head = `Workflow "${outcome.workflowId}"`;
  const resumed = outcome.resumed
    ? ` (resumed: ${outcome.memoReused} memoized value${outcome.memoReused === 1 ? '' : 's'} reused)`
    : '';
  const details = { workflowId: outcome.workflowId, status: outcome.status };
  if (outcome.status === 'detached') {
    const text = outcome.openUi.length
      ? `${head}${resumed} is waiting for the user (interface${outcome.openUi.length > 1 ? 's' : ''}: ${outcome.openUi.join(', ')}). It keeps running on its own; its result reaches you as a message when it ends. Don't wait or poll: end your turn now (or do other work).`
      : `${head}${resumed} is still running. It continues on its own; its result reaches you as a message when it ends. Don't start it again.`;
    return { content: [{ type: 'text', text }], details };
  }
  const run = outcome.outcome;
  if (!run) return errorResult(`${head} ended without an outcome.`, details);
  const parts: string[] = [];
  if (run.status === 'succeeded') {
    parts.push(`${head} succeeded${resumed}.`);
    parts.push(
      run.value === undefined ? 'main returned nothing.' : `Result:\n${pretty(run.value)}`,
    );
  } else if (run.status === 'failed') {
    parts.push(`${head} failed${resumed}:\n${run.error}`);
    parts.push(
      'Fix the module and run it again with the same workflow id: memoized steps and closed interfaces are kept, so it continues where it stopped.',
    );
  } else {
    parts.push(`${head} was cancelled: ${run.reason}`);
  }
  if (run.logs.length) parts.push(`Logs:\n${run.logs.join('\n')}`);
  const content: ToolResult['content'] = [{ type: 'text', text: clip(parts.join('\n\n')) }];
  if (options.imagesSupported)
    for (const id of run.images.slice(0, 4)) {
      const image = options.images.get(id);
      if (image) content.push({ type: 'image', data: image.dataBase64, mimeType: image.mimeType });
    }
  return { content, details, ...(run.status === 'failed' ? { isError: true } : {}) };
}
