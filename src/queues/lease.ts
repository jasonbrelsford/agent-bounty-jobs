/**
 * Job leases: the one piece every science queue shares.
 *
 * Each queue keeps its OWN tables (its batches and its leases) and its own
 * rules for what an answer is and when answers agree. This file only knows the
 * mechanics every queue needs: hand one batch to one agent with a deadline,
 * take the slot back when the deadline passes, and never give an agent the
 * same batch twice (two answers only mean something if they are independent).
 *
 * A queue's batches table needs: id, seq, status ('open' | 'done'), needed, taken.
 * Its leases table needs: id, batch_id, agent_id, status ('leased' | 'done' |
 * 'expired' | 'released'), counted, leased_at, expires_at, reported_at.
 * Table names come from the queue's own constants, never from input.
 */

export type LeaseTables = { batches: string; leases: string };

export type LeaseRow = {
  id: string; batch_id: string; agent_id: string; status: string; counted: number;
  leased_at: string; expires_at: string; reported_at: string | null;
};

/** Recount taken slots (live leases plus counted reports) for some batches. */
export async function recount(db: D1Database, t: LeaseTables, batchIds: string[]) {
  const ids = [...new Set(batchIds)];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    await db.prepare(
      `UPDATE ${t.batches} SET taken = (SELECT COUNT(*) FROM ${t.leases} l WHERE l.batch_id = ${t.batches}.id AND l.counted = 1 AND l.status IN ('leased','done'))
       WHERE id IN (${part.map(() => "?").join(",")})`,
    ).bind(...part).run();
  }
}

/** Leases past their deadline give their slot back so another agent can take the batch. */
export async function expireLeases(db: D1Database, t: LeaseTables, now: string): Promise<number> {
  const r = await db.prepare(`SELECT id, batch_id FROM ${t.leases} WHERE status = 'leased' AND expires_at < ? LIMIT 200`).bind(now).all<{ id: string; batch_id: string }>();
  const rows = r.results ?? [];
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 50) {
    const part = rows.slice(i, i + 50).map((x) => x.id);
    await db.prepare(`UPDATE ${t.leases} SET status = 'expired' WHERE status = 'leased' AND id IN (${part.map(() => "?").join(",")})`).bind(...part).run();
  }
  await recount(db, t, rows.map((x) => x.batch_id));
  return rows.length;
}

/** The agent's live lease, if it has one. */
export async function activeLease(db: D1Database, t: LeaseTables, agentId: string, now: string) {
  return (await db.prepare(`SELECT * FROM ${t.leases} WHERE agent_id = ? AND status = 'leased' AND expires_at >= ? ORDER BY leased_at DESC LIMIT 1`)
    .bind(agentId, now).first<LeaseRow>()) ?? null;
}

/**
 * Take one slot on an open batch this agent has never held. Batches already
 * started come first, so each finishes before new ones begin. Returns the batch
 * id, or null when nothing is left for this agent.
 */
export async function takeSlot(db: D1Database, t: LeaseTables, agentId: string, leaseId: string, now: string, expiresAt: string): Promise<string | null> {
  for (const started of [true, false]) {
    const r = await db.prepare(
      `SELECT id FROM ${t.batches} WHERE status = 'open' AND ${started ? "taken > 0 AND" : "taken = 0 AND"} taken < needed
       AND id NOT IN (SELECT batch_id FROM ${t.leases} WHERE agent_id = ?) ORDER BY seq LIMIT 5`,
    ).bind(agentId).all<{ id: string }>();
    for (const { id } of r.results ?? []) {
      // Conditional insert then increment in one transaction: two agents racing for the last slot cannot both win.
      const res = await db.batch([
        db.prepare(
          `INSERT INTO ${t.leases} (id, batch_id, agent_id, status, counted, leased_at, expires_at)
           SELECT ?, id, ?, 'leased', 1, ?, ? FROM ${t.batches} WHERE id = ? AND status = 'open' AND taken < needed
           AND NOT EXISTS (SELECT 1 FROM ${t.leases} WHERE batch_id = ? AND agent_id = ?)`,
        ).bind(leaseId, agentId, now, expiresAt, id, id, agentId),
        db.prepare(`UPDATE ${t.batches} SET taken = taken + 1 WHERE id = ? AND EXISTS (SELECT 1 FROM ${t.leases} WHERE id = ?)`).bind(id, leaseId),
      ]);
      if ((res[0]?.meta?.changes ?? 0) === 1) return id;
    }
  }
  return null;
}

/** Give a job back early. */
export async function release(db: D1Database, t: LeaseTables, lease: LeaseRow) {
  await db.prepare(`UPDATE ${t.leases} SET status = 'released' WHERE id = ? AND status = 'leased'`).bind(lease.id).run();
  await recount(db, t, [lease.batch_id]);
}
