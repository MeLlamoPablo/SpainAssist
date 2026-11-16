-- requires-extension: vector
-- Hybrid search: one embedding per entry, next to the full-text columns (src/embed).
-- This migration waits until the database has pgvector (see src/db/migrate.ts): until then the
-- server searches by text only. Later migrations must not depend on it.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS feedback_embeddings (
  feedback_id  uuid PRIMARY KEY REFERENCES feedback (id) ON DELETE CASCADE,
  -- "<model>@<dimensions>": vectors of different models can't be compared, so searches only
  -- read the current one and the indexer replaces the others.
  model        text NOT NULL,
  -- md5 of the text that was embedded: an edited entry is embedded again.
  content_hash text NOT NULL,
  -- No fixed dimension, so another model needs no migration. Exact search: at a few thousand
  -- rows a scan takes under a millisecond. For an index later:
  --   CREATE INDEX … USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE model = '…';
  embedding    vector NOT NULL,
  embedded_at  timestamptz NOT NULL DEFAULT now()
);
