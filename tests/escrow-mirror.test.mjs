// Read-only BountyEscrow mirror (#50), deliverable unsealing enforcement (#66 / M4),
// and 48h/68h poster review-window reminders (#52).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeD1 } from "./d1shim.mjs";
import worker from "../.test-build/index.js";
import {
  registerAgent, authByKey, postBounty, acceptBounty, getBounty, submitToBounty,
  setPayoutAddress, readInbox, reviewSubmission, settlementInstruction, cancelBounty,
  withdrawSubmission, sweepNotices, UNITS_PER_CENT, MIN_CONFIRMATIONS,
} from "../.test-build/core.js";
import { settleBounty } from "../.test-build/settle.js";
import { getBountyWithQA } from "../.test-build/messaging.js";
import { bountyPage } from "../.test-build/dashboard.js";
import { myJobPage } from "../.test-build/webjobs.js";
import { createServer } from "../.test-build/mcp.js";
import {
  ESCROW_TOPICS, DEFAULT_ESCROW_BASE_SEPOLIA, bountyEscrowRef, parseEscrowLogs,
  syncEscrowChain, syncEscrowReceipt, sweepEscrowReminders,
  ESCROW_REMINDER_48H_MS, ESCROW_REMINDER_68H_MS, ESCROW_REVIEW_WINDOW_S,
} from "../.test-build/escrow.js";

const ESCROW = DEFAULT_ESCROW_BASE_SEPOLIA;
const LOOKALIKE = "0x" + "de".repeat(20);
const FEE_ADDR = "0x" + "fe".repeat(20);
const POSTER_WALLET = "0x" + "11".repeat(20);
const AGENT_WALLET = "0x" + "22".repeat(20);
const RIVAL_WALLET = "0x" + "33".repeat(20);

const pad32 = (hexNoPrefix) => `0x${hexNoPrefix.replace(/^0x/, "").padStart(64, "0").toLowerCase()}`;
const u256Word = (n) => BigInt(n).toString(16).padStart(64, "0");
const addrTopic = (addr) => pad32(addr);
const txHash = (n) => `0x${BigInt(n).toString(16).padStart(64, "a")}`;

function fundedLog({
  address = ESCROW, jobId, poster = POSTER_WALLET, agent = AGENT_WALLET,
  amountUnits, deadline = 1_900_000_000, ref, blockNumber = 100n, logIndex = 0,
  tx = txHash(1), removed = false,
}) {
  const refClean = ref.replace(/^0x/, "").padStart(64, "0");
  return {
    address,
    topics: [ESCROW_TOPICS.Funded, pad32(BigInt(jobId).toString(16)), addrTopic(poster), addrTopic(agent)],
    data: `0x${u256Word(amountUnits)}${u256Word(deadline)}${refClean}`,
    blockNumber: `0x${BigInt(blockNumber).toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: tx,
    removed,
  };
}

function submittedLog({
  address = ESCROW, jobId, deliverable = "0x" + "cd".repeat(32),
  blockNumber = 110n, logIndex = 0, tx = txHash(2), removed = false,
}) {
  return {
    address,
    topics: [ESCROW_TOPICS.Submitted, pad32(BigInt(jobId).toString(16))],
    data: pad32(deliverable),
    blockNumber: `0x${BigInt(blockNumber).toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: tx,
    removed,
  };
}

function paidLog({
  address = ESCROW, jobId, agent = AGENT_WALLET, toAgentUnits, feeUnits,
  blockNumber = 120n, logIndex = 0, tx = txHash(3), removed = false,
}) {
  return {
    address,
    topics: [ESCROW_TOPICS.Paid, pad32(BigInt(jobId).toString(16)), addrTopic(agent)],
    data: `0x${u256Word(toAgentUnits)}${u256Word(feeUnits)}`,
    blockNumber: `0x${BigInt(blockNumber).toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: tx,
    removed,
  };
}

function refundedLog({
  address = ESCROW, jobId, poster = POSTER_WALLET, amountUnits, reasonCode,
  blockNumber = 120n, logIndex = 0, tx = txHash(4), removed = false,
}) {
  return {
    address,
    topics: [ESCROW_TOPICS.Refunded, pad32(BigInt(jobId).toString(16)), addrTopic(poster)],
    data: `0x${u256Word(amountUnits)}${u256Word(reasonCode)}`,
    blockNumber: `0x${BigInt(blockNumber).toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: tx,
    removed,
  };
}

function makeMockRpc({ head = 200n, logs = [], timestamps = new Map() } = {}) {
  return {
    setHead(h) { head = BigInt(h); },
    setLogs(l) { logs = l; },
    pushLog(l) { logs.push(l); },
    async blockNumber() { return head; },
    async getLogs(fromBlock, toBlock) {
      return logs.filter((l) => {
        const bn = BigInt(l.blockNumber);
        return bn >= fromBlock && bn <= toBlock;
      });
    },
    async getBlockTimestamp(bn) {
      return timestamps.get(BigInt(bn)) ?? 1_800_000_000;
    },
    async getReceipt(hash) {
      const matching = logs.filter((l) => l.transactionHash.toLowerCase() === hash.toLowerCase());
      if (!matching.length) return null;
      return {
        status: "0x1",
        blockNumber: BigInt(matching[0].blockNumber),
        logs: matching,
      };
    },
  };
}

async function callMcpTool(env, name, args) {
  const srv = createServer(env);
  const handler = srv.server._requestHandlers.get("tools/call");
  const extra = {
    signal: new AbortController().signal,
    sendNotification: async () => {},
    sendRequest: async () => {},
    requestId: 1,
    mcpReq: { requestState: () => undefined },
  };
  const res = await handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, extra);
  return JSON.parse(res.content[0].text);
}

const dummyCtx = { waitUntil() {}, passThroughOnException() {} };

/** Setup a whole on-chain bounty with evidence requirement, accepted filler, and a sealed submission. */
async function setupEscrowFixture(rewardCents = 500, { withWebhooks = false } = {}) {
  const db = makeD1();
  const env = {
    DB: db,
    HUMAN_BOUNTIES: "off",
    PLATFORM_FEE_ADDRESS: FEE_ADDR,
    ESCROW_ADDRESS_BASE_SEPOLIA: ESCROW,
    SESSION_SECRET: "test-only-session-hmac-key-0123456789abcdef",
  };

  const posterReg = await registerAgent(db, "EscrowPoster", {
    contact_email: "poster@example.com",
    ...(withWebhooks ? { notify_webhook: "https://hooks.example.com/poster" } : {}),
  });
  const fillerReg = await registerAgent(db, "EscrowFiller", {
    contact_email: "filler@example.com",
    ...(withWebhooks ? { notify_webhook: "https://hooks.example.com/filler" } : {}),
  });
  const rivalReg = await registerAgent(db, "EscrowRival", { contact_email: "rival@example.com" });

  const poster = await authByKey(db, posterReg.api_key);
  const filler = await authByKey(db, fillerReg.api_key);
  const rival = await authByKey(db, rivalReg.api_key);

  await setPayoutAddress(db, filler, AGENT_WALLET);
  await setPayoutAddress(db, rival, RIVAL_WALLET);

  const posted = await postBounty(db, poster, env, {
    title: "Verify supplier lead time and MOQ",
    description: "Confirm unit price and lead time from primary manufacturer catalogue with HTTPS link.",
    category: "sourcing",
    reward_amount_cents: rewardCents,
    settlement: "onchain",
    evidence_required: [{ kind: "url", label: "Catalogue link", min: 1 }],
  });

  const accepted = await acceptBounty(db, filler, posted.bounty_id, env);
  assert.equal(accepted.accepted_agent_id, filler.id);
  assert.equal(accepted.escrow_ref, bountyEscrowRef(posted.bounty_id));

  const secretContent = `SECRET_DELIVERABLE_${posted.bounty_id}_EXACT_ANSWER_42`;
  const secretUrl = "https://catalogue.example.com/private-quote-42";
  const sub = await submitToBounty(
    db,
    filler,
    posted.bounty_id,
    secretContent,
    undefined,
    "Verified primary manufacturer quote in Germany, MOQ 500 units, 10-day lead time.",
    undefined,
    [{ kind: "url", label: "Catalogue link", value: { url: secretUrl } }],
  );

  return {
    db, env,
    poster, posterKey: posterReg.api_key,
    filler, fillerKey: fillerReg.api_key,
    rival, rivalKey: rivalReg.api_key,
    bountyId: posted.bounty_id,
    ref: accepted.escrow_ref,
    submissionId: sub.submission_id,
    secretContent,
    secretUrl,
    amountUnits: BigInt(rewardCents) * UNITS_PER_CENT,
    feeUnits: (BigInt(rewardCents) * UNITS_PER_CENT * 500n) / 10_000n,
    toAgentUnits: BigInt(rewardCents) * UNITS_PER_CENT - (BigInt(rewardCents) * UNITS_PER_CENT * 500n) / 10_000n,
  };
}

/** Verify REST HTTP routes, MCP tool calls, and Web pages all agree on deliverable unsealing. */
async function assertAllSurfaces(fx, { expectUnsealed, expectState }) {
  // 1a. Real HTTP GET /v1/bounties/:id as poster
  const httpRes = await worker.fetch(
    new Request(`https://bounty.brelsfordsoftware.com/v1/bounties/${fx.bountyId}`, {
      headers: { authorization: `Bearer ${fx.posterKey}` },
    }),
    fx.env,
    dummyCtx,
  );
  assert.equal(httpRes.status, 200);
  const restPoster = await httpRes.json();
  assert.equal(restPoster.bounty.escrow.state, expectState, "REST GET /v1/bounties/:id escrow.state");
  const restSub = restPoster.submissions.find((s) => s.id === fx.submissionId);
  assert.ok(restSub, "poster sees submission metadata");

  // 1b. Real HTTP GET /v1/bounties/:id/submissions as poster
  const subsRes = await worker.fetch(
    new Request(`https://bounty.brelsfordsoftware.com/v1/bounties/${fx.bountyId}/submissions`, {
      headers: { authorization: `Bearer ${fx.posterKey}` },
    }),
    fx.env,
    dummyCtx,
  );
  assert.equal(subsRes.status, 200);
  const subsJson = await subsRes.json();
  const subsSub = subsJson.submissions.find((s) => s.id === fx.submissionId);
  assert.equal(subsSub.content, expectUnsealed ? fx.secretContent : null, "REST /submissions matches unseal rule");

  // 2. MCP get_bounty tool
  const mcpPoster = await callMcpTool(fx.env, "get_bounty", {
    bounty_id: fx.bountyId,
    api_key: fx.posterKey,
  });
  assert.equal(mcpPoster.bounty.escrow.state, expectState, "MCP escrow.state");
  const mcpSub = mcpPoster.submissions.find((s) => s.id === fx.submissionId);
  assert.ok(mcpSub, "MCP poster sees submission metadata");

  // 3. Web signed-in poster page (/my-jobs/:id) and public bounty page (/bounties/:id)
  const myJobHtml = await (await myJobPage(fx.env, fx.poster, fx.bountyId)).text();
  const publicHtml = await (await bountyPage(fx.env, fx.bountyId)).text();
  // Public page NEVER shows secret content in any state.
  assert.ok(!publicHtml.includes(fx.secretContent), "public bounty page never leaks deliverable");
  assert.ok(publicHtml.includes(expectState), "public bounty page renders mirrored escrow state");

  // Submitter always sees their own deliverable via MCP/REST.
  const restFiller = await getBounty(fx.db, fx.bountyId, fx.filler, undefined, fx.env);
  assert.equal(restFiller.submissions[0].content, fx.secretContent, "submitter can always read own work");

  if (expectUnsealed) {
    assert.equal(restSub.content, fx.secretContent, "REST unseals content on confirmed Paid");
    assert.ok(!restSub.sealed, "REST clears sealed flag");
    assert.equal(restSub.evidence[0].value.url, fx.secretUrl, "REST unseals evidence value");

    assert.equal(mcpSub.content, fx.secretContent, "MCP unseals content on confirmed Paid");
    assert.equal(mcpSub.evidence[0].value.url, fx.secretUrl, "MCP unseals evidence value");

    assert.ok(myJobHtml.includes(fx.secretContent), "Web /my-jobs/:id unseals full answer on confirmed Paid");
  } else {
    assert.equal(restSub.content, null, `REST keeps content null in state ${expectState}`);
    assert.equal(restSub.sealed, true, `REST marks sealed:true in state ${expectState}`);
    assert.equal(restSub.evidence, undefined, `REST hides evidence values in state ${expectState}`);
    assert.equal(restSub.evidence_manifest.length, 1, `REST shows evidence_manifest only in state ${expectState}`);

    assert.equal(mcpSub.content, null, `MCP keeps content null in state ${expectState}`);
    assert.equal(mcpSub.sealed, true, `MCP marks sealed:true in state ${expectState}`);
    assert.equal(mcpSub.evidence, undefined, `MCP hides evidence values in state ${expectState}`);

    assert.ok(!myJobHtml.includes(fx.secretContent), `Web /my-jobs/:id keeps deliverable sealed in state ${expectState}`);
    assert.ok(!myJobHtml.includes(fx.secretUrl), `Web /my-jobs/:id keeps evidence URL sealed in state ${expectState}`);
  }
}

test("parseEscrowLogs enforces MIN_CONFIRMATIONS=6, ignores removed logs, and ignores look-alike contracts", () => {
  const ref = bountyEscrowRef("bty_test1234567890ab");
  const goodAtBlock100 = fundedLog({ jobId: 7, amountUnits: 5_000_000n, ref, blockNumber: 100n });
  const lookalike = fundedLog({ address: LOOKALIKE, jobId: 8, amountUnits: 5_000_000n, ref, blockNumber: 90n });
  const reorged = fundedLog({ jobId: 9, amountUnits: 5_000_000n, ref, blockNumber: 90n, removed: true });

  // At head = 104, block 100 has 5 confirmations (< 6): ignored.
  assert.equal(parseEscrowLogs([goodAtBlock100, lookalike, reorged], ESCROW, 104n, MIN_CONFIRMATIONS).length, 0);

  // At head = 105, block 100 has exactly 6 confirmations: accepted; look-alike and removed still ignored.
  const parsed = parseEscrowLogs([goodAtBlock100, lookalike, reorged], ESCROW, 105n, MIN_CONFIRMATIONS);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, "funded");
  assert.equal(parsed[0].jobId, 7);
});

test("M4 table row 1 (unfunded): deliverable stays sealed across REST, MCP, and Web", async () => {
  const fx = await setupEscrowFixture();
  await assertAllSurfaces(fx, { expectUnsealed: false, expectState: "unfunded" });
});

test("M4 table rows 2 & 3 (funded -> submitted) + inbox notices + off-chain bypass guards: deliverable stays sealed throughout review", async () => {
  const fx = await setupEscrowFixture(199); // $1.99 odd cents
  const submittedBlockTime = Math.floor(Date.parse("2026-11-12T12:00:00Z") / 1000);
  const rpc = makeMockRpc({
    head: 200n,
    logs: [
      fundedLog({ jobId: 1, amountUnits: fx.amountUnits, ref: fx.ref, blockNumber: 100n, tx: txHash(101) }),
    ],
    timestamps: new Map([[205n, submittedBlockTime]]),
  });

  // Sync Funded -> funded
  const s1 = await syncEscrowChain(fx.env, { rpc, startBlock: 90 });
  assert.equal(s1.funded, 1);
  await assertAllSurfaces(fx, { expectUnsealed: false, expectState: "funded" });

  // Filler inbox received escrow.funded with exact 6-decimal USDC amounts
  const fillerInbox = await readInbox(fx.db, fx.filler.id);
  const fundedEvt = fillerInbox.events.find((e) => e.type === "escrow.funded");
  assert.ok(fundedEvt, "filler received escrow.funded inbox notice");
  assert.equal(fundedEvt.data.escrow_job_id, 1);
  assert.equal(fundedEvt.data.locked_usdc, "1.990000");
  assert.equal(fundedEvt.data.net_usdc, "1.890500");
  assert.equal(fundedEvt.data.fee_usdc, "0.099500");

  // Off-chain bypasses are refused while escrow is active
  await assert.rejects(() => reviewSubmission(fx.db, fx.poster, fx.bountyId, fx.submissionId, "accept"), /BountyEscrow/);
  await assert.rejects(() => reviewSubmission(fx.db, fx.poster, fx.bountyId, fx.submissionId, "reject"), /BountyEscrow/);
  await assert.rejects(() => settlementInstruction(fx.db, fx.env, fx.poster, fx.bountyId, fx.submissionId), /BountyEscrow/);
  await assert.rejects(() => settleBounty(fx.env, fx.poster, fx.bountyId, fx.submissionId, txHash(999)), /BountyEscrow/);
  await assert.rejects(() => cancelBounty(fx.db, fx.poster, fx.bountyId), /BountyEscrow/);
  await assert.rejects(() => withdrawSubmission(fx.db, fx.filler, fx.submissionId), /active escrow job/);

  // Sync Submitted -> submitted (mined at block 205, after cursor 195; head at 220 = 16 confirmations): STILL SEALED!
  rpc.pushLog(submittedLog({ jobId: 1, blockNumber: 205n, tx: txHash(102) }));
  rpc.setHead(220n);
  const s2 = await syncEscrowChain(fx.env, { rpc, startBlock: 90 });
  assert.equal(s2.submitted, 1);
  await assertAllSurfaces(fx, { expectUnsealed: false, expectState: "submitted" });

  const bView = (await getBounty(fx.db, fx.bountyId, fx.poster, undefined, fx.env)).bounty;
  assert.equal(bView.escrow.submitted_at, "2026-11-12T12:00:00.000Z");
});

test("M4 table row 4 (paid via complete): unseals winning deliverable across REST, MCP, and Web while keeping rival submissions sealed", async () => {
  const fx = await setupEscrowFixture(500);
  // Rival submits BEFORE escrow is funded so there are two submissions on the bounty; only the paid escrow agent's submission may unseal.
  const rivalSecret = "RIVAL_SECRET_MUST_STAY_SEALED";
  const rivalSub = await submitToBounty(
    fx.db,
    fx.rival,
    fx.bountyId,
    rivalSecret,
    undefined,
    "Alternative supplier in Poland, MOQ 1000 units, verified public price sheet.",
    undefined,
    [{ kind: "url", label: "Catalogue link", value: { url: "https://rival.example.com/quote" } }],
  );

  const rpc = makeMockRpc({
    head: 250n,
    logs: [
      fundedLog({ jobId: 42, amountUnits: fx.amountUnits, ref: fx.ref, blockNumber: 100n, tx: txHash(201) }),
      submittedLog({ jobId: 42, blockNumber: 110n, tx: txHash(202) }),
      paidLog({
        jobId: 42,
        agent: AGENT_WALLET,
        toAgentUnits: fx.toAgentUnits,
        feeUnits: fx.feeUnits,
        blockNumber: 120n,
        tx: txHash(203),
      }),
    ],
  });

  const s = await syncEscrowChain(fx.env, { rpc, startBlock: 90 });
  assert.deepEqual({ funded: s.funded, submitted: s.submitted, paid: s.paid, refunded: s.refunded }, {
    funded: 1, submitted: 1, paid: 1, refunded: 0,
  });

  await assertAllSurfaces(fx, { expectUnsealed: true, expectState: "paid" });

  // Rival submission was closed and remains strictly sealed
  const posterView = await getBountyWithQA(fx.db, fx.bountyId, fx.poster, undefined, fx.env);
  const rivalShown = posterView.submissions.find((x) => x.id === rivalSub.submission_id);
  assert.equal(rivalShown.status, "closed");
  assert.equal(rivalShown.content, null);
  assert.equal(rivalShown.sealed, true);

  // Filler inbox received escrow.paid; re-running sync is idempotent (zero duplicate events)
  const inbox1 = await readInbox(fx.db, fx.filler.id);
  const paidEvents = inbox1.events.filter((e) => e.type === "escrow.paid");
  assert.equal(paidEvents.length, 1);
  assert.equal(paidEvents[0].data.to_agent_usdc, "4.750000");
  assert.equal(paidEvents[0].data.fee_usdc, "0.250000");

  const replay = await syncEscrowChain(fx.env, { rpc, startBlock: 90 });
  assert.equal(replay.paid, 0);
});

test("M4 table row 5 (refunded after reject): marks submission rejected and keeps deliverable sealed forever", async () => {
  const fx = await setupEscrowFixture(500);
  const rpc = makeMockRpc({
    head: 250n,
    logs: [
      fundedLog({ jobId: 11, amountUnits: fx.amountUnits, ref: fx.ref, blockNumber: 100n, tx: txHash(301) }),
      submittedLog({ jobId: 11, blockNumber: 110n, tx: txHash(302) }),
      refundedLog({ jobId: 11, amountUnits: fx.amountUnits, reasonCode: 0, blockNumber: 120n, tx: txHash(303) }), // 0 = Rejected
    ],
  });

  const s = await syncEscrowChain(fx.env, { rpc, startBlock: 90 });
  assert.equal(s.refunded, 1);

  await assertAllSurfaces(fx, { expectUnsealed: false, expectState: "refunded" });
  const posterView = await getBounty(fx.db, fx.bountyId, fx.poster, undefined, fx.env);
  assert.equal(posterView.bounty.escrow.refund_reason, "rejected");
  assert.equal(posterView.submissions[0].status, "rejected");
  assert.equal(posterView.submissions[0].content, null);
  assert.equal(posterView.submissions[0].sealed, true);
});

test("M4 table row 6 (refunded after refundExpired and abandon): mirrors reason and never unseals anything", async () => {
  for (const [code, reason] of [[1, "expired"], [2, "abandoned"]]) {
    const fx = await setupEscrowFixture(500);
    const rpc = makeMockRpc({
      head: 250n,
      logs: [
        fundedLog({ jobId: 20 + code, amountUnits: fx.amountUnits, ref: fx.ref, blockNumber: 100n, tx: txHash(400 + code) }),
        refundedLog({ jobId: 20 + code, amountUnits: fx.amountUnits, reasonCode: code, blockNumber: 115n, tx: txHash(410 + code) }),
      ],
    });
    const s = await syncEscrowChain(fx.env, { rpc, startBlock: 90 });
    assert.equal(s.refunded, 1, reason);
    await assertAllSurfaces(fx, { expectUnsealed: false, expectState: "refunded" });
    const posterView = await getBounty(fx.db, fx.bountyId, fx.poster, undefined, fx.env);
    assert.equal(posterView.bounty.escrow.refund_reason, reason);
  }
});

test("M4 table row 7 (unconfirmed Paid, look-alike contract, different job_id, or different ref): never unseals", async () => {
  const fx = await setupEscrowFixture(500);
  const otherBounty = await postBounty(fx.db, fx.poster, fx.env, {
    title: "Unrelated second bounty for ref isolation test",
    description: "Ensure a Paid event on another ref/jobId never unseals the first bounty.",
    category: "research",
    reward_amount_cents: 500,
    settlement: "onchain",
  });
  await acceptBounty(fx.db, fx.rival, otherBounty.bounty_id, fx.env);
  const otherRef = bountyEscrowRef(otherBounty.bounty_id);

  const paidTxUnconfirmed = txHash(505);
  const rpc = makeMockRpc({
    head: 204n, // block 200 has only 5 confirmations (204 - 200 + 1 = 5 < 6)!
    logs: [
      // Bounty 1 funded + submitted on jobId = 1
      fundedLog({ jobId: 1, amountUnits: fx.amountUnits, ref: fx.ref, blockNumber: 100n, tx: txHash(501) }),
      submittedLog({ jobId: 1, blockNumber: 110n, tx: txHash(502) }),
      // Bounty 2 funded + paid on jobId = 2 (different job_id AND different ref!)
      fundedLog({ jobId: 2, agent: RIVAL_WALLET, amountUnits: fx.amountUnits, ref: otherRef, blockNumber: 120n, tx: txHash(503) }),
      paidLog({ jobId: 2, agent: RIVAL_WALLET, toAgentUnits: fx.toAgentUnits, feeUnits: fx.feeUnits, blockNumber: 130n, tx: txHash(504) }),
      // Look-alike contract emitting Paid for jobId = 1 at 50+ confirmations: MUST BE IGNORED
      paidLog({ address: LOOKALIKE, jobId: 1, agent: AGENT_WALLET, toAgentUnits: fx.toAgentUnits, feeUnits: fx.feeUnits, blockNumber: 140n, tx: txHash(506) }),
      // Real contract Paid for jobId = 1, but at block 200 (only 5 confirmations at head 204): MUST WAIT
      paidLog({ jobId: 1, agent: AGENT_WALLET, toAgentUnits: fx.toAgentUnits, feeUnits: fx.feeUnits, blockNumber: 200n, tx: paidTxUnconfirmed }),
    ],
  });

  await syncEscrowChain(fx.env, { rpc, startBlock: 90 });
  // Direct receipt sync at 5 confirmations also refuses with 409!
  await assert.rejects(() => syncEscrowReceipt(fx.env, paidTxUnconfirmed, { rpc }), /5 confirmation/);

  // Bounty 1 MUST still be in 'submitted' and strictly sealed!
  await assertAllSurfaces(fx, { expectUnsealed: false, expectState: "submitted" });

  // Advance chain by 1 block to head = 205 (now 6 confirmations): Paid on job #1 confirms and unseals!
  rpc.setHead(205n);
  const receiptSync = await syncEscrowReceipt(fx.env, paidTxUnconfirmed, { rpc });
  assert.equal(receiptSync.paid, 1);
  assert.equal(receiptSync.confirmations, 6);
  await assertAllSurfaces(fx, { expectUnsealed: true, expectState: "paid" });
});

test("poster review-window reminders (#52): sends 48h and 68h reminders once each, and none after Paid or Refunded", async () => {
  const fx = await setupEscrowFixture(500, { withWebhooks: true });
  const t0 = Date.parse("2026-11-12T00:00:00Z");
  const rpc = makeMockRpc({
    head: 200n,
    logs: [
      fundedLog({ jobId: 77, amountUnits: fx.amountUnits, ref: fx.ref, blockNumber: 100n, tx: txHash(701) }),
      submittedLog({ jobId: 77, deliverable: "0x" + "ab".repeat(32), blockNumber: 110n, tx: txHash(702) }),
    ],
    timestamps: new Map([[110n, Math.floor(t0 / 1000)]]),
  });
  await syncEscrowChain(fx.env, { rpc, startBlock: 90 });

  // Before 48h (47h 59m): no reminder.
  const rBefore = await sweepEscrowReminders(fx.db, t0 + ESCROW_REMINDER_48H_MS - 60_000);
  assert.deepEqual(rBefore, { reminded_48h: 0, reminded_68h: 0 });

  // At 48h: 48h reminder sent once (and marked webhook_pending=1 for poster's webhook).
  const r48 = await sweepNotices(fx.db, undefined, t0 + ESCROW_REMINDER_48H_MS);
  assert.equal(r48.escrow_reminded_48h, 1);
  assert.equal(r48.escrow_reminded_68h, 0);

  // Re-running at 50h does not duplicate the 48h reminder.
  const r50 = await sweepEscrowReminders(fx.db, t0 + 50 * 3_600_000);
  assert.deepEqual(r50, { reminded_48h: 0, reminded_68h: 0 });

  // At 68h: final reminder sent once.
  const r68 = await sweepEscrowReminders(fx.db, t0 + ESCROW_REMINDER_68H_MS);
  assert.deepEqual(r68, { reminded_48h: 0, reminded_68h: 1 });

  // Re-running at 70h sends nothing more.
  const r70 = await sweepEscrowReminders(fx.db, t0 + 70 * 3_600_000);
  assert.deepEqual(r70, { reminded_48h: 0, reminded_68h: 0 });

  const posterInbox = await readInbox(fx.db, fx.poster.id);
  const rem48 = posterInbox.events.find((e) => e.type === "escrow.review_reminder");
  const rem68 = posterInbox.events.find((e) => e.type === "escrow.review_final_reminder");
  assert.ok(rem48, "48h reminder in poster inbox");
  assert.ok(rem68, "68h final reminder in poster inbox");
  assert.equal(rem48.data.submission_id, fx.submissionId);
  assert.match(rem48.data.submission_preview, /Germany/);
  assert.equal(rem48.data.review_window_closes_at, new Date(t0 + ESCROW_REVIEW_WINDOW_S * 1000).toISOString());
  assert.match(rem48.data.choices.approve, /complete\(77\)/);
  assert.match(rem48.data.choices.reject, /reject\(77\)/);
  // Reminders NEVER contain sealed content.
  assert.ok(!JSON.stringify(rem48).includes(fx.secretContent));
  assert.ok(!JSON.stringify(rem68).includes(fx.secretContent));

  // Verify webhook_pending = 1 was queued on both reminder rows for the poster's webhook.
  const hookRows = await fx.db
    .prepare("SELECT type, webhook_pending FROM inbox WHERE agent_id = ? AND type LIKE 'escrow.review%' ORDER BY seq")
    .bind(fx.poster.id)
    .all();
  assert.deepEqual(hookRows.results, [
    { type: "escrow.review_reminder", webhook_pending: 1 },
    { type: "escrow.review_final_reminder", webhook_pending: 1 },
  ]);

  // Closed jobs (paid or refunded before 48h) emit ZERO reminders at 48h and 68h.
  for (const closeKind of ["paid", "refunded"]) {
    const closedFx = await setupEscrowFixture(500);
    const closeLog = closeKind === "paid"
      ? paidLog({ jobId: 88, agent: AGENT_WALLET, toAgentUnits: closedFx.toAgentUnits, feeUnits: closedFx.feeUnits, blockNumber: 120n, tx: txHash(803) })
      : refundedLog({ jobId: 88, amountUnits: closedFx.amountUnits, reasonCode: 0, blockNumber: 120n, tx: txHash(804) });
    const closedRpc = makeMockRpc({
      head: 200n,
      logs: [
        fundedLog({ jobId: 88, amountUnits: closedFx.amountUnits, ref: closedFx.ref, blockNumber: 100n, tx: txHash(801) }),
        submittedLog({ jobId: 88, blockNumber: 110n, tx: txHash(802) }),
        closeLog,
      ],
      timestamps: new Map([[110n, Math.floor(t0 / 1000)]]),
    });
    await syncEscrowChain(closedFx.env, { rpc: closedRpc, startBlock: 90 });

    assert.deepEqual(await sweepEscrowReminders(closedFx.db, t0 + ESCROW_REMINDER_48H_MS), { reminded_48h: 0, reminded_68h: 0 });
    assert.deepEqual(await sweepEscrowReminders(closedFx.db, t0 + ESCROW_REMINDER_68H_MS), { reminded_48h: 0, reminded_68h: 0 });
    const closedInbox = await readInbox(closedFx.db, closedFx.poster.id);
    assert.equal(closedInbox.events.filter((e) => e.type.startsWith("escrow.review")).length, 0, `no reminder after ${closeKind}`);
  }
});

test("strict 200-block RPC multi-tick catch-up never skips unscanned blocks", async () => {
  const fx = await setupEscrowFixture(500);
  // Event sits at block 2400 (> 1140 blocks past startBlock 100), with head at 2600.
  const allLogs = [
    fundedLog({ jobId: 301, amountUnits: fx.amountUnits, ref: fx.ref, blockNumber: 2400n, tx: txHash(901) }),
    submittedLog({ jobId: 301, blockNumber: 2450n, tx: txHash(902) }),
    paidLog({ jobId: 301, agent: AGENT_WALLET, toAgentUnits: fx.toAgentUnits, feeUnits: fx.feeUnits, blockNumber: 2500n, tx: txHash(903) }),
  ];
  const strictRpc = {
    async blockNumber() { return 2600n; },
    async getLogs(fromBlock, toBlock) {
      if (toBlock - fromBlock + 1n > 200n) throw new Error("eth_getLogs is limited to a 200 range");
      return allLogs.filter((l) => BigInt(l.blockNumber) >= fromBlock && BigInt(l.blockNumber) <= toBlock);
    },
    async getBlockTimestamp() { return 1_800_000_000; },
    async getReceipt() { return null; },
  };

  // Tick 1 scans 6 * 190 = 1140 blocks (100..1239): cursor must stop at 1239, NOT jump to 2595!
  const t1 = await syncEscrowChain(fx.env, { rpc: strictRpc, startBlock: 100 });
  assert.equal(t1.synced_to_block, 1239);
  assert.equal(t1.paid, 0);

  // Tick 2 scans 1240..2379: still before 2400.
  const t2 = await syncEscrowChain(fx.env, { rpc: strictRpc, startBlock: 100 });
  assert.equal(t2.synced_to_block, 2379);
  assert.equal(t2.paid, 0);

  // Tick 3 scans 2380..2595 and catches Funded + Submitted + Paid without losing a single log!
  const t3 = await syncEscrowChain(fx.env, { rpc: strictRpc, startBlock: 100 });
  assert.equal(t3.synced_to_block, 2595);
  assert.deepEqual({ funded: t3.funded, submitted: t3.submitted, paid: t3.paid }, { funded: 1, submitted: 1, paid: 1 });
  await assertAllSurfaces(fx, { expectUnsealed: true, expectState: "paid" });
});

test("squatter acceptBounty cannot block real funded filler, and out-of-order syncEscrowReceipt(paidTx) catches up prior logs", async () => {
  const db = makeD1();
  const env = {
    DB: db,
    HUMAN_BOUNTIES: "off",
    PLATFORM_FEE_ADDRESS: FEE_ADDR,
    ESCROW_ADDRESS_BASE_SEPOLIA: ESCROW,
    SESSION_SECRET: "test-only-session-hmac-key-0123456789abcdef",
  };
  const posterReg = await registerAgent(db, "PosterSquat", { contact_email: "p@example.com" });
  const squatterReg = await registerAgent(db, "Squatter", { contact_email: "s@example.com" });
  const fillerReg = await registerAgent(db, "RealFiller", { contact_email: "f@example.com" });
  const poster = await authByKey(db, posterReg.api_key);
  const squatter = await authByKey(db, squatterReg.api_key);
  const filler = await authByKey(db, fillerReg.api_key);
  await setPayoutAddress(db, squatter, RIVAL_WALLET);
  await setPayoutAddress(db, filler, AGENT_WALLET);

  const posted = await postBounty(db, poster, env, {
    title: "Benchmark Postgres JSONB indexing options",
    description: "Provide reproducible benchmark numbers across GIN jsonb_ops vs jsonb_path_ops.",
    category: "research",
    reward_amount_cents: 400,
    settlement: "onchain",
  });
  // Squatter grabs accepted_agent_id off-chain, while real filler submits the actual work.
  await acceptBounty(db, squatter, posted.bounty_id, env);
  const sub = await submitToBounty(
    db, filler, posted.bounty_id,
    "EXACT_BENCHMARK_RESULTS_GIN_PATH_OPS_3X",
    undefined,
    "Reproducible 10M-row benchmark comparing jsonb_ops and jsonb_path_ops.",
  );

  const amountUnits = 4_000_000n;
  const feeUnits = 200_000n;
  const toAgentUnits = 3_800_000n;
  const ref = bountyEscrowRef(posted.bounty_id);
  const paidHash = txHash(953);
  const rpc = makeMockRpc({
    head: 300n,
    logs: [
      fundedLog({ jobId: 51, agent: AGENT_WALLET, amountUnits, ref, blockNumber: 100n, tx: txHash(951) }),
      submittedLog({ jobId: 51, blockNumber: 110n, tx: txHash(952) }),
      paidLog({ jobId: 51, agent: AGENT_WALLET, toAgentUnits, feeUnits, blockNumber: 120n, tx: paidHash }),
    ],
  });

  // Poster calls syncEscrowReceipt(paidHash) BEFORE cron ever ran syncEscrowChain!
  const res = await syncEscrowReceipt(env, paidHash, { rpc, startBlock: 90 });
  assert.equal(res.funded, 1);
  assert.equal(res.paid, 1);

  const view = await getBounty(db, posted.bounty_id, poster, undefined, env);
  assert.equal(view.bounty.escrow.state, "paid");
  assert.equal(view.bounty.accepted_agent_id, filler.id, "real funded filler overrides squatter");
  assert.equal(view.submissions.find((s) => s.id === sub.submission_id).content, "EXACT_BENCHMARK_RESULTS_GIN_PATH_OPS_3X");
});

test("fund + abandon refund does not brick an open bounty, while refunded agent's work stays sealed", async () => {
  const fx = await setupEscrowFixture(500);
  const rivalSecret = "SECOND_FILLER_VALID_DELIVERABLE";
  const rivalSub = await submitToBounty(
    fx.db, fx.rival, fx.bountyId,
    rivalSecret,
    undefined,
    "Verified second manufacturer quote with full HTTPS catalogue link.",
    undefined,
    [{ kind: "url", label: "Catalogue link", value: { url: "https://second.example.com/quote" } }],
  );

  const rpc = makeMockRpc({
    head: 300n,
    logs: [
      // First job (#61) funded for AGENT_WALLET and abandoned
      fundedLog({ jobId: 61, agent: AGENT_WALLET, amountUnits: fx.amountUnits, ref: fx.ref, blockNumber: 100n, tx: txHash(961) }),
      refundedLog({ jobId: 61, amountUnits: fx.amountUnits, reasonCode: 2, blockNumber: 110n, tx: txHash(962) }),
    ],
  });
  await syncEscrowChain(fx.env, { rpc, startBlock: 90 });
  await assertAllSurfaces(fx, { expectUnsealed: false, expectState: "refunded" });

  // Poster cannot pay direct settlement legs for the refunded escrow agent's submission (stays sealed under M4)
  await assert.rejects(
    () => settlementInstruction(fx.db, fx.env, fx.poster, fx.bountyId, fx.submissionId),
    /refunded.*stays sealed/i,
  );

  // Rival can now accept the still-open bounty, idempotently without inbox spam, and locks out third parties!
  const inboxBefore = (await readInbox(fx.db, fx.poster.id, null, 50)).events.filter((e) => e.type === "bounty.accepted").length;
  const reAccepted = await acceptBounty(fx.db, fx.rival, fx.bountyId, fx.env);
  assert.equal(reAccepted.accepted_agent_id, fx.rival.id);
  const reAcceptedDup = await acceptBounty(fx.db, fx.rival, fx.bountyId, fx.env);
  assert.equal(reAcceptedDup.already_accepted, true);
  const inboxAfter = (await readInbox(fx.db, fx.poster.id, null, 50)).events.filter((e) => e.type === "bounty.accepted").length;
  assert.equal(inboxAfter, inboxBefore + 1, "repeated acceptBounty after refund must not spam inbox");
  await assert.rejects(
    () => acceptBounty(fx.db, fx.filler, fx.bountyId, fx.env),
    /already accepted/,
  );

  rpc.pushLog(fundedLog({ jobId: 62, agent: RIVAL_WALLET, amountUnits: fx.amountUnits, ref: fx.ref, blockNumber: 310n, tx: txHash(963) }));
  rpc.pushLog(submittedLog({ jobId: 62, blockNumber: 320n, tx: txHash(964) }));
  rpc.pushLog(paidLog({ jobId: 62, agent: RIVAL_WALLET, toAgentUnits: fx.toAgentUnits, feeUnits: fx.feeUnits, blockNumber: 330n, tx: txHash(965) }));
  rpc.setHead(350n);

  const s2 = await syncEscrowChain(fx.env, { rpc, startBlock: 90 });
  assert.equal(s2.paid, 1);

  // Rival's winning submission is unsealed; first agent's submission stays sealed!
  const posterView = await getBounty(fx.db, fx.bountyId, fx.poster, undefined, fx.env);
  assert.equal(posterView.bounty.status, "awarded");
  assert.equal(posterView.submissions.find((s) => s.id === rivalSub.submission_id).content, rivalSecret);
  assert.equal(posterView.submissions.find((s) => s.id === fx.submissionId).content, null);
});

test("late board submission after Paid confirmed on-chain finalizes award cleanly for the paid escrow agent", async () => {
  const db = makeD1();
  const env = {
    DB: db,
    HUMAN_BOUNTIES: "off",
    PLATFORM_FEE_ADDRESS: FEE_ADDR,
    ESCROW_ADDRESS_BASE_SEPOLIA: ESCROW,
    SESSION_SECRET: "test-only-session-hmac-key-0123456789abcdef",
  };
  const posterReg = await registerAgent(db, "LatePoster", { contact_email: "lp@example.com" });
  const fillerReg = await registerAgent(db, "LateFiller", { contact_email: "lf@example.com" });
  const rivalReg = await registerAgent(db, "LateRival", { contact_email: "lr@example.com" });
  const poster = await authByKey(db, posterReg.api_key);
  const filler = await authByKey(db, fillerReg.api_key);
  const rival = await authByKey(db, rivalReg.api_key);
  await setPayoutAddress(db, filler, AGENT_WALLET);
  await setPayoutAddress(db, rival, RIVAL_WALLET);

  const posted = await postBounty(db, poster, env, {
    title: "Compile EU customs tariff code table",
    description: "Map 20 product SKUs to verified TARIC 10-digit codes with official TARIC links.",
    category: "data",
    reward_amount_cents: 500,
    settlement: "onchain",
  });
  await acceptBounty(db, filler, posted.bounty_id, env);
  const ref = bountyEscrowRef(posted.bounty_id);

  const rpc = makeMockRpc({
    head: 250n,
    logs: [
      fundedLog({ jobId: 91, agent: AGENT_WALLET, amountUnits: 5_000_000n, ref, blockNumber: 100n, tx: txHash(971) }),
      submittedLog({ jobId: 91, blockNumber: 110n, tx: txHash(972) }),
      paidLog({ jobId: 91, agent: AGENT_WALLET, toAgentUnits: 4_750_000n, feeUnits: 250_000n, blockNumber: 120n, tx: txHash(973) }),
    ],
  });
  await syncEscrowChain(env, { rpc, startBlock: 90 });

  // Rival is blocked from submitting once paid
  await assert.rejects(
    () => submitToBounty(db, rival, posted.bounty_id, "rival text", undefined, "Rival preview text that is at least forty characters long."),
    /already paid/,
  );

  // Paid escrow filler attaches deliverable -> immediately finalized & unsealed!
  const lateSub = await submitToBounty(
    db, filler, posted.bounty_id,
    "LATE_ATTACHED_TARIC_TABLE_DELIVERABLE",
    undefined,
    "All 20 SKUs mapped to TARIC 10-digit codes with official Europa links.",
  );
  assert.equal(lateSub.status, "accepted");

  const posterView = await getBounty(db, posted.bounty_id, poster, undefined, env);
  assert.equal(posterView.bounty.status, "awarded");
  assert.equal(posterView.submissions[0].content, "LATE_ATTACHED_TARIC_TABLE_DELIVERABLE");
});

test("Worker source has zero private-key handling or chain-writing RPC methods", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : [],
    );
  for (const file of walk(srcDir)) {
    const code = fs.readFileSync(file, "utf8");
    assert.ok(!code.includes("eth_sendRawTransaction"), `${file} must never send raw transactions`);
    assert.ok(!code.includes("PRIVATE_KEY"), `${file} must never reference a private key binding`);
    // In src/fundpage.ts, only the inline browser `<script>` (`CLIENT_JS`, calling `window.ethereum`) may mention `eth_sendTransaction`.
    const serverCode = file.endsWith("fundpage.ts")
      ? code.replace(/const CLIENT_JS = `[\s\S]*?`;/, "")
      : code;
    assert.ok(!serverCode.includes("eth_sendTransaction"), `${file} server code must never send transactions from the Worker`);
  }
});
