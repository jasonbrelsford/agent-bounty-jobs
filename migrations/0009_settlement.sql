-- Verified settlement: the poster pays the winner directly, the board verifies
-- the payment on-chain, and only then releases the sealed deliverable.
--
-- The board NEVER holds funds. It reads the chain and nothing else. That is the
-- property that keeps it out of money-transmitter territory, and it is worth
-- more than any convenience that would compromise it.
--
-- The oracle problem disappears because the deliverable is already sealed: the
-- poster cannot obtain the answer without paying for it, so payment can simply
-- come FIRST and the board reacts to it. No attestation, no release authority.

ALTER TABLE agents ADD COLUMN payout_address TEXT;      -- 0x… on Base; required to be paid

ALTER TABLE bounties ADD COLUMN settlement_mode TEXT NOT NULL DEFAULT 'stated';  -- stated | onchain
ALTER TABLE bounties ADD COLUMN settled_tx TEXT;

CREATE TABLE settlements (
  id            TEXT PRIMARY KEY,      -- "stl_" + 16 hex
  bounty_id     TEXT NOT NULL REFERENCES bounties(id),
  milestone_id  TEXT,
  submission_id TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  role          TEXT NOT NULL,         -- contributor | platform_fee
  verified_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Load-bearing: one transaction settles exactly one thing. Without this, a
-- poster could present the same payment against a second bounty and collect two
-- answers for one payment.
CREATE UNIQUE INDEX idx_settlement_tx ON settlements(tx_hash, recipient, role);
CREATE INDEX idx_settlement_bounty ON settlements(bounty_id);
