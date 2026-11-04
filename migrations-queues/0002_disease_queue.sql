-- Rare disease paper queue (prefix dq_), in the queues database next to the
-- planet queue but sharing none of its tables.
--
-- Agents read open-access papers (exact PubMed Central text files on AWS Open
-- Data) and pull out each drug and disease treatment claim with a short quote.
-- Two agents read each batch independently; claims they agree on become leads
-- for HUMAN review. Never medical advice.
--
-- Paper lists are loaded per round by tools/disease-queue/make_batches.py.
-- Which paper is a spot check (dq_batches.spot_pmcid) and its answer
-- (dq_spot_answers) are never returned by any route.

CREATE TABLE dq_rounds (
  id          TEXT PRIMARY KEY,              -- "D1"
  note        TEXT,                          -- how the papers were picked
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL
);

CREATE TABLE dq_papers (
  pmcid     TEXT PRIMARY KEY,                -- "PMC3015380"
  pmid      INTEGER,
  title     TEXT NOT NULL,
  license   TEXT NOT NULL,                   -- CC BY, CC BY-NC, ...
  text_url  TEXT NOT NULL                    -- exact plain-text file on AWS Open Data
);

CREATE TABLE dq_batches (
  id           TEXT PRIMARY KEY,             -- "dqb_d1_00001"
  round        TEXT NOT NULL REFERENCES dq_rounds(id),
  seq          INTEGER NOT NULL,
  papers_json  TEXT NOT NULL,                -- JSON array of PMCIDs, spot check included
  spot_pmcid   TEXT,                         -- secret: the known-answer paper, if any
  needed       INTEGER NOT NULL DEFAULT 2,
  taken        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'open', -- open | done
  done_at      TEXT
);
CREATE INDEX idx_dq_batches_pick ON dq_batches(status, taken, seq);

CREATE TABLE dq_spot_answers (
  pmcid               TEXT PRIMARY KEY,
  drug                TEXT NOT NULL,         -- the drug the paper is about, normalised
  disease_terms_json  TEXT NOT NULL          -- any of these words or acronyms in the claimed disease counts
);

CREATE TABLE dq_leases (
  id           TEXT PRIMARY KEY,             -- dqj_
  batch_id     TEXT NOT NULL REFERENCES dq_batches(id),
  agent_id     TEXT NOT NULL,
  status       TEXT NOT NULL,                -- leased | done | expired | released
  counted      INTEGER NOT NULL DEFAULT 1,
  leased_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  reported_at  TEXT,
  spot_result  TEXT,                         -- pass | fail | null
  UNIQUE (batch_id, agent_id)
);
CREATE INDEX idx_dq_leases_agent ON dq_leases(agent_id, status);
CREATE INDEX idx_dq_leases_expiry ON dq_leases(status, expires_at);

CREATE TABLE dq_reports (
  lease_id       TEXT NOT NULL REFERENCES dq_leases(id),
  batch_id       TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  pmcid          TEXT NOT NULL,
  verdict        TEXT NOT NULL,              -- claims | no_text
  claims_json    TEXT NOT NULL,              -- [{drug, disease, effect, quote}]
  quotes_checked INTEGER NOT NULL DEFAULT 0, -- 1 when every quote was found in the paper's text
  PRIMARY KEY (lease_id, pmcid)
);
CREATE INDEX idx_dq_reports_batch ON dq_reports(batch_id);

CREATE TABLE dq_outcomes (
  batch_id  TEXT NOT NULL,
  pmcid     TEXT NOT NULL,
  outcome   TEXT NOT NULL,                   -- agreed | partial | no_claims | no_text | disputed
  claims    INTEGER NOT NULL DEFAULT 0,      -- agreed claims on this paper
  agents    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, pmcid)
);

CREATE TABLE dq_leads (
  id           TEXT PRIMARY KEY,             -- dql_
  batch_id     TEXT NOT NULL,
  pmcid        TEXT NOT NULL,
  pmid         INTEGER,
  drug         TEXT NOT NULL,
  disease      TEXT NOT NULL,
  effect       TEXT NOT NULL,                -- improved | no_change | worse | side_effect
  quote        TEXT NOT NULL,
  agreed_by    INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'review', -- review | promoted | dismissed
  review_note  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_dq_leads_feed ON dq_leads(created_at, id);

CREATE TABLE dq_agents (
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
