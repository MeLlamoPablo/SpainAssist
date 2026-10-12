-- Agent and human up/down votes. They decide how often an entry is served (see
-- src/feedback/votes.ts) and replace the old "helpful" counter. No voter identity is stored.
CREATE TABLE IF NOT EXISTS feedback_votes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feedback_id uuid NOT NULL REFERENCES feedback (id) ON DELETE CASCADE,
  value       smallint NOT NULL CHECK (value IN (-1, 1)),
  voter       text NOT NULL CHECK (voter IN ('agent', 'human')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_votes_feedback_idx ON feedback_votes (feedback_id);

ALTER TABLE feedback DROP COLUMN IF EXISTS helpful;
