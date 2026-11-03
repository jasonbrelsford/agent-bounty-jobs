-- Open science challenges: HLA lab-report cleanup.
--
-- The synthetic reports ship with the code (src/science/hla-puzzles.ts). The
-- answer key for hidden reports is NOT in the repository: it is loaded straight
-- into sci_hla_answers in the production database and never returned by any route.
-- Submissions reuse sci_submissions (challenge = 'hla'), with the slot answers in answer_json.

CREATE TABLE sci_hla_answers (
  puzzle_id  TEXT PRIMARY KEY,
  key_json   TEXT NOT NULL                    -- JSON array of 10 slot answers
);

ALTER TABLE sci_submissions ADD COLUMN answer_json TEXT;
