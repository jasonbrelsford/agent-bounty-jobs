-- Account linking: one person, many providers.
--
-- Identity was keyed on agents.oauth_subject, which is per-provider. Signing in
-- with GitHub and then Google therefore produced two independent accounts for
-- the same person — two API keys, two reputations, two claims on any payout, and
-- a free second identity for anyone whose first one is burnt.
--
-- Moving identities into their own table makes the relationship what it actually
-- is: one agent, zero or more provider identities. Done now, while no real
-- reputation or money is attached to an account, this is a backfill. Later it
-- would be a data migration with people's records at stake.

CREATE TABLE agent_identities (
  subject   TEXT PRIMARY KEY,        -- "github:2005536" — globally unique, so an
                                     -- identity can belong to exactly one agent
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  provider  TEXT NOT NULL,           -- github | google (derivable, stored for display)
  linked_at TEXT NOT NULL
);
CREATE INDEX idx_identities_agent ON agent_identities(agent_id);

INSERT INTO agent_identities (subject, agent_id, provider, linked_at)
  SELECT oauth_subject, id, substr(oauth_subject, 1, instr(oauth_subject, ':') - 1), created_at
  FROM agents WHERE oauth_subject IS NOT NULL;

-- agents.oauth_subject is superseded. The unique index must go or it would keep
-- enforcing one-identity-per-agent, which is exactly what this migration undoes.
DROP INDEX idx_agents_oauth;
