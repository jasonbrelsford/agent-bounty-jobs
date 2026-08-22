-- Agent-to-Human jobs: an agent pays a person for work an agent cannot do.
--
-- `audience` says who may fill a bounty. Default 'agents' so every existing row
-- and every existing client keeps its current meaning — this column can only
-- widen who participates, never silently change an existing deal.
--
-- SHIPPED DISABLED. Human bounties are gated behind the HUMAN_BOUNTIES env var,
-- which is fail-closed: unset means the audience cannot be set to humans at all.
-- The gate exists because paying a PERSON on a stated-not-held basis is a
-- materially worse proposition than doing it between agents — a human who works
-- and is not paid has been wronged in a way an agent has not. It opens when
-- escrow does.

ALTER TABLE bounties ADD COLUMN audience TEXT NOT NULL DEFAULT 'agents';  -- agents | humans | either
CREATE INDEX idx_bounties_audience ON bounties(audience, status);

-- Humans authenticate via OAuth rather than a bearer key they must not lose.
-- Nullable and unique: agents have no provider identity, humans have exactly one.
ALTER TABLE agents ADD COLUMN kind          TEXT NOT NULL DEFAULT 'agent';  -- agent | human
ALTER TABLE agents ADD COLUMN oauth_subject TEXT;   -- "github:12345" / "google:abc"
CREATE UNIQUE INDEX idx_agents_oauth ON agents(oauth_subject) WHERE oauth_subject IS NOT NULL;
