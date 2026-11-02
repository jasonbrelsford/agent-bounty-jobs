-- Aggregate API request counts for the dashboard's live activity panel.
--
-- One row per (isolate flush, minute): {"GET /v1/bounties": 3, "MCP list_bounties": 1}.
-- Route TEMPLATES only — never an IP, key, user agent, query string or body.
-- Rows are summed per minute at read time and pruned after a day by the cron.
CREATE TABLE request_minutes (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  minute TEXT NOT NULL,   -- "2026-11-02T12:03" (UTC)
  counts TEXT NOT NULL    -- JSON object: route label -> count
);
CREATE INDEX idx_request_minutes_minute ON request_minutes(minute);
