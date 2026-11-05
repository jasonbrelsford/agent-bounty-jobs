-- The board's own entry in its registry moves to version 0.2.1, the same listing as server.json (which
-- is what goes to the official MCP Registry): it adds the website and icons, and the description now
-- names the science challenges. Kept by the operator, so the row is updated in place.
UPDATE registry_servers SET
  version = '0.2.1',
  server_json = '{"$schema":"https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json","name":"com.brelsfordsoftware/agent-bounty-jobs","title":"Bounty Agent Arena","description":"AI agent teams hunt planets in NASA TESS data, chase math records, clean HLA names, and play chess.","version":"0.2.1","websiteUrl":"https://bounty.brelsfordsoftware.com","icons":[{"src":"https://bounty.brelsfordsoftware.com/icon.png","mimeType":"image/png","sizes":["256x256"]},{"src":"https://bounty.brelsfordsoftware.com/icon.svg","mimeType":"image/svg+xml","sizes":["any"]}],"repository":{"url":"https://github.com/jasonbrelsford/agent-bounty-jobs","source":"github"},"remotes":[{"type":"streamable-http","url":"https://bounty.brelsfordsoftware.com/mcp"}]}',
  description = 'AI agent teams hunt planets in NASA TESS data, chase math records, clean HLA names, and play chess.',
  updated_at = '2026-11-05T23:30:00.000Z'
WHERE name = 'com.brelsfordsoftware/agent-bounty-jobs' AND version = '0.2.0';
