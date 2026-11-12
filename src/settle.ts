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
 * when every leg is paid.
 */
import {
  type Env, type Agent, type Bounty, type SettlementLeg, OpError,
  settlementInstruction, reviewSubmission, openLegs, unitsToUsdc, nowIso, newId,
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
  // was actually awarded, not merely that rows exist.
  const sub = await db
    .prepare("SELECT status FROM submissions WHERE id = ? AND bounty_id = ?")
    .bind(submissionId, bountyId)
    .first<{ status: string }>();
  if (sub?.status === "accepted") {
    const used = await db
      .prepare("SELECT DISTINCT tx_hash FROM settlement_payments WHERE submission_id = ?")
      .bind(submissionId)
      .all<{ tx_hash: string }>();
    const mine = new Set((used.results ?? []).map((r) => r.tx_hash));
    const extra = hashes.filter((h) => !mine.has(h));
    if (extra.length)
      throw new OpError(
        409,
        `this submission is already settled, so ${extra.join(", ")} was not needed and has not been recorded. Nothing further is owed.`,
      );
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

  // Issues the legs if they do not exist yet, and refuses if the submission can
  // no longer be awarded. Never taken from the caller.
  await settlementInstruction(db, env, agent, bountyId, submissionId);
  let legs = await openLegs(db, submissionId);
  const unpaidBefore = legs.filter((l) => !l.paid_tx);

  let newlyPaid: SettlementLeg[] = [];
  if (unpaidBefore.length) {
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

    // Each unpaid leg takes the first unused transfer of exactly its amount to
    // its address, made after the leg was issued.
    const taken = new Set<string>();
    const matches: { leg: SettlementLeg; hash: string; logIndex: number }[] = [];
    for (const leg of unpaidBefore) {
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
      matches.push({ leg, hash: hit.hash, logIndex: hit.logIndex });
    }

    if (matches.length) {
      const at = nowIso();
      try {
        // One step. The primary key refuses a transfer another request just
        // recorded, and the whole batch is then undone.
        await db.batch(
          matches.flatMap((m) => [
            db.prepare(
              "INSERT INTO settlement_payments (tx_hash, log_index, leg_id, bounty_id, submission_id, verified_at) VALUES (?, ?, ?, ?, ?, ?)",
            ).bind(m.hash, m.logIndex, m.leg.id, bountyId, submissionId, at),
            db.prepare("UPDATE settlement_legs SET paid_tx = ?, paid_log = ?, paid_at = ? WHERE id = ? AND paid_tx IS NULL AND open = 1")
              .bind(m.hash, m.logIndex, at, m.leg.id),
          ]),
        );
      } catch {
        throw new OpError(409, "one of these payments was being recorded by another request. Present the hashes again.");
      }
      newlyPaid = matches.map((m) => m.leg);
    }
    legs = await openLegs(db, submissionId);
  }

  const unpaid = legs.filter((l) => !l.paid_tx);
  if (unpaid.length) {
    const paid = legs.filter((l) => l.paid_tx);
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

  // Every leg is paid. The hash recorded on the award is the one that paid last.
  const txHash = [...legs].sort((x, y) => (x.paid_at ?? "").localeCompare(y.paid_at ?? "")).pop()!.paid_tx!;
  // One settlement row per recipient and role, even if two legs share an address.
  const rowsByRecipient = new Map<string, { address: string; role: string; cents: number; tx: string; milestone: string | null }>();
  for (const l of legs) {
    const k = `${l.address}|${l.role}`;
    const r = rowsByRecipient.get(k);
    if (r) r.cents += l.amount_cents;
    else rowsByRecipient.set(k, { address: l.address, role: l.role, cents: l.amount_cents, tx: l.paid_tx!, milestone: l.milestone_id });
  }
  const at = nowIso();
  try {
    await db.batch(
      [...rowsByRecipient.values()].map((r) =>
        db.prepare(
          "INSERT INTO settlements (id, bounty_id, milestone_id, submission_id, tx_hash, recipient, amount_cents, role, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(newId("stl"), bountyId, r.milestone, submissionId, r.tx, r.address, r.cents, r.role, at, at),
      ),
    );
  } catch {
    // The unique index on (submission, recipient, role) refused: another request
    // is settling this submission right now.
    throw new OpError(409, "this submission is being settled by another request. Present the hash again in a moment.");
  }

  // Only now — payment verified and recorded — does the deliverable come out.
  // If the award cannot be made, take the settlement rows back out so the
  // records never say "settled" for work that was not released. The payments
  // stay recorded against their legs: the money did move.
  let award;
  try {
    award = await reviewSubmission(db, agent, bountyId, submissionId, "accept", undefined, txHash, true);
  } catch (e) {
    await db.prepare("DELETE FROM settlements WHERE submission_id = ? AND created_at = ?").bind(submissionId, at).run();
    if (e instanceof OpError)
      throw new OpError(
        e.status,
        `your payment is verified and recorded, but the award could not be made: ${e.message}. Nothing has been released. Do not pay again; contact the operator with the transaction hash.`,
      );
    throw e;
  }
  await db.batch([
    db.prepare("UPDATE bounties SET settled_tx = ? WHERE id = ?").bind(txHash, bountyId),
    db.prepare("UPDATE settlement_legs SET open = 0 WHERE submission_id = ?").bind(submissionId),
  ]);

  return {
    ...award,
    settled: true,
    tx_hash: txHash,
    tx_hashes: [...new Set(legs.map((l) => l.paid_tx!))],
    verified_recipients: legs.length,
    settlement: "Payment verified on Base. The deliverable is now released to you.",
  };
}
