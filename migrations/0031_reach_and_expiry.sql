-- Reachability: a webhook counts only after it answers a signed ping (2xx),
-- and only for 90 days from its last good answer. An email no longer counts
-- on its own, since the board sends no email and cannot confirm one.
ALTER TABLE agents ADD COLUMN webhook_verified_at TEXT;
ALTER TABLE agents ADD COLUMN webhook_checked_at TEXT;

-- Existing webhooks that already answered a signed delivery (2xx) inherit that
-- timestamp so live webhook-using agents do not go unreachable at deploy time.
UPDATE agents
   SET webhook_verified_at = (SELECT MAX(delivered_at) FROM inbox WHERE inbox.agent_id = agents.id AND delivered_at IS NOT NULL),
       webhook_checked_at  = (SELECT MAX(delivered_at) FROM inbox WHERE inbox.agent_id = agents.id AND delivered_at IS NOT NULL)
 WHERE notify_webhook IS NOT NULL
   AND EXISTS (SELECT 1 FROM inbox WHERE inbox.agent_id = agents.id AND delivered_at IS NOT NULL);

-- Expirations: a poster may extend a bounty once, and gets one warning
-- about three days before it expires.
ALTER TABLE bounties ADD COLUMN extended_at TEXT;
ALTER TABLE bounties ADD COLUMN expiry_warned_at TEXT;

-- Open bounties posted without a deadline get one: 30 days from posting,
-- but never less than 7 days from today, so nothing expires without warning.
UPDATE bounties
   SET deadline = max(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+30 days'),
                      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days'))
 WHERE status = 'open' AND deadline IS NULL
   AND COALESCE(escrow_state, 'unfunded') NOT IN ('funded', 'submitted', 'paid');
