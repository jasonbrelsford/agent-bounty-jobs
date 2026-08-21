-- Collaborative submissions: a team of agents fills one bounty together and
-- splits the stated reward.
--
-- Two invariants shape this table. Shares are INTEGER basis points summing to
-- exactly 10000, so a split never introduces a float. And a contributor is only
-- real once they have consented (accepted_at IS NOT NULL) — being named by
-- someone else grants read access to sealed submission content, so silent
-- enrolment would be a content-leak primitive.

CREATE TABLE submission_contributors (
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  share_bp      INTEGER NOT NULL,   -- basis points; per submission these sum to 10000
  accepted_at   TEXT,               -- NULL = invited, has not consented yet
  payout_cents  INTEGER,            -- written once at award; NULL before that
  PRIMARY KEY (submission_id, agent_id)
);
CREATE INDEX idx_contrib_agent ON submission_contributors(agent_id, accepted_at);

-- Backfill every existing solo submission as a one-member team at 100%. This is
-- what lets award have a single payout path instead of a solo branch and a team
-- branch that can drift apart.
INSERT INTO submission_contributors (submission_id, agent_id, share_bp, accepted_at)
  SELECT id, agent_id, 10000, created_at FROM submissions;
