/**
 * The eval host's configuration file: `HostEvalConfig` (contracts.ts) as JSON, at the path in
 * `SA_EVAL_CONFIG`. The run loop writes it (`writeHostEvalConfig`) once per host process and the
 * eval host entry reads it (`loadHostEvalConfig`); the product host never does. Both sides validate
 * it with the same strict schema, so a field the contract gains and the schema does not know is an
 * error instead of a silent drop.
 *
 * Plain Node plus zod: bundled into the eval host. Never print to stdout (the host's RPC channel).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ResearchOutput } from '@sa/shared';
import { z } from 'zod';
import type { HostEvalConfig } from '../contracts';
import { HostTable, isLoopbackHost, sameLoopbackListener } from '../net/hosts';

/** The environment variable that holds the path of the config file. */
export const EVAL_CONFIG_ENV = 'SA_EVAL_CONFIG';

const loopbackOrigin = (what: string) =>
  z.string().refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' && isLoopbackHost(url.hostname);
      } catch {
        return false;
      }
    },
    { message: `must be a plain http loopback origin (${what})` },
  );

const routes = z.array(z.string().min(1)).superRefine((patterns, ctx) => {
  try {
    new HostTable(patterns);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

const origin = z.string().refine(
  (value) => {
    try {
      return ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  },
  { message: 'must be an http(s) or ws(s) origin' },
);

export const HostEvalConfigSchema = z
  .strictObject({
    worldId: z.string().min(1),
    mockOrigin: loopbackOrigin('SpainBench public listener'),
    scoringOrigin: loopbackOrigin('SpainBench scoring listener'),
    routes,
    unmapped: z.discriminatedUnion('mode', [
      z.strictObject({ mode: z.enum(['enotfound', 'econnrefused', 'timeout']) }),
      z.strictObject({ mode: z.literal('status'), status: z.number().int().min(100).max(599) }),
    ]),
    netlog: z.string().min(1),
    llm: z.strictObject({ extraAllowOrigins: z.array(origin) }),
    research: z.strictObject({
      shape: z.enum(['auto', 'key-server', 'chatgpt']),
      // The stub answers the first one. At least one: a run without a recording would make
      // providers differ (no web research for some of them), which the eval must never do silently.
      answers: z
        .array(z.strictObject({ id: z.uuid(), output: ResearchOutput }))
        .min(1, 'at least one recorded research answer is required'),
    }),
    /** An ISO 8601 instant with its offset: the agents' "today". */
    now: z.iso.datetime({ offset: true }),
  })
  .refine(
    (config) => {
      try {
        return !sameLoopbackListener(config.mockOrigin, config.scoringOrigin);
      } catch {
        return true; // not URLs: the fields say so
      }
    },
    {
      message: 'the mock origin is the scoring listener: the agent must never reach it',
      path: ['mockOrigin'],
    },
  );

/** Validates a config (a parsed JSON value). Throws an `Error` that lists every problem. */
export function parseHostEvalConfig(input: unknown): HostEvalConfig {
  const parsed = HostEvalConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid eval host config:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Reads and validates the file `env.SA_EVAL_CONFIG` points to. */
export function loadHostEvalConfig(env: NodeJS.ProcessEnv): HostEvalConfig {
  const file = env[EVAL_CONFIG_ENV];
  if (!file) {
    throw new Error(
      `${EVAL_CONFIG_ENV} is not set: the eval host needs the path of its config file`,
    );
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read the eval host config (${EVAL_CONFIG_ENV}=${file}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The eval host config (${file}) is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseHostEvalConfig(json);
}

/**
 * Validates `config` and writes it to `file` (owner only, replaced atomically; its folder is
 * created). Returns the path, ready for `SA_EVAL_CONFIG`.
 */
export function writeHostEvalConfig(file: string, config: HostEvalConfig): string {
  const valid = parseHostEvalConfig(config);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return file;
}
