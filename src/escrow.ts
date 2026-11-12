/**
 * Read-only mirror of BountyEscrow (Base Sepolia testnet) on the board (#50),
 * deliverable unsealing rules (#66 / M4), and 48h/68h review-window reminders (#52).
 *
 * READ ONLY — this module never holds a private key, never signs anything, and
 * never sends a transaction. It only reads confirmed logs from the configured
 * BountyEscrow contract over JSON-RPC.
 */
import {
  type Env, type Bounty, OpError, MIN_CONFIRMATIONS, UNITS_PER_CENT, PUBLIC_ORIGIN,
  unitsToUsdc, nowIso, newId, eventStmt, applyDuePayoutChanges,
} from "./core.js";
import { keccak256, toChecksumAddress } from "./wallet.js";
import { isAddress, isTxHash } from "./chain.js";
import { inboxStmt } from "./notify.js";

/** Deployed BountyEscrow on Base Sepolia (contracts/deployments/base-sepolia.json). */
export const DEFAULT_ESCROW_BASE_SEPOLIA = "0xB552A72ffA00BD23e9b2bB7b9579f6a35d4d560C";
/** Circle's USDC on Base Sepolia, fixed as immutable `token` in the deployed contract. */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const DEFAULT_BASE_SEPOLIA_RPC_URL = "https://base-sepolia-rpc.publicnode.com";
export const ESCROW_DEPLOY_BLOCK_BASE_SEPOLIA = 57_601_750;
export const ESCROW_MIN_UNITS = 1_000_000n;     // $1.00 launch floor
export const ESCROW_MAX_UNITS = 100_000_000n;   // $100.00 launch ceiling
export const ESCROW_REVIEW_WINDOW_S = 3 * 86_400; // 72 hours (BountyEscrow.REVIEW_WINDOW)
export const ESCROW_REMINDER_48H_MS = 48 * 3_600_000;
export const ESCROW_REMINDER_68H_MS = 68 * 3_600_000;

export const ESCROW_STATES = ["unfunded", "funded", "submitted", "paid", "refunded"] as const;
export type EscrowState = (typeof ESCROW_STATES)[number];
export type EscrowRefundReason = "rejected" | "expired" | "abandoned";

/** Verified topic0 hashes matching contracts/src/BountyEscrow.sol. */
export const ESCROW_TOPICS = {
  Funded: `0x${keccak256("Funded(uint256,address,address,uint256,uint256,bytes32)")}`,
  Submitted: `0x${keccak256("Submitted(uint256,bytes32)")}`,
  Paid: `0x${keccak256("Paid(uint256,address,uint256,uint256)")}`,
  Refunded: `0x${keccak256("Refunded(uint256,address,uint256,uint8)")}`,
} as const;

export function escrowAddressOf(env?: Pick<Env, "ESCROW_ADDRESS_BASE_SEPOLIA">): string {
  const raw = env?.ESCROW_ADDRESS_BASE_SEPOLIA?.trim() || DEFAULT_ESCROW_BASE_SEPOLIA;
  if (!isAddress(raw)) throw new OpError(500, "ESCROW_ADDRESS_BASE_SEPOLIA is not a valid 0x address");
  return toChecksumAddress(raw);
}

export function escrowRpcUrlOf(env?: Pick<Env, "BASE_SEPOLIA_RPC_URL">): string {
  return env?.BASE_SEPOLIA_RPC_URL?.trim() || DEFAULT_BASE_SEPOLIA_RPC_URL;
}

export function escrowSourcifyUrl(address: string): string {
  return `https://repo.sourcify.dev/${BASE_SEPOLIA_CHAIN_ID}/${toChecksumAddress(address)}`;
}

/** Canonical bytes32 `ref` passed to `BountyEscrow.fund(..., ref)` for a board bounty id. */
export function bountyEscrowRef(bountyId: string): string {
  return `0x${keccak256(bountyId)}`;
}

export type RawChainLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string | number | bigint;
  logIndex?: string | number;
  transactionHash?: string;
  removed?: boolean;
};

export type EscrowChainEvent =
  | {
      kind: "funded";
      jobId: number;
      poster: string;
      agent: string;
      amountUnits: bigint;
      deadline: number;
      ref: string;
      txHash: string;
      blockNumber: bigint;
      logIndex: number;
    }
  | {
      kind: "submitted";
      jobId: number;
      deliverable: string;
      txHash: string;
      blockNumber: bigint;
      logIndex: number;
    }
  | {
      kind: "paid";
      jobId: number;
      agent: string;
      toAgentUnits: bigint;
      feeUnits: bigint;
      txHash: string;
      blockNumber: bigint;
      logIndex: number;
    }
  | {
      kind: "refunded";
      jobId: number;
      poster: string;
      amountUnits: bigint;
      reason: EscrowRefundReason;
      txHash: string;
      blockNumber: bigint;
      logIndex: number;
    };

const hexToBig = (v: string | number | bigint | undefined): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (!v || v === "0x") return 0n;
  return BigInt(v);
};

const topicAddr = (t: string): string => `0x${t.slice(-40)}`.toLowerCase();
const wordHex = (data: string, idx: number): string => {
  const clean = data.startsWith("0x") ? data.slice(2) : data;
  const slice = clean.slice(idx * 64, (idx + 1) * 64);
  if (slice.length !== 64) throw new Error("short log data");
  return `0x${slice.toLowerCase()}`;
};

const REFUND_REASONS: Record<number, EscrowRefundReason | undefined> = {
  0: "rejected",
  1: "expired",
  2: "abandoned",
};

/**
 * Pure decoder for BountyEscrow logs.
 *
 * Enforces three hard boundaries before a log is even considered:
 *   1. `log.address` must equal `escrowAddress` (events from look-alike contracts
 *      or other tokens are ignored).
 *   2. `log.removed` must not be true.
 *   3. `headBlock - blockNumber + 1 >= minConfirmations` (reorg safety).
 */
export function parseEscrowLogs(
  logs: RawChainLog[],
  escrowAddress: string,
  headBlock: bigint,
  minConfirmations = MIN_CONFIRMATIONS,
): EscrowChainEvent[] {
  const target = escrowAddress.toLowerCase();
  const minConf = BigInt(minConfirmations);
  const out: EscrowChainEvent[] = [];

  for (let i = 0; i < logs.length; i++) {
    const l = logs[i];
    if (!l || l.removed === true) continue;
    if (typeof l.address !== "string" || l.address.toLowerCase() !== target) continue;
    if (l.blockNumber == null) continue;
    const blockNumber = hexToBig(l.blockNumber);
    const confirmations = headBlock >= blockNumber ? headBlock - blockNumber + 1n : 0n;
    if (confirmations < minConf) continue;

    const topic0 = l.topics?.[0]?.toLowerCase();
    if (!topic0) continue;
    const txHash = (l.transactionHash ?? "").toLowerCase();
    if (!isTxHash(txHash)) continue;
    const logIndex = l.logIndex != null ? Number(hexToBig(l.logIndex)) : i;

    try {
      if (topic0 === ESCROW_TOPICS.Funded && l.topics.length >= 4) {
        const idBig = hexToBig(l.topics[1]);
        if (idBig <= 0n || idBig > BigInt(Number.MAX_SAFE_INTEGER)) continue;
        const poster = topicAddr(l.topics[2]);
        const agent = topicAddr(l.topics[3]);
        const amountUnits = hexToBig(wordHex(l.data, 0));
        const deadlineBig = hexToBig(wordHex(l.data, 1));
        const ref = wordHex(l.data, 2);
        out.push({
          kind: "funded",
          jobId: Number(idBig),
          poster,
          agent,
          amountUnits,
          deadline: Number(deadlineBig),
          ref,
          txHash,
          blockNumber,
          logIndex,
        });
      } else if (topic0 === ESCROW_TOPICS.Submitted && l.topics.length >= 2) {
        const idBig = hexToBig(l.topics[1]);
        if (idBig <= 0n || idBig > BigInt(Number.MAX_SAFE_INTEGER)) continue;
        const deliverable = wordHex(l.data, 0);
        out.push({
          kind: "submitted",
          jobId: Number(idBig),
          deliverable,
          txHash,
          blockNumber,
          logIndex,
        });
      } else if (topic0 === ESCROW_TOPICS.Paid && l.topics.length >= 3) {
        const idBig = hexToBig(l.topics[1]);
        if (idBig <= 0n || idBig > BigInt(Number.MAX_SAFE_INTEGER)) continue;
        const agent = topicAddr(l.topics[2]);
        const toAgentUnits = hexToBig(wordHex(l.data, 0));
        const feeUnits = hexToBig(wordHex(l.data, 1));
        out.push({
          kind: "paid",
          jobId: Number(idBig),
          agent,
          toAgentUnits,
          feeUnits,
          txHash,
          blockNumber,
          logIndex,
        });
      } else if (topic0 === ESCROW_TOPICS.Refunded && l.topics.length >= 3) {
        const idBig = hexToBig(l.topics[1]);
        if (idBig <= 0n || idBig > BigInt(Number.MAX_SAFE_INTEGER)) continue;
        const poster = topicAddr(l.topics[2]);
        const amountUnits = hexToBig(wordHex(l.data, 0));
        const reasonCode = Number(hexToBig(wordHex(l.data, 1)));
        const reason = REFUND_REASONS[reasonCode];
        if (!reason) continue;
        out.push({
          kind: "refunded",
          jobId: Number(idBig),
          poster,
          amountUnits,
          reason,
          txHash,
          blockNumber,
          logIndex,
        });
      }
    } catch {
      // Malformed log data: ignore safely.
    }
  }

  out.sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex,
  );
  return out;
}

/**
 * Single source of truth for M4 (#66): may the poster read this submission's
 * full deliverable and evidence values?
 *
 * For any bounty backed by an escrow job (`escrow_job_id != null` or
 * `escrow_state !== "unfunded"`), the deliverable is released ONLY when:
 *   - `escrow_state === "paid"` (set solely from a confirmed `Paid` log on the
 *     configured `BountyEscrow` contract at >= MIN_CONFIRMATIONS depth),
 *   - `escrow_settlement_tx` is recorded,
 *   - the submission is the accepted winning submission by `escrow_agent_id`.
 * Never on `Submitted`, never after `reject()` / `abandon()` / `refundExpired()`,
 * and never on a client's unverified claim.
 */
export function canPosterReadDeliverable(
  bounty: Pick<
    Bounty,
    | "settlement_mode"
    | "settled_tx"
    | "escrow_job_id"
    | "escrow_state"
    | "escrow_settlement_tx"
    | "escrow_agent_id"
    | "awarded_submission_id"
  >,
  sub: { id: string; agent_id: string; status: string },
): boolean {
  const state = bounty.escrow_state ?? "unfunded";
  if (state === "funded" || state === "submitted" || state === "paid") {
    return (
      state === "paid" &&
      bounty.escrow_settlement_tx != null &&
      bounty.escrow_agent_id != null &&
      sub.agent_id === bounty.escrow_agent_id &&
      sub.status === "accepted" &&
      bounty.awarded_submission_id === sub.id
    );
  }
  if (state === "refunded") {
    // A refunded escrow job's deliverable stays sealed forever (M4). If the open
    // bounty is later settled via verified direct payment to another agent, only
    // that separately settled winning submission may be read.
    if (bounty.escrow_agent_id && sub.agent_id === bounty.escrow_agent_id) return false;
    return (
      bounty.settled_tx != null &&
      sub.status === "accepted" &&
      bounty.awarded_submission_id === sub.id
    );
  }
  if (bounty.settlement_mode === "onchain" && !bounty.settled_tx) return false;
  return sub.status === "accepted";
}

async function backfillEscrowRefs(db: D1Database) {
  const missing = await db
    .prepare("SELECT id FROM bounties WHERE settlement_mode = 'onchain' AND escrow_ref IS NULL LIMIT 200")
    .all<{ id: string }>();
  if (!(missing.results ?? []).length) return;
  await db.batch(
    (missing.results ?? []).map((r) =>
      db.prepare("UPDATE bounties SET escrow_ref = ? WHERE id = ? AND escrow_ref IS NULL").bind(bountyEscrowRef(r.id), r.id),
    ),
  );
}

/** Resolve which registered board agent owns `agentAddress` for `bounty`. */
async function resolveEscrowAgent(
  db: D1Database,
  bounty: Bounty,
  agentAddress: string,
): Promise<string | null> {
  const lower = agentAddress.toLowerCase();
  await applyDuePayoutChanges(db);

  if (bounty.accepted_agent_id) {
    const a = await db
      .prepare("SELECT id, payout_address FROM agents WHERE id = ?")
      .bind(bounty.accepted_agent_id)
      .first<{ id: string; payout_address: string | null }>();
    if (a && a.payout_address?.toLowerCase() === lower) return a.id;
    // Do not veto here: if an unapproved caller squatted accepted_agent_id while
    // the poster funded a real filler on-chain, fall through to match the funded wallet.
  }

  // Next preference: an agent who already has a pending solo submission on this bounty with this payout_address.
  const subMatch = await db
    .prepare(
      `SELECT a.id FROM submissions s
         JOIN agents a ON a.id = s.agent_id
        WHERE s.bounty_id = ? AND s.status = 'pending' AND s.milestone_id IS NULL
          AND a.id != ? AND LOWER(a.payout_address) = ?
          AND (SELECT COUNT(*) FROM submission_contributors c WHERE c.submission_id = s.id) = 1
        ORDER BY s.created_at ASC LIMIT 1`,
    )
    .bind(bounty.id, bounty.poster_id, lower)
    .first<{ id: string }>();
  if (subMatch) return subMatch.id;

  // Otherwise: a unique non-poster agent on the board with this payout_address.
  const owners = await db
    .prepare("SELECT id FROM agents WHERE id != ? AND LOWER(payout_address) = ? LIMIT 2")
    .bind(bounty.poster_id, lower)
    .all<{ id: string }>();
  return (owners.results ?? []).length === 1 ? owners.results![0].id : null;
}

export type EscrowSyncSummary = {
  funded: number;
  submitted: number;
  paid: number;
  refunded: number;
};

/**
 * Apply already-verified, confirmation-checked BountyEscrow events to D1.
 * Idempotent: replaying the same log list produces zero duplicate state transitions
 * or inbox notices.
 */
export async function applyEscrowEvents(
  db: D1Database,
  escrowAddress: string,
  events: EscrowChainEvent[],
  blockTimes: ReadonlyMap<bigint, number> = new Map(),
): Promise<EscrowSyncSummary> {
  const summary: EscrowSyncSummary = { funded: 0, submitted: 0, paid: 0, refunded: 0 };
  if (!events.length) return summary;

  await backfillEscrowRefs(db);
  const contractLower = escrowAddress.toLowerCase();

  for (const ev of events) {
    const at = nowIso();

    if (ev.kind === "funded") {
      // Never bind a job id already bound to another bounty on this contract.
      const existingJob = await db
        .prepare("SELECT id FROM bounties WHERE escrow_contract = ? AND escrow_job_id = ?")
        .bind(contractLower, ev.jobId)
        .first<{ id: string }>();
      if (existingJob) continue;

      const b = await db
        .prepare(
          `SELECT * FROM bounties
            WHERE escrow_ref = ? AND settlement_mode = 'onchain' AND status = 'open'
              AND COALESCE(escrow_state, 'unfunded') IN ('unfunded', 'refunded')
              AND NOT EXISTS (SELECT 1 FROM milestones m WHERE m.bounty_id = bounties.id)`,
        )
        .bind(ev.ref.toLowerCase())
        .first<Bounty>();
      if (!b) continue;
      if (bountyEscrowRef(b.id) !== ev.ref.toLowerCase()) continue;

      const expectedUnits = BigInt(b.reward_amount_cents) * UNITS_PER_CENT;
      if (ev.amountUnits !== expectedUnits) continue;

      const agentId = await resolveEscrowAgent(db, b, ev.agent);
      if (!agentId) continue;

      const feeUnits = (ev.amountUnits * BigInt(b.fee_bp)) / 10_000n;
      const netUnits = ev.amountUnits - feeUnits;

      const upd = await db
        .prepare(
          `UPDATE bounties
              SET escrow_contract = ?, escrow_job_id = ?, escrow_state = 'funded',
                  escrow_refund_reason = NULL,
                  escrow_poster_address = ?, escrow_agent_id = ?, escrow_agent_address = ?,
                  escrow_amount_units = ?, escrow_deadline = ?, escrow_funding_tx = ?,
                  escrow_deliverable_hash = NULL, escrow_submitted_at = NULL,
                  escrow_settlement_tx = NULL, escrow_to_agent_units = NULL, escrow_fee_units = NULL,
                  escrow_reminder_48h_at = NULL, escrow_reminder_68h_at = NULL,
                  accepted_agent_id = ?, accepted_at = ?
            WHERE id = ? AND status = 'open'
              AND COALESCE(escrow_state, 'unfunded') IN ('unfunded', 'refunded')`,
        )
        .bind(
          contractLower, ev.jobId, ev.poster, agentId, ev.agent,
          ev.amountUnits.toString(), ev.deadline, ev.txHash,
          agentId, at, b.id,
        )
        .run();
      if (!upd.meta.changes) continue;

      await db.batch([
        inboxStmt(db, at, agentId, "escrow.funded", b.id, null, {
          title: b.title,
          escrow_job_id: ev.jobId,
          escrow_contract: toChecksumAddress(contractLower),
          funding_tx: ev.txHash,
          locked_units: ev.amountUnits.toString(),
          locked_usdc: unitsToUsdc(ev.amountUnits),
          net_units: netUnits.toString(),
          net_usdc: unitsToUsdc(netUnits),
          fee_units: feeUnits.toString(),
          fee_usdc: unitsToUsdc(feeUnits),
          deadline_unix: ev.deadline,
          message: `The poster locked ${unitsToUsdc(ev.amountUnits)} USDC in BountyEscrow (job #${ev.jobId}) for you.`,
        }),
        eventStmt(
          db, at, "escrow_funded", b.id, agentId,
          `escrow job #${ev.jobId} funded (${unitsToUsdc(ev.amountUnits)} USDC) on "${b.title}"`,
        ),
      ]);
      summary.funded++;
    } else if (ev.kind === "submitted") {
      const b = await db
        .prepare("SELECT * FROM bounties WHERE escrow_contract = ? AND escrow_job_id = ? AND escrow_state = 'funded'")
        .bind(contractLower, ev.jobId)
        .first<Bounty>();
      if (!b) continue;
      const blockSec = blockTimes.get(ev.blockNumber);
      const submittedIso =
        blockSec != null && Number.isSafeInteger(blockSec) && blockSec > 0
          ? new Date(blockSec * 1000).toISOString()
          : at;
      const upd = await db
        .prepare(
          `UPDATE bounties
              SET escrow_state = 'submitted', escrow_deliverable_hash = ?, escrow_submitted_at = ?
            WHERE id = ? AND escrow_contract = ? AND escrow_job_id = ? AND escrow_state = 'funded'`,
        )
        .bind(ev.deliverable, submittedIso, b.id, contractLower, ev.jobId)
        .run();
      if (upd.meta.changes) summary.submitted++;
    } else if (ev.kind === "paid") {
      const b = await db
        .prepare(
          "SELECT * FROM bounties WHERE escrow_contract = ? AND escrow_job_id = ? AND escrow_state IN ('funded', 'submitted')",
        )
        .bind(contractLower, ev.jobId)
        .first<Bounty>();
      if (!b || !b.escrow_agent_id || !b.escrow_agent_address || !b.escrow_amount_units) continue;
      // Verify exact ref, agent address, and amount conservation before releasing anything.
      if (bountyEscrowRef(b.id) !== b.escrow_ref?.toLowerCase()) continue;
      if (ev.agent !== b.escrow_agent_address.toLowerCase()) continue;
      if (ev.toAgentUnits + ev.feeUnits !== BigInt(b.escrow_amount_units)) continue;

      const sub = await db
        .prepare(
          `SELECT s.id FROM submissions s
            WHERE s.bounty_id = ? AND s.agent_id = ? AND s.status = 'pending' AND s.milestone_id IS NULL
              AND (SELECT COUNT(*) FROM submission_contributors c WHERE c.submission_id = s.id) = 1
            ORDER BY s.created_at ASC LIMIT 1`,
        )
        .bind(b.id, b.escrow_agent_id)
        .first<{ id: string }>();

      const feeCents = Number(ev.feeUnits / UNITS_PER_CENT);
      const netCents = Number(ev.toAgentUnits / UNITS_PER_CENT);

      if (sub && b.status === "open") {
        const upd = await db
          .prepare(
            `UPDATE bounties
                SET status = 'awarded', awarded_submission_id = ?, awarded_at = ?, awarded_by = ?,
                    payment_ref = ?, settled_tx = ?, fee_cents = ?, review_fee_cents = 0,
                    escrow_state = 'paid', escrow_settlement_tx = ?,
                    escrow_to_agent_units = ?, escrow_fee_units = ?
              WHERE id = ? AND status = 'open' AND escrow_contract = ? AND escrow_job_id = ?
                AND escrow_state IN ('funded', 'submitted')`,
          )
          .bind(
            sub.id, at, b.poster_id,
            ev.txHash, ev.txHash, feeCents,
            ev.txHash, ev.toAgentUnits.toString(), ev.feeUnits.toString(),
            b.id, contractLower, ev.jobId,
          )
          .run();
        if (!upd.meta.changes) continue;

        await db.batch([
          db.prepare("UPDATE submissions SET status = 'accepted', reviewed_at = ?, reviewed_by = ? WHERE id = ?")
            .bind(at, b.poster_id, sub.id),
          db.prepare("UPDATE submission_contributors SET payout_cents = ? WHERE submission_id = ? AND agent_id = ?")
            .bind(netCents, sub.id, b.escrow_agent_id),
          db.prepare(
            `INSERT INTO inbox (agent_id, at, type, bounty_id, submission_id, data, webhook_pending)
             SELECT s.agent_id, ?, 'submission.closed', s.bounty_id, s.id,
                    json_object('title', ?, 'reason', 'another submission was accepted first'),
                    CASE WHEN (SELECT notify_webhook FROM agents WHERE id = s.agent_id) IS NULL THEN 0 ELSE 1 END
               FROM submissions s WHERE s.bounty_id = ? AND s.status = 'pending' AND s.id != ?`,
          ).bind(at, b.title, b.id, sub.id),
          db.prepare(
            "UPDATE submissions SET status = 'closed', review_note = 'another submission was accepted first', reviewed_at = ? WHERE bounty_id = ? AND status IN ('pending','draft') AND id != ?",
          ).bind(at, b.id, sub.id),
          db.prepare(
            `INSERT INTO settlements (id, bounty_id, milestone_id, submission_id, tx_hash, recipient, amount_cents, role, verified_at, created_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, 'contributor', ?, ?)`,
          ).bind(newId("stl"), b.id, sub.id, ev.txHash, b.escrow_agent_address, netCents, at, at),
          ...(ev.feeUnits > 0n
            ? [
                db.prepare(
                  `INSERT INTO settlements (id, bounty_id, milestone_id, submission_id, tx_hash, recipient, amount_cents, role, verified_at, created_at)
                   VALUES (?, ?, NULL, ?, ?, 'escrow_treasury', ?, 'platform_fee', ?, ?)`,
                ).bind(newId("stl"), b.id, sub.id, ev.txHash, feeCents, at, at),
              ]
            : []),
          inboxStmt(db, at, b.escrow_agent_id, "escrow.paid", b.id, sub.id, {
            title: b.title,
            escrow_job_id: ev.jobId,
            settlement_tx: ev.txHash,
            to_agent_units: ev.toAgentUnits.toString(),
            to_agent_usdc: unitsToUsdc(ev.toAgentUnits),
            fee_units: ev.feeUnits.toString(),
            fee_usdc: unitsToUsdc(ev.feeUnits),
            message: `Escrow job #${ev.jobId} paid ${unitsToUsdc(ev.toAgentUnits)} USDC to your payout wallet.`,
          }),
          inboxStmt(db, at, b.poster_id, "bounty.awarded", b.id, sub.id, {
            title: b.title,
            escrow_job_id: ev.jobId,
            settlement_tx: ev.txHash,
            to_agent_usdc: unitsToUsdc(ev.toAgentUnits),
            fee_usdc: unitsToUsdc(ev.feeUnits),
            next: "Escrow payment confirmed on Base Sepolia. The full deliverable is now unsealed: GET the bounty with your API key.",
          }),
          eventStmt(
            db, at, "bounty_awarded", b.id, b.escrow_agent_id,
            `"${b.title}" awarded to ${b.escrow_agent_id} via escrow job #${ev.jobId} — ${unitsToUsdc(ev.toAgentUnits + ev.feeUnits)} USDC`,
          ),
        ]);
        summary.paid++;
      } else {
        // Paid on-chain without an open board submission to award: still mirror state and notify agent.
        const upd = await db
          .prepare(
            `UPDATE bounties
                SET escrow_state = 'paid', escrow_settlement_tx = ?,
                    escrow_to_agent_units = ?, escrow_fee_units = ?
              WHERE id = ? AND escrow_contract = ? AND escrow_job_id = ?
                AND escrow_state IN ('funded', 'submitted')`,
          )
          .bind(ev.txHash, ev.toAgentUnits.toString(), ev.feeUnits.toString(), b.id, contractLower, ev.jobId)
          .run();
        if (!upd.meta.changes) continue;
        await inboxStmt(db, at, b.escrow_agent_id, "escrow.paid", b.id, null, {
          title: b.title,
          escrow_job_id: ev.jobId,
          settlement_tx: ev.txHash,
          to_agent_units: ev.toAgentUnits.toString(),
          to_agent_usdc: unitsToUsdc(ev.toAgentUnits),
          fee_units: ev.feeUnits.toString(),
          fee_usdc: unitsToUsdc(ev.feeUnits),
          message: `Escrow job #${ev.jobId} paid ${unitsToUsdc(ev.toAgentUnits)} USDC to your payout wallet.`,
        }).run();
        summary.paid++;
      }
    } else if (ev.kind === "refunded") {
      const b = await db
        .prepare(
          "SELECT * FROM bounties WHERE escrow_contract = ? AND escrow_job_id = ? AND escrow_state IN ('funded', 'submitted')",
        )
        .bind(contractLower, ev.jobId)
        .first<Bounty>();
      if (!b || !b.escrow_amount_units) continue;
      if (ev.amountUnits !== BigInt(b.escrow_amount_units)) continue;

      const upd = await db
        .prepare(
          `UPDATE bounties
              SET escrow_state = 'refunded', escrow_refund_reason = ?, escrow_settlement_tx = ?,
                  accepted_agent_id = NULL, accepted_at = NULL
            WHERE id = ? AND escrow_contract = ? AND escrow_job_id = ? AND escrow_state IN ('funded', 'submitted')`,
        )
        .bind(ev.reason, ev.txHash, b.id, contractLower, ev.jobId)
        .run();
      if (!upd.meta.changes) continue;

      // On reject(), reject the agent's pending submission while keeping its deliverable sealed forever.
      if (ev.reason === "rejected" && b.escrow_agent_id) {
        const sub = await db
          .prepare(
            "SELECT id FROM submissions WHERE bounty_id = ? AND agent_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1",
          )
          .bind(b.id, b.escrow_agent_id)
          .first<{ id: string }>();
        if (sub) {
          await db.batch([
            db.prepare(
              "UPDATE submissions SET status = 'rejected', review_note = 'rejected on-chain via BountyEscrow.reject()', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'",
            ).bind(at, b.poster_id, sub.id),
            inboxStmt(db, at, b.escrow_agent_id, "submission.rejected", b.id, sub.id, {
              title: b.title,
              by: "poster",
              escrow_job_id: ev.jobId,
              refund_tx: ev.txHash,
              note: "Poster called reject() on BountyEscrow within the review window. Your deliverable remains sealed.",
            }),
            eventStmt(db, at, "submission_rejected", b.id, b.escrow_agent_id, `submission on "${b.title}" rejected via escrow`),
          ]);
        }
      }
      summary.refunded++;
    }
  }

  return summary;
}

/**
 * Finalize an award when `Paid` confirmed on-chain BEFORE the escrow agent posted
 * their solo submission to the board, and that agent now attaches their deliverable.
 */
export async function finalizePaidEscrowSubmission(
  db: D1Database,
  b: Bounty,
  submissionId: string,
): Promise<boolean> {
  if (
    b.status !== "open" ||
    b.escrow_state !== "paid" ||
    !b.escrow_contract ||
    b.escrow_job_id == null ||
    !b.escrow_agent_id ||
    !b.escrow_agent_address ||
    !b.escrow_settlement_tx ||
    !b.escrow_to_agent_units ||
    !b.escrow_fee_units
  ) {
    return false;
  }
  const at = nowIso();
  const toAgentUnits = BigInt(b.escrow_to_agent_units);
  const feeUnits = BigInt(b.escrow_fee_units);
  const feeCents = Number(feeUnits / UNITS_PER_CENT);
  const netCents = Number(toAgentUnits / UNITS_PER_CENT);
  const upd = await db
    .prepare(
      `UPDATE bounties
          SET status = 'awarded', awarded_submission_id = ?, awarded_at = ?, awarded_by = ?,
              payment_ref = ?, settled_tx = ?, fee_cents = ?, review_fee_cents = 0
        WHERE id = ? AND status = 'open' AND escrow_state = 'paid' AND awarded_submission_id IS NULL`,
    )
    .bind(
      submissionId, at, b.poster_id,
      b.escrow_settlement_tx, b.escrow_settlement_tx, feeCents,
      b.id,
    )
    .run();
  if (!upd.meta.changes) return false;

  await db.batch([
    db.prepare("UPDATE submissions SET status = 'accepted', reviewed_at = ?, reviewed_by = ? WHERE id = ?")
      .bind(at, b.poster_id, submissionId),
    db.prepare("UPDATE submission_contributors SET payout_cents = ? WHERE submission_id = ? AND agent_id = ?")
      .bind(netCents, submissionId, b.escrow_agent_id),
    db.prepare(
      `INSERT INTO inbox (agent_id, at, type, bounty_id, submission_id, data, webhook_pending)
       SELECT s.agent_id, ?, 'submission.closed', s.bounty_id, s.id,
              json_object('title', ?, 'reason', 'another submission was accepted first'),
              CASE WHEN (SELECT notify_webhook FROM agents WHERE id = s.agent_id) IS NULL THEN 0 ELSE 1 END
         FROM submissions s WHERE s.bounty_id = ? AND s.status = 'pending' AND s.id != ?`,
    ).bind(at, b.title, b.id, submissionId),
    db.prepare(
      "UPDATE submissions SET status = 'closed', review_note = 'another submission was accepted first', reviewed_at = ? WHERE bounty_id = ? AND status IN ('pending','draft') AND id != ?",
    ).bind(at, b.id, submissionId),
    db.prepare(
      `INSERT INTO settlements (id, bounty_id, milestone_id, submission_id, tx_hash, recipient, amount_cents, role, verified_at, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, 'contributor', ?, ?)`,
    ).bind(newId("stl"), b.id, submissionId, b.escrow_settlement_tx, b.escrow_agent_address, netCents, at, at),
    ...(feeUnits > 0n
      ? [
          db.prepare(
            `INSERT INTO settlements (id, bounty_id, milestone_id, submission_id, tx_hash, recipient, amount_cents, role, verified_at, created_at)
             VALUES (?, ?, NULL, ?, ?, 'escrow_treasury', ?, 'platform_fee', ?, ?)`,
          ).bind(newId("stl"), b.id, submissionId, b.escrow_settlement_tx, feeCents, at, at),
        ]
      : []),
    inboxStmt(db, at, b.poster_id, "bounty.awarded", b.id, submissionId, {
      title: b.title,
      escrow_job_id: b.escrow_job_id,
      settlement_tx: b.escrow_settlement_tx,
      to_agent_usdc: unitsToUsdc(toAgentUnits),
      fee_usdc: unitsToUsdc(feeUnits),
      next: "Escrow payment confirmed on Base Sepolia. The full deliverable is now unsealed: GET the bounty with your API key.",
    }),
    eventStmt(
      db, at, "bounty_awarded", b.id, b.escrow_agent_id,
      `"${b.title}" awarded to ${b.escrow_agent_id} via escrow job #${b.escrow_job_id} — ${unitsToUsdc(toAgentUnits + feeUnits)} USDC`,
    ),
  ]);
  return true;
}

// ── Read-only JSON-RPC client (Base Sepolia) ────────────────────────────────

export type EscrowRpc = {
  blockNumber: () => Promise<bigint>;
  getLogs: (fromBlock: bigint, toBlock: bigint, address: string) => Promise<RawChainLog[]>;
  getBlockTimestamp: (blockNumber: bigint) => Promise<number>;
  getReceipt: (txHash: string) => Promise<{ status: string; blockNumber: bigint; logs: RawChainLog[] } | null>;
};

async function jsonRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OpError(502, `escrow RPC HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new OpError(502, `escrow RPC error: ${j.error.message ?? "unknown"}`);
  return j.result;
}

export function makeHttpEscrowRpc(rpcUrl: string): EscrowRpc {
  return {
    async blockNumber() {
      const h = (await jsonRpc(rpcUrl, "eth_blockNumber", [])) as string;
      return hexToBig(h);
    },
    async getLogs(fromBlock, toBlock, address) {
      return (await jsonRpc(rpcUrl, "eth_getLogs", [
        {
          address,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          topics: [[ESCROW_TOPICS.Funded, ESCROW_TOPICS.Submitted, ESCROW_TOPICS.Paid, ESCROW_TOPICS.Refunded]],
        },
      ])) as RawChainLog[];
    },
    async getBlockTimestamp(blockNumber) {
      const b = (await jsonRpc(rpcUrl, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false])) as {
        timestamp?: string;
      } | null;
      const t = b?.timestamp ? Number(hexToBig(b.timestamp)) : NaN;
      if (!Number.isSafeInteger(t) || t <= 0) throw new OpError(502, "could not read block timestamp from escrow RPC");
      return t;
    },
    async getReceipt(txHash) {
      const r = (await jsonRpc(rpcUrl, "eth_getTransactionReceipt", [txHash])) as {
        status?: string;
        blockNumber?: string;
        logs?: RawChainLog[];
      } | null;
      if (!r) return null;
      const bn = hexToBig(r.blockNumber);
      return {
        status: r.status ?? "0x0",
        blockNumber: bn,
        logs: (r.logs ?? []).map((l) => ({ ...l, blockNumber: l.blockNumber ?? r.blockNumber, transactionHash: l.transactionHash ?? txHash })),
      };
    },
  };
}

async function fetchLogsChunked(
  rpc: EscrowRpc,
  fromBlock: bigint,
  toBlock: bigint,
  address: string,
  chunkSize = 40_000n,
): Promise<{ logs: RawChainLog[]; scannedTo: bigint }> {
  const all: RawChainLog[] = [];
  let cur = fromBlock;
  let step = chunkSize;
  let calls = 0;
  while (cur <= toBlock && calls < 6) {
    const end = cur + step - 1n < toBlock ? cur + step - 1n : toBlock;
    try {
      const logs = await rpc.getLogs(cur, end, address);
      all.push(...logs);
      cur = end + 1n;
      calls++;
    } catch (e) {
      // Adaptive fallback for strict RPCs such as sepolia.base.org (200-block limit).
      if (step > 190n) {
        step = 190n;
        continue;
      }
      throw e;
    }
  }
  if (cur === fromBlock) {
    throw new OpError(502, "escrow RPC made zero log-scan progress");
  }
  return { logs: all, scannedTo: cur - 1n };
}

/**
 * Periodic read-only log sync from the cursor up to `head - (MIN_CONFIRMATIONS - 1)`.
 * Skips external RPC calls altogether when the board has no open or in-progress
 * on-chain bounties.
 */
export async function syncEscrowChain(
  env: Pick<Env, "DB" | "ESCROW_ADDRESS_BASE_SEPOLIA" | "BASE_SEPOLIA_RPC_URL">,
  opts: { rpc?: EscrowRpc; minConfirmations?: number; startBlock?: number } = {},
): Promise<EscrowSyncSummary & { synced_to_block: number | null }> {
  const active = await env.DB
    .prepare(
      "SELECT 1 AS x FROM bounties WHERE settlement_mode = 'onchain' AND (status = 'open' OR escrow_state IN ('funded', 'submitted')) LIMIT 1",
    )
    .first<{ x: number }>();
  if (!active) return { funded: 0, submitted: 0, paid: 0, refunded: 0, synced_to_block: null };

  const escrowAddr = escrowAddressOf(env);
  const contractLower = escrowAddr.toLowerCase();
  const minConf = opts.minConfirmations ?? MIN_CONFIRMATIONS;
  const rpc = opts.rpc ?? makeHttpEscrowRpc(escrowRpcUrlOf(env));

  const head = await rpc.blockNumber();
  const safeHead = head - BigInt(minConf - 1);
  if (safeHead < 0n) return { funded: 0, submitted: 0, paid: 0, refunded: 0, synced_to_block: null };

  const curRow = await env.DB
    .prepare("SELECT last_synced_block FROM escrow_sync_cursor WHERE escrow_contract = ?")
    .bind(contractLower)
    .first<{ last_synced_block: number }>();
  const defaultStart = opts.startBlock ?? ESCROW_DEPLOY_BLOCK_BASE_SEPOLIA;
  const fromBlock = BigInt(curRow ? curRow.last_synced_block + 1 : defaultStart);
  if (fromBlock > safeHead) {
    return { funded: 0, submitted: 0, paid: 0, refunded: 0, synced_to_block: Number(safeHead) };
  }

  // Bound per-invocation scan to 200k blocks; cursor records actual scannedTo so
  // strict 200-block RPCs never skip unscanned blocks between ticks.
  const maxSpan = 200_000n;
  const targetBlock = safeHead - fromBlock >= maxSpan ? fromBlock + maxSpan - 1n : safeHead;
  const { logs: rawLogs, scannedTo } = await fetchLogsChunked(rpc, fromBlock, targetBlock, escrowAddr);
  const events = parseEscrowLogs(rawLogs, escrowAddr, head, minConf);

  const blockTimes = new Map<bigint, number>();
  for (const ev of events) {
    if (ev.kind === "submitted" && !blockTimes.has(ev.blockNumber)) {
      blockTimes.set(ev.blockNumber, await rpc.getBlockTimestamp(ev.blockNumber));
    }
  }

  const summary = await applyEscrowEvents(env.DB, escrowAddr, events, blockTimes);
  await env.DB
    .prepare(
      `INSERT INTO escrow_sync_cursor (escrow_contract, last_synced_block, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(escrow_contract) DO UPDATE SET last_synced_block = excluded.last_synced_block, updated_at = excluded.updated_at`,
    )
    .bind(contractLower, Number(scannedTo), nowIso())
    .run();

  return { ...summary, synced_to_block: Number(scannedTo) };
}

/**
 * Sync one specific Base Sepolia transaction receipt against BountyEscrow.
 * Used when a poster or agent wants immediate feedback once their tx reaches
 * MIN_CONFIRMATIONS without waiting for the next cron tick.
 */
export async function syncEscrowReceipt(
  env: Pick<Env, "DB" | "ESCROW_ADDRESS_BASE_SEPOLIA" | "BASE_SEPOLIA_RPC_URL">,
  txHashRaw: unknown,
  opts: { rpc?: EscrowRpc; minConfirmations?: number; startBlock?: number } = {},
): Promise<EscrowSyncSummary & { confirmations: number }> {
  if (!isTxHash(txHashRaw)) throw new OpError(400, "tx_hash must be a 0x-prefixed 64-hex-character transaction hash");
  const txHash = txHashRaw.toLowerCase();
  const escrowAddr = escrowAddressOf(env);
  const contractLower = escrowAddr.toLowerCase();
  const minConf = opts.minConfirmations ?? MIN_CONFIRMATIONS;
  const rpc = opts.rpc ?? makeHttpEscrowRpc(escrowRpcUrlOf(env));

  const receipt = await rpc.getReceipt(txHash);
  if (!receipt) throw new OpError(404, "transaction not found on Base Sepolia — is it mined, and is the hash right?");
  if (receipt.status !== "0x1") throw new OpError(400, "that transaction reverted on-chain");

  const head = await rpc.blockNumber();
  const confirmations = head >= receipt.blockNumber ? Number(head - receipt.blockNumber + 1n) : 0;
  if (confirmations < minConf) {
    throw new OpError(
      409,
      `transaction has ${confirmations} confirmation(s); ${minConf} required before escrow state advances or work is unsealed. Try again shortly.`,
    );
  }

  const events = parseEscrowLogs(receipt.logs, escrowAddr, head, minConf);
  const totals: EscrowSyncSummary = { funded: 0, submitted: 0, paid: 0, refunded: 0 };

  // If this receipt carries a follow-up event (Submitted / Paid / Refunded) whose
  // earlier Funded log has not been mirrored by cron yet, catch up the chain cursor
  // first so events apply in causal order.
  const needsPriorJob = events.some((e) => e.kind !== "funded");
  if (needsPriorJob) {
    for (const ev of events) {
      if (ev.kind === "funded") continue;
      const bound = await env.DB
        .prepare("SELECT escrow_state FROM bounties WHERE escrow_contract = ? AND escrow_job_id = ?")
        .bind(contractLower, ev.jobId)
        .first<{ escrow_state: string }>();
      if (!bound) {
        for (let step = 0; step < 8; step++) {
          const pre = await syncEscrowChain(env, opts);
          totals.funded += pre.funded;
          totals.submitted += pre.submitted;
          totals.paid += pre.paid;
          totals.refunded += pre.refunded;
          if (pre.synced_to_block == null || BigInt(pre.synced_to_block) >= receipt.blockNumber) break;
        }
        break;
      }
    }
  }

  const blockTimes = new Map<bigint, number>();
  for (const ev of events) {
    if (ev.kind === "submitted" && !blockTimes.has(ev.blockNumber)) {
      blockTimes.set(ev.blockNumber, await rpc.getBlockTimestamp(ev.blockNumber));
    }
  }
  const summary = await applyEscrowEvents(env.DB, escrowAddr, events, blockTimes);
  return {
    funded: totals.funded + summary.funded,
    submitted: totals.submitted + summary.submitted,
    paid: totals.paid + summary.paid,
    refunded: totals.refunded + summary.refunded,
    confirmations,
  };
}

/**
 * Poster review-window reminders (#52):
 *   - First reminder at >= 48 hours after `escrow_submitted_at`
 *   - Second, final reminder at >= 68 hours (4 hours before the 72h window closes)
 *   - Never sent if the job is already `paid` or `refunded`.
 */
export async function sweepEscrowReminders(
  db: D1Database,
  nowMs = Date.now(),
): Promise<{ reminded_48h: number; reminded_68h: number }> {
  const at = new Date(nowMs).toISOString();
  const rows = await db
    .prepare(
      `SELECT b.id, b.poster_id, b.title, b.escrow_job_id, b.escrow_contract,
              b.escrow_deliverable_hash, b.escrow_submitted_at,
              b.escrow_reminder_48h_at, b.escrow_reminder_68h_at,
              (SELECT s.id FROM submissions s
                WHERE s.bounty_id = b.id AND s.agent_id = b.escrow_agent_id AND s.status = 'pending'
                ORDER BY s.created_at ASC LIMIT 1) AS submission_id,
              (SELECT s.preview FROM submissions s
                WHERE s.bounty_id = b.id AND s.agent_id = b.escrow_agent_id AND s.status = 'pending'
                ORDER BY s.created_at ASC LIMIT 1) AS submission_preview
         FROM bounties b
        WHERE b.escrow_state = 'submitted' AND b.escrow_submitted_at IS NOT NULL
          AND (b.escrow_reminder_48h_at IS NULL OR b.escrow_reminder_68h_at IS NULL)
        LIMIT 200`,
    )
    .all<{
      id: string;
      poster_id: string;
      title: string;
      escrow_job_id: number;
      escrow_contract: string | null;
      escrow_deliverable_hash: string | null;
      escrow_submitted_at: string;
      escrow_reminder_48h_at: string | null;
      escrow_reminder_68h_at: string | null;
      submission_id: string | null;
      submission_preview: string | null;
    }>();

  let reminded48 = 0;
  let reminded68 = 0;

  for (const r of rows.results ?? []) {
    const submittedMs = Date.parse(r.escrow_submitted_at);
    if (!Number.isFinite(submittedMs)) continue;
    const elapsed = nowMs - submittedMs;
    const closesAt = new Date(submittedMs + ESCROW_REVIEW_WINDOW_S * 1000).toISOString();
    const bountyUrl = `${PUBLIC_ORIGIN}/bounties/${r.id}`;
    const choices = {
      approve: `Call complete(${r.escrow_job_id}) on BountyEscrow to pay the agent and unseal the full deliverable.`,
      reject: `Call reject(${r.escrow_job_id}) on BountyEscrow before ${closesAt} for a full refund (the deliverable stays sealed).`,
    };

    if (elapsed >= ESCROW_REMINDER_68H_MS && !r.escrow_reminder_68h_at) {
      const upd = await db
        .prepare(
          `UPDATE bounties
              SET escrow_reminder_68h_at = ?,
                  escrow_reminder_48h_at = COALESCE(escrow_reminder_48h_at, ?)
            WHERE id = ? AND escrow_state = 'submitted' AND escrow_reminder_68h_at IS NULL`,
        )
        .bind(at, at, r.id)
        .run();
      if (!upd.meta.changes) continue;
      await inboxStmt(db, at, r.poster_id, "escrow.review_final_reminder", r.id, r.submission_id, {
        title: r.title,
        bounty_url: bountyUrl,
        escrow_job_id: r.escrow_job_id,
        escrow_contract: r.escrow_contract ? toChecksumAddress(r.escrow_contract) : null,
        submission_id: r.submission_id,
        submission_preview: r.submission_preview,
        deliverable_hash: r.escrow_deliverable_hash,
        submitted_at: r.escrow_submitted_at,
        review_window_closes_at: closesAt,
        reminder_hour: 68,
        choices,
        message:
          `Final reminder: the 3-day escrow review window for "${r.title}" (job #${r.escrow_job_id}) closes at ${closesAt}. ` +
          `Approve with complete(${r.escrow_job_id}) or reject with reject(${r.escrow_job_id}) before then; after ${closesAt} anyone may call complete(${r.escrow_job_id}) to release payment.`,
      }).run();
      reminded68++;
    } else if (elapsed >= ESCROW_REMINDER_48H_MS && elapsed < ESCROW_REMINDER_68H_MS && !r.escrow_reminder_48h_at) {
      const upd = await db
        .prepare(
          `UPDATE bounties
              SET escrow_reminder_48h_at = ?
            WHERE id = ? AND escrow_state = 'submitted' AND escrow_reminder_48h_at IS NULL`,
        )
        .bind(at, r.id)
        .run();
      if (!upd.meta.changes) continue;
      await inboxStmt(db, at, r.poster_id, "escrow.review_reminder", r.id, r.submission_id, {
        title: r.title,
        bounty_url: bountyUrl,
        escrow_job_id: r.escrow_job_id,
        escrow_contract: r.escrow_contract ? toChecksumAddress(r.escrow_contract) : null,
        submission_id: r.submission_id,
        submission_preview: r.submission_preview,
        deliverable_hash: r.escrow_deliverable_hash,
        submitted_at: r.escrow_submitted_at,
        review_window_closes_at: closesAt,
        reminder_hour: 48,
        choices,
        message:
          `Day-2 reminder: work was submitted on "${r.title}" (escrow job #${r.escrow_job_id}) at ${r.escrow_submitted_at}. ` +
          `Your 3-day review window closes at ${closesAt}: call complete(${r.escrow_job_id}) to approve and unseal the work, or reject(${r.escrow_job_id}) before ${closesAt} for a full refund.`,
      }).run();
      reminded48++;
    }
  }

  return { reminded_48h: reminded48, reminded_68h: reminded68 };
}
