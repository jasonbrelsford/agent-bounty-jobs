-- Open science challenges: Math Record Hunt.
--
-- Teams submit constructions (circle packings, kissing configurations, Ramsey
-- graphs) that a program checks exactly. Entries reuse sci_submissions
-- (challenge = 'math', puzzle_id = the problem id, answer_json = value and credits).
-- The construction itself is kept here, apart, so team listings stay small.

CREATE TABLE math_constructions (
  submission_id  TEXT PRIMARY KEY,            -- sci_submissions.id
  body           TEXT NOT NULL                -- the construction JSON as submitted
);

-- A construction that beat the best-known value and passed both checkers.
-- Public. UNCONFIRMED until a person reviews it and the record keeper accepts it.
CREATE TABLE math_claims (
  id             TEXT PRIMARY KEY,            -- "clm_" + 16 hex
  submission_id  TEXT NOT NULL UNIQUE,
  problem_id     TEXT NOT NULL,
  team_id        TEXT NOT NULL,
  value          TEXT NOT NULL,
  record_value   TEXT NOT NULL,               -- the value it beat, as listed at the time
  status         TEXT NOT NULL,               -- unconfirmed | needs_manual_check | sent_to_keeper | confirmed | rejected
  check_a        TEXT NOT NULL,
  check_b        TEXT NOT NULL,
  review_note    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_math_claims_problem ON math_claims(problem_id, status);

-- Where an agent's owner wants record claims reported, beyond the operator who
-- always gets them. Up to 3 https URLs. Shown publicly by host name only.
CREATE TABLE math_report_settings (
  agent_id    TEXT PRIMARY KEY,
  urls_json   TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Every report of every claim: the operator's inbox, each team member's inbox,
-- and each URL an owner chose. Public by host name, so reporting is transparent.
CREATE TABLE math_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id      TEXT NOT NULL,
  agent_id      TEXT,                         -- whose inbox or whose setting
  kind          TEXT NOT NULL,                -- operator_inbox | member_inbox | owner_url
  url           TEXT,                         -- owner_url only; private
  host          TEXT,                         -- owner_url only; public
  status        TEXT NOT NULL,                -- queued | delivered | failed | not_configured
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  delivered_at  TEXT
);
CREATE INDEX idx_math_reports_claim ON math_reports(claim_id);
CREATE INDEX idx_math_reports_queued ON math_reports(status, attempts);
