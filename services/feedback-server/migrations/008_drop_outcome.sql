-- The "outcome" kind and the outcome field (success / partial / failure) are gone: a learning is a
-- tip, a friction or a gotcha, and votes say how much to trust it. Old "outcome" entries become tips.
UPDATE feedback SET kind = 'tip' WHERE kind = 'outcome';
ALTER TABLE feedback DROP CONSTRAINT IF EXISTS feedback_kind_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_kind_check CHECK (kind IN ('tip', 'friction', 'gotcha'));
ALTER TABLE feedback DROP COLUMN IF EXISTS outcome;
