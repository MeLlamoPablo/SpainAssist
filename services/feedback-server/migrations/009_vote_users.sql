-- Agent votes record who cast them, so each user has one vote per entry, also across restarts.
-- user_id is `userId` of @sa/gateway-keys: an HMAC of the user's gateway key with the server's
-- USER_ID_SECRET, which can't be matched with LiteLLM's key hashes without the secret. Human
-- (maintainer) votes have none, nor do agent votes cast before this migration.
ALTER TABLE feedback_votes ADD COLUMN user_id text;
ALTER TABLE feedback_votes
  ADD CONSTRAINT feedback_votes_user_check CHECK (voter = 'agent' OR user_id IS NULL);
CREATE UNIQUE INDEX feedback_votes_user_idx
  ON feedback_votes (feedback_id, user_id) WHERE user_id IS NOT NULL;
