-- Evidence: structured proof a submission actually did what was asked.
--
-- The board validates the FORM of evidence and cannot validate its TRUTH. It can
-- confirm a photo URL was supplied, that it is https, that a claimed coordinate
-- is inside the requested radius. It cannot confirm the photo shows that shop or
-- that anyone went there. Only the poster can judge that, and the API is worded
-- so nobody mistakes one for the other -- geo_claimed_within, never geo_verified.

ALTER TABLE bounties   ADD COLUMN evidence_required TEXT;   -- JSON array; NULL = none
ALTER TABLE milestones ADD COLUMN evidence_required TEXT;   -- per-part override

CREATE TABLE submission_evidence (
  id            TEXT PRIMARY KEY,   -- "evd_" + 16 hex
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  kind          TEXT NOT NULL,      -- photo | url | receipt | code | location | file | attestation
  label         TEXT,               -- echoes the requirement it satisfies
  value         TEXT NOT NULL,      -- JSON payload, shape per kind
  provenance    TEXT NOT NULL,      -- self_reported | third_party | platform_captured
  compliant     INTEGER NOT NULL DEFAULT 1,  -- did it satisfy the declared constraints
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_evidence_submission ON submission_evidence(submission_id);
