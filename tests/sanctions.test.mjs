// Sanctions screening (#51): read-only Chainalysis oracle check on payout
// wallets (signup, first set, 24h change) and poster funding wallets,
// neutral refusal, private operator logging, zero public feed leakage, and
// fail-closed behavior when screening is down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import worker from "../.test-build/index.js";
import {
  registerAgent, authByKey, postBounty, acceptBounty, setPayoutAddress,
  payoutView, recentActivity, readInbox,
} from "../.test-build/core.js";
import { dashboard } from "../.test-build/dashboard.js";
import { FEED_KINDS, publicEvents } from "../.test-build/livefeed.js";
import { createServer } from "../.test-build/mcp.js";
import {
  CHAINALYSIS_SANCTIONS_ORACLE_BASE, IS_SANCTIONED_SELECTOR,
  NEUTRAL_WALLET_REFUSAL, NEUTRAL_FUNDING_TARGET_REFUSAL,
  encodeIsSanctionedCall, queryChainalysisOracle, screenBountyFundingWallet,
} from "../.test-build/sanctions.js";

const CLEAR_A = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const CLEAR_B = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const CLEAR_POSTER = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
const FLAGGED_WALLET = "0x7F367cC41522cE07553e823bf3be79A889DEbe1B";
const FEE_ADDR = "0x" + "fe".repeat(20);
const ESCROW_ADDR = "0xB552A72ffA00BD23e9b2bB7b9579f6a35d4d560C";

const WORD_FALSE = "0x" + "0".repeat(64);
const WORD_TRUE = "0x" + "0".repeat(63) + "1";
const CTX = { waitUntil: () => {} };

async function withMockFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

async function callMcpTool(env, name, args = {}) {
  const srv = createServer(env);
  const handler = srv.server._requestHandlers.get("tools/call");
  return handler(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { requestId: 1, signal: new AbortController().signal, mcpReq: { requestState: () => undefined } },
  );
}

function assertNeutralMessage(msg) {
  assert.equal(typeof msg, "string");
  for (const forbidden of ["sanction", "ofac", "chainalysis", "sdn", "flagged", "blacklist"]) {
    assert.ok(!msg.toLowerCase().includes(forbidden), `message leaked "${forbidden}": ${msg}`);
  }
}

test("encodeIsSanctionedCall & queryChainalysisOracle handle clear, flagged, and fail-closed RPC errors", async () => {
  const data = encodeIsSanctionedCall(FLAGGED_WALLET);
  assert.equal(data, `${IS_SANCTIONED_SELECTOR}000000000000000000000000${FLAGGED_WALLET.slice(2).toLowerCase()}`);
  assert.equal(data.length, 10 + 64);

  // Clear (0x00..00) and Flagged (0x00..01)
  await withMockFetch(
    async (url, init) => {
      assert.equal(url, "https://rpc.sanctions.test");
      const body = JSON.parse(init.body);
      assert.equal(body.method, "eth_call");
      assert.equal(body.params[0].to, CHAINALYSIS_SANCTIONS_ORACLE_BASE);
      assert.equal(body.params[1], "latest");
      const calledAddr = "0x" + body.params[0].data.slice(-40);
      const resWord = calledAddr === FLAGGED_WALLET.toLowerCase() ? WORD_TRUE : WORD_FALSE;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: resWord }), { status: 200 });
    },
    async () => {
      assert.equal(await queryChainalysisOracle("https://rpc.sanctions.test", CLEAR_A), "clear");
      assert.equal(await queryChainalysisOracle("https://rpc.sanctions.test", FLAGGED_WALLET), "flagged");
    },
  );

  // Fail closed on HTTP 500, network throw, JSON-RPC error, short hex, and non-bool uint256
  const badResponses = [
    async () => new Response("gateway error", { status: 502 }),
    async () => { throw new Error("ECONNREFUSED"); },
    async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } }), { status: 200 }),
    async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 }),
    async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(63) + "2" }), { status: 200 }),
  ];
  for (const bad of badResponses) {
    await withMockFetch(bad, async () => {
      await assert.rejects(
        () => queryChainalysisOracle("https://rpc.sanctions.test", CLEAR_A),
        (err) => err.status === 503 && /try again later/i.test(err.message),
      );
    });
  }
});

test("stubbed screening covers clear, flagged, and service-down on signup, first set, and 24h change, with zero public feed leakage", async () => {
  const db = makeD1();
  const env = {
    DB: db,
    HUMAN_BOUNTIES: "off",
    PLATFORM_FEE_ADDRESS: FEE_ADDR,
    ESCROW_ADDRESS_BASE_SEPOLIA: ESCROW_ADDR,
    SANCTIONS_RPC_URL: "https://rpc.sanctions.test",
    ADMIN_KEY: "test-only-admin-key-32-bytes-00000000",
  };

  const stubScreen = async (addr) => {
    if (addr === FLAGGED_WALLET.toLowerCase()) return "flagged";
    return "clear";
  };
  const downScreen = async () => {
    throw new Error("RPC down");
  };

  // 1. Flagged wallet at signup: refused neutrally, no agent created, private log written
  await assert.rejects(
    () => registerAgent(db, "BlockedSignup", { payout_address: FLAGGED_WALLET }, undefined, env, { screen: stubScreen }),
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.message, NEUTRAL_WALLET_REFUSAL);
      assertNeutralMessage(err.message);
      return true;
    },
  );
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE name = 'BlockedSignup'").get().n, 0);

  // 2. Service-down at signup: fails closed (503)
  await assert.rejects(
    () => registerAgent(db, "DownSignup", { payout_address: CLEAR_A }, undefined, env, { screen: downScreen }),
    (err) => err.status === 503 && /try again later/i.test(err.message),
  );

  // 3. Clear signup without wallet, then flagged first set -> 403, then service-down -> 503, then clear first set -> 200
  const reg = await registerAgent(db, "CleanAgent", { contact_email: "clean@example.com" }, undefined, env, { screen: stubScreen });
  const agent = await authByKey(db, reg.api_key);

  await assert.rejects(
    () => setPayoutAddress(db, agent, FLAGGED_WALLET, "base", env, { screen: stubScreen }),
    (err) => {
      assert.equal(err.status, 403);
      assertNeutralMessage(err.message);
      return true;
    },
  );
  assert.equal((await payoutView(db, agent.id)).payout_address, null);

  await assert.rejects(
    () => setPayoutAddress(db, agent, CLEAR_A, "base", env, { screen: downScreen }),
    (err) => err.status === 503 && /try again later/i.test(err.message),
  );

  const firstSet = await setPayoutAddress(db, agent, CLEAR_A, "base", env, { screen: stubScreen });
  assert.equal(firstSet.status, "active");
  assert.equal(firstSet.payout_address, CLEAR_A);

  // 4. Flagged 24h change -> 403, leaves active wallet untouched and no pending change
  await assert.rejects(
    () => setPayoutAddress(db, agent, FLAGGED_WALLET, "base", env, { screen: stubScreen }),
    (err) => {
      assert.equal(err.status, 403);
      assertNeutralMessage(err.message);
      return true;
    },
  );
  assert.equal((await payoutView(db, agent.id)).pending_change, null);

  // 5. Clear 24h change -> pending; emergency cancel back to CLEAR_A still works even while screening is down!
  const pendingChange = await setPayoutAddress(db, agent, CLEAR_B, "base", env, { screen: stubScreen });
  assert.equal(pendingChange.status, "pending");
  const cancelledDuringOutage = await setPayoutAddress(db, agent, CLEAR_A, "base", env, { screen: downScreen });
  assert.equal(cancelledDuringOutage.cancelled_pending_change, CLEAR_B);

  // 6. Verify operator-private log has all 3 flagged attempts, while admin route requires x-admin-key
  const unauthAdmin = await worker.fetch(new Request("https://bounty.brelsfordsoftware.com/v1/admin/sanctions-blocks"), env, CTX);
  assert.equal(unauthAdmin.status, 403);

  const authAdmin = await worker.fetch(
    new Request("https://bounty.brelsfordsoftware.com/v1/admin/sanctions-blocks", {
      headers: { "x-admin-key": env.ADMIN_KEY },
    }),
    env,
    CTX,
  );
  assert.equal(authAdmin.status, 200);
  const adminJson = await authAdmin.json();
  assert.equal(adminJson.blocks.length, 3);
  assert.deepEqual(
    adminJson.blocks.map((b) => b.context).sort(),
    ["payout_change", "payout_set", "payout_signup"],
  );

  // 7. Verify NOTHING about flagged addresses or sanctions appears in any public feed, activity, inbox, or dashboard!
  for (const k of Object.keys(FEED_KINDS)) {
    assert.ok(!k.includes("sanction") && !k.includes("block"), `FEED_KINDS must not include ${k}`);
  }
  const allEvents = await recentActivity(db, 200);
  const feedEvs = await publicEvents(db, null, 100);
  const inboxEvs = (await readInbox(db, agent.id, null, 100)).events;
  const liveFeedRes = await worker.fetch(new Request("https://bounty.brelsfordsoftware.com/v1/events"), env, CTX);
  const liveFeedText = await liveFeedRes.text();
  const actRes = await worker.fetch(new Request("https://bounty.brelsfordsoftware.com/v1/activity"), env, CTX);
  const actText = await actRes.text();
  const dashHtml = await (await dashboard(env, "https://bounty.brelsfordsoftware.com")).text();

  const combinedPublic = JSON.stringify({ allEvents, feedEvs, inboxEvs }) + liveFeedText + actText + dashHtml;
  assert.ok(!combinedPublic.toLowerCase().includes(FLAGGED_WALLET.toLowerCase()), "flagged address leaked publicly");
  assert.ok(!combinedPublic.toLowerCase().includes("BlockedSignup".toLowerCase()), "blocked signup name leaked publicly");
  assert.ok(!combinedPublic.toLowerCase().includes("sanctions_blocks"), "private table leaked publicly");
});

test("REST, MCP, and poster funding check (/v1/bounties/:id/fund/check) enforce screening and fail closed without RPC", async () => {
  const db = makeD1();
  const baseEnv = {
    DB: db,
    HUMAN_BOUNTIES: "off",
    PLATFORM_FEE_ADDRESS: FEE_ADDR,
    ESCROW_ADDRESS_BASE_SEPOLIA: ESCROW_ADDR,
    SANCTIONS_RPC_URL: "https://rpc.sanctions.test",
    ADMIN_KEY: "test-only-admin-key-32-bytes-00000000",
  };

  let flaggedSet = new Set([FLAGGED_WALLET.toLowerCase()]);
  let rpcHealthy = true;

  await withMockFetch(
    async (url, init) => {
      if (!rpcHealthy) return new Response("service unavailable", { status: 503 });
      const body = JSON.parse(init.body);
      const addr = "0x" + body.params[0].data.slice(-40);
      const word = flaggedSet.has(addr) ? WORD_TRUE : WORD_FALSE;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: word }), { status: 200 });
    },
    async () => {
      // Missing RPC config at HTTP/MCP boundary fails closed (503)
      const noRpcEnv = { ...baseEnv, SANCTIONS_RPC_URL: undefined, BASE_RPC_URL: undefined };
      const noRpcRes = await worker.fetch(
        new Request("https://bounty.brelsfordsoftware.com/v1/agents/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "NoRpcAgent", payout_address: CLEAR_A }),
        }),
        noRpcEnv,
        CTX,
      );
      assert.equal(noRpcRes.status, 503);

      // Register poster and filler via REST & MCP with live screening
      const posterRes = await worker.fetch(
        new Request("https://bounty.brelsfordsoftware.com/v1/agents/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "FundPoster", contact_email: "fp@example.com" }),
        }),
        baseEnv,
        CTX,
      );
      assert.equal(posterRes.status, 201);
      const posterReg = await posterRes.json();
      const poster = await authByKey(db, posterReg.api_key);

      // MCP flagged set_payout_address is refused neutrally
      const fillerReg = await registerAgent(db, "FundFiller", { contact_email: "ff@example.com" });
      const mcpBlocked = await callMcpTool(baseEnv, "set_payout_address", {
        api_key: fillerReg.api_key,
        payout_address: FLAGGED_WALLET,
      });
      const mcpBlockedBody = JSON.parse(mcpBlocked.content[0].text);
      assert.equal(mcpBlockedBody.error, true);
      assert.equal(mcpBlockedBody.status, 403);
      assert.equal(mcpBlockedBody.message, NEUTRAL_WALLET_REFUSAL);
      assertNeutralMessage(mcpBlockedBody.message);

      // MCP clear set_payout_address succeeds
      const mcpClear = await callMcpTool(baseEnv, "set_payout_address", {
        api_key: fillerReg.api_key,
        payout_address: CLEAR_A,
      });
      const mcpClearBody = JSON.parse(mcpClear.content[0].text);
      assert.equal(mcpClearBody.payout_address, CLEAR_A);

      // Post on-chain bounty and accept it
      const filler = await authByKey(db, fillerReg.api_key);
      const bounty = await postBounty(db, poster, baseEnv, {
        title: "Verify European capacitor distributor stock",
        description: "Find authorized distributor stock for 10,000 X7R 10uF capacitors with datasheet link.",
        category: "sourcing",
        reward_amount_cents: 500,
        settlement: "onchain",
      });
      await acceptBounty(db, filler, bounty.bounty_id, baseEnv);

      // Clear poster funding wallet passes POST /v1/bounties/:id/fund/check
      const clearFundRes = await worker.fetch(
        new Request(`https://bounty.brelsfordsoftware.com/v1/bounties/${bounty.bounty_id}/fund/check`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: CLEAR_POSTER }),
        }),
        baseEnv,
        CTX,
      );
      assert.equal(clearFundRes.status, 200);
      const clearFundJson = await clearFundRes.json();
      assert.equal(clearFundJson.ok, true);
      assert.equal(clearFundJson.funding_address, CLEAR_POSTER);
      assert.equal(clearFundJson.agent_payout_address, CLEAR_A);

      // Flagged poster funding wallet is refused with neutral 403 and logged privately
      const flaggedFundRes = await worker.fetch(
        new Request(`https://bounty.brelsfordsoftware.com/v1/bounties/${bounty.bounty_id}/fund/check`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: FLAGGED_WALLET }),
        }),
        baseEnv,
        CTX,
      );
      assert.equal(flaggedFundRes.status, 403);
      const flaggedFundJson = await flaggedFundRes.json();
      assert.equal(flaggedFundJson.message, NEUTRAL_WALLET_REFUSAL);
      assertNeutralMessage(flaggedFundJson.message);

      // If the accepting agent's wallet becomes sanctioned AFTER signup, funding is also refused neutrally!
      flaggedSet.add(CLEAR_A.toLowerCase());
      await assert.rejects(
        () => screenBountyFundingWallet(db, baseEnv, bounty.bounty_id, CLEAR_POSTER, poster.id),
        (err) => {
          assert.equal(err.status, 403);
          assert.equal(err.message, NEUTRAL_FUNDING_TARGET_REFUSAL);
          assertNeutralMessage(err.message);
          return true;
        },
      );
      flaggedSet.delete(CLEAR_A.toLowerCase());

      // When screening RPC goes down, funding check fails closed with 503
      rpcHealthy = false;
      const downFundRes = await worker.fetch(
        new Request(`https://bounty.brelsfordsoftware.com/v1/bounties/${bounty.bounty_id}/fund/check`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: CLEAR_POSTER }),
        }),
        baseEnv,
        CTX,
      );
      assert.equal(downFundRes.status, 503);
      const downFundJson = await downFundRes.json();
      assert.match(downFundJson.message, /try again later/i);

      // Public feed still has zero mention of FLAGGED_WALLET
      const pubFeed = await (await worker.fetch(new Request("https://bounty.brelsfordsoftware.com/v1/events"), baseEnv, CTX)).text();
      assert.ok(!pubFeed.toLowerCase().includes(FLAGGED_WALLET.toLowerCase()));
    },
  );
});
