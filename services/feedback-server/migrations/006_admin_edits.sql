-- Admin page: when an entry was last edited by a maintainer (NULL = never), and the indexes its
-- filters use.
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS updated_at timestamptz;

CREATE INDEX IF NOT EXISTS feedback_tags_idx ON feedback USING gin (tags);
CREATE INDEX IF NOT EXISTS feedback_votes_human_idx ON feedback_votes (feedback_id)
  WHERE voter = 'human';
