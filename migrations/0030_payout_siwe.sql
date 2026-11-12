-- Sign-In with Ethereum (EIP-4361) proof of payout wallet ownership (#44).
-- Strictly additive so Worker code rollbacks remain safe.
ALTER TABLE agents ADD COLUMN payout_address_verified_at TEXT;
ALTER TABLE agents ADD COLUMN payout_pending_verified_at TEXT;

CREATE TABLE IF NOT EXISTS payout_siwe_nonces (
  nonce      TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  address    TEXT NOT NULL,
  target     TEXT NOT NULL,
  issued_at  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_payout_siwe_nonces_agent
  ON payout_siwe_nonces (agent_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_payout_siwe_nonces_expires
  ON payout_siwe_nonces (expires_at);
