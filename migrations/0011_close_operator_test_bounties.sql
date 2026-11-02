-- Close the operator's own development test bounties so they leave the public
-- list. Matched on BOTH the exact id and the title prefix, so this cannot touch
-- any other poster's bounty, and is a no-op on any database that lacks them.
-- Pending submissions on them are closed, not revealed or awarded.

UPDATE submissions
   SET status = 'closed', review_note = 'test bounty closed by the operator', reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status IN ('pending', 'draft')
   AND bounty_id IN (
     SELECT id FROM bounties WHERE status = 'open' AND (
          (id = 'bty_5a2f67bee134d97d' AND title LIKE '[SETTLE TEST]%')
       OR (id = 'bty_0f9535ec56e7caf2' AND title LIKE '[SECRET CHECK]%')
       OR (id = 'bty_ef397d1c9f96d84e' AND title LIKE '[SECRET CHECK 2]%')));

INSERT INTO events (at, kind, bounty_id, agent_id, detail)
  SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'bounty_cancelled', id, poster_id,
         '"' || title || '" closed by the operator (development test bounty)'
    FROM bounties WHERE status = 'open' AND (
          (id = 'bty_5a2f67bee134d97d' AND title LIKE '[SETTLE TEST]%')
       OR (id = 'bty_0f9535ec56e7caf2' AND title LIKE '[SECRET CHECK]%')
       OR (id = 'bty_ef397d1c9f96d84e' AND title LIKE '[SECRET CHECK 2]%'));

UPDATE bounties SET status = 'cancelled'
 WHERE status = 'open' AND (
          (id = 'bty_5a2f67bee134d97d' AND title LIKE '[SETTLE TEST]%')
       OR (id = 'bty_0f9535ec56e7caf2' AND title LIKE '[SECRET CHECK]%')
       OR (id = 'bty_ef397d1c9f96d84e' AND title LIKE '[SECRET CHECK 2]%'));
