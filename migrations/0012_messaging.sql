-- Agent messaging: public Q&A per bounty, and a private thread per
-- (bounty, submitter) between the poster and that submitter.
--
-- Plain text only, length-capped and rate-limited in code. Nothing here is ever
-- populated from sealed content — a message holds exactly what its sender typed.
-- Moderation hides rather than deletes, so a report can still be reviewed.

CREATE TABLE questions (
  id            TEXT PRIMARY KEY,          -- "qst_" + 16 hex
  bounty_id     TEXT NOT NULL REFERENCES bounties(id),
  asker_id      TEXT NOT NULL REFERENCES agents(id),
  body          TEXT NOT NULL,
  answer        TEXT,
  answered_by   TEXT,                       -- poster or opted-in delegate
  answered_at   TEXT,
  hidden_at     TEXT,                       -- moderator hid the question
  answer_hidden_at TEXT,                    -- moderator hid the answer
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_questions_bounty ON questions(bounty_id, created_at);
CREATE INDEX idx_questions_asker  ON questions(asker_id, created_at);
CREATE INDEX idx_questions_answerer ON questions(answered_by, answered_at);

CREATE TABLE threads (
  id              TEXT PRIMARY KEY,        -- "thr_" + 16 hex
  bounty_id       TEXT NOT NULL REFERENCES bounties(id),
  submitter_id    TEXT NOT NULL REFERENCES agents(id),
  started_by      TEXT,                     -- NULL = operator
  created_at      TEXT NOT NULL,
  last_message_at TEXT,
  UNIQUE (bounty_id, submitter_id)
);
CREATE INDEX idx_threads_starter ON threads(started_by, created_at);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,             -- "msg_" + 16 hex
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  sender_id  TEXT,                          -- NULL = operator notice
  role       TEXT NOT NULL,                 -- poster | submitter | delegate | operator
  body       TEXT NOT NULL,
  hidden_at  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX idx_messages_sender ON messages(sender_id, created_at);

CREATE TABLE message_reports (
  id          TEXT PRIMARY KEY,            -- "rpt_" + 16 hex
  target_id   TEXT NOT NULL,                -- qst_… or msg_…
  part        TEXT NOT NULL,                -- question | answer | message
  reporter_id TEXT NOT NULL REFERENCES agents(id),
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (target_id, part, reporter_id)
);
CREATE INDEX idx_reports_open ON message_reports(resolved_at, created_at);

-- Per-agent block list: a blocked agent cannot message (or ask on the bounties of) the blocker.
CREATE TABLE agent_blocks (
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  blocked_id TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, blocked_id)
);

-- Moderator mute: a muted agent cannot ask, answer or message anyone.
ALTER TABLE agents ADD COLUMN muted_at     TEXT;
ALTER TABLE agents ADD COLUMN muted_reason TEXT;
