-- Registry safety scan (src/registry/scan.ts): last verdict and findings per
-- version row, plus a fingerprint of the tool definitions to spot changes.
-- A 'flagged' row is hidden from the list, the API and the sitemap.
ALTER TABLE registry_servers ADD COLUMN scan_verdict TEXT;      -- passed | warning | flagged | partial
ALTER TABLE registry_servers ADD COLUMN scan_json TEXT;         -- the Scan object
ALTER TABLE registry_servers ADD COLUMN scanned_at TEXT;
ALTER TABLE registry_servers ADD COLUMN tools_hash TEXT;
ALTER TABLE registry_servers ADD COLUMN tools_changed_at TEXT;
