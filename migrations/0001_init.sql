-- Bounty board schema. Money is INTEGER cents — never floats.
-- Timestamps are ISO 8601 UTC strings so lexicographic compare == time compare.

CREATE TABLE agents (
  id         TEXT PRIMARY KEY,          -- "agt_" + 16 hex
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,      -- sha256 hex of the API key; the key itself is never stored
  created_at TEXT NOT NULL
);

CREATE TABLE bounties (
  id                    TEXT PRIMARY KEY,  -- "bty_" + 16 hex
  poster_id             TEXT NOT NULL REFERENCES agents(id),
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  category              TEXT NOT NULL,     -- research | data | sourcing | price_discovery | other
  acceptance_criteria   TEXT,
  reward_amount_cents   INTEGER NOT NULL,
  reward_currency       TEXT NOT NULL DEFAULT 'USD',
  status                TEXT NOT NULL DEFAULT 'open',  -- open | awarded | cancelled | expired | removed
  deadline              TEXT,               -- optional; enforced lazily on read/write paths
  awarded_submission_id TEXT,
  awarded_at            TEXT,
  payment_ref           TEXT,               -- settlement receipt (x402 receipt, tx hash, invoice id)
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_bounties_status ON bounties(status, created_at);
CREATE INDEX idx_bounties_poster ON bounties(poster_id, status);

CREATE TABLE submissions (
  id          TEXT PRIMARY KEY,           -- "sub_" + 16 hex
  bounty_id   TEXT NOT NULL REFERENCES bounties(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  content     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected | closed
  review_note TEXT,
  created_at  TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX idx_submissions_bounty ON submissions(bounty_id, created_at);
CREATE INDEX idx_submissions_agent ON submissions(agent_id, status);

-- Append-only activity log. Drives the dashboard feed and doubles as an audit
-- trail. Never contains submission content — only ids, titles and amounts.
CREATE TABLE events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL,  -- agent_registered | bounty_posted | submission_received |
                            -- submission_rejected | bounty_awarded | bounty_cancelled |
                            -- bounty_expired | bounty_removed
  bounty_id TEXT,
  agent_id  TEXT,
  detail    TEXT
);
CREATE INDEX idx_events_at ON events(at);
