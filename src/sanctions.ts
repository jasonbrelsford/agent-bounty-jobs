/**
 * Read-only sanctions screening via Chainalysis' free on-chain Sanctions Oracle
 * on Base (`0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B`).
 *
 * Security & privacy invariants (#51):
 *  - Read-only `eth_call` (`isSanctioned(address)`). No API keys, no accounts,
 *    no private keys, and no transactions sent.
 *  - Fail closed: if no RPC URL is configured on the live Worker or the RPC /
 *    oracle call fails, times out, or returns an unexpected payload, refuse new
 *    wallets and funding with 503 ("try again later").
 *  - Neutral refusal & zero public leakage: if an address is flagged, record it
 *    ONLY in the operator-private `sanctions_blocks` table (never in `events`,
 *    `FEED_KINDS`, `inbox`, or public error details) and return a neutral 403.
 */
import { OpError, applyDuePayoutChanges, newId, nowIso } from "./core.js";
import { checkPayoutAddress, toChecksumAddress } from "./wallet.js";

/** Chainalysis SanctionsList contract deployed on Base (chainId 8453). */
export const CHAINALYSIS_SANCTIONS_ORACLE_BASE = "0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B";

/** First 4 bytes of keccak256("isSanctioned(address)"). */
export const IS_SANCTIONED_SELECTOR = "0xdf592f7d";

export const NEUTRAL_WALLET_REFUSAL = "this wallet address cannot be used on this board";
export const NEUTRAL_FUNDING_TARGET_REFUSAL = "funding is unavailable for this job right now";
export const SCREENING_UNAVAILABLE_MESSAGE =
  "address screening is temporarily unavailable — please try again later";

export type ScreenResult = "clear" | "flagged";
export type SanctionsContext =
  | "payout_signup"
  | "payout_set"
  | "payout_change"
  | "poster_fund"
  | "poster_fund_recipient";
export type ScreenFn = (address: string) => Promise<ScreenResult>;

export interface SanctionsEnv {
  DB: D1Database;
  SANCTIONS_RPC_URL?: string;
  BASE_RPC_URL?: string;
  SANCTIONS_ORACLE_ADDRESS?: string;
}

/** Encode `isSanctioned(address)` calldata for a validated 20-byte hex address. */
export function encodeIsSanctionedCall(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new OpError(400, "invalid 0x-prefixed 20-byte wallet address");
  }
  return `${IS_SANCTIONED_SELECTOR}${clean.padStart(64, "0")}`;
}

/**
 * Query Chainalysis' on-chain Sanctions Oracle via read-only `eth_call`.
 * Any network, HTTP, JSON-RPC, or ABI anomaly throws 503 (fail closed).
 */
export async function queryChainalysisOracle(
  rpcUrl: string,
  address: string,
  oracleAddress = CHAINALYSIS_SANCTIONS_ORACLE_BASE,
): Promise<ScreenResult> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(oracleAddress)) {
    throw new OpError(503, SCREENING_UNAVAILABLE_MESSAGE);
  }
  const data = encodeIsSanctionedCall(address);
  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: oracleAddress, data }, "latest"],
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new OpError(503, SCREENING_UNAVAILABLE_MESSAGE);
  }
  if (!res.ok) throw new OpError(503, SCREENING_UNAVAILABLE_MESSAGE);

  let payload: { result?: unknown; error?: unknown };
  try {
    payload = (await res.json()) as { result?: unknown; error?: unknown };
  } catch {
    throw new OpError(503, SCREENING_UNAVAILABLE_MESSAGE);
  }
  if (!payload || typeof payload !== "object" || payload.error || typeof payload.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(payload.result)) {
    throw new OpError(503, SCREENING_UNAVAILABLE_MESSAGE);
  }

  const v = BigInt(payload.result);
  if (v === 0n) return "clear";
  if (v === 1n) return "flagged";
  throw new OpError(503, SCREENING_UNAVAILABLE_MESSAGE);
}

/**
 * Screen an address and enforce fail-closed + private operator logging.
 *
 * - When `opts.screen` is supplied (unit tests), uses that stub directly.
 * - Else when `env` is supplied (every HTTP, MCP, and web funding entry point),
 *   requires `env.SANCTIONS_RPC_URL || env.BASE_RPC_URL` and fails closed (503)
 *   if absent or unreachable.
 * - Only when both `env` and `opts.screen` are omitted (direct offline domain
 *   calls in unit tests that pass `db` alone) is network I/O skipped.
 */
export async function enforceAddressScreening(
  db: D1Database,
  env: Pick<SanctionsEnv, "SANCTIONS_RPC_URL" | "BASE_RPC_URL" | "SANCTIONS_ORACLE_ADDRESS"> | undefined,
  address: string,
  context: SanctionsContext,
  meta: { agentId?: string | null; bountyId?: string | null; refusalMessage?: string } = {},
  opts: { screen?: ScreenFn } = {},
): Promise<void> {
  const normalized = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new OpError(400, "invalid 0x-prefixed 20-byte wallet address");
  }

  let verdict: ScreenResult;
  if (opts.screen) {
    try {
      verdict = await opts.screen(normalized);
    } catch (e) {
      if (e instanceof OpError && e.status === 503) throw e;
      throw new OpError(503, SCREENING_UNAVAILABLE_MESSAGE);
    }
    if (verdict !== "clear" && verdict !== "flagged") {
      throw new OpError(503, SCREENING_UNAVAILABLE_MESSAGE);
    }
  } else if (env !== undefined) {
    const rpcUrl = env.SANCTIONS_RPC_URL?.trim() || env.BASE_RPC_URL?.trim() || "";
    if (!rpcUrl) throw new OpError(503, SCREENING_UNAVAILABLE_MESSAGE);
    const oracle = env.SANCTIONS_ORACLE_ADDRESS?.trim() || CHAINALYSIS_SANCTIONS_ORACLE_BASE;
    verdict = await queryChainalysisOracle(rpcUrl, normalized, oracle);
  } else {
    return;
  }

  if (verdict === "flagged") {
    await db
      .prepare(
        "INSERT INTO sanctions_blocks (id, address, context, agent_id, bounty_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(newId("sbl"), normalized, context, meta.agentId ?? null, meta.bountyId ?? null, nowIso())
      .run();
    throw new OpError(403, meta.refusalMessage ?? NEUTRAL_WALLET_REFUSAL);
  }
}

/**
 * Validate and screen a poster's funding wallet (and re-screen the accepting
 * agent's payout wallet so a post-signup listing cannot slip through) before
 * the Fund this job page builds `approve` and `fund` transactions.
 */
export async function checkPosterFundingAddresses(
  db: D1Database,
  env: Pick<SanctionsEnv, "SANCTIONS_RPC_URL" | "BASE_RPC_URL" | "SANCTIONS_ORACLE_ADDRESS"> | undefined,
  bountyId: string,
  posterAddressRaw: unknown,
  agentPayoutAddress: string | null | undefined,
  posterAgentId?: string | null,
  acceptedAgentId?: string | null,
  opts: { screen?: ScreenFn } = {},
): Promise<{ poster_address: string; poster_checksum: string }> {
  const posterCheck = checkPayoutAddress(posterAddressRaw, "base");
  if (!posterCheck.ok) {
    throw new OpError(400, posterCheck.error.replace(/\bpayout_address\b/g, "funding_address"));
  }

  await enforceAddressScreening(
    db,
    env,
    posterCheck.address,
    "poster_fund",
    { agentId: posterAgentId ?? null, bountyId },
    opts,
  );

  if (agentPayoutAddress) {
    if (posterCheck.address === agentPayoutAddress.toLowerCase()) {
      throw new OpError(400, "the poster funding wallet cannot be the same address as the accepting agent's payout wallet");
    }
    await enforceAddressScreening(
      db,
      env,
      agentPayoutAddress,
      "poster_fund_recipient",
      {
        agentId: acceptedAgentId ?? null,
        bountyId,
        refusalMessage: NEUTRAL_FUNDING_TARGET_REFUSAL,
      },
      opts,
    );
  }

  return {
    poster_address: posterCheck.address,
    poster_checksum: toChecksumAddress(posterCheck.address),
  };
}

/**
 * Screen a poster's funding wallet against an open, accepted on-chain bounty
 * before building `approve` and `fund` transactions (#51 + #49).
 */
export async function screenBountyFundingWallet(
  db: D1Database,
  env: Pick<SanctionsEnv, "SANCTIONS_RPC_URL" | "BASE_RPC_URL" | "SANCTIONS_ORACLE_ADDRESS"> | undefined,
  bountyId: string,
  posterAddressRaw: unknown,
  callerAgentId?: string | null,
  opts: { screen?: ScreenFn } = {},
) {
  const b = await db
    .prepare(
      "SELECT id, poster_id, status, settlement_mode, accepted_agent_id, escrow_state FROM bounties WHERE id = ?",
    )
    .bind(bountyId)
    .first<{
      id: string;
      poster_id: string;
      status: string;
      settlement_mode: string;
      accepted_agent_id: string | null;
      escrow_state: string | null;
    }>();
  if (!b || b.status === "removed") throw new OpError(404, `no bounty ${bountyId}`);
  if (b.settlement_mode !== "onchain")
    throw new OpError(409, "this bounty settles off-platform and does not use escrow funding");
  if (b.status !== "open")
    throw new OpError(409, `bounty is ${b.status}, not awaiting funding`);
  const state = b.escrow_state ?? "unfunded";
  if (state !== "unfunded" && state !== "refunded")
    throw new OpError(409, `escrow job for this bounty is already ${state}`);
  if (!b.accepted_agent_id)
    throw new OpError(409, "no agent has accepted this bounty yet; wait for an agent to call accept_bounty before funding");

  await applyDuePayoutChanges(db, [b.accepted_agent_id]);
  const filler = await db
    .prepare("SELECT payout_address FROM agents WHERE id = ?")
    .bind(b.accepted_agent_id)
    .first<{ payout_address: string | null }>();
  if (!filler?.payout_address)
    throw new OpError(409, "the accepting agent has no active payout_address on file");

  const checked = await checkPosterFundingAddresses(
    db,
    env,
    bountyId,
    posterAddressRaw,
    filler.payout_address,
    callerAgentId ?? null,
    b.accepted_agent_id,
    opts,
  );
  return {
    ok: true,
    bounty_id: bountyId,
    funding_address: checked.poster_checksum,
    agent_payout_address: toChecksumAddress(filler.payout_address),
  };
}

/** Operator-only view of private sanctions screening blocks (`x-admin-key`). */
export async function adminSanctionsBlocks(db: D1Database, limitRaw?: unknown) {
  const limit = Math.min(Math.max(1, Math.floor(Number(limitRaw) || 50)), 200);
  const { results } = await db
    .prepare(
      "SELECT id, address, context, agent_id, bounty_id, created_at FROM sanctions_blocks ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .bind(limit)
    .all<{
      id: string;
      address: string;
      context: string;
      agent_id: string | null;
      bounty_id: string | null;
      created_at: string;
    }>();
  return {
    blocks: (results ?? []).map((r) => ({
      ...r,
      checksum_address: /^0x[0-9a-f]{40}$/i.test(r.address) ? toChecksumAddress(r.address) : r.address,
    })),
  };
}
