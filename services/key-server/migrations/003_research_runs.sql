-- Deep research runs (POST /v1/research): Parallel Task API runs paid from a voucher key's
-- LiteLLM budget. No research content (input, output, progress) is ever stored: only which key
-- started the run, Parallel's run id, the state of the charge and timestamps.

-- Voucher keys authenticate research calls by the SHA-256 of the key (LiteLLM's token id).
CREATE INDEX issued_keys_key_hash_idx ON issued_keys (key_hash);

CREATE TABLE research_runs (
  id uuid PRIMARY KEY,
  issued_key_id uuid NOT NULL REFERENCES issued_keys (id),
  -- Client-chosen id that makes POST /v1/research idempotent per key (NULL = not idempotent).
  request_id uuid,
  -- Parallel's run id, set once the run exists upstream.
  parallel_run_id text,
  processor text NOT NULL,
  price_usd numeric(12, 4) NOT NULL CHECK (price_usd >= 0),
  -- reserved:  the price was taken from the key's max_budget; the Parallel run is being created
  -- running:   the Parallel run exists; the price stays reserved
  -- completed: the run finished; the price is charged for good
  -- refunding: the run failed but giving the price back to the key failed; retried hourly
  -- refunded:  the run failed (or never started); the price was given back
  -- expired:   we stopped following the run; the price stays charged
  state text NOT NULL CHECK (
    state IN ('reserved', 'running', 'completed', 'refunding', 'refunded', 'expired')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (issued_key_id, request_id)
);

CREATE INDEX research_runs_pending_idx ON research_runs (state, created_at)
  WHERE state IN ('reserved', 'running', 'refunding');
CREATE INDEX research_runs_key_idx ON research_runs (issued_key_id, created_at DESC);
