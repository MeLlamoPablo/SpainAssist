import type { ResearchOutput } from '@sa/shared';
import { z } from 'zod';
import { type FetchLike, ProviderError } from '../providers/key-provisioner';

/**
 * Parallel Task API (https://docs.parallel.ai, "Task API"): `POST /v1/tasks/runs` creates a run,
 * `GET /v1/tasks/runs/{id}/result?timeout=` blocks until it completes (408 while still active,
 * 404 when it failed or does not exist), `GET /v1/tasks/runs/{id}` reads its status. There is no
 * cancel endpoint for task runs. Parallel bills only completed runs.
 *
 * Error messages never include response bodies: Parallel may echo the research input.
 */

export const PARALLEL_API_URL = 'https://api.parallel.ai';

/** Parallel's processors and their price per completed run in USD (pricing page, 2026-10). */
export const PARALLEL_PROCESSOR_PRICES: Readonly<Record<string, number>> = {
  lite: 0.005,
  base: 0.01,
  core: 0.025,
  core2x: 0.05,
  pro: 0.1,
  ultra: 0.3,
  ultra2x: 0.6,
  ultra4x: 1.2,
  ultra8x: 2.4,
};

export interface CreateRunInput {
  input: string;
  /** Text description, JSON Schema object, or undefined (auto). */
  outputSchema?: string | Record<string, unknown>;
  processor: string;
  /** Non-secret, non-content labels (our run id). */
  metadata: Record<string, string>;
}

export type RunPoll =
  | { kind: 'completed'; output: ResearchOutput }
  | { kind: 'pending'; status: 'queued' | 'running' }
  | { kind: 'failed' };

/** What the key server needs from a research provider (Parallel, or a fake in tests). */
export interface ResearchUpstream {
  /** Creates a run; returns its id. `ResearchRejected` for a 4xx (the input or schema). */
  create(input: CreateRunInput): Promise<string>;
  /** Waits up to `timeoutSeconds` for the result. Throws `ProviderError` on transient errors. */
  poll(runId: string, timeoutSeconds: number): Promise<RunPoll>;
}

/** Parallel refused the request itself (4xx other than auth/rate limits). Not retried. */
export class ResearchRejected extends Error {
  constructor(readonly status: number) {
    super(`Parallel rejected the research request (${status})`);
    this.name = 'ResearchRejected';
  }
}

const RunCreated = z.object({ run_id: z.string().min(1) });
const RunStatus = z.object({
  run_id: z.string(),
  status: z.string(),
  is_active: z.boolean().nullish(),
});
const RunResult = z.object({
  run: RunStatus,
  output: z.object({
    type: z.enum(['text', 'json']),
    content: z.json(),
    basis: z.array(z.json()).nullish(),
  }),
});

export interface ParallelOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Timeout of the create and status calls (the result call adds its own wait). */
  timeoutMs?: number;
}

export class ParallelTaskApi implements ResearchUpstream {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: ParallelOptions) {
    this.baseUrl = (options.baseUrl ?? PARALLEL_API_URL).replace(/\/+$/, '');
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async call(
    path: string,
    action: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs, ...rest } = init;
    try {
      return await this.fetch(`${this.baseUrl}${path}`, {
        ...rest,
        headers: {
          'x-api-key': this.options.apiKey,
          ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw new ProviderError(`Parallel unreachable during ${action} (${(err as Error).name})`);
    }
  }

  async create(input: CreateRunInput): Promise<string> {
    const body: Record<string, unknown> = {
      input: input.input,
      processor: input.processor,
      metadata: input.metadata,
    };
    if (typeof input.outputSchema === 'string') {
      body.task_spec = { output_schema: { type: 'text', description: input.outputSchema } };
    } else if (input.outputSchema) {
      body.task_spec = { output_schema: { type: 'json', json_schema: input.outputSchema } };
    }
    const res = await this.call('/v1/tasks/runs', 'run creation', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status >= 400 && res.status < 500 && ![401, 403, 408, 429].includes(res.status)) {
        throw new ResearchRejected(res.status);
      }
      throw new ProviderError(`Parallel run creation failed (${res.status})`);
    }
    const parsed = RunCreated.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ProviderError('Parallel returned an unexpected run');
    return parsed.data.run_id;
  }

  async poll(runId: string, timeoutSeconds: number): Promise<RunPoll> {
    const id = encodeURIComponent(runId);
    const res = await this.call(
      `/v1/tasks/runs/${id}/result?timeout=${Math.max(0, Math.round(timeoutSeconds))}`,
      'result',
      { timeoutMs: timeoutSeconds * 1000 + this.timeoutMs },
    );
    if (res.status === 200) {
      const parsed = RunResult.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new ProviderError('Parallel returned an unexpected result');
      const { type, content, basis } = parsed.data.output;
      return { kind: 'completed', output: { type, content, basis: basis ?? [] } };
    }
    await res.body?.cancel().catch(() => {});
    if (res.status === 408) return { kind: 'pending', status: 'running' };
    if (res.status !== 404) throw new ProviderError(`Parallel result failed (${res.status})`);

    // 404: "Run failed or run id not found". Tell them apart.
    const statusRes = await this.call(`/v1/tasks/runs/${id}`, 'status');
    if (statusRes.status === 404) {
      await statusRes.body?.cancel().catch(() => {});
      return { kind: 'failed' };
    }
    if (!statusRes.ok) {
      await statusRes.body?.cancel().catch(() => {});
      throw new ProviderError(`Parallel status failed (${statusRes.status})`);
    }
    const parsed = RunStatus.safeParse(await statusRes.json().catch(() => null));
    if (!parsed.success) throw new ProviderError('Parallel returned an unexpected status');
    const { status } = parsed.data;
    if (status === 'queued') return { kind: 'pending', status: 'queued' };
    if (status === 'running' || status === 'cancelling')
      return { kind: 'pending', status: 'running' };
    // completed between the two calls: the next poll returns the result.
    if (status === 'completed') return { kind: 'pending', status: 'running' };
    // failed, cancelled, action_required (cannot happen without MCP servers) or anything new.
    return { kind: 'failed' };
  }
}
