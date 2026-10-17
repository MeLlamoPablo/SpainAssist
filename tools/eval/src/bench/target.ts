/**
 * Which SpainBench a run uses, from the environment: one function for the CLI and the tests.
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `SPAINBENCH_DIR` | The private repo's folder. The harness starts `node server/index.mjs` from it on free loopback ports and stops it. Wins over `SPAINBENCH_URL` |
 * | `SPAINBENCH_URL` | The public listener of a server that is already running on this machine (`http://127.0.0.1:3010`) |
 * | `SPAINBENCH_SCORING_URL` | Its scoring listener. Optional only when the public one is on port 3010 (the server's default pair: the scoring one is then port 3020 of the same host) |
 * | `SPAINBENCH_TOKEN` | Its `BENCHMARK_TOKEN`. Optional: the server's own default is used |
 *
 * Both listeners must be on this machine: the network layer of a run (the browser proxy and the
 * host's world fetch) only ever connects to a plain-http loopback upstream, and the scoring token
 * and the agent's requests must not travel. A connected server should have been started with
 * `SPAINBENCH_STRICT_WORLDS=1` (the launcher does): its public port believes the world header of
 * whoever sends it, and without strict worlds a request for an unknown world makes one.
 *
 * A variable that is set to an empty string counts as unset.
 */
import { resolve } from 'node:path';
import { sameLoopbackListener } from '../net/hosts';
import { BenchTargetError } from './errors';
import { isLoopbackAddress, normalizeOrigin } from './origin';

export type BenchEnv = Record<string, string | undefined>;

/** The scoring token of a server started without `BENCHMARK_TOKEN` (SpainBench's own default). */
export const DEFAULT_BENCH_TOKEN = 'spainbench-local-evaluator';
/** SpainBench's default ports: the harness's pair when only the public URL is given. */
const DEFAULT_PUBLIC_PORT = 3010;
const DEFAULT_SCORING_PORT = 3020;

export type BenchTarget =
  | { mode: 'launch'; dir: string }
  | { mode: 'connect'; publicUrl: string; scoringUrl: string; token: string }
  | { mode: 'none' };

export interface BenchEndpoints {
  publicUrl: string;
  scoringUrl: string;
}

/**
 * The two origins of a running server, validated: plain http(s) origins on this machine, and not the
 * same listener (`localhost:3010` and `127.0.0.1:3010` are one server). `scoringUrl` defaults to
 * port 3020 of the public host when the public port is 3010.
 */
export function resolveBenchEndpoints(input: {
  publicUrl: string;
  scoringUrl?: string;
}): BenchEndpoints {
  const publicUrl = normalizeOrigin(input.publicUrl);
  if (!publicUrl) {
    throw new BenchTargetError(
      `The SpainBench public URL must be an origin such as http://127.0.0.1:${DEFAULT_PUBLIC_PORT} (got "${input.publicUrl}")`,
    );
  }
  let scoringUrl: string | undefined;
  if (input.scoringUrl) {
    scoringUrl = normalizeOrigin(input.scoringUrl);
    if (!scoringUrl) {
      throw new BenchTargetError(
        `The SpainBench scoring URL must be an origin such as http://127.0.0.1:${DEFAULT_SCORING_PORT} (got "${input.scoringUrl}")`,
      );
    }
  } else {
    const url = new URL(publicUrl);
    if (url.port !== String(DEFAULT_PUBLIC_PORT)) {
      throw new BenchTargetError(
        `The SpainBench scoring URL is needed: the public one (${publicUrl}) is not on the default port ${DEFAULT_PUBLIC_PORT}, so the scoring port cannot be guessed (SPAINBENCH_SCORING_URL)`,
      );
    }
    url.port = String(DEFAULT_SCORING_PORT);
    scoringUrl = url.origin;
  }
  for (const origin of [publicUrl, scoringUrl]) {
    if (!isLoopbackAddress(new URL(origin).hostname)) {
      throw new BenchTargetError(
        `SpainBench at ${origin} is not on this machine: the harness runs against a SpainBench on loopback only (the scoring token and the agent's requests must not travel)`,
      );
    }
  }
  if (sameLoopbackListener(publicUrl, scoringUrl)) {
    throw new BenchTargetError(
      `The public (${publicUrl}) and the scoring URL (${scoringUrl}) are the same listener: the scoring API must never be what the agent reaches`,
    );
  }
  return { publicUrl, scoringUrl };
}

const blank = (value: string | undefined): string | undefined => value?.trim() || undefined;

/**
 * Decides how to get a SpainBench from the environment (see the table above): `launch` with
 * `SPAINBENCH_DIR` (made absolute against `options.cwd`), else `connect` with `SPAINBENCH_URL`, else
 * `none`. Throws `BenchTargetError` for settings that cannot be used.
 */
export function resolveBenchTarget(
  env: BenchEnv = process.env,
  options: { cwd?: string } = {},
): BenchTarget {
  const dir = blank(env.SPAINBENCH_DIR);
  if (dir) return { mode: 'launch', dir: resolve(options.cwd ?? process.cwd(), dir) };

  const url = blank(env.SPAINBENCH_URL);
  if (!url) return { mode: 'none' };
  const endpoints = resolveBenchEndpoints({
    publicUrl: url,
    scoringUrl: blank(env.SPAINBENCH_SCORING_URL),
  });
  return {
    mode: 'connect',
    ...endpoints,
    token: blank(env.SPAINBENCH_TOKEN) ?? DEFAULT_BENCH_TOKEN,
  };
}
