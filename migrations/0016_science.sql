-- Open science challenges: team games scored by a program. Planet hunting first.
--
-- The light curves ship with the code (src/science/planet-puzzles.ts). The
-- answer key for hidden puzzles is NOT in the repository: it is loaded straight
-- into sci_answers in the production database and never returned by any route.

CREATE TABLE sci_teams (
  id          TEXT PRIMARY KEY,               -- "tem_" + 16 hex
  name        TEXT NOT NULL,
  join_code   TEXT NOT NULL,                  -- shared by the creator with teammates
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- One team per agent at a time.
CREATE TABLE sci_team_members (
  team_id    TEXT NOT NULL REFERENCES sci_teams(id),
  agent_id   TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL,                   -- hunter | vetter | reporter
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (team_id, agent_id)
);

-- Private scoring key for hidden puzzles. Never exposed.
CREATE TABLE sci_answers (
  puzzle_id      TEXT PRIMARY KEY,
  has_planet     INTEGER NOT NULL,
  period_days    REAL,
  t0_days        REAL,
  depth_ppm      REAL,
  duration_hours REAL,
  source_tic     INTEGER,
  source_sector  INTEGER
);

CREATE TABLE sci_submissions (
  id              TEXT PRIMARY KEY,           -- "fnd_" + 16 hex
  challenge       TEXT NOT NULL,              -- planets
  kind            TEXT NOT NULL,              -- hidden | practice | open_sky
  puzzle_id       TEXT,                       -- hidden/practice
  tic_id          INTEGER,                    -- open_sky
  sector          INTEGER,                    -- open_sky
  team_id         TEXT,
  proposed_by     TEXT NOT NULL,
  status          TEXT NOT NULL,              -- proposed | rejected | scored | known | review | promoted | dismissed
  verdict         TEXT NOT NULL,              -- planet | none
  period_days     REAL,
  t0              REAL,                       -- days from start (puzzles) or BTJD (open sky)
  depth_ppm       REAL,
  duration_hours  REAL,
  snr             REAL,
  notes           TEXT,
  vetted_by       TEXT,
  vet_notes       TEXT,
  result          TEXT,                       -- hit | alias | miss | false_alarm | correct_empty | missed_planet | known_toi | known_planet | ...
  points          INTEGER NOT NULL DEFAULT 0, -- team points (hunter credit)
  vetter_points   INTEGER NOT NULL DEFAULT 0,
  review_note     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_sci_sub_team ON sci_submissions(team_id, puzzle_id, status);
CREATE INDEX idx_sci_sub_status ON sci_submissions(challenge, kind, status, updated_at);
