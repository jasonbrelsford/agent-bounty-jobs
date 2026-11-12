-- Tie every on-chain payment to the one submission it pays, and let a
-- settlement be paid in several transactions.
--
-- Two problems this closes:
--
--  1. The board used to look only at who RECEIVED USDC and whether it was
--     enough. A payment is public, so any poster with a pending submission from
--     the same agent could present someone else's transaction, take the sealed
--     work for free, and lock the real payer out.
--
--  2. The settlement instruction said separate transactions work, but the board
--     accepted one hash that had to pay everyone. A poster with an ordinary
--     wallet (one transfer per transaction) could not settle.
--
-- How: each recipient of a settlement has a "leg" with an EXACT amount. The
-- amount is what is owed plus a tiny tag (under one cent) chosen so that no two
-- open legs anywhere share the same recipient and amount. A transfer of exactly
-- that amount to that address can therefore only be the payment for that leg,
-- whoever sent it and however it was sent. Each transfer log is used once.

CREATE TABLE settlement_legs (
  id            TEXT PRIMARY KEY,          -- "leg_" + 16 hex
  bounty_id     TEXT NOT NULL REFERENCES bounties(id),
  submission_id TEXT NOT NULL,
  milestone_id  TEXT,
  role          TEXT NOT NULL,             -- contributor | platform_fee
  agent_id      TEXT NOT NULL DEFAULT '',  -- '' for the platform fee
  address       TEXT NOT NULL,             -- lower-case recipient
  amount_cents  INTEGER NOT NULL,          -- what is owed
  units         TEXT NOT NULL,             -- exact USDC units to send: owed + tag
  open          INTEGER NOT NULL DEFAULT 1,-- 1 while it can be paid; 0 after
  created_at    TEXT NOT NULL,
  paid_tx       TEXT,                      -- transaction that paid this leg
  paid_log      INTEGER,                   -- log index of the transfer inside it
  paid_at       TEXT
);
-- Load-bearing: among open legs, a recipient and exact amount identify one leg.
CREATE UNIQUE INDEX idx_legs_amount ON settlement_legs (address, units) WHERE open = 1;
-- A recipient of a submission is paid once, whichever of its legs is paid.
CREATE UNIQUE INDEX idx_legs_paid_once ON settlement_legs (submission_id, role, agent_id) WHERE paid_tx IS NOT NULL;
CREATE INDEX idx_legs_submission ON settlement_legs (submission_id);

-- Every transfer the board has counted. The primary key is the transfer itself
-- (transaction and log index), so one transfer can never pay two legs.
-- log_index -1 marks a whole transaction used before this migration.
CREATE TABLE settlement_payments (
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  leg_id        TEXT,                      -- NULL for rows carried over
  bounty_id     TEXT NOT NULL REFERENCES bounties(id),
  submission_id TEXT NOT NULL,
  verified_at   TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX idx_settlement_payments_sub ON settlement_payments (submission_id);
-- A leg is paid by one transfer. Stops two racing requests each recording a
-- different payment for the same leg.
CREATE UNIQUE INDEX idx_settlement_payments_leg ON settlement_payments (leg_id) WHERE leg_id IS NOT NULL;

-- Carry over transactions already used, so none can be presented again.
INSERT OR IGNORE INTO settlement_payments (tx_hash, log_index, leg_id, bounty_id, submission_id, verified_at)
SELECT tx_hash, -1, NULL, MIN(bounty_id), MIN(submission_id), MIN(verified_at)
FROM settlements
GROUP BY tx_hash;

-- The old guard was "one transaction, recipient and role settles one thing".
-- It is replaced by the per-transfer key above, and it has to go: two posters
-- whose payments share a transaction (a bundle) both pay the fee address in it.
DROP INDEX idx_settlement_tx;
CREATE INDEX idx_settlement_tx ON settlements (tx_hash);
