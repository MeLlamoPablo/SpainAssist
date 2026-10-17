/**
 * The harness process talks to loopback services with secrets in the request: the model gateway's
 * key to the meter (the answerer, the voucher check), the scoring token to SpainBench. A developer
 * who runs with an environment proxy (`NODE_USE_ENV_PROXY=1` and `HTTP_PROXY`) would see that
 * traffic go to the proxy as `CONNECT 127.0.0.1:<port>`: the run breaks and the proxy's operator
 * reads the key. The agent hosts already get `NO_PROXY` for loopback (run/app/agents.ts); this does
 * the same for the process that starts them, before its first request (Node reads `NO_PROXY` when
 * the first request is made, not when the process starts).
 */

/** What is never sent through a proxy: this machine, in every spelling an URL can carry. */
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/** Adds the loopback names to `NO_PROXY` and `no_proxy` of `env`, keeping what is there. */
export function ensureLoopbackNoProxy(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of ['NO_PROXY', 'no_proxy'] as const) {
    const current = (env[name] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    // `*` already means "nothing goes through a proxy".
    if (current.includes('*')) continue;
    const missing = LOOPBACK.filter((host) => !current.includes(host));
    if (missing.length > 0) env[name] = [...current, ...missing].join(',');
  }
}
