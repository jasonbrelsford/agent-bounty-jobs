// Real-money (Base mainnet) escrow switch: off by default, fail-closed when half set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import worker from "../.test-build/index.js";
import { registerAgent, authByKey, postBounty, acceptBounty, getBounty } from "../.test-build/core.js";
import { escrowNetworkOf, escrowNetworkView, escrowChainIdOf, USDC_BASE } from "../.test-build/escrow.js";
import { assertAllowedFundingChain, buildEscrowFundingTransactions } from "../.test-build/fundpage.js";

const CTX = { waitUntil: () => {} };
const ORIGIN = "https://bounty.brelsfordsoftware.com";
const MAINNET_ESCROW = "0x1111111111111111111111111111111111111111";
const FEE = "0x4444444444444444444444444444444444444444";
const ON = { ESCROW_TESTNET_ONLY: "off", ESCROW_ADDRESS_BASE: MAINNET_ESCROW, ESCROW_DEPLOY_BLOCK_BASE: "38000000" };

test("testnet stays the default unless the switch is exactly off", () => {
  for (const env of [undefined, {}, { ESCROW_TESTNET_ONLY: "on" }, { ESCROW_TESTNET_ONLY: "yes" }, { ESCROW_TESTNET_ONLY: "" }]) {
    const n = escrowNetworkOf(env);
    assert.equal(n.mainnet, false);
    assert.equal(n.chainId, 84532);
  }
  // Mainnet settings alone never switch it on.
  assert.equal(escrowNetworkOf({ ESCROW_ADDRESS_BASE: MAINNET_ESCROW, ESCROW_DEPLOY_BLOCK_BASE: "5" }).mainnet, false);
});

test("switched on without a contract: escrow pauses rather than guess", () => {
  for (const env of [
    { ESCROW_TESTNET_ONLY: "off" },
    { ESCROW_TESTNET_ONLY: "off", ESCROW_ADDRESS_BASE: MAINNET_ESCROW },
    { ESCROW_TESTNET_ONLY: "off", ESCROW_DEPLOY_BLOCK_BASE: "100" },
    { ESCROW_TESTNET_ONLY: "off", ESCROW_ADDRESS_BASE: "0x123", ESCROW_DEPLOY_BLOCK_BASE: "100" },
    { ESCROW_TESTNET_ONLY: "off", ESCROW_ADDRESS_BASE: MAINNET_ESCROW, ESCROW_DEPLOY_BLOCK_BASE: "0" },
  ]) {
    assert.throws(() => escrowNetworkOf(env), (e) => e.status === 503 && /escrow is paused/.test(e.message));
    const v = escrowNetworkView(env);
    assert.equal(v.paused, true);
    assert.equal(v.real_money, true);
    assert.equal(v.contract, undefined);
  }
});

test("switched on and configured: Base, Circle USDC, chain 8453", () => {
  const n = escrowNetworkOf(ON);
  assert.equal(n.mainnet, true);
  assert.equal(n.chainId, 8453);
  assert.equal(n.chainHex, "0x2105");
  assert.equal(n.tokenAddress, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(n.tokenAddress, USDC_BASE);
  assert.equal(n.deployBlock, 38000000);
  assert.equal(n.rpcUrl, "https://mainnet.base.org");
  // A testnet token override is ignored on mainnet.
  assert.equal(escrowNetworkOf({ ...ON, ESCROW_TOKEN_ADDRESS_BASE_SEPOLIA: MAINNET_ESCROW }).tokenAddress, USDC_BASE);
  const v = escrowNetworkView(ON);
  assert.deepEqual([v.real_money, v.paused, v.chain_id], [true, false, 8453]);
  // A job funded on the old testnet contract still points at testnet.
  assert.equal(escrowChainIdOf("0xB552A72ffA00BD23e9b2bB7b9579f6a35d4d560C", ON), 84532);
  assert.equal(escrowChainIdOf(MAINNET_ESCROW, ON), 8453);
});

test("funding chain checks follow the network", () => {
  const main = escrowNetworkOf(ON);
  assert.equal(assertAllowedFundingChain("0x2105", main), 8453);
  assert.throws(() => assertAllowedFundingChain(84532, main), /Real-money escrow runs on Base/);
  assert.equal(assertAllowedFundingChain(84532, true), 84532);
  assert.throws(() => assertAllowedFundingChain(8453, true), /Testnet mode is active/);
  const steps = buildEscrowFundingTransactions({
    escrowAddress: main.escrowAddress,
    tokenAddress: main.tokenAddress,
    agentPayoutAddress: "0x2222222222222222222222222222222222222222",
    exactAmountUnits: 5_000_000n,
    deadlineUnix: Math.floor(Date.now() / 1000) + 86_400,
    ref: "0x" + "ab".repeat(32),
    chainId: 8453,
  });
  for (const s of steps) assert.equal(Number(s.chain_id ?? s.chainId), 8453);
});

test("the live API says which escrow is in use, and a half-set switch never breaks it", async () => {
  const db = makeD1();
  const res = await worker.fetch(new Request(`${ORIGIN}/v1`), { DB: db }, CTX);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.escrow_network.real_money, false);
  assert.equal(body.escrow_network.chain_id, 84532);

  const half = await worker.fetch(new Request(`${ORIGIN}/v1`), { DB: db, ESCROW_TESTNET_ONLY: "off" }, CTX);
  assert.equal(half.status, 200);
  assert.equal((await half.json()).escrow_network.paused, true);
});

test("a half-set switch pauses funding but jobs stay viewable", async () => {
  const db = makeD1();
  const env = { DB: db, ESCROW_TESTNET_ONLY: "off", PLATFORM_FEE_ADDRESS: FEE };
  const poster = await authByKey(db, (await registerAgent(db, "main-poster", {})).api_key);
  const filler = await authByKey(
    db,
    (await registerAgent(db, "main-filler", { payout_address: "0x3333333333333333333333333333333333333333" })).api_key,
  );
  const created = await postBounty(db, poster, env, {
    title: "Check the mainnet switch keeps jobs readable",
    description: "Read the board while escrow is paused and report what you see.",
    category: "research",
    reward_amount_cents: 300,
    settlement: "onchain",
  });
  const r = await getBounty(db, created.bounty_id, null, undefined, env);
  assert.equal(r.bounty.escrow, undefined);
  assert.match(r.bounty.escrow_paused, /escrow is paused/);
  await assert.rejects(acceptBounty(db, filler, created.bounty_id, env), (e) => e.status === 503);
  const page = await worker.fetch(new Request(`${ORIGIN}/bounties/${created.bounty_id}/fund`), env, CTX);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /Escrow is paused/);
});

test("configured mainnet: the fund page says real USDC on Base", async () => {
  const db = makeD1();
  const env = { DB: db, ...ON, PLATFORM_FEE_ADDRESS: FEE };
  const poster = await authByKey(db, (await registerAgent(db, "real-poster", {})).api_key);
  const created = await postBounty(db, poster, env, {
    title: "Show the real-money fund page wording",
    description: "Open the fund page and confirm it names Base and real USDC.",
    category: "research",
    reward_amount_cents: 300,
    settlement: "onchain",
  });
  const r = await getBounty(db, created.bounty_id, null, undefined, env);
  assert.equal(r.bounty.escrow.chain_id, 8453);
  assert.equal(r.bounty.escrow.network, "base");
  assert.ok(r.bounty.escrow.sourcify_url.includes("/8453/"));
  const page = await worker.fetch(new Request(`${ORIGIN}/bounties/${created.bounty_id}/fund`), env, CTX);
  const html = await page.text();
  assert.match(html, /Real USDC on Base/);
  assert.doesNotMatch(html, /Base Sepolia testnet only/);
});
