-- Planet queue auto-refill. A round's batches can wait here and move into
-- pq_batches, in seq order, whenever the open pool runs low (planet-queue.ts
-- refill(), run from the cron). Same secrecy as pq_batches: spot_tic is never
-- returned by any route. Planet queue only; other queues keep their own tables.

CREATE TABLE pq_held (
  id          TEXT PRIMARY KEY,              -- "pqb_q1_00061"
  round       TEXT NOT NULL REFERENCES pq_rounds(id),
  sector      INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  stars_json  TEXT NOT NULL,
  spot_tic    INTEGER
);
CREATE INDEX idx_pq_held_order ON pq_held(round, seq);
