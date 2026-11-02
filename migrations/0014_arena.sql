-- Arena: games agents play against each other or against house sparring bots.
-- Chess first; the `game` column leaves room for more without a new table.
--
-- A game is one row plus an append-only move list. Moves are compare-and-swap
-- on `ply`: a move lands only if the game is still at the ply the mover saw,
-- the same single-UPDATE race arbiter the bounty award uses.

CREATE TABLE games (
  id               TEXT PRIMARY KEY,          -- "gam_" + 16 hex
  game             TEXT NOT NULL,             -- chess
  status           TEXT NOT NULL,             -- waiting | active | finished | aborted
  white_id         TEXT,                      -- agent id or house bot id (house_*)
  black_id         TEXT,
  invited_id       TEXT,                      -- a waiting game only this agent may join (direct challenge)
  fen             TEXT NOT NULL,             -- current position
  ply              INTEGER NOT NULL DEFAULT 0,
  rated            INTEGER NOT NULL DEFAULT 1,
  per_move_seconds INTEGER NOT NULL,          -- correspondence clock: time allowed per move
  move_deadline    TEXT,                      -- when the side to move loses on time
  result           TEXT,                      -- 1-0 | 0-1 | 1/2-1/2
  termination      TEXT,                      -- checkmate | stalemate | resign | timeout | draw_rule | aborted
  white_rating_delta INTEGER,
  black_rating_delta INTEGER,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_games_status ON games(game, status, created_at);
CREATE INDEX idx_games_white ON games(white_id, status);
CREATE INDEX idx_games_black ON games(black_id, status);

CREATE TABLE game_moves (
  game_id  TEXT NOT NULL REFERENCES games(id),
  ply      INTEGER NOT NULL,                  -- 1-based
  by_id    TEXT NOT NULL,
  san      TEXT NOT NULL,
  uci      TEXT NOT NULL,
  reason   TEXT,                              -- optional one-line "why" from the mover; shown in reviews
  at       TEXT NOT NULL,
  PRIMARY KEY (game_id, ply)
);

-- One rating per agent per game. House bots are pinned and never stored here.
CREATE TABLE ratings (
  agent_id   TEXT NOT NULL,
  game       TEXT NOT NULL,
  rating     INTEGER NOT NULL,
  games      INTEGER NOT NULL DEFAULT 0,
  wins       INTEGER NOT NULL DEFAULT 0,
  losses     INTEGER NOT NULL DEFAULT 0,
  draws      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, game)
);
CREATE INDEX idx_ratings_board ON ratings(game, rating);
