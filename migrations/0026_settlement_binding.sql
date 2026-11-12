-- Bind every on-chain payment to the poster who made it, and let a settlement
-- be paid across several transactions.
--
-- Two problems this closes:
--
--  1. The board used to look only at who RECEIVED USDC in a transaction. Any
--     poster with a pending submission from the same agent could present someone
--     else's payment as their own, take the sealed work for free, and lock the
--     real payer out. Now a poster names the wallet they will pay from BEFORE
--     paying, a wallet belongs to one account only, and only transfers sent
--     from that wallet after it was registered are counted.
--
--  2. The settlement instruction said separate transactions work, but the board
--     accepted one hash that had to pay everyone. A poster with an ordinary
--     wallet (one transfer per transaction) could not settle. Now each verified
--     transaction is recorded against the submission and the amounts are summed.

-- The wallet a poster pays from. One account per address.
CREATE TABLE payer_wallets (
  address       TEXT PRIMARY KEY,          -- lower-case 0x…
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  registered_at TEXT NOT NULL              -- only payments mined at or after this count
);
CREATE INDEX idx_payer_wallets_agent ON payer_wallets (agent_id);

-- One row per verified transaction. tx_hash is the primary key, so a
-- transaction can only ever count toward one submission.
CREATE TABLE settlement_payments (
  tx_hash       TEXT PRIMARY KEY,
  bounty_id     TEXT NOT NULL REFERENCES bounties(id),
  submission_id TEXT NOT NULL,
  poster_id     TEXT,                      -- NULL for rows carried over from before this migration
  block_time    INTEGER,                   -- unix seconds of the block; NULL for carried-over rows
  transfers     TEXT NOT NULL,             -- JSON [{"to":"0x…","units":"1234"}], counted transfers only
  verified_at   TEXT NOT NULL
);
CREATE INDEX idx_settlement_payments_sub ON settlement_payments (submission_id);

-- Carry over transactions already used, so none can be presented a second time.
INSERT OR IGNORE INTO settlement_payments (tx_hash, bounty_id, submission_id, poster_id, block_time, transfers, verified_at)
SELECT tx_hash, MIN(bounty_id), MIN(submission_id), NULL, NULL,
       json_group_array(json_object('to', recipient, 'units', CAST(amount_cents * 10000 AS TEXT))),
       MIN(verified_at)
FROM settlements
GROUP BY tx_hash;
