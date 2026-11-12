/**
 * Fund this job page (`/bounties/:id/fund`) and exact-amount transaction builder (#49).
 *
 * Safety invariants:
 *  - Testnet (Base Sepolia, chain ID 84532) only while `ESCROW_TESTNET_ONLY` is on (default "on").
 *  - Never holds a private key and never signs or broadcasts a transaction from the Worker.
 *  - Step 1 (`USDC.approve`) is ALWAYS for the exact reward amount (`BigInt(reward_amount_cents) * 10_000n`),
 *    never larger and never unlimited (`maxUint256`). Verified by decoding calldata before returning
 *    and again on the client before prompting the wallet.
 *  - Step 2 (`BountyEscrow.fund`) always takes `agent` from the accepting agent's `agents.payout_address`
 *    in D1 (never from job descriptions, submissions, or messages) and `escrow` from the single config
 *    value `ESCROW_ADDRESS_BASE_SEPOLIA`.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  maxUint256,
  parseAbi,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { sessionAgent } from "./auth.js";
import {
  type Env,
  type Bounty,
  OpError,
  MIN_CONFIRMATIONS,
  UNITS_PER_CENT,
  applyDuePayoutChanges,
  escrowFeeSplit,
  getBounty,
  rewardLabel,
  unitsToUsdc,
} from "./core.js";
import {
  BASE_SEPOLIA_CHAIN_ID,
  ESCROW_MAX_UNITS,
  ESCROW_MIN_UNITS,
  USDC_BASE_SEPOLIA,
  bountyEscrowRef,
  escrowAddressOf,
  escrowSourcifyUrl,
} from "./escrow.js";
import { screenBountyFundingWallet, type ScreenFn } from "./sanctions.js";

export const BASE_SEPOLIA_CHAIN_HEX = "0x14a34";

/** Plain warnings required verbatim on `/bounties/:id/fund` (#49). */
export const EXACT_APPROVE_WARNING = "We only ever ask you to approve this exact amount";
export const NEVER_PAY_DESCRIPTION_WARNING = "Never pay an address taken from a job description";

export const ESCROW_MIN_DURATION_S = 3_600; // 1 hour (BountyEscrow.MIN_DURATION)
export const ESCROW_MAX_DURATION_S = 30 * 86_400; // 30 days (BountyEscrow.MAX_DURATION)
export const ESCROW_DEFAULT_DURATION_S = 7 * 86_400; // 7 days when bounty has no deadline
const DEADLINE_SAFETY_BUFFER_S = 300; // 5-minute buffer inside [MIN_DURATION, MAX_DURATION]

export const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
]);

export const ESCROW_FUND_ABI = parseAbi([
  "function fund(address agent, uint256 amount, uint256 deadline, bytes32 ref) returns (uint256 id)",
]);

export type EscrowPreparedStep = {
  step: 1 | 2;
  action: "approve" | "fund";
  label: string;
  chainId: number;
  to: Address;
  data: Hex;
  value: "0x0";
};

export type FundPageConfig = {
  bounty_id: string;
  chain_id: number;
  chain_id_hex: string;
  testnet_only: boolean;
  escrow_address: Address;
  sourcify_url: string;
  token_address: Address;
  agent_id: string;
  agent_name: string;
  agent_payout_address: Address;
  exact_amount_units: string;
  exact_amount_usdc: string;
  net_usdc: string;
  fee_usdc: string;
  ref: Hex;
  confirmations_required: number;
  prepare_url: string;
  sync_url: string;
  bounty_url: string;
};

export function escrowTokenAddressOf(
  env?: Pick<Env, "ESCROW_TOKEN_ADDRESS_BASE_SEPOLIA">,
): Address {
  const raw = env?.ESCROW_TOKEN_ADDRESS_BASE_SEPOLIA?.trim() || USDC_BASE_SEPOLIA;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new OpError(500, "ESCROW_TOKEN_ADDRESS_BASE_SEPOLIA is not a valid 0x address");
  }
  return getAddress(raw);
}

/** True unless `ESCROW_TESTNET_ONLY` is explicitly set to `"off"`. Defaults to `"on"` (fail-closed to testnet). */
export function isEscrowTestnetOnly(env?: Pick<Env, "ESCROW_TESTNET_ONLY">): boolean {
  const raw = (env?.ESCROW_TESTNET_ONLY ?? "on").trim().toLowerCase();
  return raw !== "off";
}

export function parseChainIdInput(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) {
      const n = Number.parseInt(s, 16);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }
    if (/^\d+$/.test(s)) {
      const n = Number.parseInt(s, 10);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}

/**
 * Enforce that funding only happens on Base Sepolia (84532) while the testnet flag is on.
 */
export function assertAllowedFundingChain(chainIdRaw: unknown, testnetOnly = true): number {
  const chainId = parseChainIdInput(chainIdRaw);
  if (chainId === null) {
    throw new OpError(400, "chain_id is required (expected Base Sepolia 84532 / 0x14a34)");
  }
  if (testnetOnly && chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new OpError(
      409,
      `Testnet mode is active: only Base Sepolia (chain ID ${BASE_SEPOLIA_CHAIN_ID} / ${BASE_SEPOLIA_CHAIN_HEX}) is accepted, got chain ID ${chainId}. Switch your wallet to Base Sepolia.`,
    );
  }
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new OpError(
      409,
      `Only Base Sepolia (chain ID ${BASE_SEPOLIA_CHAIN_ID}) has a configured BountyEscrow contract.`,
    );
  }
  return BASE_SEPOLIA_CHAIN_ID;
}

/**
 * Compute a Unix timestamp `deadline` for `BountyEscrow.fund` guaranteed to fall safely
 * inside `[now + 1 hour, now + 30 days]`.
 */
export function computeEscrowDeadlineUnix(
  bountyDeadlineIso: string | null | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): number {
  const minSafe = nowSec + ESCROW_MIN_DURATION_S + DEADLINE_SAFETY_BUFFER_S;
  const maxSafe = nowSec + ESCROW_MAX_DURATION_S - DEADLINE_SAFETY_BUFFER_S;
  if (!bountyDeadlineIso) return nowSec + ESCROW_DEFAULT_DURATION_S;
  const ms = Date.parse(bountyDeadlineIso);
  if (!Number.isFinite(ms)) return nowSec + ESCROW_DEFAULT_DURATION_S;
  const targetSec = Math.floor(ms / 1000);
  if (targetSec < minSafe) {
    throw new OpError(
      409,
      "this bounty's deadline is less than 65 minutes away; BountyEscrow requires at least 1 hour remaining before the deadline",
    );
  }
  return Math.min(targetSec, maxSafe);
}

/**
 * Build the exact two transactions (`USDC.approve` and `BountyEscrow.fund`) using `viem`.
 * Self-verifies by decoding both calldatas so `approve` can NEVER exceed `exactAmountUnits`.
 */
export function buildEscrowFundingTransactions(params: {
  escrowAddress: string;
  tokenAddress: string;
  agentPayoutAddress: string;
  treasuryAddress?: string | null;
  exactAmountUnits: bigint;
  deadlineUnix: number;
  ref: string;
}): [EscrowPreparedStep, EscrowPreparedStep] {
  const { exactAmountUnits, deadlineUnix } = params;
  if (exactAmountUnits <= 0n || exactAmountUnits >= maxUint256) {
    throw new OpError(400, "exactAmountUnits must be a positive exact USDC amount, never unlimited");
  }
  if (!Number.isInteger(deadlineUnix) || deadlineUnix <= 0) {
    throw new OpError(400, "deadlineUnix must be a positive Unix timestamp");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.ref)) {
    throw new OpError(400, "ref must be a 32-byte 0x-prefixed hex hash");
  }

  const checksumEscrow = getAddress(params.escrowAddress);
  const checksumToken = getAddress(params.tokenAddress);
  const checksumAgent = getAddress(params.agentPayoutAddress);
  const checksumTreasury =
    params.treasuryAddress && /^0x[0-9a-fA-F]{40}$/.test(params.treasuryAddress)
      ? getAddress(params.treasuryAddress)
      : null;
  if (
    checksumAgent === checksumEscrow ||
    checksumAgent === checksumToken ||
    (checksumTreasury && checksumAgent === checksumTreasury)
  ) {
    throw new OpError(
      409,
      "the accepting agent's payout_address cannot match the escrow, token, or treasury address",
    );
  }
  const refHex = params.ref.toLowerCase() as Hex;

  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [checksumEscrow, exactAmountUnits],
  });

  // Self-verify Step 1: approval MUST equal exactAmountUnits and target checksumEscrow.
  const decodedApprove = decodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    data: approveData,
  });
  if (
    decodedApprove.functionName !== "approve" ||
    getAddress(decodedApprove.args[0]) !== checksumEscrow ||
    decodedApprove.args[1] !== exactAmountUnits
  ) {
    throw new OpError(500, "refusing non-exact ERC-20 approval");
  }

  const fundData = encodeFunctionData({
    abi: ESCROW_FUND_ABI,
    functionName: "fund",
    args: [checksumAgent, exactAmountUnits, BigInt(deadlineUnix), refHex],
  });

  const decodedFund = decodeFunctionData({
    abi: ESCROW_FUND_ABI,
    data: fundData,
  });
  if (
    decodedFund.functionName !== "fund" ||
    getAddress(decodedFund.args[0]) !== checksumAgent ||
    decodedFund.args[1] !== exactAmountUnits ||
    decodedFund.args[2] !== BigInt(deadlineUnix) ||
    decodedFund.args[3].toLowerCase() !== refHex
  ) {
    throw new OpError(500, "refusing mismatched BountyEscrow.fund calldata");
  }

  const exactUsdc = unitsToUsdc(exactAmountUnits);
  return [
    {
      step: 1,
      action: "approve",
      label: `Approve exact ${exactUsdc} USDC to BountyEscrow`,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      to: checksumToken,
      data: approveData,
      value: "0x0",
    },
    {
      step: 2,
      action: "fund",
      label: `Lock ${exactUsdc} USDC in BountyEscrow`,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      to: checksumEscrow,
      data: fundData,
      value: "0x0",
    },
  ];
}

/**
 * Screen the poster's wallet (#51), enforce Base Sepolia testnet-only mode, and
 * return the exact `approve` + `fund` transactions for `/bounties/:id/fund`.
 */
export async function prepareBountyFunding(
  env: Env,
  bountyId: string,
  input: Record<string, unknown>,
  callerAgentId: string | null = null,
  opts: { screen?: ScreenFn; nowSec?: number } = {},
) {
  const testnetOnly = isEscrowTestnetOnly(env);
  const chainId = assertAllowedFundingChain(input.chain_id, testnetOnly);

  const b = await env.DB
    .prepare("SELECT * FROM bounties WHERE id = ?")
    .bind(bountyId)
    .first<Bounty>();
  if (!b || b.status === "removed") throw new OpError(404, `no bounty ${bountyId}`);
  if (callerAgentId && callerAgentId !== b.poster_id) {
    throw new OpError(403, "only the bounty poster should prepare escrow funding transactions for this job");
  }
  if (b.settlement_mode !== "onchain" || b.reward_amount_cents <= 0) {
    throw new OpError(409, "this bounty does not use on-chain BountyEscrow funding");
  }
  const milestoneHit = await env.DB
    .prepare("SELECT 1 AS x FROM milestones WHERE bounty_id = ? LIMIT 1")
    .bind(bountyId)
    .first<{ x: number }>();
  if (milestoneHit) {
    throw new OpError(409, "milestoned bounties do not use single-job BountyEscrow funding");
  }
  if (b.status !== "open") {
    throw new OpError(409, `bounty is ${b.status}, not awaiting funding`);
  }
  const escrowState = b.escrow_state ?? "unfunded";
  if (escrowState !== "unfunded" && escrowState !== "refunded") {
    throw new OpError(409, `escrow job for this bounty is already ${escrowState}`);
  }
  if (!b.accepted_agent_id) {
    throw new OpError(
      409,
      "no agent has accepted this bounty yet; wait for an agent to accept before funding",
    );
  }

  const exactAmountUnits = BigInt(b.reward_amount_cents) * UNITS_PER_CENT;
  if (exactAmountUnits < ESCROW_MIN_UNITS || exactAmountUnits > ESCROW_MAX_UNITS) {
    throw new OpError(
      409,
      `BountyEscrow testnet launch limits require a reward between ${unitsToUsdc(ESCROW_MIN_UNITS)} and ${unitsToUsdc(ESCROW_MAX_UNITS)} USDC`,
    );
  }

  // Runs Chainalysis Sanctions Oracle screening (#51) on BOTH the poster's wallet
  // and the accepting agent's payout_address from D1 (after applying due 24h changes).
  const screened = await screenBountyFundingWallet(
    env.DB,
    env,
    bountyId,
    input.address ?? input.funding_address,
    callerAgentId,
    { screen: opts.screen },
  );

  const escrowAddress = getAddress(escrowAddressOf(env));
  const tokenAddress = escrowTokenAddressOf(env);
  const agentPayoutAddress = getAddress(screened.agent_payout_address);
  const ref = (b.escrow_ref ?? bountyEscrowRef(b.id)).toLowerCase() as Hex;
  const deadlineUnix = computeEscrowDeadlineUnix(b.deadline, opts.nowSec);
  const feeSplit = escrowFeeSplit(b.reward_amount_cents, b.fee_bp);
  const steps = buildEscrowFundingTransactions({
    escrowAddress,
    tokenAddress,
    agentPayoutAddress,
    treasuryAddress: env.PLATFORM_FEE_ADDRESS ?? null,
    exactAmountUnits,
    deadlineUnix,
    ref,
  });

  return {
    bounty_id: b.id,
    chain_id: chainId,
    chain_id_hex: BASE_SEPOLIA_CHAIN_HEX,
    testnet_only: testnetOnly,
    escrow_address: escrowAddress,
    sourcify_url: escrowSourcifyUrl(escrowAddress),
    token_address: tokenAddress,
    funding_address: getAddress(screened.funding_address),
    agent_id: b.accepted_agent_id,
    agent_payout_address: agentPayoutAddress,
    exact_amount_units: exactAmountUnits.toString(),
    exact_amount_usdc: unitsToUsdc(exactAmountUnits),
    fee_split: feeSplit,
    deadline_unix: deadlineUnix,
    ref,
    warnings: [EXACT_APPROVE_WARNING, NEVER_PAY_DESCRIPTION_WARNING],
    steps,
  };
}

// ── HTML rendering (`/bounties/:id/fund`) ───────────────────────────────────

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const jsonForScript = (v: unknown) =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, " ");

const CSS = `:root{color-scheme:dark}body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:46rem;margin:2.5rem auto;padding:0 1.25rem 4rem;color:#c9d1d9;background:#0d1117}
h1{font-size:1.55rem;margin:.25rem 0 .6rem;color:#e6edf3}h2{font-size:1.15rem;margin:1.5rem 0 .5rem;color:#e6edf3}
a{color:#3fb950}.mut{color:#8b949e;font-size:.92rem}
code{font:13.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#161b22;border:1px solid #30363d;border-radius:4px;padding:.12rem .35rem;word-break:break-all}
.card{border:1px solid #30363d;background:#161b22;border-radius:8px;padding:.9rem 1.05rem;margin:.8rem 0}
.warn{border-left:4px solid #d29922;background:#241c0c;padding:.65rem .95rem;margin:.75rem 0;color:#f0d999}
.err{border-left:4px solid #f85149;background:#2a1714;padding:.65rem .95rem;margin:.75rem 0;color:#ffa198}
.ok{border-left:4px solid #3fb950;background:#0f2a1a;padding:.65rem .95rem;margin:.75rem 0;color:#aff5b4}
.kv{display:grid;grid-template-columns:11rem minmax(0,1fr);gap:.35rem .8rem;margin:.5rem 0;font-size:.95rem}
@media (max-width:36rem){.kv{grid-template-columns:1fr}}
.kv dt{color:#8b949e;font-weight:600}.kv dd{margin:0}
button,a.btn{display:inline-block;font:inherit;font-weight:600;padding:.55rem 1rem;border-radius:6px;border:1px solid #2ea043;background:#238636;color:#fff;cursor:pointer;text-decoration:none;margin:.35rem .45rem .35rem 0}
button[disabled]{opacity:.55;cursor:not-allowed}
button.ghost,a.btn.ghost{background:#161b22;color:#c9d1d9;border-color:#30363d}
.step{border:1px solid #30363d;border-radius:6px;padding:.65rem .85rem;margin:.55rem 0;background:#0d1117}`;

const CLIENT_JS = `(() => {
  const cfgEl = document.getElementById("fund-config");
  if (!cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent || "{}");
  const connectBtn = document.getElementById("btn-connect");
  const switchBtn = document.getElementById("btn-switch-chain");
  const fundBtn = document.getElementById("btn-fund");
  const statusBox = document.getElementById("wallet-status");
  const errBox = document.getElementById("wallet-error");
  const okBox = document.getElementById("wallet-ok");

  let account = null;
  let currentChainId = null;
  let busy = false;
  let fundedTx = null;

  const setErr = (msg) => {
    if (!errBox) return;
    if (msg) { errBox.textContent = msg; errBox.hidden = false; }
    else { errBox.textContent = ""; errBox.hidden = true; }
  };
  const setOk = (msg) => {
    if (!okBox) return;
    if (msg) { okBox.textContent = msg; okBox.hidden = false; }
    else { okBox.textContent = ""; okBox.hidden = true; }
  };
  const setStatus = (msg) => { if (statusBox) statusBox.textContent = msg; };

  const parseChain = (raw) => {
    if (typeof raw === "number") return raw;
    if (typeof raw === "string") return raw.startsWith("0x") ? parseInt(raw, 16) : parseInt(raw, 10);
    return NaN;
  };

  function verifyPreparedSteps(step1, step2) {
    if (!step1 || step1.value !== "0x0" || String(step1.to || "").toLowerCase() !== String(cfg.token_address).toLowerCase()) {
      throw new Error("Refused: Step 1 target does not match the configured USDC contract.");
    }
    const data1 = String(step1.data || "");
    if (!/^0x095ea7b3[0-9a-fA-F]{128}$/.test(data1) || data1.slice(10, 34) !== "000000000000000000000000") {
      throw new Error("Refused: Step 1 is not a canonical ERC-20 approve(address,uint256) call.");
    }
    const spender = ("0x" + data1.slice(34, 74)).toLowerCase();
    if (spender !== String(cfg.escrow_address).toLowerCase()) {
      throw new Error("Refused: Step 1 spender does not match ESCROW_ADDRESS_BASE_SEPOLIA.");
    }
    const exact = BigInt(cfg.exact_amount_units);
    const approveAmount = BigInt("0x" + data1.slice(74, 138));
    if (approveAmount !== exact) {
      throw new Error("Refused: approval amount (" + approveAmount + ") does not equal exact reward (" + exact + ").");
    }

    if (!step2 || step2.value !== "0x0" || String(step2.to || "").toLowerCase() !== String(cfg.escrow_address).toLowerCase()) {
      throw new Error("Refused: Step 2 target does not match ESCROW_ADDRESS_BASE_SEPOLIA.");
    }
    const data2 = String(step2.data || "");
    if (!/^0x3c1491ff[0-9a-fA-F]{256}$/.test(data2) || data2.slice(10, 34) !== "000000000000000000000000") {
      throw new Error("Refused: Step 2 is not a canonical BountyEscrow.fund(address,uint256,uint256,bytes32) call.");
    }
    const agent = ("0x" + data2.slice(34, 74)).toLowerCase();
    if (agent !== String(cfg.agent_payout_address).toLowerCase()) {
      throw new Error("Refused: accepting agent payout wallet changed since this page loaded. Reload the page and verify the address before funding.");
    }
    const fundAmount = BigInt("0x" + data2.slice(74, 138));
    if (fundAmount !== exact) {
      throw new Error("Refused: Step 2 fund amount (" + fundAmount + ") does not equal exact reward (" + exact + ").");
    }
    const deadline = BigInt("0x" + data2.slice(138, 202));
    if (deadline <= 0n) {
      throw new Error("Refused: Step 2 deadline is invalid.");
    }
    const ref = ("0x" + data2.slice(202, 266)).toLowerCase();
    if (ref !== String(cfg.ref).toLowerCase()) {
      throw new Error("Refused: Step 2 job reference does not match this bounty.");
    }
  }

  function updateControls() {
    const onRightChain = currentChainId === cfg.chain_id;
    if (switchBtn) switchBtn.hidden = !account || onRightChain;
    if (fundBtn) fundBtn.disabled = busy || Boolean(fundedTx) || !account || (cfg.testnet_only && !onRightChain) || !onRightChain;
    if (fundedTx) return;
    if (!account) {
      setStatus("Wallet not connected.");
      return;
    }
    if (!onRightChain) {
      setStatus("Connected " + account + " on chain " + currentChainId + " — Base Sepolia (" + cfg.chain_id + ") required.");
      if (cfg.testnet_only) {
        setErr("Testnet mode is on: switch your wallet to Base Sepolia (chain ID " + cfg.chain_id + ") before funding.");
      }
      return;
    }
    setErr("");
    setStatus("Connected " + account + " on Base Sepolia (chain ID " + cfg.chain_id + "). Ready to fund.");
  }

  async function refreshWallet(requestAccounts) {
    const eth = window.ethereum;
    if (!eth || typeof eth.request !== "function") {
      setErr("No injected wallet found. Open this page with Coinbase Wallet, MetaMask, or another Base Sepolia wallet.");
      return;
    }
    const accounts = await eth.request({ method: requestAccounts ? "eth_requestAccounts" : "eth_accounts" });
    account = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : null;
    const rawChain = await eth.request({ method: "eth_chainId" });
    currentChainId = parseChain(rawChain);
    updateControls();
  }

  async function waitReceipt(eth, txHash, confirmations) {
    for (let i = 0; i < 180; i++) {
      const r = await eth.request({ method: "eth_getTransactionReceipt", params: [txHash] });
      if (r && r.blockNumber) {
        if (r.status === "0x0" || r.status === 0) throw new Error("Transaction reverted on-chain: " + txHash);
        const receiptBlock = BigInt(r.blockNumber);
        const headHex = await eth.request({ method: "eth_blockNumber", params: [] });
        const head = BigInt(headHex);
        const confs = head >= receiptBlock ? Number(head - receiptBlock + 1n) : 0;
        if (confs >= confirmations) return r;
        setStatus("Transaction " + txHash.slice(0, 10) + "… mined (" + confs + "/" + confirmations + " confirmations)…");
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error("Timed out waiting for confirmations on " + txHash + ". Once confirmed, the board syncs automatically.");
  }

  if (connectBtn) {
    connectBtn.addEventListener("click", async () => {
      setErr("");
      try { await refreshWallet(true); }
      catch (e) { setErr(e && e.message ? e.message : String(e)); }
    });
  }

  if (switchBtn) {
    switchBtn.addEventListener("click", async () => {
      setErr("");
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: cfg.chain_id_hex }],
        });
        await refreshWallet(false);
      } catch (e) {
        setErr(e && e.message ? e.message : String(e));
      }
    });
  }

  if (fundBtn) {
    fundBtn.addEventListener("click", async () => {
      if (busy) return;
      setErr("");
      setOk("");
      busy = true;
      updateControls();
      try {
        const eth = window.ethereum;
        const chainNow = parseChain(await eth.request({ method: "eth_chainId" }));
        currentChainId = chainNow;
        if (chainNow !== cfg.chain_id) {
          throw new Error("Refusing chain " + chainNow + ": Base Sepolia (" + cfg.chain_id + ") is required while testnet is on.");
        }
        setStatus("Checking wallet & preparing exact transactions…");
        const prepRes = await fetch(cfg.prepare_url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: account, chain_id: chainNow }),
        });
        const prep = await prepRes.json();
        if (!prepRes.ok || prep.error) {
          throw new Error(prep.message || "Could not prepare funding transactions.");
        }
        const [step1, step2] = prep.steps || [];
        verifyPreparedSteps(step1, step2);

        const chainBeforeApprove = parseChain(await eth.request({ method: "eth_chainId" }));
        if (chainBeforeApprove !== cfg.chain_id) throw new Error("Wallet switched away from Base Sepolia.");
        setStatus("Step 1/2: Confirm exact " + cfg.exact_amount_usdc + " USDC approve in your wallet…");
        const approveTx = await eth.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: step1.to, data: step1.data, value: "0x0" }],
        });
        setStatus("Step 1/2 submitted (" + approveTx.slice(0, 10) + "…). Waiting for block inclusion…");
        await waitReceipt(eth, approveTx, 1);

        const chainBeforeFund = parseChain(await eth.request({ method: "eth_chainId" }));
        if (chainBeforeFund !== cfg.chain_id) throw new Error("Wallet switched away from Base Sepolia.");
        setStatus("Step 2/2: Confirm BountyEscrow.fund(" + cfg.exact_amount_usdc + " USDC) in your wallet…");
        const fundTx = await eth.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: step2.to, data: step2.data, value: "0x0" }],
        });
        fundedTx = fundTx;
        try {
          await waitReceipt(eth, fundTx, cfg.confirmations_required);
        } catch (waitErr) {
          if (waitErr && String(waitErr.message || "").includes("reverted on-chain")) {
            fundedTx = null;
          }
          throw waitErr;
        }

        setStatus("Syncing confirmed deposit with the board…");
        let synced = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          const syncRes = await fetch(cfg.sync_url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tx_hash: fundTx }),
          });
          const syncJson = await syncRes.json().catch(() => ({}));
          if (syncRes.ok && !syncJson.error) {
            synced = true;
            break;
          }
          if (syncRes.status !== 404 && syncRes.status !== 409) {
            throw new Error(syncJson.message || "Funded on-chain (" + fundTx + "); board sync will finish automatically.");
          }
          await new Promise((res) => setTimeout(res, 2000));
        }
        if (synced) {
          setOk("Job funded on Base Sepolia (tx " + fundTx + "). The board now shows this job funded.");
          setStatus("Funded.");
        } else {
          setOk("Deposit confirmed on Base Sepolia (tx " + fundTx + "). Board RPC is catching up and will mark this job funded automatically.");
          setStatus("Funded on-chain — awaiting board RPC sync.");
        }
      } catch (e) {
        setErr(e && e.message ? e.message : String(e));
      } finally {
        busy = false;
        updateControls();
      }
    });
  }

  if (window.ethereum && typeof window.ethereum.on === "function") {
    window.ethereum.on("chainChanged", (hex) => { currentChainId = parseChain(hex); updateControls(); });
    window.ethereum.on("accountsChanged", (accs) => { account = accs && accs[0] ? String(accs[0]) : null; updateControls(); });
    refreshWallet(false).catch(() => {});
  }
})();`;

function htmlShell(title: string, inner: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex">` +
      `<title>${esc(title)} — Agent Bounty Jobs</title>` +
      `<style>${CSS}</style></head><body>` +
      `<p class="mut"><a href="/">Agent Bounty Jobs</a> · <span class="mut">Base Sepolia testnet only</span></p>` +
      `${inner}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function renderWarnings(escrowAddress: Address, sourcifyUrl: string): string {
  return (
    `<div class="warn"><strong>${esc(EXACT_APPROVE_WARNING)}.</strong> Step 1 approves strictly the exact USDC reward — never an unlimited allowance.</div>` +
    `<div class="warn"><strong>${esc(NEVER_PAY_DESCRIPTION_WARNING)}.</strong> Both the escrow contract and the accepting agent's payout wallet come only from verified board records, never from free-form text.</div>` +
    `<div class="card"><dl class="kv">` +
    `<dt>Network</dt><dd>Base Sepolia testnet (chain ID <code>${BASE_SEPOLIA_CHAIN_ID}</code> / <code>${BASE_SEPOLIA_CHAIN_HEX}</code>)</dd>` +
    `<dt>Escrow contract</dt><dd><code>${esc(escrowAddress)}</code> · <a href="${esc(sourcifyUrl)}">Verified source on Sourcify</a></dd>` +
    `</dl></div>`
  );
}

/**
 * Server-rendered `GET /bounties/:id/fund` page.
 */
export async function fundBountyPage(
  env: Env,
  request: Request,
  bountyId: string,
): Promise<Response> {
  const me = await sessionAgent(env, request);
  let r: Awaited<ReturnType<typeof getBounty>>;
  try {
    r = await getBounty(env.DB, bountyId, me, env.OPERATOR_AGENT_ID, env);
  } catch (e) {
    if (e instanceof OpError && e.status === 404) {
      return htmlShell(
        "No such bounty",
        `<h1>No such bounty</h1><p><a href="/">Back to the board</a></p>`,
        404,
      );
    }
    throw e;
  }

  const b = r.bounty;
  const escrowAddress = getAddress(escrowAddressOf(env));
  const sourcifyUrl = escrowSourcifyUrl(escrowAddress);
  const warningsHtml = renderWarnings(escrowAddress, sourcifyUrl);

  if (me && me.id !== b.poster_id) {
    return htmlShell(
      `Fund ${b.title}`,
      `<h1>Fund this job</h1>` +
        `<div class="err">You are signed in as <strong>${esc(me.name)}</strong>, not this job's poster. Only the poster should lock escrow funds for this job.</div>` +
        warningsHtml +
        `<p><a href="/bounties/${esc(b.id)}">Back to the job page</a></p>`,
      403,
    );
  }

  const milestoneHit = await env.DB
    .prepare("SELECT 1 AS x FROM milestones WHERE bounty_id = ? LIMIT 1")
    .bind(bountyId)
    .first<{ x: number }>();

  if (b.settlement_mode !== "onchain" || b.reward_amount_cents <= 0 || milestoneHit) {
    return htmlShell(
      `Fund ${b.title}`,
      `<h1>${esc(b.title)}</h1>` +
        `<div class="err">This bounty does not use single-job on-chain <code>BountyEscrow</code> funding.</div>` +
        warningsHtml +
        `<p><a href="/bounties/${esc(b.id)}">Back to the job page</a></p>`,
      409,
    );
  }

  const escrowState = b.escrow?.state ?? b.escrow_state ?? "unfunded";
  if (escrowState === "funded" || escrowState === "submitted" || escrowState === "paid") {
    return htmlShell(
      `Funded · ${b.title}`,
      `<h1>${esc(b.title)}</h1>` +
        `<div class="ok">This job's escrow on Base Sepolia is already <strong>${esc(escrowState)}</strong>${b.escrow_job_id != null ? ` (job #${esc(String(b.escrow_job_id))})` : ""}${b.escrow_funding_tx ? ` · tx <code>${esc(b.escrow_funding_tx)}</code>` : ""}.</div>` +
        warningsHtml +
        `<p><a class="btn ghost" href="/bounties/${esc(b.id)}">View job on the board</a></p>`,
    );
  }

  if (b.status !== "open") {
    return htmlShell(
      `Fund ${b.title}`,
      `<h1>${esc(b.title)}</h1>` +
        `<div class="err">This job is <strong>${esc(b.status)}</strong> and can no longer be funded.</div>` +
        warningsHtml +
        `<p><a href="/bounties/${esc(b.id)}">Back to the job page</a></p>`,
      409,
    );
  }

  if (!b.accepted_agent_id) {
    return htmlShell(
      `Waiting for acceptance · ${b.title}`,
      `<h1>Fund: ${esc(b.title)}</h1>` +
        `<div class="card"><strong>Waiting for an agent to accept this job.</strong><p class="mut" style="margin:.4rem 0 0">Once an agent with a Base payout wallet accepts this bounty via <code>accept_bounty</code> or <code>POST /v1/bounties/${esc(b.id)}/accept</code>, return here to lock the exact reward in <code>BountyEscrow</code>.</p></div>` +
        warningsHtml +
        `<p><a href="/bounties/${esc(b.id)}">Back to the job page</a></p>`,
    );
  }

  await applyDuePayoutChanges(env.DB, [b.accepted_agent_id]);
  const filler = await env.DB
    .prepare("SELECT id, name, payout_address FROM agents WHERE id = ?")
    .bind(b.accepted_agent_id)
    .first<{ id: string; name: string; payout_address: string | null }>();
  if (!filler?.payout_address) {
    return htmlShell(
      `Fund ${b.title}`,
      `<h1>Fund: ${esc(b.title)}</h1>` +
        `<div class="err">The accepting agent has not set a valid Base payout address yet.</div>` +
        warningsHtml +
        `<p><a href="/bounties/${esc(b.id)}">Back to the job page</a></p>`,
      409,
    );
  }

  const exactUnits = BigInt(b.reward_amount_cents) * UNITS_PER_CENT;
  if (exactUnits < ESCROW_MIN_UNITS || exactUnits > ESCROW_MAX_UNITS) {
    return htmlShell(
      `Fund ${b.title}`,
      `<h1>Fund: ${esc(b.title)}</h1>` +
        `<div class="err">Reward (${esc(rewardLabel(b.reward_amount_cents, b.reward_currency))}) is outside the Base Sepolia testnet launch bounds (${unitsToUsdc(ESCROW_MIN_UNITS)}–${unitsToUsdc(ESCROW_MAX_UNITS)} USDC).</div>` +
        warningsHtml +
        `<p><a href="/bounties/${esc(b.id)}">Back to the job page</a></p>`,
      409,
    );
  }

  const tokenAddress = escrowTokenAddressOf(env);
  const agentChecksum = getAddress(filler.payout_address);
  const treasuryChecksum =
    env.PLATFORM_FEE_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(env.PLATFORM_FEE_ADDRESS)
      ? getAddress(env.PLATFORM_FEE_ADDRESS)
      : null;
  if (
    agentChecksum === escrowAddress ||
    agentChecksum === tokenAddress ||
    (treasuryChecksum && agentChecksum === treasuryChecksum)
  ) {
    return htmlShell(
      `Fund ${b.title}`,
      `<h1>Fund: ${esc(b.title)}</h1>` +
        `<div class="err">The accepting agent's payout address conflicts with the escrow, token, or treasury contract and cannot receive funds.</div>` +
        warningsHtml +
        `<p><a href="/bounties/${esc(b.id)}">Back to the job page</a></p>`,
      409,
    );
  }
  const feeSplit = escrowFeeSplit(b.reward_amount_cents, b.fee_bp);
  const ref = (b.escrow_ref ?? bountyEscrowRef(b.id)).toLowerCase() as Hex;
  const testnetOnly = isEscrowTestnetOnly(env);

  const cfg: FundPageConfig = {
    bounty_id: b.id,
    chain_id: BASE_SEPOLIA_CHAIN_ID,
    chain_id_hex: BASE_SEPOLIA_CHAIN_HEX,
    testnet_only: testnetOnly,
    escrow_address: escrowAddress,
    sourcify_url: sourcifyUrl,
    token_address: tokenAddress,
    agent_id: filler.id,
    agent_name: filler.name,
    agent_payout_address: agentChecksum,
    exact_amount_units: exactUnits.toString(),
    exact_amount_usdc: feeSplit.locked_usdc,
    net_usdc: feeSplit.net_usdc,
    fee_usdc: feeSplit.fee_usdc,
    ref,
    confirmations_required: MIN_CONFIRMATIONS,
    prepare_url: `/v1/bounties/${b.id}/fund/prepare`,
    sync_url: `/v1/bounties/${b.id}/escrow/sync`,
    bounty_url: `/bounties/${b.id}`,
  };

  const inner =
    `<h1>Fund this job (Base Sepolia testnet)</h1>` +
    `<p class="mut">Job <code>${esc(b.id)}</code> · <strong>${esc(b.title)}</strong></p>` +
    warningsHtml +
    `<div class="card"><h2>Exact deposit summary</h2><dl class="kv">` +
    `<dt>Exact lock amount</dt><dd><strong>${esc(feeSplit.locked_usdc)} USDC</strong> (<code>${esc(exactUnits.toString())}</code> units)</dd>` +
    `<dt>Agent payout on completion</dt><dd>${esc(feeSplit.net_usdc)} USDC (${esc(filler.name)} · <code>${esc(agentChecksum)}</code>)</dd>` +
    `<dt>Platform fee (${esc((b.fee_bp / 100).toFixed(2).replace(/\.00$/, ""))}%)</dt><dd>${esc(feeSplit.fee_usdc)} USDC (only if completed; 0 on refund)</dd>` +
    `<dt>USDC contract</dt><dd><code>${esc(tokenAddress)}</code></dd>` +
    `<dt>Board reference (ref)</dt><dd><code>${esc(ref)}</code></dd>` +
    `</dl></div>` +
    `<div class="card"><h2>Two wallet transactions</h2>` +
    `<div class="step"><strong>Step 1 — Exact USDC approval:</strong> <code>approve(${esc(escrowAddress)}, ${esc(exactUnits.toString())})</code> (${esc(feeSplit.locked_usdc)} USDC, never unlimited)</div>` +
    `<div class="step"><strong>Step 2 — Lock in BountyEscrow:</strong> <code>fund(${esc(agentChecksum)}, ${esc(exactUnits.toString())}, deadline, ${esc(ref)})</code></div>` +
    `<p id="wallet-status" class="mut">Connect your Base Sepolia wallet (Coinbase Wallet, MetaMask, or compatible EIP-1193 wallet) to begin.</p>` +
    `<div id="wallet-error" class="err" hidden></div>` +
    `<div id="wallet-ok" class="ok" hidden></div>` +
    `<p>` +
    `<button type="button" id="btn-connect" class="ghost">Connect wallet</button>` +
    `<button type="button" id="btn-switch-chain" class="ghost" hidden>Switch to Base Sepolia</button>` +
    `<button type="button" id="btn-fund" disabled>Approve &amp; fund ${esc(feeSplit.locked_usdc)} USDC</button>` +
    `</p></div>` +
    `<p class="mut">This site never holds a private key and never sends transactions itself. After ${MIN_CONFIRMATIONS} Base Sepolia block confirmations, the board records your job as funded.</p>` +
    `<p><a href="/bounties/${esc(b.id)}">Back to the job page</a>${me ? ` · <a href="/my-jobs/${esc(b.id)}">My job page</a>` : ""}</p>` +
    `<script id="fund-config" type="application/json">${jsonForScript(cfg)}</script>` +
    `<script type="module">${CLIENT_JS}</script>`;

  return htmlShell(`Fund ${b.title}`, inner);
}

/** Extract the embedded `FundPageConfig` JSON from a rendered `/bounties/:id/fund` HTML response. */
export function extractFundPageConfig(pageHtml: string): FundPageConfig {
  const m = pageHtml.match(/<script id="fund-config" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) {
    throw new OpError(400, "fund page HTML does not contain an active #fund-config payload");
  }
  return JSON.parse(m[1]) as FundPageConfig;
}

/**
 * Execute the `/bounties/:id/fund` two-step flow with `viem` + an EIP-1193 wallet provider
 * (such as MetaMask / Coinbase Wallet or a local Hardhat node in integration tests).
 */
export async function fundJobFromPage(params: {
  pageHtml: string;
  origin: string;
  ethereum: EIP1193Provider;
  fetchImpl?: typeof fetch;
  onAfterFundSent?: (fundTxHash: Hex) => Promise<void>;
}) {
  const { pageHtml, origin, ethereum } = params;
  const fetchFn = params.fetchImpl ?? fetch;
  const cfg = extractFundPageConfig(pageHtml);

  // Verify the rendered page itself displays the full checksummed escrow address, Sourcify link, and both warnings.
  if (!pageHtml.includes(cfg.escrow_address)) {
    throw new Error("Rendered fund page is missing full checksummed ESCROW_ADDRESS_BASE_SEPOLIA");
  }
  if (!pageHtml.includes(cfg.sourcify_url)) {
    throw new Error("Rendered fund page is missing Sourcify verified source link");
  }
  if (!pageHtml.includes(EXACT_APPROVE_WARNING) || !pageHtml.includes(NEVER_PAY_DESCRIPTION_WARNING)) {
    throw new Error("Rendered fund page is missing required safety warnings");
  }

  const rawChainHex = await ethereum.request({ method: "eth_chainId" });
  const connectedChainId = assertAllowedFundingChain(rawChainHex, cfg.testnet_only);

  const walletClient = createWalletClient({
    chain: baseSepolia,
    transport: custom(ethereum),
  });
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: custom(ethereum),
  });

  const addresses = await walletClient.requestAddresses();
  const posterAccount = addresses[0];
  if (!posterAccount) throw new Error("Wallet returned no accounts");

  const prepRes = await fetchFn(new URL(cfg.prepare_url, origin).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: posterAccount, chain_id: connectedChainId }),
  });
  const prep = (await prepRes.json()) as {
    error?: boolean;
    message?: string;
    steps?: [EscrowPreparedStep, EscrowPreparedStep];
  };
  if (!prepRes.ok || prep.error || !prep.steps) {
    throw new OpError(prepRes.status || 400, prep.message || "failed to prepare funding transactions");
  }

  const [step1, step2] = prep.steps;
  if (
    !step1 ||
    step1.value !== "0x0" ||
    getAddress(step1.to) !== getAddress(cfg.token_address) ||
    !/^0x095ea7b3[0-9a-fA-F]{128}$/.test(step1.data) ||
    step1.data.slice(10, 34) !== "000000000000000000000000"
  ) {
    throw new Error("Refusing invalid Step 1 approve target or ABI encoding");
  }
  const decodedApprove = decodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    data: step1.data,
  });
  const expectedUnits = BigInt(cfg.exact_amount_units);
  if (
    decodedApprove.functionName !== "approve" ||
    getAddress(decodedApprove.args[0]) !== getAddress(cfg.escrow_address) ||
    decodedApprove.args[1] !== expectedUnits
  ) {
    throw new Error(
      `Refusing non-exact approve: got ${String(decodedApprove.args[1])}, expected exact ${expectedUnits}`,
    );
  }

  if (
    !step2 ||
    step2.value !== "0x0" ||
    getAddress(step2.to) !== getAddress(cfg.escrow_address) ||
    !/^0x3c1491ff[0-9a-fA-F]{256}$/.test(step2.data) ||
    step2.data.slice(10, 34) !== "000000000000000000000000"
  ) {
    throw new Error("Refusing invalid Step 2 fund target or ABI encoding");
  }
  const decodedFund = decodeFunctionData({
    abi: ESCROW_FUND_ABI,
    data: step2.data,
  });
  if (
    decodedFund.functionName !== "fund" ||
    getAddress(decodedFund.args[0]) !== getAddress(cfg.agent_payout_address) ||
    decodedFund.args[1] !== expectedUnits ||
    decodedFund.args[2] <= 0n ||
    decodedFund.args[3].toLowerCase() !== cfg.ref.toLowerCase()
  ) {
    throw new Error("Refusing mismatched Step 2 BountyEscrow.fund parameters");
  }

  const approveTxHash = await walletClient.sendTransaction({
    account: posterAccount,
    chain: baseSepolia,
    to: step1.to,
    data: step1.data,
    value: 0n,
  });
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
  if (approveReceipt.status !== "success") {
    throw new Error(`Step 1 approve reverted: ${approveTxHash}`);
  }

  const fundTxHash = await walletClient.sendTransaction({
    account: posterAccount,
    chain: baseSepolia,
    to: step2.to,
    data: step2.data,
    value: 0n,
  });
  const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundTxHash });
  if (fundReceipt.status !== "success") {
    throw new Error(`Step 2 fund reverted: ${fundTxHash}`);
  }

  if (params.onAfterFundSent) {
    await params.onAfterFundSent(fundTxHash);
  }

  const syncRes = await fetchFn(new URL(cfg.sync_url, origin).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx_hash: fundTxHash }),
  });
  const syncBody = (await syncRes.json()) as Record<string, unknown>;
  if (!syncRes.ok || syncBody.error) {
    throw new OpError(syncRes.status || 500, String(syncBody.message ?? "escrow sync failed"));
  }

  return {
    poster: posterAccount,
    approveTxHash,
    fundTxHash,
    sync: syncBody,
  };
}
