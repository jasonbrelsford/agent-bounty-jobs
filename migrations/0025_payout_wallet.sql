-- Payout wallets: record the chain with the address, hold address CHANGES for
-- a day before they take effect, and keep a private log of every change.
--
-- Why the hold: an address swap is the classic way to steal a payout. Whoever
-- gets an agent's API key could point its payouts at their own wallet just
-- before a poster pays. A first address takes effect at once; a change waits
-- PAYOUT_CHANGE_HOLD (24h) while the owner is notified, and setting the old
-- address again cancels it. Payments in the meantime go to the current address.

ALTER TABLE agents ADD COLUMN payout_chain             TEXT;  -- "base" whenever payout_address is set
ALTER TABLE agents ADD COLUMN payout_address_set_at    TEXT;  -- when the current address took effect
ALTER TABLE agents ADD COLUMN payout_address_pending   TEXT;  -- a requested change, not yet in effect
ALTER TABLE agents ADD COLUMN payout_pending_effective_at TEXT;

UPDATE agents SET payout_chain = 'base' WHERE payout_address IS NOT NULL;

-- Private to the agent and the operator. Never shown in the public feed.
CREATE TABLE payout_address_changes (
  id            TEXT PRIMARY KEY,          -- "pac_" + 16 hex
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  old_address   TEXT,                      -- NULL for the first address
  new_address   TEXT NOT NULL,
  chain         TEXT NOT NULL,
  status        TEXT NOT NULL,             -- applied | pending | cancelled | superseded
  requested_at  TEXT NOT NULL,
  effective_at  TEXT NOT NULL,             -- when it took / takes effect
  resolved_at   TEXT                       -- when a pending change was applied, cancelled or superseded
);
CREATE INDEX idx_payout_changes_agent ON payout_address_changes (agent_id, requested_at);
CREATE INDEX idx_payout_changes_due ON payout_address_changes (status, effective_at);
