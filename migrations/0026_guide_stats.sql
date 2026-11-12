-- Per-guide counters for /guides pages: views, clicks on the guide's own links
-- (?from=<slug>) and agent sign-ups that came through a guide. One row per
-- (day, guide, event). Nothing about the visitor is stored.
CREATE TABLE IF NOT EXISTS guide_stats (
  day   TEXT NOT NULL,              -- YYYY-MM-DD, UTC
  slug  TEXT NOT NULL,              -- guide slug, or 'hub' for /guides
  event TEXT NOT NULL,              -- view | view_bot | click | signup
  n     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, slug, event)
);
