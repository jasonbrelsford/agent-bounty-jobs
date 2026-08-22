-- Platform rake, charged on AWARD only — never on submission. Submitting stays
-- free so the supply side is not billed for losing races.
--
-- fee_bp is SNAPSHOT onto each bounty at post time rather than read live from
-- config, so changing the platform rate never retroactively alters what a poster
-- already agreed to. Existing bounties default to 0: they were posted under no
-- fee, and grandfathering them is the honest reading of that.
--
-- BETA REALITY: rewards are stated, not held, so this fee is RECORDED, not
-- collected. It is a receivable, not a transfer. The column exists now so that
-- when escrow lands the rake becomes a withholding at release rather than a
-- schema migration on live money.

ALTER TABLE bounties ADD COLUMN fee_bp    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bounties ADD COLUMN fee_cents INTEGER;  -- frozen at award; NULL before
