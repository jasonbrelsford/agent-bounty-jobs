/**
 * Sign-In with Ethereum (EIP-4361) proof of payout wallet ownership (#44).
 *
 * Security & privacy invariants:
 *  - Uses `viem` (`viem/siwe` + `createPublicClient` on Base, chain ID 8453) so
 *    EOA, deployed ERC-1271 smart wallets, and counterfactual ERC-6492 smart
 *    wallets all work without any hand-rolled signature cryptography.
 *  - Generates nonces with Web Crypto CSPRNG (`crypto.getRandomValues`, 128 bits)
 *    rather than `viem`'s `Math.random()` ring-buffer helper.
 *  - Enforces exact canonical EIP-4361 message matching alongside field-specific
 *    400 errors so no URI, statement, scheme, timestamp, or parser-smuggling
 *    tampering can pass.
 *  - Read-only signature check: the board never holds, generates, or asks for a
 *    private key or seed phrase, and never moves funds.
 *  - Never reads text from job descriptions, submissions, or messages to choose
 *    which address is verified; only `agents.payout_address` and
 *    `agents.payout_address_pending` in D1 can be challenged or verified.
 *  - Verifying a pending 24-hour payout-address change records
 *    `payout_pending_verified_at` without shortening `payout_pending_effective_at`.
 */
import { createPublicClient, getAddress, http, type Hex, type PublicClient } from "viem";
import { base } from "viem/chains";
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import {
  type Agent,
  type Env,
  OpError,
  applyDuePayoutChanges,
  payoutView,
} from "./core.js";

export const SIWE_DOMAIN = "bounty.brelsfordsoftware.com";
export const SIWE_URI = "https://bounty.brelsfordsoftware.com";
export const SIWE_CHAIN_ID = 8453; // Base
export const SIWE_NONCE_TTL_MS = 10 * 60_000; // 10 minutes
export const SIWE_MAX_OPEN_NONCES_PER_AGENT = 20;
export const SIWE_STATEMENT =
  "Prove that this agent controls its USDC payout wallet on Base for Agent Bounty Jobs.";

export type PayoutChallengeTarget = "current" | "pending";

type AgentWalletRow = {
  payout_address: string | null;
  payout_address_verified_at: string | null;
  payout_address_pending: string | null;
  payout_pending_effective_at: string | null;
  payout_pending_verified_at: string | null;
};

type NonceRow = {
  nonce: string;
  agent_id: string;
  address: string;
  target: string;
  issued_at: string;
  expires_at: string;
  used_at: string | null;
};

function generateCsprngNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isRpcTransportError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    const name = (cur as { name?: unknown }).name;
    if (
      name === "HttpRequestError" ||
      name === "TimeoutError" ||
      name === "WebSocketRequestError" ||
      name === "RpcRequestError" ||
      name === "LimitExceededRpcError" ||
      name === "InternalRpcError"
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Issue a single-use, 10-minute EIP-4361 SIWE challenge message for the
 * authenticated agent's current or pending Base payout wallet.
 */
export async function payoutAddressChallenge(
  db: D1Database,
  agent: Agent,
  input: { target?: unknown; address?: unknown } = {},
  opts: { nowMs?: number } = {},
) {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIsoStr = new Date(nowMs).toISOString();

  await applyDuePayoutChanges(db, [agent.id]);
  const cur = await db
    .prepare(
      "SELECT payout_address, payout_address_verified_at, payout_address_pending, payout_pending_effective_at, payout_pending_verified_at FROM agents WHERE id = ?",
    )
    .bind(agent.id)
    .first<AgentWalletRow>();

  let target: PayoutChallengeTarget;
  let targetRawAddress: string;

  if (input.target !== undefined && input.target !== null && input.target !== "") {
    if (input.target !== "current" && input.target !== "pending") {
      throw new OpError(400, 'target must be "current" or "pending"');
    }
    target = input.target;
    if (target === "pending") {
      if (!cur?.payout_address_pending) {
        throw new OpError(409, "no pending payout_address change on hold to verify");
      }
      targetRawAddress = cur.payout_address_pending;
    } else {
      if (!cur?.payout_address) {
        throw new OpError(
          409,
          "no payout_address set — call set_payout_address (or POST /v1/agents/me/payout-address) first",
        );
      }
      targetRawAddress = cur.payout_address;
    }
    if (input.address !== undefined && input.address !== null && input.address !== "") {
      if (typeof input.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input.address.trim())) {
        throw new OpError(400, "address must be a 0x-prefixed 40-hex-character wallet address");
      }
      if (input.address.trim().toLowerCase() !== targetRawAddress.toLowerCase()) {
        throw new OpError(400, `address does not match your ${target} payout_address`);
      }
    }
  } else if (input.address !== undefined && input.address !== null && input.address !== "") {
    if (typeof input.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input.address.trim())) {
      throw new OpError(400, "address must be a 0x-prefixed 40-hex-character wallet address");
    }
    const want = input.address.trim().toLowerCase();
    if (cur?.payout_address_pending && cur.payout_address_pending.toLowerCase() === want) {
      target = "pending";
      targetRawAddress = cur.payout_address_pending;
    } else if (cur?.payout_address && cur.payout_address.toLowerCase() === want) {
      target = "current";
      targetRawAddress = cur.payout_address;
    } else {
      throw new OpError(400, "address does not match your current or pending payout_address");
    }
  } else if (cur?.payout_address_pending) {
    target = "pending";
    targetRawAddress = cur.payout_address_pending;
  } else if (cur?.payout_address) {
    target = "current";
    targetRawAddress = cur.payout_address;
  } else {
    throw new OpError(
      409,
      "no payout_address set — call set_payout_address (or POST /v1/agents/me/payout-address) first",
    );
  }

  // Prune only expired nonces so used nonces retain their explicit replay status for the full 10m window.
  await db
    .prepare("DELETE FROM payout_siwe_nonces WHERE expires_at <= ?")
    .bind(nowIsoStr)
    .run();

  const activeCount = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM payout_siwe_nonces WHERE agent_id = ? AND used_at IS NULL AND expires_at > ?",
    )
    .bind(agent.id, nowIsoStr)
    .first<{ n: number }>();
  if ((activeCount?.n ?? 0) >= SIWE_MAX_OPEN_NONCES_PER_AGENT) {
    throw new OpError(
      429,
      "too many active wallet verification challenges — sign your latest challenge or wait for old ones to expire",
    );
  }

  const checksumAddr = getAddress(targetRawAddress);
  const nonce = generateCsprngNonce();
  const issuedAt = new Date(nowMs);
  const expirationTime = new Date(nowMs + SIWE_NONCE_TTL_MS);

  const message = createSiweMessage({
    domain: SIWE_DOMAIN,
    address: checksumAddr,
    statement: SIWE_STATEMENT,
    uri: SIWE_URI,
    version: "1",
    chainId: SIWE_CHAIN_ID,
    nonce,
    issuedAt,
    expirationTime,
  });

  await db
    .prepare(
      "INSERT INTO payout_siwe_nonces (nonce, agent_id, address, target, issued_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(
      nonce,
      agent.id,
      checksumAddr.toLowerCase(),
      target,
      issuedAt.toISOString(),
      expirationTime.toISOString(),
    )
    .run();

  return {
    agent_id: agent.id,
    target,
    payout_address: checksumAddr,
    domain: SIWE_DOMAIN,
    statement: SIWE_STATEMENT,
    uri: SIWE_URI,
    version: "1",
    chain_id: SIWE_CHAIN_ID,
    nonce,
    issued_at: issuedAt.toISOString(),
    expires_at: expirationTime.toISOString(),
    ...(target === "pending" && cur?.payout_pending_effective_at
      ? { pending_effective_at: cur.payout_pending_effective_at }
      : {}),
    message,
  };
}

/**
 * Verify an EIP-4361 SIWE `{ message, signature }` against Base (EOA, ERC-1271,
 * and ERC-6492 supported via `viem`) and mark the agent's current or pending
 * payout wallet verified.
 */
export async function verifyPayoutAddress(
  db: D1Database,
  env: Pick<Env, "BASE_RPC_URL" | "SANCTIONS_RPC_URL"> | undefined,
  agent: Agent,
  input: { message?: unknown; signature?: unknown },
  opts: { nowMs?: number; publicClient?: Pick<PublicClient, "verifySiweMessage"> } = {},
) {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIsoStr = new Date(nowMs).toISOString();

  if (typeof input.message !== "string" || input.message.length === 0 || input.message.length > 4096) {
    throw new OpError(400, "message must be a non-empty EIP-4361 Sign-In with Ethereum string");
  }
  if (
    typeof input.signature !== "string" ||
    input.signature.length < 4 ||
    input.signature.length > 32_770 ||
    input.signature.length % 2 !== 0 ||
    !/^0x[0-9a-fA-F]+$/.test(input.signature)
  ) {
    throw new OpError(400, "signature must be a 0x-prefixed hex byte string (max 16KB)");
  }

  const parsed = parseSiweMessage(input.message);
  if (parsed.scheme !== undefined) {
    throw new OpError(400, "SIWE message must not include a scheme prefix on domain");
  }
  if (!parsed.domain || parsed.domain !== SIWE_DOMAIN) {
    throw new OpError(400, `SIWE domain must be "${SIWE_DOMAIN}"`);
  }
  if (!parsed.address || !/^0x[0-9a-fA-F]{40}$/.test(parsed.address)) {
    throw new OpError(400, "SIWE message must include a valid 0x wallet address");
  }
  let checksumMsgAddr: `0x${string}`;
  try {
    checksumMsgAddr = getAddress(parsed.address);
  } catch {
    throw new OpError(400, "SIWE message address is invalid");
  }
  if (parsed.address !== checksumMsgAddr) {
    throw new OpError(400, `SIWE message address must be EIP-55 checksummed (${checksumMsgAddr})`);
  }
  if (parsed.statement !== SIWE_STATEMENT) {
    throw new OpError(400, `SIWE statement must be "${SIWE_STATEMENT}"`);
  }
  if (parsed.uri !== SIWE_URI) {
    throw new OpError(400, `SIWE URI must be "${SIWE_URI}"`);
  }
  if (parsed.version !== "1") {
    throw new OpError(400, 'SIWE version must be "1"');
  }
  if (parsed.chainId !== SIWE_CHAIN_ID) {
    throw new OpError(400, `SIWE chainId must be ${SIWE_CHAIN_ID} (Base)`);
  }
  if (!parsed.nonce || !/^[a-zA-Z0-9]{8,128}$/.test(parsed.nonce)) {
    throw new OpError(400, "SIWE message is missing a valid nonce");
  }
  if (!parsed.issuedAt || Number.isNaN(parsed.issuedAt.getTime())) {
    throw new OpError(400, "SIWE message must include a valid RFC 3339 issuedAt timestamp");
  }
  if (!parsed.expirationTime || Number.isNaN(parsed.expirationTime.getTime())) {
    throw new OpError(400, "SIWE message must include a valid RFC 3339 expirationTime");
  }
  if (parsed.expirationTime.getTime() <= nowMs) {
    throw new OpError(400, "SIWE challenge has expired — request a fresh challenge");
  }
  if (parsed.notBefore !== undefined) {
    throw new OpError(400, "SIWE message must not include unexpected notBefore field");
  }
  if (parsed.requestId !== undefined || parsed.resources !== undefined) {
    throw new OpError(400, "SIWE message must not include unexpected requestId or resources fields");
  }

  await applyDuePayoutChanges(db, [agent.id]);

  const nonceRow = await db
    .prepare("SELECT * FROM payout_siwe_nonces WHERE nonce = ?")
    .bind(parsed.nonce)
    .first<NonceRow>();
  if (!nonceRow || nonceRow.agent_id !== agent.id) {
    throw new OpError(400, "unknown or invalid SIWE nonce for this agent — request a fresh challenge");
  }
  if (nonceRow.used_at !== null) {
    throw new OpError(400, "SIWE nonce has already been used — request a fresh challenge");
  }
  const dbExpiryMs = Date.parse(nonceRow.expires_at);
  if (!Number.isFinite(dbExpiryMs) || dbExpiryMs <= nowMs) {
    throw new OpError(400, "SIWE challenge nonce has expired — request a fresh challenge");
  }
  if (parsed.issuedAt.toISOString() !== nonceRow.issued_at) {
    throw new OpError(400, "SIWE message issuedAt does not match the issued challenge");
  }
  if (parsed.expirationTime.toISOString() !== nonceRow.expires_at) {
    throw new OpError(400, "SIWE message expirationTime does not match the issued challenge");
  }

  const expectedChecksum = getAddress(nonceRow.address);
  if (checksumMsgAddr !== expectedChecksum) {
    throw new OpError(
      400,
      `SIWE message address (${checksumMsgAddr}) does not match challenged payout wallet (${expectedChecksum})`,
    );
  }

  // Enforce exact byte-for-byte match against the canonical EIP-4361 challenge message
  // so no unanchored lines or parser-ignored suffixes can be smuggled in.
  const expectedMessage = createSiweMessage({
    domain: SIWE_DOMAIN,
    address: expectedChecksum,
    statement: SIWE_STATEMENT,
    uri: SIWE_URI,
    version: "1",
    chainId: SIWE_CHAIN_ID,
    nonce: nonceRow.nonce,
    issuedAt: new Date(nonceRow.issued_at),
    expirationTime: new Date(nonceRow.expires_at),
  });
  if (input.message !== expectedMessage) {
    throw new OpError(400, "SIWE message does not match the canonical challenge issued by the board");
  }

  const cur = await db
    .prepare(
      "SELECT payout_address, payout_address_verified_at, payout_address_pending, payout_pending_effective_at, payout_pending_verified_at FROM agents WHERE id = ?",
    )
    .bind(agent.id)
    .first<AgentWalletRow>();
  const addrLower = expectedChecksum.toLowerCase();
  const matchesCurrent = cur?.payout_address?.toLowerCase() === addrLower;
  const matchesPending = !matchesCurrent && cur?.payout_address_pending?.toLowerCase() === addrLower;
  if (!matchesCurrent && !matchesPending) {
    throw new OpError(
      400,
      "the challenged wallet is no longer your current or pending payout_address",
    );
  }

  const fieldsValid = validateSiweMessage({
    message: parsed,
    address: expectedChecksum,
    domain: SIWE_DOMAIN,
    nonce: nonceRow.nonce,
    time: new Date(nowMs),
  });
  if (!fieldsValid) {
    throw new OpError(400, "SIWE message failed EIP-4361 validation");
  }

  let transportFailure: Error | null = null;
  let client = opts.publicClient;
  if (!client) {
    const rpcUrl = env?.BASE_RPC_URL?.trim() || env?.SANCTIONS_RPC_URL?.trim() || "";
    if (!rpcUrl) {
      throw new OpError(
        503,
        "no Base RPC endpoint is configured on this board, so wallet signatures cannot be verified right now",
      );
    }
    const rpcClient = createPublicClient({
      chain: base,
      transport: http(rpcUrl, {
        timeout: 8_000,
        retryCount: 0,
        fetchFn: async (url, init) => {
          try {
            const res = await fetch(url, init);
            if (!res.ok) {
              transportFailure = new Error(`Base RPC HTTP ${res.status}`);
            }
            return res;
          } catch (e) {
            transportFailure = e instanceof Error ? e : new Error(String(e));
            throw e;
          }
        },
      }),
    });

    let rpcChainId: number;
    try {
      rpcChainId = await rpcClient.getChainId();
    } catch {
      throw new OpError(
        503,
        "Base RPC is temporarily unavailable while verifying wallet signature — please try again shortly",
      );
    }
    if (rpcChainId !== SIWE_CHAIN_ID) {
      throw new OpError(
        503,
        `configured Base RPC reported chainId ${rpcChainId} instead of Base (${SIWE_CHAIN_ID})`,
      );
    }
    client = rpcClient;
  }

  let signatureValid = false;
  try {
    signatureValid = await client.verifySiweMessage({
      message: input.message,
      signature: input.signature as Hex,
      address: expectedChecksum,
      domain: SIWE_DOMAIN,
      nonce: nonceRow.nonce,
      time: new Date(nowMs),
    });
  } catch (err) {
    if (transportFailure !== null || isRpcTransportError(err)) {
      throw new OpError(
        503,
        "Base RPC is temporarily unavailable while verifying wallet signature — please try again shortly",
      );
    }
    throw new OpError(
      400,
      `signature verification failed: malformed or unsupported signature for ${expectedChecksum}`,
    );
  }

  // `viem`'s `verifyHash` can swallow mid-call RPC errors into `false` (for smart wallets)
  // or fall back to offline recovery (for EIP-7702 EOAs). Fail closed with 503 if any
  // RPC transport error occurred during `verifySiweMessage`.
  if (transportFailure !== null) {
    throw new OpError(
      503,
      "Base RPC is temporarily unavailable while verifying wallet signature — please try again shortly",
    );
  }

  if (!signatureValid) {
    throw new OpError(
      400,
      `signature verification failed: signature was not produced by ${expectedChecksum} on Base`,
    );
  }

  // Atomically consume the single-use nonce so concurrent replays cannot both succeed.
  const consumed = await db
    .prepare(
      "UPDATE payout_siwe_nonces SET used_at = ? WHERE nonce = ? AND agent_id = ? AND used_at IS NULL AND expires_at > ?",
    )
    .bind(nowIsoStr, nonceRow.nonce, agent.id, nowIsoStr)
    .run();
  if (!consumed.meta.changes) {
    throw new OpError(400, "SIWE nonce has already been used — request a fresh challenge");
  }

  if (matchesCurrent) {
    const upd = await db
      .prepare(
        "UPDATE agents SET payout_address_verified_at = ? WHERE id = ? AND LOWER(payout_address) = ?",
      )
      .bind(nowIsoStr, agent.id, addrLower)
      .run();
    if (!upd.meta.changes) {
      throw new OpError(409, "payout_address changed concurrently; request a new challenge");
    }
  } else {
    // Pending 24-hour hold: record verification WITHOUT altering payout_pending_effective_at.
    const upd = await db
      .prepare(
        "UPDATE agents SET payout_pending_verified_at = ? WHERE id = ? AND LOWER(payout_address_pending) = ?",
      )
      .bind(nowIsoStr, agent.id, addrLower)
      .run();
    if (!upd.meta.changes) {
      throw new OpError(409, "pending payout_address changed concurrently; request a new challenge");
    }
  }

  const view = await payoutView(db, agent.id);
  return {
    agent_id: agent.id,
    verified_target: matchesCurrent ? ("current" as const) : ("pending" as const),
    verified_address: expectedChecksum,
    ...view,
  };
}
