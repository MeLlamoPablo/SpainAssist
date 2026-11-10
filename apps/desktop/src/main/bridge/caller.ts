import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The agent whose bridge call is running. A prompt shown during the call (a confirmation, a
 * certificate to use) is that agent's: the meter shows it waits for the user.
 */
const caller = new AsyncLocalStorage<string>();

export function runAsCaller<T>(agentId: string, fn: () => T): T {
  return caller.run(agentId, fn);
}

export function currentCaller(): string | undefined {
  return caller.getStore();
}
