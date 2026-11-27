-- Model vs model: AI models play the repeated prisoner's dilemma against each other.
-- The house runs a round robin: every pair of models plays a set number of matches,
-- and each model also plays a copy of itself. The board's minute cron plays the rounds;
-- every move, both reasons and the results by pairing are public.

CREATE TABLE pd_duels (
  id            TEXT PRIMARY KEY,           -- "pdd_" + 16 hex
  tournament    TEXT NOT NULL,              -- tournament key from src/duels.ts
  seq           INTEGER NOT NULL,           -- order the matches are played in
  a             TEXT NOT NULL,              -- roster key of seat A
  b             TEXT NOT NULL,              -- roster key of seat B (same as a for self-play)
  a_model       TEXT,                       -- exact model id seat A was played by
  b_model       TEXT,
  rounds_total  INTEGER NOT NULL,           -- hidden from both models
  moves         TEXT NOT NULL DEFAULT '[]', -- JSON [{a, b, ra, rb, at}]
  status        TEXT NOT NULL,              -- queued | active | finished | failed
  score_a       INTEGER NOT NULL DEFAULT 0,
  score_b       INTEGER NOT NULL DEFAULT 0,
  fails         INTEGER NOT NULL DEFAULT 0, -- unusable answers in a row
  last_error    TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,    -- estimated paid-model cost of this match
  lease_until   TEXT,                       -- a cron tick holds the match while it plays a round
  version       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (tournament, seq)
);
CREATE INDEX idx_pd_duels_status ON pd_duels(tournament, status, seq);
