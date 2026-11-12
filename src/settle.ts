/**
 * On-chain settlement: verify a payment, then release the deliverable.
 *
 * The order is the whole design. Because the board already seals submissions
 * until award, the poster cannot obtain the answer without paying — so payment
 * can come FIRST and the board simply reacts to it. That removes the oracle
 * problem entirely: nothing needs to attest that an award happened, and nobody
 * holds a release key. The board reads the chain and updates its own records.
 *
 * What makes a transfer count:
 *
 *  - It pays one leg exactly. Every recipient of a settlement is a leg with an
 *    exact amount that no other open leg shares (see freezeLegs in core.ts). A
 *    transfer of exactly that amount to that address is the payment for that
 *    leg and nothing else. "At least this much to this address" is NOT enough:
 *    payments are public, and that rule let any poster present someone else's.
 *  - It was made after the leg was issued.
 *  - It is used once. The transfer (transaction and log index) is recorded and
 *    can never pay a second leg.
 *
 * Who sent it does not matter, so batch contracts, smart wallets and exchange
 * withdrawals all work. Legs may be paid in one transaction or several; each
 * matched transfer is recorded when presented and the deliverable is released
 * when every recipient is paid.
 *
 * Order at the end: the award is made first and the settlement rows are written
 * after it. The award's own compare-and-swap decides any race, and a request
 * that dies in between leaves nothing that blocks a retry: presenting the hash
 * again finishes the job.
 */
import {
  type Env, type Agent, type Bounty, type SettlementLeg, OpError,
  settlementInstruction, reviewSubmission, liveLegs, unitsToUsdc, nowIso, newId,
} from "./core.js";
import { usdcTransfers, isTxHash, type TxRead } from "./chain.js";

/** Most hashes accepted in one call. Each costs three RPC requests. */
export const MAX_TX_HASHES = 10;

/**
 * A leg can only be paid by a block produced after the leg was issued. The
 * allowance covers the gap between this server's clock and the chain's; the
 * rule exists to stop old transfers being dug up, not to time anyone to the second.
 */
export const LEG_CLOCK_ALLOWANCE_S = 600;

function normaliseHashes(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || list.length > MAX_TX_HASHES)
    throw new OpError(400, `present between 1 and ${MAX_TX_HASHES} transaction hashes`);
  const out: string[] = [];
  for (const h of list) {
    if (!isTxHash(h)) throw new OpError(400, "tx_hash must be a 0x-prefixed 64-hex-character transaction hash");
    const lower = h.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

const describe = (l: SettlementLeg) => `${unitsToUsdc(BigInt(l.units))} USDC to ${l.address}`;
const slotOf = (l: SettlementLeg) => `${l.role}|${l.agent_id}`;

/**
 * Write what a finished settlement leaves behind: one settlements row per
 * recipient and role, the hash on the bounty, and the legs closed so their
 * amounts can be used again. Safe to run twice.
 */
async function recordSettlement(db: Env["DB"], bountyId: string, submissionId: string, paid: SettlementLeg[]) {
  const txHash = [...paid].sort((x, y) => (x.paid_at ?? "").localeCompare(y.paid_at ?? "")).pop()!.paid_tx!;
  const rows = new Map<string, { address: string; role: string; cents: number; tx: string; milestone: string | null }>();
  for (const l of paid) {
    const k = `${l.address}|${l.role}`;
    const r = rows.get(k);
    if (r) r.cents += l.amount_cents;
    else rows.set(k, { address: l.address, role: l.role, cents: l.amount_cents, tx: l.paid_tx!, milestone: l.milestone_id });
  }
  const at = nowIso();
  await db.batch([
    ...[...rows.values()].map((r) =>
      db.prepare(
        `INSERT INTO settlements (id, bounty_id, milestone_id, submission_id, tx_hash, recipient, amount_cents, role, verified_at, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM settlements WHERE submission_id = ? AND recipient = ? AND role = ?)`,
      ).bind(newId("stl"), bountyId, r.milestone, submissionId, r.tx, r.address, r.cents, r.role, at, at, submissionId, r.address, r.role),
    ),
    db.prepare("UPDATE bounties SET settled_tx = ? WHERE id = ?").bind(txHash, bountyId),
    db.prepare("UPDATE settlement_legs SET open = 0 WHERE submission_id = ?").bind(submissionId),
  ]);
  return txHash;
}

export async function settleBounty(
  env: Env,
  agent: Agent,
  bountyId: string,
  submissionId: string,
  txHashRaw: unknown,
  /** Test seam: how a transaction is read. Production always reads Base. */
  opts: { readTx?: (txHash: string) => Promise<TxRead> } = {},
) {
  const db = env.DB;
  const hashes = normaliseHashes(txHashRaw);

  const b = await db.prepare("SELECT * FROM bounties WHERE id = ?").bind(bountyId).first<Bounty>();
  if (!b || b.status === "removed") throw new OpError(404, `no bounty ${bountyId}`);
  if (b.poster_id !== agent.id) throw new OpError(403, "only the bounty poster can settle it");

  // Idempotent: a poster who paid and then lost the response can re-present the
  // same hash. The payment is public and irreversible, so recovery must never
  // depend on them having received our reply. "Settled" means the submission
  // was actually awarded, never merely that rows exist.
  const sub = await db
    .prepare("SELECT status FROM submissions WHERE id = ? AND bounty_id = ?")
    .bind(submissionId, bountyId)
    .first<{ status: string }>();
  if (sub?.status === "accepted") {
    const paid = (await liveLegs(db, submissionId)).filter((l) => l.paid_tx);
    const mine = new Set(paid.map((l) => l.paid_tx!));
    const extra = hashes.filter((h) => !mine.has(h));
    if (extra.length)
      throw new OpError(
        409,
        `this submission is already settled, so ${extra.join(", ")} was not needed and has not been recorded. Nothing further is owed.`,
      );
    // If the request that made the award died before writing its records, finish them now.
    if (paid.length) await recordSettlement(db, bountyId, submissionId, paid);
    return {
      bounty_id: bountyId,
      submission_id: submissionId,
      tx_hash: hashes[hashes.length - 1],
      tx_hashes: hashes,
      already_settled: true,
      submission_status: "accepted",
      note: "This payment was already verified and applied. Nothing was charged twice.",
    };
  }

  // A transaction used before per-transfer records existed is spent as a whole.
  for (const h of hashes) {
    const legacy = await db
      .prepare("SELECT submission_id FROM settlement_payments WHERE tx_hash = ? AND log_index = -1")
      .bind(h)
      .first<{ submission_id: string }>();
    if (legacy) throw new OpError(409, `transaction ${h} was already used to settle a submission; a transaction counts once`);
  }

  // Who must be paid. Recomputed by the board, never taken from the caller, and
  // refused if the submission can no longer be awarded. This may issue a new leg
  // (a payout address change came due), but never retires one: an earlier leg
  // the poster may already have paid stays payable below.
  const instruction = await settlementInstruction(db, env, agent, bountyId, submissionId);
  const slots = instruction.legs.map(slotOf);
  const paidSlot = (legs: SettlementLeg[], slot: string) => legs.find((l) => slotOf(l) === slot && l.paid_tx);

  let legs = await liveLegs(db, submissionId);
  const payable = legs.filter((l) => !l.paid_tx && l.open === 1 && slots.includes(slotOf(l)) && !paidSlot(legs, slotOf(l)));

  const newlyPaid: SettlementLeg[] = [];
  if (payable.length) {
    // No default endpoint. The public mainnet.base.org rate-limits and blocks
    // hard enough to be unusable (429 from the Worker, 403 from a laptop), so
    // falling back to it would turn a missing configuration into a confusing
    // verification failure at the exact moment money has already moved.
    const rpcUrl = env.BASE_RPC_URL;
    if (!opts.readTx && !rpcUrl)
      throw new OpError(503, "no Base RPC endpoint is configured on this board, so payments cannot be verified");
    const readTx = opts.readTx ?? ((h: string) => usdcTransfers(rpcUrl!, h));

    // Read every presented transaction before recording anything.
    const candidates: { hash: string; logIndex: number; to: string; units: bigint; blockTime: number }[] = [];
    for (const h of hashes) {
      const { transfers, blockTime } = await readTx(h);
      for (const t of transfers) {
        if (t.units <= 0n) continue;
        const spent = await db
          .prepare("SELECT 1 AS x FROM settlement_payments WHERE tx_hash = ? AND log_index = ?")
          .bind(h, t.logIndex)
          .first<{ x: number }>();
        if (!spent) candidates.push({ hash: h, logIndex: t.logIndex, to: t.to.toLowerCase(), units: t.units, blockTime });
      }
    }

    // Each recipient still unpaid takes the first unused transfer of exactly the
    // amount of one of its legs, to that leg's address, made after it was issued.
    const taken = new Set<string>();
    const filled = new Set<string>();
    const matches: { leg: SettlementLeg; hash: string; logIndex: number }[] = [];
    for (const leg of payable) {
      if (filled.has(slotOf(leg))) continue;
      const issued = Math.floor(Date.parse(leg.created_at) / 1000) - LEG_CLOCK_ALLOWANCE_S;
      const hit = candidates.find(
        (c) =>
          !taken.has(`${c.hash}:${c.logIndex}`) &&
          c.to === leg.address &&
          c.units === BigInt(leg.units) &&
          c.blockTime >= issued,
      );
      if (!hit) continue;
      taken.add(`${hit.hash}:${hit.logIndex}`);
      filled.add(slotOf(leg));
      matches.push({ leg, hash: hit.hash, logIndex: hit.logIndex });
    }

    if (matches.length) {
      const at = nowIso();
      try {
        // One step. Each payment is written only if its leg can still be paid
        // and its recipient has not been paid meanwhile; the leg is marked only
        // if that payment row went in; and the recipient's other legs are then
        // closed. The primary key refuses a transfer another request recorded
        // a moment ago, and the whole batch is then undone.
        await db.batch(
          matches.flatMap((m) => [
            db.prepare(
              `INSERT INTO settlement_payments (tx_hash, log_index, leg_id, bounty_id, submission_id, verified_at)
               SELECT ?, ?, ?, ?, ?, ?
                WHERE EXISTS (SELECT 1 FROM settlement_legs WHERE id = ? AND open = 1 AND paid_tx IS NULL)
                  AND NOT EXISTS (SELECT 1 FROM settlement_legs WHERE submission_id = ? AND role = ? AND agent_id = ? AND paid_tx IS NOT NULL)`,
            ).bind(m.hash, m.logIndex, m.leg.id, bountyId, submissionId, at, m.leg.id, submissionId, m.leg.role, m.leg.agent_id),
            db.prepare(
              `UPDATE settlement_legs SET paid_tx = ?, paid_log = ?, paid_at = ?
                WHERE id = ? AND open = 1 AND paid_tx IS NULL
                  AND EXISTS (SELECT 1 FROM settlement_payments WHERE tx_hash = ? AND log_index = ? AND leg_id = ?)`,
            ).bind(m.hash, m.logIndex, at, m.leg.id, m.hash, m.logIndex, m.leg.id),
            db.prepare(
              `UPDATE settlement_legs SET open = 0
                WHERE submission_id = ? AND role = ? AND agent_id = ? AND paid_tx IS NULL
                  AND EXISTS (SELECT 1 FROM settlement_legs p WHERE p.id = ? AND p.paid_tx IS NOT NULL)`,
            ).bind(submissionId, m.leg.role, m.leg.agent_id, m.leg.id),
          ]),
        );
      } catch {
        throw new OpError(409, "one of these payments was being recorded by another request. Present the hashes again.");
      }
    }
    legs = await liveLegs(db, submissionId);
    // Report as recorded only what the database now says this call paid.
    for (const m of matches) {
      const now = legs.find((l) => l.id === m.leg.id);
      if (now && now.paid_tx === m.hash && now.paid_log === m.logIndex) newlyPaid.push(now);
    }
  }

  const paid = slots.map((slot) => paidSlot(legs, slot)).filter((l): l is SettlementLeg => !!l);
  if (paid.length < slots.length) {
    // What is still owed, at the recipients' current addresses.
    const unpaid = instruction.legs.filter((l) => !paidSlot(legs, slotOf(l)));
    throw new OpError(
      400,
      (newlyPaid.length
        ? `recorded: ${newlyPaid.map(describe).join("; ")}. `
        : "no transfer in what you presented matches an unpaid amount of this settlement. ") +
        `Still to pay, each as ONE transfer of EXACTLY this amount: ${unpaid.map(describe).join("; ")}. ` +
        (paid.length ? `Already paid and not to be sent again: ${paid.map(describe).join("; ")}. ` : "") +
        "Nothing has been released. Amounts must match to six decimal places; a rounded or different amount is not recognised. " +
        "If you already sent a different amount, do not send it again: contact the operator with the transaction hash.",
    );
  }

  // Every recipient is paid. Make the award; only then does the deliverable come
  // out. If the award cannot be made, nothing claims to be settled: the payments
  // stay recorded against their legs, because the money did move.
  const awardHash = [...paid].sort((x, y) => (x.paid_at ?? "").localeCompare(y.paid_at ?? "")).pop()!.paid_tx!;
  let award;
  try {
    award = await reviewSubmission(db, agent, bountyId, submissionId, "accept", undefined, awardHash, true);
  } catch (e) {
    const now = await db.prepare("SELECT status FROM submissions WHERE id = ?").bind(submissionId).first<{ status: string }>();
    if (now?.status === "accepted")
      throw new OpError(409, "this submission was settled by another request a moment ago. Present the hash again to see the result; nothing further is owed.");
    const holder = await db
      .prepare(
        "SELECT 1 AS x FROM bounties WHERE id = ? AND awarded_submission_id = ? UNION ALL SELECT 1 FROM milestones WHERE bounty_id = ? AND awarded_submission_id = ?",
      )
      .bind(bountyId, submissionId, bountyId, submissionId)
      .first<{ x: number }>();
    if (holder)
      throw new OpError(409, "your payment is verified and recorded, and the award is in progress. Do not pay again. Present the same hash again in a minute.");
    const why = e instanceof OpError ? e.message : "a temporary error";
    throw new OpError(
      e instanceof OpError ? e.status : 503,
      `your payment is verified and recorded, but the award could not be made: ${why}. Nothing has been released. Do not pay again. ` +
        (e instanceof OpError ? "Contact the operator with the transaction hash." : "Present the same hash again in a moment."),
    );
  }
  const txHash = await recordSettlement(db, bountyId, submissionId, paid);

  return {
    ...award,
    settled: true,
    tx_hash: txHash,
    tx_hashes: [...new Set(paid.map((l) => l.paid_tx!))],
    verified_recipients: paid.length,
    settlement: "Payment verified on Base. The deliverable is now released to you.",
  };
}
