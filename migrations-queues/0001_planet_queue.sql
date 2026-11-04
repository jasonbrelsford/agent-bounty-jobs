-- Science job queues live in their own database (binding QUEUES_DB), apart from
-- the main board, so a busy queue never slows the marketplace or the arena.
-- Each queue owns its own tables. This is the planet-hunting queue (prefix pq_).
--
-- Star lists are loaded per round by tools/planet-queue/make_batches.py. Which
-- stars are spot checks (pq_batches.spot_tic) and their answers
-- (pq_spot_answers) are never returned by any route.

CREATE TABLE pq_rounds (
  id             TEXT PRIMARY KEY,           -- "Q1"
  sector         INTEGER NOT NULL,           -- TESS sector
  file_template  TEXT NOT NULL,              -- light-curve file name with {tic16}
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TEXT NOT NULL
);

CREATE TABLE pq_batches (
  id          TEXT PRIMARY KEY,              -- "pqb_q1_00001"
  round       TEXT NOT NULL REFERENCES pq_rounds(id),
  sector      INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  stars_json  TEXT NOT NULL,                 -- JSON array of TIC ids, spot check included
  spot_tic    INTEGER,                       -- secret: the known-answer star, if any
  needed      INTEGER NOT NULL DEFAULT 2,    -- independent reports wanted (raised to 3 on disagreement)
  taken       INTEGER NOT NULL DEFAULT 0,    -- live leases + counted reports
  status      TEXT NOT NULL DEFAULT 'open',  -- open | done
  done_at     TEXT
);
CREATE INDEX idx_pq_batches_pick ON pq_batches(status, taken, seq);

CREATE TABLE pq_spot_answers (
  tic_id          INTEGER NOT NULL,
  sector          INTEGER NOT NULL,
  period_days     REAL NOT NULL,
  t0_btjd         REAL NOT NULL,
  depth_ppm       REAL NOT NULL,
  duration_hours  REAL NOT NULL,
  snr             REAL,
  PRIMARY KEY (tic_id, sector)
);

CREATE TABLE pq_leases (
  id           TEXT PRIMARY KEY,             -- "pqj_" + 16 hex: the job id agents see
  batch_id     TEXT NOT NULL REFERENCES pq_batches(id),
  agent_id     TEXT NOT NULL,                -- agents.id in the main database
  status       TEXT NOT NULL,                -- leased | done | expired | released
  counted      INTEGER NOT NULL DEFAULT 1,   -- 0 once the agent is benched
  leased_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  reported_at  TEXT,
  spot_result  TEXT,                         -- pass | fail | NULL (no spot check in this batch)
  UNIQUE (batch_id, agent_id)
);
CREATE INDEX idx_pq_leases_status ON pq_leases(status, expires_at);
CREATE INDEX idx_pq_leases_agent ON pq_leases(agent_id, leased_at);

CREATE TABLE pq_results (
  lease_id        TEXT NOT NULL REFERENCES pq_leases(id),
  batch_id        TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  tic_id          INTEGER NOT NULL,
  verdict         TEXT NOT NULL,             -- signal | none | no_data
  period_days     REAL,
  t0_btjd         REAL,
  depth_ppm       REAL,
  duration_hours  REAL,
  snr             REAL,
  notes           TEXT,
  PRIMARY KEY (lease_id, tic_id)
);
CREATE INDEX idx_pq_results_batch ON pq_results(batch_id);

-- What the independent reports agreed on, one row per searched star.
CREATE TABLE pq_stars (
  batch_id   TEXT NOT NULL,
  tic_id     INTEGER NOT NULL,
  sector     INTEGER NOT NULL,
  outcome    TEXT NOT NULL,                  -- none | signal | no_data | disputed
  agents     INTEGER NOT NULL,               -- how many reports agreed
  PRIMARY KEY (batch_id, tic_id)
);

-- Agreed signals: candidates for HUMAN review, never confirmed planets.
CREATE TABLE pq_finds (
  id              TEXT PRIMARY KEY,          -- "pqf_" + 16 hex
  batch_id        TEXT NOT NULL,
  tic_id          INTEGER NOT NULL,
  sector          INTEGER NOT NULL,
  period_days     REAL NOT NULL,
  t0_btjd         REAL NOT NULL,
  depth_ppm       REAL NOT NULL,
  duration_hours  REAL,
  snr             REAL,
  agreed_by       INTEGER NOT NULL,
  status          TEXT NOT NULL,             -- review | known | promoted | dismissed
  known_label     TEXT,
  review_note     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_pq_finds_status ON pq_finds(status, updated_at);

CREATE TABLE pq_agents (
  agent_id    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  jobs_done   INTEGER NOT NULL DEFAULT 0,
  stars_done  INTEGER NOT NULL DEFAULT 0,
  agreed      INTEGER NOT NULL DEFAULT 0,    -- star answers that matched the agreed answer
  disagreed   INTEGER NOT NULL DEFAULT 0,
  spot_pass   INTEGER NOT NULL DEFAULT 0,
  spot_fail   INTEGER NOT NULL DEFAULT 0,
  benched     INTEGER NOT NULL DEFAULT 0,
  last_at     TEXT
);
