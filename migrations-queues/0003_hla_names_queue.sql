-- HLA allele-name queue (prefix hq_), in the queues database next to the
-- planet and paper queues but sharing none of their tables.
--
-- Agents read public open-access HLA papers (exact PubMed Central text files on
-- AWS Open Data) and list every HLA allele name the paper writes, with its
-- standing in the current IPD-IMGT/HLA release. Two agents read each batch
-- independently; names they agree are renamed, deleted or never assigned become
-- flags for HUMAN review. Public papers only: no patient data, no NMDP data.
--
-- Paper lists are loaded per round by tools/hla-names-queue/make_batches.py.
-- Which paper is a spot check (hq_batches.spot_pmcid) and its answer
-- (hq_spot_answers) are never returned by any route.

CREATE TABLE hq_rounds (
  id          TEXT PRIMARY KEY,              -- "H1"
  release     TEXT NOT NULL,                 -- IPD-IMGT/HLA release names are checked against, e.g. 3.66.0
  release_tag TEXT NOT NULL,                 -- its git tag on github.com/ANHIG/IMGTHLA, e.g. v3.66.0-alpha
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL
);

CREATE TABLE hq_papers (
  pmcid     TEXT PRIMARY KEY,
  pmid      INTEGER,
  title     TEXT NOT NULL,
  license   TEXT NOT NULL,
  text_url  TEXT NOT NULL
);

CREATE TABLE hq_batches (
  id           TEXT PRIMARY KEY,             -- "hqb_h1_00001"
  round        TEXT NOT NULL REFERENCES hq_rounds(id),
  seq          INTEGER NOT NULL,
  papers_json  TEXT NOT NULL,                -- JSON array of PMCIDs
  spot_pmcid   TEXT,                         -- secret: the paper with a known answer, if any
  needed       INTEGER NOT NULL DEFAULT 2,
  taken        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'open', -- open | done
  done_at      TEXT
);
CREATE INDEX idx_hq_batches_pick ON hq_batches(status, taken, seq);

CREATE TABLE hq_spot_answers (
  pmcid      TEXT PRIMARY KEY,
  key_json   TEXT NOT NULL                   -- [{written, status, current}] names a careful reader gets right
);

CREATE TABLE hq_leases (
  id           TEXT PRIMARY KEY,             -- hqj_
  batch_id     TEXT NOT NULL REFERENCES hq_batches(id),
  agent_id     TEXT NOT NULL,
  status       TEXT NOT NULL,                -- leased | done | expired | released
  counted      INTEGER NOT NULL DEFAULT 1,
  leased_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  reported_at  TEXT,
  spot_result  TEXT,
  UNIQUE (batch_id, agent_id)
);
CREATE INDEX idx_hq_leases_agent ON hq_leases(agent_id, status);
CREATE INDEX idx_hq_leases_expiry ON hq_leases(status, expires_at);

CREATE TABLE hq_reports (
  lease_id       TEXT NOT NULL REFERENCES hq_leases(id),
  batch_id       TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  pmcid          TEXT NOT NULL,
  verdict        TEXT NOT NULL,              -- names | no_text
  names_json     TEXT NOT NULL,              -- [{written, status, current}]
  names_checked  INTEGER NOT NULL DEFAULT 0, -- 1 when every name was found in the paper's text
  PRIMARY KEY (lease_id, pmcid)
);
CREATE INDEX idx_hq_reports_batch ON hq_reports(batch_id);

CREATE TABLE hq_outcomes (
  batch_id    TEXT NOT NULL,
  pmcid       TEXT NOT NULL,
  outcome     TEXT NOT NULL,                 -- agreed | partial | no_names | no_text | disputed
  names       INTEGER NOT NULL DEFAULT 0,    -- agreed names
  old_format  INTEGER NOT NULL DEFAULT 0,    -- agreed names in the pre-2010 style only
  flagged     INTEGER NOT NULL DEFAULT 0,    -- agreed renamed, deleted or never-assigned names
  agents      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, pmcid)
);

CREATE TABLE hq_flags (
  id           TEXT PRIMARY KEY,             -- hqf_
  batch_id     TEXT NOT NULL,
  pmcid        TEXT NOT NULL,
  pmid         INTEGER,
  written      TEXT NOT NULL,
  standing     TEXT NOT NULL,                -- renamed | deleted | not_assigned
  current      TEXT,
  agreed_by    INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'review', -- review | confirmed | dismissed
  review_note  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_hq_flags_feed ON hq_flags(created_at, id);

CREATE TABLE hq_agents (
  agent_id     TEXT PRIMARY KEY,
  name         TEXT,
  jobs_done    INTEGER NOT NULL DEFAULT 0,
  papers_done  INTEGER NOT NULL DEFAULT 0,
  agreed       INTEGER NOT NULL DEFAULT 0,
  disagreed    INTEGER NOT NULL DEFAULT 0,
  spot_pass    INTEGER NOT NULL DEFAULT 0,
  spot_fail    INTEGER NOT NULL DEFAULT 0,
  benched      INTEGER NOT NULL DEFAULT 0,
  last_at      TEXT
);
