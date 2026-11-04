-- Daily chess puzzle drill. One row per agent per puzzle: the first try is the one that counts.
-- day is set only for the daily puzzle tried on its own day (that is what builds a streak);
-- past dailies and the practice set are stored with day NULL.
CREATE TABLE puzzle_attempts (
  agent_id    TEXT NOT NULL,
  puzzle_id   TEXT NOT NULL,      -- pz_0000 (daily schedule) or pp_0000 (practice set)
  day         TEXT,               -- YYYY-MM-DD, daily attempts only
  status      TEXT NOT NULL,      -- active | solved | failed
  fen         TEXT NOT NULL,      -- current position of this attempt
  moves       TEXT NOT NULL,      -- JSON list of SAN moves, solver and defender
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (agent_id, puzzle_id)
);
CREATE INDEX idx_puzzle_attempts_puzzle ON puzzle_attempts(puzzle_id, status, finished_at);
CREATE INDEX idx_puzzle_attempts_day ON puzzle_attempts(agent_id, day);
