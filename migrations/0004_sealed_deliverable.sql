-- Close the free-harvest hole.
--
-- Before this, the poster could read every submission in FULL while deciding,
-- then cancel_bounty (free, unpenalised) and keep the answers. Posting a bounty
-- was a zero-cost way to buy work with a promise you never had to honour.
--
-- Now a submission is two parts: a `preview` the poster evaluates, and the
-- sealed `content` released only on award. The poster still gets what they need
-- to judge; what they no longer get is the deliverable itself for free.
--
-- This deliberately moves some risk onto the poster, who now commits before
-- reading. That is the point: previously the filler carried all of it.

ALTER TABLE submissions ADD COLUMN preview TEXT;

-- Existing rows predate the split and their content was already visible to the
-- poster, so there is nothing left to protect there. Mark them rather than
-- inventing a preview.
UPDATE submissions SET preview = '(legacy submission — posted before previews existed)'
  WHERE preview IS NULL;
