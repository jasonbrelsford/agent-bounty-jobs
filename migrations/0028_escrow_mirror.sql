-- Read-only mirror of BountyEscrow (Base Sepolia testnet) state per bounty (#50),
-- deliverable unsealing enforcement (#66 / M4), and 48h/68h review reminders (#52).
--
-- Strictly additive (nullable columns and safe defaults) so rolling Worker code
-- back one step never breaks D1 queries.

ALTER TABLE bounties ADD COLUMN accepted_agent_id       TEXT REFERENCES agents(id);
ALTER TABLE bounties ADD COLUMN accepted_at             TEXT;
ALTER TABLE bounties ADD COLUMN escrow_ref              TEXT;                       -- 0x + keccak256(bounty.id)
ALTER TABLE bounties ADD COLUMN escrow_contract         TEXT;                       -- lower-case escrow address
ALTER TABLE bounties ADD COLUMN escrow_job_id           INTEGER;                    -- BountyEscrow job id
ALTER TABLE bounties ADD COLUMN escrow_state            TEXT NOT NULL DEFAULT 'unfunded'; -- unfunded | funded | submitted | paid | refunded
ALTER TABLE bounties ADD COLUMN escrow_refund_reason    TEXT;                       -- rejected | expired | abandoned
ALTER TABLE bounties ADD COLUMN escrow_poster_address   TEXT;
ALTER TABLE bounties ADD COLUMN escrow_agent_id         TEXT REFERENCES agents(id);
ALTER TABLE bounties ADD COLUMN escrow_agent_address    TEXT;
ALTER TABLE bounties ADD COLUMN escrow_amount_units     TEXT;
ALTER TABLE bounties ADD COLUMN escrow_deadline         INTEGER;                    -- unix seconds
ALTER TABLE bounties ADD COLUMN escrow_funding_tx       TEXT;
ALTER TABLE bounties ADD COLUMN escrow_deliverable_hash TEXT;
ALTER TABLE bounties ADD COLUMN escrow_submitted_at     TEXT;                       -- ISO-8601 from confirmed block timestamp
ALTER TABLE bounties ADD COLUMN escrow_settlement_tx    TEXT;                       -- Paid or Refunded tx hash
ALTER TABLE bounties ADD COLUMN escrow_to_agent_units   TEXT;
ALTER TABLE bounties ADD COLUMN escrow_fee_units        TEXT;
ALTER TABLE bounties ADD COLUMN escrow_reminder_48h_at  TEXT;
ALTER TABLE bounties ADD COLUMN escrow_reminder_68h_at  TEXT;

CREATE UNIQUE INDEX idx_bounties_escrow_job
  ON bounties (escrow_contract, escrow_job_id)
  WHERE escrow_job_id IS NOT NULL;

CREATE INDEX idx_bounties_escrow_ref
  ON bounties (escrow_ref)
  WHERE escrow_ref IS NOT NULL;

CREATE INDEX idx_bounties_escrow_state
  ON bounties (escrow_state, escrow_submitted_at);

CREATE TABLE escrow_sync_cursor (
  escrow_contract   TEXT PRIMARY KEY,
  last_synced_block INTEGER NOT NULL,
  updated_at        TEXT NOT NULL
);
