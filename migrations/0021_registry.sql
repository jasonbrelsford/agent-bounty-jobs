-- Open MCP server registry (src/registry). Its own tables, apart from the board,
-- the arena and the science queues. One row per server version, like the
-- official MCP Registry: versions never change once listed.

CREATE TABLE registry_servers (
  name              TEXT NOT NULL,             -- reverse-DNS, e.g. com.example/weather
  version           TEXT NOT NULL,
  server_json       TEXT NOT NULL,             -- the maker's server.json, as checked
  title             TEXT NOT NULL DEFAULT '',  -- copies for search
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active', -- active | deprecated | deleted
  status_message    TEXT,
  status_changed_at TEXT NOT NULL,
  published_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  is_latest         INTEGER NOT NULL DEFAULT 0,
  featured          INTEGER NOT NULL DEFAULT 0, -- shown first on the browse page
  source            TEXT NOT NULL DEFAULT 'owner', -- owner (proved by their file) | operator
  domain            TEXT NOT NULL,             -- where the ownership file lives
  checks_json       TEXT,                      -- last remote checks
  last_checked_at   TEXT,
  PRIMARY KEY (name, version)
);
CREATE INDEX registry_servers_latest ON registry_servers (is_latest, status, name);
CREATE INDEX registry_servers_updated ON registry_servers (updated_at);

-- Submission attempts, for rate limits. The caller is a daily-rotating hash, never an address.
CREATE TABLE registry_publish_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash    TEXT NOT NULL,
  domain     TEXT,
  name       TEXT,
  ok         INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX registry_publish_log_time ON registry_publish_log (created_at);

-- The board's own server, listed first. Kept by the operator, so it is not rechecked.
INSERT INTO registry_servers
  (name, version, server_json, title, description, status, status_changed_at, published_at, updated_at,
   is_latest, featured, source, domain)
VALUES (
  'com.brelsfordsoftware/agent-bounty-jobs', '0.2.0',
  '{"$schema":"https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json","name":"com.brelsfordsoftware/agent-bounty-jobs","title":"Bounty Agent Arena","description":"Agent arena: teams of AI agents hunt planets in real NASA TESS light curves, plus chess and dice.","version":"0.2.0","repository":{"url":"https://github.com/jasonbrelsford/agent-bounty-jobs","source":"github"},"remotes":[{"type":"streamable-http","url":"https://bounty.brelsfordsoftware.com/mcp"}]}',
  'Bounty Agent Arena',
  'Agent arena: teams of AI agents hunt planets in real NASA TESS light curves, plus chess and dice.',
  'active', '2026-11-04T18:27:54.000Z', '2026-11-04T18:27:54.000Z', '2026-11-04T18:27:54.000Z',
  1, 1, 'operator', 'brelsfordsoftware.com'
);
