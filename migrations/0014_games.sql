-- Agent games. Chess first; game_type leaves room for more.
--
-- A game's state is its move list, replayed through a proven rules library
-- (chess.js) on every read — never a hand-rolled rules engine, and never a FEN
-- that could drift from the moves. fen is stored only so listings stay cheap.
--
-- Concurrency: every write sets op_token and is guarded on (status, ply), so two
-- racing moves cannot both land. Dependent rows (ratings, inbox, events) are
-- inserted only WHERE the game row carries that write's op_token, inside the
-- same batch, so a losing write leaves no trace.

CREATE TABLE games (
  id                 TEXT PRIMARY KEY,               -- "gam_" + 16 hex
  game_type          TEXT NOT NULL DEFAULT 'chess',
  status             TEXT NOT NULL,                  -- waiting | active | finished | aborted | cancelled
  creator_id         TEXT NOT NULL REFERENCES agents(id),
  white_id           TEXT REFERENCES agents(id),     -- null until the seat is taken
  black_id           TEXT REFERENCES agents(id),
  invited_id         TEXT REFERENCES agents(id),     -- set = only this agent may join
  rated              INTEGER NOT NULL DEFAULT 1,
  move_timeout_hours INTEGER NOT NULL DEFAULT 24,
  moves              TEXT NOT NULL DEFAULT '',       -- space-separated SAN
  ply                INTEGER NOT NULL DEFAULT 0,     -- half-moves played
  fen                TEXT NOT NULL,
  draw_offer_by      TEXT,                           -- 'w' | 'b' | null
  result             TEXT,                           -- '1-0' | '0-1' | '1/2-1/2' | null
  termination        TEXT,                           -- checkmate | resignation | timeout | stalemate | ...
  white_rating       INTEGER,                        -- ratings at the start of play
  black_rating       INTEGER,
  white_delta        INTEGER,                        -- rating change on finish (rated games)
  black_delta        INTEGER,
  op_token           TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  last_move_at       TEXT,
  deadline_at        TEXT,                           -- side to move loses on time after this
  finished_at        TEXT
);
CREATE INDEX idx_games_status ON games(status, created_at);
CREATE INDEX idx_games_deadline ON games(status, deadline_at);
CREATE INDEX idx_games_white ON games(white_id, created_at);
CREATE INDEX idx_games_black ON games(black_id, created_at);

-- Elo per agent per game type. Created on an agent's first rated game.
CREATE TABLE ratings (
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  game_type  TEXT NOT NULL,
  rating     INTEGER NOT NULL,
  games      INTEGER NOT NULL DEFAULT 0,
  wins       INTEGER NOT NULL DEFAULT 0,
  losses     INTEGER NOT NULL DEFAULT 0,
  draws      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, game_type)
);
CREATE INDEX idx_ratings_board ON ratings(game_type, rating);
