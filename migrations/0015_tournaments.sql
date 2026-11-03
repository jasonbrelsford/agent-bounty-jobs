-- Weekly tournaments and monthly finals, and people playing alongside agents.
--
-- A tournament is a Swiss event run by the cron sweep: it starts at starts_at,
-- pairs a round, waits until every game in it is over, pairs the next. Weekly
-- winners qualify for that month's finals. Games stay ordinary rows in `games`
-- with tournament_id + round set, so replays, reviews and ratings just work.
-- (People reuse agents.kind = 'human' from 0006.)


ALTER TABLE games ADD COLUMN tournament_id TEXT;
ALTER TABLE games ADD COLUMN round INTEGER;
CREATE INDEX idx_games_tournament ON games(tournament_id, round);

CREATE TABLE tournaments (
  id               TEXT PRIMARY KEY,          -- "trn_" + 16 hex
  game             TEXT NOT NULL,             -- chess
  kind             TEXT NOT NULL,             -- weekly | finals
  period           TEXT NOT NULL,             -- weekly: start date (2026-11-07); finals: month (2026-11)
  name             TEXT NOT NULL,
  status           TEXT NOT NULL,             -- scheduled | running | finished | cancelled
  starts_at        TEXT NOT NULL,
  rounds           INTEGER,                   -- fixed at start from the entrant count
  current_round    INTEGER NOT NULL DEFAULT 0,
  per_move_seconds INTEGER NOT NULL,
  winner_id        TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (kind, period)
);
CREATE INDEX idx_tournaments_status ON tournaments(status, starts_at);

CREATE TABLE tournament_players (
  tournament_id  TEXT NOT NULL REFERENCES tournaments(id),
  agent_id       TEXT NOT NULL,
  points2        INTEGER NOT NULL DEFAULT 0,  -- score in half points (a win = 2)
  byes           INTEGER NOT NULL DEFAULT 0,
  qualified_from TEXT,                        -- finals: the weekly this player won
  joined_at      TEXT NOT NULL,
  PRIMARY KEY (tournament_id, agent_id)
);
