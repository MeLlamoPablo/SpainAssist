import { randomUUID } from 'node:crypto';
import { ApiError, ResearchEvent, ResearchMode } from '@sa/shared';
import { Type } from 'typebox';
import { defineSaTool, errorResult, StringEnum, textResult } from '../tools/common';
import { WEB_RESEARCH_TOOL_NAME } from '../tools/names';
import { anonymizeQuery, type ScrubOutgoing } from './scrub';
import { events } from './sse';

const MAX_WAIT_MS = 30 * 60_000;
/** Reconnections to a run's event stream after the connection drops. */
const MAX_RECONNECTS = 3;

export interface KeyServerResearchOptions {
  /** Base URL of our key server (POST {keyServerUrl}/v1/research). */
  keyServerUrl: string;
  /** The voucher key, read when the tool runs (it may rotate); undefined = no voucher. */
  apiKey: () => Promise<string | undefined>;
  language: 'es' | 'en';
  /** Removes personal data from the query before it is sent. */
  scrub: ScrubOutgoing;
  fetch?: typeof fetch;
}

const NO_RETRY = 'Do not automatically start a replacement run.';

function httpErrorText(status: number, code: string | undefined): string {
  if (status === 402 || code === 'insufficient_budget') {
    return 'Web research is blocked: the voucher has no credit left. Report this research blocker; do not retry.';
  }
  if (status === 401 || status === 403) {
    return 'Web research is blocked: the voucher key was not accepted. Report this research blocker; do not retry.';
  }
  if (status === 429) {
    return 'Too many research runs are in progress for this voucher. Wait for them to finish; do not start duplicates.';
  }
  if (status === 503 || code === 'research_unavailable') {
    return 'Web research is not available on the server right now. Report this research blocker.';
  }
  return `Research request failed (HTTP ${status}).`;
}

/**
 * Web research for voucher users: our key server runs it on Parallel's Task API with the
 * processor of the chosen mode and charges the voucher. One model-issued call, one streaming request (plus
 * reconnections to the same run if the connection drops), no polling turns.
 */
export function createKeyServerResearchTool(options: KeyServerResearchOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.keyServerUrl.replace(/\/+$/, '');
  return defineSaTool({
    name: WEB_RESEARCH_TOOL_NAME,
    label: options.language === 'es' ? 'Investigación en la web' : 'Web research',
    description:
      'Research a procedure on the web using official sources. This call waits for the final result and streams progress to the app; do not poll or start duplicate research while waiting. Each call costs the user credit. Include everything known about the user that may matter, anonymized: never names, ID or document numbers, street addresses, phone numbers, emails or exact birth dates. The app also removes the personal data it recognizes before sending.',
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
      let runId: string | undefined;
      try {
        requestSignal.throwIfAborted();
        const apiKey = await options.apiKey();
        if (!apiKey) {
          return errorResult(
            'Web research is blocked: no voucher key is available. Report this research blocker.',
          );
        }
        const anonymized = await anonymizeQuery(options.scrub, params.query, requestSignal);
        if ('error' in anonymized) return anonymized.error;
        const headers = {
          authorization: `Bearer ${apiKey}`,
          accept: 'text/event-stream',
        };
        let response = await doFetch(`${base}/v1/research`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            input: anonymized.query,
            mode: params.mode,
            ...(params.outputSchema ? { outputSchema: params.outputSchema } : {}),
            requestId: randomUUID(),
          }),
          signal: requestSignal,
          redirect: 'error',
        });
        if (!response.ok) {
          const body = ApiError.safeParse(await response.json().catch(() => null));
          return errorResult(
            httpErrorText(response.status, body.success ? body.data.error.code : undefined),
          );
        }

        for (let reconnects = 0; ; reconnects++) {
          if (
            !response.body ||
            !response.headers.get('content-type')?.includes('text/event-stream')
          ) {
            await response.body?.cancel();
            throw new Error('The research server did not return a research event stream.');
          }
          try {
            for await (const frame of events(response.body)) {
              const parsed = ResearchEvent.safeParse(JSON.parse(frame.data));
              if (!parsed.success) continue; // unknown event types are safe to ignore
              const event = parsed.data;
              if (runId && event.id !== runId) {
                throw new Error('The research server changed the research run ID.');
              }
              runId = event.id;
              if (event.type === 'completed') {
                const result = {
                  success: true,
                  id: event.id,
                  status: 'completed',
                  outputReady: true,
                  output: event.output,
                };
                return { ...textResult(JSON.stringify(result)), structuredContent: result };
              }
              if (event.type === 'failed') {
                return errorResult(
                  JSON.stringify({
                    success: false,
                    id: event.id,
                    status: event.code,
                    message: event.message,
                    outputReady: false,
                    ...(event.code === 'failed' ? {} : { note: NO_RETRY }),
                  }),
                );
              }
              onUpdate?.(
                textResult(
                  options.language === 'es' ? 'Investigando fuentes…' : 'Researching sources…',
                  { runId, status: event.type === 'progress' ? event.status : 'queued' },
                ),
              );
            }
          } catch (error) {
            if (requestSignal.aborted || !runId || reconnects >= MAX_RECONNECTS) throw error;
          }
          // The stream ended without a result: follow the same run again (no new charge).
          if (!runId || reconnects >= MAX_RECONNECTS) {
            throw new Error('Research stream ended before a final result arrived.');
          }
          response = await doFetch(`${base}/v1/research/${encodeURIComponent(runId)}/events`, {
            headers,
            signal: requestSignal,
            redirect: 'error',
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Could not reconnect to the research (HTTP ${response.status}).`);
          }
        }
      } catch (error) {
        // Propagate user cancellation so pi stops the run instead of asking the model to retry.
        if (signal?.aborted) throw error;
        const reason = timeout.aborted
          ? 'Research exceeded the 30-minute waiting limit.'
          : error instanceof Error
            ? error.message
            : 'Research failed.';
        return errorResult(
          `${reason}${runId ? ` Run ID: ${runId}.` : ''} Upstream state may be unknown; ${NO_RETRY.toLowerCase()}`,
        );
      }
    },
  });
}
