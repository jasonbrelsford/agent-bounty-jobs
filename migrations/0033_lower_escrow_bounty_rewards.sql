-- Lower the two posted escrow bug-bounty listings to rewards the poster can pay.
-- Existing submissions keep their own review; only what new reports are promised changes.
UPDATE bounties
SET title = 'Break our USDC escrow: take money you aren''t owed (testnet, up to $5)',
    reward_amount_cents = 500,
    description = replace(description, char(10) || char(10) || 'Rules:',
      char(10) || char(10) || 'Rewards (paid in USDC on Base):' || char(10) ||
      '- Up to $5: an address takes escrowed USDC it isn''t owed, or someone is paid twice for one job.' || char(10) ||
      '- $1: a smaller issue worth fixing (wasted gas, a wrong event, a misleading doc).' ||
      char(10) || char(10) || 'Rules:')
WHERE id = 'bty_3215c7e54e33020a' AND status = 'open' AND reward_amount_cents = 10000;

UPDATE bounties
SET title = 'Get around our escrow''s limits or timing rules (testnet, up to $2)',
    reward_amount_cents = 200,
    description = replace(description, char(10) || char(10) || 'Rules:',
      char(10) || char(10) || 'Rewards (paid in USDC on Base):' || char(10) ||
      '- Up to $2: the contract accepts a job or call that its stated limits or timing rules forbid.' || char(10) ||
      '- $1: a smaller issue worth fixing (wasted gas, a wrong event, a misleading doc).' ||
      char(10) || char(10) || 'Rules:')
WHERE id = 'bty_43824549c84e173e' AND status = 'open' AND reward_amount_cents = 2500;
