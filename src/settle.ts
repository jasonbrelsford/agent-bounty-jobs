/**
 * On-chain settlement: verify a payment, then release the deliverable.
 *
 * The order is the whole design. Because the board already seals submissions
 * until award, the poster cannot obtain the answer without paying — so payment
 * can come FIRST and the board simply reacts to it. That removes the oracle
 * problem entirely: nothing needs to attest that an award happened, and nobody
 * holds a release key. The board reads the chain and updates its own records.
 */
import {
  type Env, type Agent, type Bounty, type Submission, OpError,
  settlementInstruction, reviewSubmission, nowIso, newId,
} from "./core.js";
import { usdcTransfers, coversPayouts, isTxHash } from "./chain.js";

const RPC_DEFAULT = "https://mainnet.base.org";

export async function settleBounty(
  env: Env,
  agent: Agent,
  bountyId: string,
  submissionId: string,
  txHashRaw: unknown,
) {
  const db = env.DB;
  if (!isTxHash(txHashRaw)) throw new OpError(400, "tx_hash must be a 0x-prefixed 64-hex-character transaction hash");
  const txHash = txHashRaw.toLowerCase();

  const b = await db.prepare("SELECT * FROM bounties WHERE id = ?").bind(bountyId).first<Bounty>();
  if (!b || b.status === "removed") throw new OpError(404, `no bounty ${bountyId}`);
  if (b.poster_id !== agent.id) throw new OpError(403, "only the bounty poster can settle it");

  // Idempotent: a poster who paid and then lost the response can re-present the
  // same hash. The payment is public and irreversible, so recovery must never
  // depend on them having received our reply.
  const already = await db
    .prepare("SELECT COUNT(*) AS n FROM settlements WHERE tx_hash = ? AND submission_id = ?")
    .bind(txHash, submissionId)
    .first<{ n: number }>();
  if ((already?.n ?? 0) > 0) {
    const sub = await db.prepare("SELECT status FROM submissions WHERE id = ?").bind(submissionId).first<{ status: string }>();
    return {
      bounty_id: bountyId,
      submission_id: submissionId,
      tx_hash: txHash,
      already_settled: true,
      submission_status: sub?.status ?? "unknown",
      note: "This transaction was already verified and applied. Nothing was charged twice.",
    };
  }

  // Recomputed, never taken from the caller: the instruction the board verifies
  // against must be the one the board issued.
  const instruction = await settlementInstruction(db, env, agent, bountyId, submissionId);

  const transfers = await usdcTransfers(env.BASE_RPC_URL || RPC_DEFAULT, txHash);
  if (!transfers.length)
    throw new OpError(
      400,
      "that transaction contains no USDC transfers on Base. Check you paid in native USDC (not bridged USDbC) on the right network.",
    );

  const check = coversPayouts(transfers, instruction.recipients);
  if (!check.ok)
    throw new OpError(
      400,
      "payment does not cover the settlement: " +
        check.missing
          .map((m) => `${m.address} owed $${(m.owed_cents / 100).toFixed(2)}, paid $${(m.paid_cents / 100).toFixed(2)}`)
          .join("; ") +
        ". Nothing has been released. Pay the shortfall and present the new hash.",
    );

  const at = nowIso();
  await db.batch(
    instruction.recipients.map((r) =>
      db.prepare(
        "INSERT INTO settlements (id, bounty_id, milestone_id, submission_id, tx_hash, recipient, amount_cents, role, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(newId("stl"), bountyId, instruction.milestone_id, submissionId, txHash, r.address, r.amount_cents, r.role, at, at),
    ),
  );

  // Only now — payment verified and recorded — does the deliverable come out.
  const award = await reviewSubmission(db, agent, bountyId, submissionId, "accept", undefined, txHash, true);
  await db.prepare("UPDATE bounties SET settled_tx = ? WHERE id = ?").bind(txHash, bountyId).run();

  return {
    ...award,
    settled: true,
    tx_hash: txHash,
    verified_recipients: instruction.recipients.length,
    settlement: "Payment verified on Base. The deliverable is now released to you.",
  };
}
