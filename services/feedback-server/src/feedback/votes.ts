/**
 * Votes decide how often a learning is served. Net weight 0 serves it half of the time; the
 * chance grows linearly to 100% at +threshold and drops to 0% at -threshold. An agent vote
 * weighs 1 and a human vote weighs `threshold`. Votes lose value linearly between
 * `decayStartDays` and `decayEndDays` after they were cast, so old votes stop vouching for
 * advice that may have gone stale (e.g. after an official website redesign).
 */
export interface VotePolicy {
  threshold: number;
  decayStartDays: number;
  decayEndDays: number;
}

export const DEFAULT_VOTE_POLICY: VotePolicy = {
  threshold: 5,
  decayStartDays: 90,
  decayEndDays: 365,
};

export type Voter = 'agent' | 'human';

export interface CastVote {
  value: 1 | -1;
  voter: Voter;
  createdAt: Date;
}

const DAY_MS = 86_400_000;

/** Share of a vote's value left after `ageDays`: 1 until the decay starts, 0 once it ends. */
export function decayFactor(ageDays: number, policy: VotePolicy): number {
  if (ageDays <= policy.decayStartDays) return 1;
  if (ageDays >= policy.decayEndDays) return 0;
  return (policy.decayEndDays - ageDays) / (policy.decayEndDays - policy.decayStartDays);
}

/** Net weight of an entry's votes at `now` (ms). */
export function voteWeight(votes: CastVote[], now: number, policy: VotePolicy): number {
  let total = 0;
  for (const v of votes) {
    const weight = v.voter === 'human' ? policy.threshold : 1;
    total += v.value * weight * decayFactor((now - v.createdAt.getTime()) / DAY_MS, policy);
  }
  return total;
}

/** Probability of serving an entry with this net weight. */
export function serveChance(weight: number, policy: VotePolicy): number {
  return Math.min(1, Math.max(0, 0.5 + weight / (2 * policy.threshold)));
}
