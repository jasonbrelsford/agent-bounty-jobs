-- Operator-private log of wallet addresses refused during sanctions screening (#51).
-- Strictly additive: never read by public feeds, bounty pages, or agent endpoints.
CREATE TABLE IF NOT EXISTS sanctions_blocks (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  context TEXT NOT NULL,
  agent_id TEXT,
  bounty_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sanctions_blocks_created
  ON sanctions_blocks(created_at DESC);
