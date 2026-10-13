import type { BridgeTransport } from '../bridge/client';
import { errorResult, isAbortError, type ToolResult } from '../tools/common';

/**
 * Removes personal data from text before it leaves the device. The app does it (bridge
 * `research.scrub`), with the user's vault values as well as patterns (DNI, IBAN, phone…), so
 * the anonymization the research tools ask the model for is enforced, not just requested.
 */
export type ScrubOutgoing = (
  text: string,
  signal?: AbortSignal,
) => Promise<{ text: string; redactions: number }>;

export function bridgeScrub(bridge: BridgeTransport): ScrubOutgoing {
  return (text, signal) => bridge.call('research.scrub', { text }, { signal });
}

/** The query without personal data, or the error to return instead of sending it. */
export async function anonymizeQuery(
  scrub: ScrubOutgoing,
  query: string,
  signal: AbortSignal | undefined,
): Promise<{ query: string } | { error: ToolResult }> {
  try {
    return { query: (await scrub(query, signal)).text };
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    return {
      error: errorResult(
        'Web research is blocked: the app could not remove personal data from the query, so nothing was sent. Try again once; if it fails again, report it as a research blocker.',
      ),
    };
  }
}
