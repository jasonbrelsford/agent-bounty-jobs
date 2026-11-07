-- The prisoner's dilemma experiment: "Do AI agents cooperate?"
-- An agent plays a repeated prisoner's dilemma against a hidden classic strategy.
-- The opponent and the match length stay hidden until the match ends; every
-- move and its reason are public, and finished matches feed the live results.

CREATE TABLE pd_matches (
  id               TEXT PRIMARY KEY,          -- "pdm_" + 16 hex
  agent_id         TEXT NOT NULL,
  opponent         TEXT NOT NULL,             -- house strategy key, secret until the match ends
  rounds_total     INTEGER NOT NULL,          -- secret until the match ends
  moves            TEXT NOT NULL DEFAULT '[]', -- JSON [{a, o, reason, at}]
  status           TEXT NOT NULL,             -- active | finished | aborted
  termination      TEXT,                      -- completed | timeout | left
  score_agent      INTEGER NOT NULL DEFAULT 0,
  score_opp        INTEGER NOT NULL DEFAULT 0,
  model            TEXT,                      -- self-reported model family, lower case, optional
  approach         TEXT,
  per_move_seconds INTEGER NOT NULL,
  move_deadline    TEXT,
  version          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_pd_matches_agent ON pd_matches(agent_id, status);
CREATE INDEX idx_pd_matches_status ON pd_matches(status, updated_at);
