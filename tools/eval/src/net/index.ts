/**
 * The network layer of the eval suite (docs/EVAL.md, "Network transparency"): everything the
 * evaluated agents send leaves through here, to SpainBench or to nothing.
 *
 *   hosts.ts          which real hostnames SpainBench serves (HostTable)
 *   netlog.ts         one JSONL record per request (NetLog), and readers for the files
 *   world-fetch.ts    the host process' `fetch` (createWorldFetch) and its tool call context
 *   egress-guard.ts   deny-by-default `fetch` / `WebSocket` for the host process
 *   eval-network.ts   the browser's mapping proxy (EvalNetwork, a CertificateProxy of @sa/browser)
 *   node-guard.ts     the process-level half of the guard: sockets, DNS, UDP, child processes
 *   proxy-env.ts      NO_PROXY for loopback in the harness process (keys never go to a proxy)
 *   canary.ts         exfiltration detection over the records
 *
 * The host process bundle takes hosts, netlog, world-fetch, egress-guard, node-guard and wire only:
 * they import nothing but Node's built-ins.
 */
export * from './canary';
export * from './egress-guard';
export * from './eval-network';
export * from './hosts';
export * from './netlog';
export * from './netlog-reader';
export * from './proxy-env';
export * from './world-fetch';
