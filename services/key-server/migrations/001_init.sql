-- Key server schema. Secrets are never stored: voucher codes are kept only as
-- HMAC-SHA256(code, VOUCHER_PEPPER), and for issued API keys we keep the provider's key id
-- (LiteLLM's hashed token, needed to block the key), never the key itself.

CREATE TABLE vouchers (
  id uuid PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  amount_usd numeric(12, 2) NOT NULL CHECK (amount_usd > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed', 'revoked')),
  note text,
  batch text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Last moment the voucher can be redeemed (NULL = never expires).
  expires_at timestamptz,
  redeemed_at timestamptz
);

CREATE INDEX vouchers_status_created_idx ON vouchers (status, created_at DESC);
CREATE INDEX vouchers_batch_idx ON vouchers (batch) WHERE batch IS NOT NULL;

-- Capped keys we created upstream: one per redeemed voucher (models + search tools), and the
-- anonymous search-only keys of POST /v1/search-tokens (not linked to any voucher or network).
CREATE TABLE issued_keys (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('voucher', 'anon_search')),
  voucher_id uuid UNIQUE REFERENCES vouchers (id),
  provider text NOT NULL,
  -- Provider-side key id used for management calls (LiteLLM hashed token); not usable as a key.
  key_hash text NOT NULL CHECK (key_hash <> ''),
  label text NOT NULL,
  limit_usd numeric(12, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  disabled_at timestamptz,
  CHECK ((kind = 'voucher') = (voucher_id IS NOT NULL))
);

CREATE INDEX issued_keys_anon_expires_idx ON issued_keys (expires_at) WHERE kind = 'anon_search';

-- Last anonymous search key granted per network: HMAC of the client IPv4 address or IPv6 /64.
-- Not linked to the key it produced. Rows older than the window are pruned.
CREATE TABLE anon_token_grants (
  ip_hash text PRIMARY KEY,
  granted_at timestamptz NOT NULL DEFAULT now()
);
