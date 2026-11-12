/**
 * On-chain settlement: verify a payment, then release the deliverable.
 *
 * The order is the whole design. Because the board already seals submissions
 * until award, the poster cannot obtain the answer without paying — so payment
 * can come FIRST and the board simply reacts to it. That removes the oracle
 * problem entirely: nothing needs to attest that an award happened, and nobody
 * holds a release key. The board reads the chain and updates its own records.
 *
 * Two rules decide whether a transaction counts:
 *
 *  - It is the poster's own. Only USDC that left a wallet the poster registered
 *    before the block was produced is counted. A payment is public, so without
 *    this any poster could present someone else's payment to the same agent.
 *  - It is used once. A transaction hash is recorded against one submission and
 *    can never count toward another.
 *
 * A settlement may be paid across several transactions. Each verified one is
 * recorded as it is presented and the amounts are added up; the deliverable is
 * released when every recipient is covered.
 */
import {
  type Env, type Agent, type Bounty, OpError,
  settlementInstruction, reviewSubmission, payerWallets, nowIso, newId, UNITS_PER_CENT,
} from "./core.js";
import { usdcTransfers, coversPayouts, isTxHash, type TxRead } from "./chain.js";

/** Most hashes accepted in one call. Each costs three RPC requests. */
export const MAX_TX_HASHES = 10;

type PaymentRow = { tx_hash: string; submission_id: string; transfers: string };
type Counted = { to: string; units: bigint };

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

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

function parseCounted(json: string): Counted[] {
  const arr = JSON.parse(json) as { to: string; units: string }[];
  return arr.map((t) => ({ to: String(t.to).toLowerCase(), units: BigInt(t.units) }));
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

  // What do we already know about these hashes? A hash recorded against any
  // other submission is refused outright, whoever presents it.
  const known = new Map<string, PaymentRow>();
  for (const h of hashes) {
    const row = await db
      .prepare("SELECT tx_hash, submission_id, transfers FROM settlement_payments WHERE tx_hash = ?")
      .bind(h)
      .first<PaymentRow>();
    if (!row) continue;
    if (row.submission_id !== submissionId)
      throw new OpError(409, `transaction ${h} was already used to settle a different submission; a transaction counts once`);
    known.set(h, row);
  }
  const fresh = hashes.filter((h) => !known.has(h));

  // Idempotent: a poster who paid and then lost the response can re-present the
  // same hash. The payment is public and irreversible, so recovery must never
  // depend on them having received our reply.
  const done = await db
    .prepare("SELECT COUNT(*) AS n FROM settlements WHERE submission_id = ?")
    .bind(submissionId)
    .first<{ n: number }>();
  if ((done?.n ?? 0) > 0) {
    if (fresh.length)
      throw new OpError(
        409,
        `this submission is already settled, so ${fresh.join(", ")} was not needed and has not been recorded. Nothing further is owed.`,
      );
    const sub = await db.prepare("SELECT status FROM submissions WHERE id = ?").bind(submissionId).first<{ status: string }>();
    return {
      bounty_id: bountyId,
      submission_id: submissionId,
      tx_hash: hashes[hashes.length - 1],
      tx_hashes: hashes,
      already_settled: true,
      submission_status: sub?.status ?? "unknown",
      note: "This payment was already verified and applied. Nothing was charged twice.",
    };
  }

  // Recomputed, never taken from the caller: the instruction the board verifies
  // against must be the one the board issued.
  const instruction = await settlementInstruction(db, env, agent, bountyId, submissionId);
  const wallets = await payerWallets(db, agent.id);

  if (fresh.length) {
    // No default endpoint. The public mainnet.base.org rate-limits and blocks
    // hard enough to be unusable (429 from the Worker, 403 from a laptop), so
    // falling back to it would turn a missing configuration into a confusing
    // verification failure at the exact moment money has already moved.
    const rpcUrl = env.BASE_RPC_URL;
    if (!opts.readTx && !rpcUrl)
      throw new OpError(503, "no Base RPC endpoint is configured on this board, so payments cannot be verified");
    const readTx = opts.readTx ?? ((h: string) => usdcTransfers(rpcUrl!, h));

    // Verify every new hash before recording any, so a bad one records nothing.
    const verified: { hash: string; blockTime: number; counted: Counted[] }[] = [];
    for (const h of fresh) {
      const { transfers, blockTime } = await readTx(h);
      if (!transfers.length)
        throw new OpError(
          400,
          `transaction ${h} contains no USDC transfers on Base. Check you paid in native USDC (not bridged USDbC) on the right network.`,
        );
      // Count only what left one of the poster's wallets, and only if that
      // wallet was registered before the block. Registering after the fact
      // would let someone claim a payment they watched go by.
      const eligible = new Set(
        wallets.filter((w) => Math.floor(Date.parse(w.registered_at) / 1000) <= blockTime).map((w) => w.address),
      );
      const counted = transfers
        .filter((t) => eligible.has(t.from.toLowerCase()))
        .map((t) => ({ to: t.to.toLowerCase(), units: t.units }));
      if (!counted.length)
        throw new OpError(
          400,
          `none of the USDC in transaction ${h} was sent from a wallet you registered before paying (${wallets.map((w) => w.address).join(", ")}). ` +
            "The board only counts payments from your own registered wallet, so that nobody else can present your payment as theirs. Nothing has been recorded or released.",
        );
      verified.push({ hash: h, blockTime, counted });
    }

    const at = nowIso();
    try {
      await db.batch(
        verified.map((v) =>
          db.prepare(
            "INSERT INTO settlement_payments (tx_hash, bounty_id, submission_id, poster_id, block_time, transfers, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            v.hash, bountyId, submissionId, agent.id, v.blockTime,
            JSON.stringify(v.counted.map((c) => ({ to: c.to, units: c.units.toString() }))), at,
          ),
        ),
      );
    } catch {
      // The primary key on tx_hash refused a row: another request recorded one
      // of these hashes between our check and our insert.
      throw new OpError(409, "one of these transactions was recorded by another request just now. Present the hashes again.");
    }
  }

  // Add up everything recorded for this submission, not just what was presented
  // in this call: earlier partial payments count.
  const rows = await db
    .prepare("SELECT tx_hash, submission_id, transfers FROM settlement_payments WHERE submission_id = ? ORDER BY verified_at, tx_hash")
    .bind(submissionId)
    .all<PaymentRow>();
  const all = (rows.results ?? []).flatMap((r) => parseCounted(r.transfers));
  const check = coversPayouts(all, instruction.recipients);
  if (!check.ok) {
    const shortfall = check.missing
      .map((m) => {
        const paid = all.filter((t) => t.to === m.address.toLowerCase()).reduce((a, t) => a + t.units, 0n);
        const owed = BigInt(m.owed_cents) * UNITS_PER_CENT;
        const stillCents = Number((owed - paid + UNITS_PER_CENT - 1n) / UNITS_PER_CENT);
        return `${m.address} is owed ${usd(m.owed_cents)}, has ${usd(m.paid_cents)}, needs ${usd(stillCents)} more`;
      })
      .join("; ");
    throw new OpError(
      400,
      `payment so far does not cover the settlement: ${shortfall}. ` +
        (fresh.length
          ? "What you have paid is recorded and will count. "
          : "") +
        "Nothing has been released. Send ONLY the amounts still needed, from your registered wallet, and present that transaction's hash. Do not pay the full amounts again.",
    );
  }

  // The hash recorded on the award: the one that completed the payment.
  const txHash = fresh.length ? fresh[fresh.length - 1] : hashes[hashes.length - 1];
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
    tx_hashes: (rows.results ?? []).map((r) => r.tx_hash),
    verified_recipients: instruction.recipients.length,
    settlement: "Payment verified on Base. The deliverable is now released to you.",
  };
}
