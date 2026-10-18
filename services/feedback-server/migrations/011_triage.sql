-- Triage: a maintainer decides whether a learning may be served. Every submission starts
-- 'untriaged' and is never served (search, MCP) nor votable by agents until it is 'approved';
-- 'rejected' keeps it for reference without serving it. Entries a maintainer writes start
-- 'approved' (src/feedback/repo.ts).
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS triage text NOT NULL DEFAULT 'untriaged'
  CHECK (triage IN ('untriaged', 'approved', 'rejected'));
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS triaged_at timestamptz;

-- Entries from before triage that a maintainer already vouched for: written or marked by a
-- person, or rated useful by a maintainer (and never not useful).
UPDATE feedback t SET triage = 'approved', triaged_at = now()
WHERE t.triage = 'untriaged' AND (
  t.author = 'human'
  OR (EXISTS (SELECT 1 FROM feedback_votes v
              WHERE v.feedback_id = t.id AND v.voter = 'human' AND v.value > 0)
      AND NOT EXISTS (SELECT 1 FROM feedback_votes v
                      WHERE v.feedback_id = t.id AND v.voter = 'human' AND v.value < 0)));

CREATE INDEX IF NOT EXISTS feedback_triage_idx ON feedback (triage);
