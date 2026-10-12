-- ChatGPT subsidy keys (D12) replace the anonymous search keys of POST /v1/search-tokens.
--
-- One permanent LiteLLM key per OpenAI account, for document-scan frame screening only. Unlike
-- voucher keys, the key itself is kept (AES-256-GCM with KEY_ENCRYPTION_KEY) so another device
-- signing in with the same account gets the same key back. The account is stored only as
-- HMAC-SHA256(issuer + subject, VOUCHER_PEPPER), never as its id or e-mail.

DROP TABLE anon_token_grants;

-- The anonymous search keys still exist in LiteLLM (alias sa-anon-search-*) until they expire;
-- the key server no longer tracks them.
DELETE FROM issued_keys WHERE kind = 'anon_search';
DROP INDEX IF EXISTS issued_keys_anon_expires_idx;

ALTER TABLE issued_keys DROP CONSTRAINT IF EXISTS issued_keys_kind_check;
ALTER TABLE issued_keys DROP CONSTRAINT IF EXISTS issued_keys_check;

ALTER TABLE issued_keys
  -- HMAC of the OpenAI account (chatgpt keys only).
  ADD COLUMN account_hash text UNIQUE,
  -- 'v1.' + base64(iv | tag | ciphertext) of the key, bound to account_hash (chatgpt keys only).
  ADD COLUMN key_ciphertext text,
  -- Last time an account fetched its key (any device).
  ADD COLUMN last_issued_at timestamptz;

ALTER TABLE issued_keys
  ADD CONSTRAINT issued_keys_kind_check CHECK (kind IN ('voucher', 'chatgpt')),
  ADD CONSTRAINT issued_keys_voucher_link_check CHECK ((kind = 'voucher') = (voucher_id IS NOT NULL)),
  ADD CONSTRAINT issued_keys_chatgpt_account_check CHECK (
    (kind = 'chatgpt') = (account_hash IS NOT NULL AND key_ciphertext IS NOT NULL)
  );

-- Small key/value settings owned by the server (e.g. the LiteLLM team of all ChatGPT keys).
CREATE TABLE server_settings (
  name text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
