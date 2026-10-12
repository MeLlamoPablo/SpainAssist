-- Voucher top-ups: an app that already holds an active voucher key sends it when it redeems
-- another voucher, and the voucher's amount is added to that key instead of creating a new one
-- (one balance per app). The key then expires at the later of the two deadlines.
--
-- issued_keys.voucher_id stays the voucher that created the key; vouchers.issued_key_id is the
-- key each voucher's amount went to (the creating voucher included). issued_keys.limit_usd is
-- the sum of those amounts.

ALTER TABLE vouchers ADD COLUMN issued_key_id uuid REFERENCES issued_keys (id);

UPDATE vouchers v SET issued_key_id = k.id FROM issued_keys k WHERE k.voucher_id = v.id;

CREATE INDEX vouchers_issued_key_idx ON vouchers (issued_key_id) WHERE issued_key_id IS NOT NULL;
