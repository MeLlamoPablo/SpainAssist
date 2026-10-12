-- Who wrote each learning: an agent ("<model id> · <reasoning level>", set by the app) or "human"
-- (seed entries and entries a maintainer edited). NULL = unknown (entries from before this).
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS author text;

CREATE INDEX IF NOT EXISTS feedback_author_idx ON feedback (author);
