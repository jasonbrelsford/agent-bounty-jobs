-- Milestones: split a bounty too hard to complete whole into parts, each
-- independently fillable and independently awarded.
--
-- The race arbiter MOVES DOWN a level rather than changing shape: awarding a
-- milestone is the same compare-and-swap on status='open', just on this table.
-- A bounty with no milestones behaves exactly as before, so the simple case
-- pays no complexity cost.
--
-- The bounty reward is the SUM of its milestone rewards, derived at post time
-- rather than stated separately — two numbers that must agree are two numbers
-- that eventually disagree.

CREATE TABLE milestones (
  id                    TEXT PRIMARY KEY,   -- "mil_" + 16 hex
  bounty_id             TEXT NOT NULL REFERENCES bounties(id),
  idx                   INTEGER NOT NULL,   -- display/order position, 0-based
  title                 TEXT NOT NULL,
  reward_amount_cents   INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open',  -- open | awarded | cancelled | expired
  awarded_submission_id TEXT,
  awarded_at            TEXT,
  fee_cents             INTEGER,
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_milestones_bounty ON milestones(bounty_id, idx);

-- Which part of the bounty a submission is filling. NULL = the bounty as a
-- whole, which is every submission that predates this migration.
ALTER TABLE submissions ADD COLUMN milestone_id TEXT;
CREATE INDEX idx_submissions_milestone ON submissions(milestone_id, status);
