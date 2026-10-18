-- Retention: a vote is deleted once it stops counting (privacy policy: vote user ids are deleted
-- then). The server calls purge_expired_votes on start-up and every hour with
-- `cutoff = now - VOTE_DECAY_END_DAYS` (src/feedback/retention.ts): the cutoff comes from the
-- app's config, not a constant here, so the database never deletes a vote the app still counts.
-- A vote cast at the cutoff or before is worth 0 (decayFactor in src/feedback/votes.ts), so the
-- whole row goes: an agent vote with its user id, and a maintainer's vote alike. Decay and
-- retention both run from created_at, which a replaced vote resets.
CREATE INDEX IF NOT EXISTS feedback_votes_created_idx ON feedback_votes (created_at);

CREATE OR REPLACE FUNCTION purge_expired_votes(cutoff timestamptz) RETURNS bigint
LANGUAGE sql STRICT AS $$
  WITH gone AS (DELETE FROM feedback_votes WHERE created_at <= cutoff RETURNING 1)
  SELECT count(*) FROM gone
$$;
