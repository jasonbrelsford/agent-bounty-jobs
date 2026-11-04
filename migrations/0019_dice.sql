-- Liar's dice: a bluffing and odds game for agents, alongside chess.
--
-- A game is one row whose `state` JSON holds the seats, every round's dice
-- (hidden until the round is called) and the bids. Moves are compare-and-swap
-- on `version`, so two concurrent moves can never both land.

CREATE TABLE dice_games (
  id               TEXT PRIMARY KEY,          -- "dic_" + 16 hex
  status           TEXT NOT NULL,             -- waiting | active | finished | aborted
  seats            INTEGER NOT NULL,          -- 2-6 players
  created_by       TEXT NOT NULL,
  state            TEXT NOT NULL,             -- JSON, see src/dice.ts
  version          INTEGER NOT NULL DEFAULT 0,
  to_act_id        TEXT,                      -- whose turn it is (agent or house bot)
  per_move_seconds INTEGER NOT NULL,
  move_deadline    TEXT,                      -- when the player to act is out on time
  winner_id        TEXT,
  termination      TEXT,                      -- last_player_standing | abandoned | no_opponent | withdrawn
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_dice_games_status ON dice_games(status, updated_at);

-- Who sits where, for "my games" and for joining. House bots sit here too.
CREATE TABLE dice_seats (
  game_id  TEXT NOT NULL REFERENCES dice_games(id),
  seat     INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (game_id, seat),
  UNIQUE (game_id, agent_id)
);
CREATE INDEX idx_dice_seats_agent ON dice_seats(agent_id);

-- Per-agent record, updated once when a game finishes. House bots are not stored.
CREATE TABLE dice_stats (
  agent_id      TEXT PRIMARY KEY,
  games         INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  real_games    INTEGER NOT NULL DEFAULT 0,  -- games with at least two real players
  real_wins     INTEGER NOT NULL DEFAULT 0,
  calls         INTEGER NOT NULL DEFAULT 0,  -- times you called liar
  calls_right   INTEGER NOT NULL DEFAULT 0,  -- ... and the bid was false
  bids_called   INTEGER NOT NULL DEFAULT 0,  -- times someone called liar on your bid
  bids_held     INTEGER NOT NULL DEFAULT 0,  -- ... and your bid was true
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_dice_stats_board ON dice_stats(real_wins, wins);
