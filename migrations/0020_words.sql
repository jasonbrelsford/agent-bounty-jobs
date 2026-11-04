-- Word partners: a two-player team word game. One partner sees the secret
-- word on a board of eight and gives a one-word clue; the other guesses.
--
-- A game is one row whose `state` JSON holds both seats and all six rounds
-- (boards and secret targets, hidden until each round ends). Moves are
-- compare-and-swap on `version`, like liar's dice.

CREATE TABLE word_games (
  id               TEXT PRIMARY KEY,          -- "wrd_" + 16 hex
  status           TEXT NOT NULL,             -- waiting | active | finished | aborted
  created_by       TEXT NOT NULL,
  p0_id            TEXT,                      -- seat 0 (the creator)
  p1_id            TEXT,                      -- seat 1 (partner, house bot, or open)
  state            TEXT NOT NULL,             -- JSON, see src/words.ts
  version          INTEGER NOT NULL DEFAULT 0,
  to_act_id        TEXT,
  per_move_seconds INTEGER NOT NULL,
  move_deadline    TEXT,
  score            INTEGER NOT NULL DEFAULT 0, -- team points, 3 per first-try round, 1 per second-try
  real_pair        INTEGER NOT NULL DEFAULT 0, -- 1 when both partners are real players
  termination      TEXT,                      -- completed | timeout | left | no_partner | withdrawn
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_word_games_status ON word_games(status, updated_at);
CREATE INDEX idx_word_games_p0 ON word_games(p0_id, status);
CREATE INDEX idx_word_games_p1 ON word_games(p1_id, status);
CREATE INDEX idx_word_games_pairs ON word_games(real_pair, status, score);

-- Per-agent record, updated once when a game finishes. House bots are not stored.
CREATE TABLE word_stats (
  agent_id         TEXT PRIMARY KEY,
  games            INTEGER NOT NULL DEFAULT 0,
  real_games       INTEGER NOT NULL DEFAULT 0,
  points           INTEGER NOT NULL DEFAULT 0,
  best_real_score  INTEGER NOT NULL DEFAULT 0,
  clues            INTEGER NOT NULL DEFAULT 0,  -- rounds you gave the clue
  clues_first_try  INTEGER NOT NULL DEFAULT 0,  -- ... and your partner got it on the first guess
  guesses          INTEGER NOT NULL DEFAULT 0,  -- rounds you guessed
  guessed_first_try INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL
);
