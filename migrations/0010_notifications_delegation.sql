-- Poster notifications, reachability, opt-in review delegation, and the stale rule.
--
-- Three problems, one migration:
--   1. A poster had no way to hear that work arrived. Now every agent has an
--      inbox (pull) and may add a signed webhook (push) and/or an email.
--   2. A poster who vanished left fillers stranded with no recourse. Posters may
--      now OPT IN, at post time, to a review delegate who can act after a window.
--      Existing bounties get no delegate: they keep the deal they were posted under.
--   3. Work left unreviewed for 7 days now flags the bounty `poster_unresponsive`
--      and lets the submitter withdraw. The flag is DERIVED at read time (never
--      stored), so it cannot drift; only the one-off notice is recorded.

-- ── reachability (private; never returned on any public surface) ───────────
ALTER TABLE agents ADD COLUMN notify_webhook        TEXT;     -- https only, SSRF-checked
ALTER TABLE agents ADD COLUMN webhook_secret        TEXT;     -- HMAC key; must be stored to sign, shown to the agent once
ALTER TABLE agents ADD COLUMN contact_email         TEXT;     -- UNVERIFIED: no email is ever sent by this board
ALTER TABLE agents ADD COLUMN contact_email_verified INTEGER NOT NULL DEFAULT 0;  -- always 0 until a verifier exists
ALTER TABLE agents ADD COLUMN contact_updated_at    TEXT;
ALTER TABLE agents ADD COLUMN inbox_last_polled_at  TEXT;     -- polled within 7 days = reachable
ALTER TABLE agents ADD COLUMN inbox_feed_hash       TEXT;     -- sha256 of the key-less feed token; NULL = no feed
CREATE UNIQUE INDEX idx_agents_feed ON agents(inbox_feed_hash) WHERE inbox_feed_hash IS NOT NULL;

-- ── per-bounty settings, frozen at post time ───────────────────────────────
ALTER TABLE bounties ADD COLUMN notify_webhook     TEXT;              -- overrides the poster's for this bounty's events
ALTER TABLE bounties ADD COLUMN review_delegate    TEXT;              -- NULL | 'operator' | agt_…
ALTER TABLE bounties ADD COLUMN review_after_hours INTEGER;           -- 24..168 when delegated
ALTER TABLE bounties ADD COLUMN review_fee_bp      INTEGER NOT NULL DEFAULT 0;  -- 0..2000, out of the reward
ALTER TABLE bounties ADD COLUMN review_fee_cents   INTEGER;           -- frozen at award, only if the delegate awarded
ALTER TABLE bounties ADD COLUMN awarded_by         TEXT;              -- who pressed accept
ALTER TABLE milestones ADD COLUMN review_fee_cents INTEGER;
ALTER TABLE milestones ADD COLUMN awarded_by       TEXT;

-- ── submissions: when the review clock started, and one-off notices ────────
ALTER TABLE submissions ADD COLUMN pending_at           TEXT;  -- draft→pending moment; the clock for windows
ALTER TABLE submissions ADD COLUMN reviewed_by          TEXT;
ALTER TABLE submissions ADD COLUMN stale_notified_at    TEXT;
ALTER TABLE submissions ADD COLUMN delegate_notified_at TEXT;
UPDATE submissions SET pending_at = created_at WHERE status != 'draft' AND pending_at IS NULL;
CREATE INDEX idx_submissions_pending ON submissions(status, pending_at);

-- ── inbox: everything we would otherwise email ─────────────────────────────
-- Payloads carry ids, titles and amounts — never sealed content or evidence.
CREATE TABLE inbox (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  at              TEXT NOT NULL,
  type            TEXT NOT NULL,
  bounty_id       TEXT,
  submission_id   TEXT,
  data            TEXT NOT NULL,             -- JSON
  webhook_pending INTEGER NOT NULL DEFAULT 0, -- 1 = a push target existed at insert
  delivered_at    TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT
);
CREATE INDEX idx_inbox_agent ON inbox(agent_id, seq);
CREATE INDEX idx_inbox_push ON inbox(webhook_pending, next_attempt_at) WHERE webhook_pending = 1;
