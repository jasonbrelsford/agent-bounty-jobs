// The tighter reachable rule (verified webhook or a recent inbox check; email
// alone never counts) and bounty expirations (default deadline, one warning,
// one extension, a review window for work that arrived in time).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeD1 } from "./d1shim.mjs";
import {
  registerAgent, authByKey, postBounty, acceptBounty, submitToBounty, joinSubmission, reviewSubmission,
  setPayoutAddress, settlementInstruction, posterReputation, readInbox, updateAgentProfile, isReachable,
  extendBounty, warnExpiring, expireOverdue, getBounty, EXPIRY, STALE_DAYS,
} from "../.test-build/core.js";
import { pingWebhook, repingWebhooks, flushWebhooks } from "../.test-build/notify.js";
import { routeLabel, mcpLabels } from "../.test-build/livefeed.js";

const ENV = { HUMAN_BOUNTIES: "off" };
const DAY = 86_400_000;
const at = (ms) => new Date(Date.now() + ms).toISOString();
const resolve = async () => ["93.184.216.34"];
const BOUNTY = {
  title: "Find the cheapest verified supplier", description: "Unit price, MOQ, lead time and a source link please.",
  category: "sourcing", reward_amount_cents: 2500,
};
const SUB = ["Supplier Y: EUR 0.42/unit at 10k MOQ, source https://example.com/catalogue", undefined,
  "Verified EU supplier at EUR 0.42/unit for 10k MOQ, confirmed against their public catalogue."];

async function agent(db, name, extra = {}) {
  const r = await registerAgent(db, name, extra);
  return { ...r, a: await authByKey(db, r.api_key) };
}
const set = (db, sql, ...args) => db.raw.prepare(sql).run(...args);
const quiet = (db, id) => set(db, "UPDATE agents SET inbox_last_polled_at = ? WHERE id = ?", at(-4 * DAY), id);
const inbox = async (db, id) => (await readInbox(db, id)).events;

// ── reachable ───────────────────────────────────────────────────────────────

test("an inbox check counts for three days, and registering is the first one", async () => {
  const db = makeD1();
  const p = await agent(db, "inbox-only");
  assert.ok(await isReachable(db, p.agent_id));
  set(db, "UPDATE agents SET inbox_last_polled_at = ? WHERE id = ?", at(-2.9 * DAY), p.agent_id);
  assert.ok(await isReachable(db, p.agent_id));
  quiet(db, p.agent_id);
  assert.ok(!(await isReachable(db, p.agent_id)));
  await readInbox(db, p.agent_id);
  assert.ok(await isReachable(db, p.agent_id));
});

test("an email alone never makes an agent reachable", async () => {
  const db = makeD1();
  const p = await agent(db, "email-only", { contact_email: "ops@example.com" });
  quiet(db, p.agent_id);
  assert.ok(!(await isReachable(db, p.agent_id)));
  await assert.rejects(postBounty(db, p.a, ENV, BOUNTY), (e) => e.status === 403 && /reachable/.test(e.message));
});

test("a webhook counts once it answers a signed ping, for 90 days, and resets when changed", async () => {
  const db = makeD1();
  const p = await agent(db, "hooked", { notify_webhook: "https://hooks.example.com/in" });
  quiet(db, p.agent_id);
  assert.ok(!(await isReachable(db, p.agent_id)), "not until it answers");
  const calls = [];
  let status = 500;
  const fetcher = async (url, init) => { calls.push(init); return new Response(null, { status }); };
  let r = await pingWebhook(db, p.agent_id, { fetcher, resolve });
  assert.equal(r.verified, false);
  assert.match(r.error, /HTTP 500/);
  assert.equal(calls[0].headers["x-bounty-event"], "webhook.verify");
  assert.match(calls[0].headers["x-bounty-signature"], /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(calls[0].redirect, "manual");
  status = 204;
  r = await pingWebhook(db, p.agent_id, { fetcher, resolve });
  assert.equal(r.verified, true);
  assert.ok(await isReachable(db, p.agent_id));
  // A private address is refused before anything is sent.
  const evil = await agent(db, "evil", { notify_webhook: "https://rebind.example.com/in" });
  quiet(db, evil.agent_id);
  r = await pingWebhook(db, evil.agent_id, { fetcher, resolve: async () => ["10.0.0.5"] });
  assert.equal(r.verified, false);
  assert.ok(!(await isReachable(db, evil.agent_id)));
  // Lapses after 90 days without a good answer.
  set(db, "UPDATE agents SET webhook_verified_at = ? WHERE id = ?", at(-91 * DAY), p.agent_id);
  assert.ok(!(await isReachable(db, p.agent_id)));
  // A changed URL starts unverified again.
  set(db, "UPDATE agents SET webhook_verified_at = ? WHERE id = ?", at(-DAY), p.agent_id);
  assert.ok(await isReachable(db, p.agent_id));
  await updateAgentProfile(db, p.a, { notify_webhook: "https://hooks.example.com/new" });
  assert.ok(!(await isReachable(db, p.agent_id)));
});

test("the hourly re-ping keeps live webhooks verified, at most once a day each", async () => {
  const db = makeD1();
  const p = await agent(db, "old-hook", { notify_webhook: "https://hooks.example.com/old" });
  const fresh = await agent(db, "fresh-hook", { notify_webhook: "https://hooks.example.com/fresh" });
  set(db, "UPDATE agents SET webhook_verified_at = ?, webhook_checked_at = ? WHERE id = ?", at(-85 * DAY), at(-85 * DAY), p.agent_id);
  set(db, "UPDATE agents SET webhook_verified_at = ?, webhook_checked_at = ? WHERE id = ?", at(-DAY), at(-DAY), fresh.agent_id);
  let n = 0;
  const fetcher = async () => { n++; return new Response("ok"); };
  assert.deepEqual(await repingWebhooks(db, 80, { fetcher, resolve }), { checked: 1, verified: 1 });
  assert.equal(n, 1, "only the old one is pinged");
  assert.deepEqual(await repingWebhooks(db, 80, { fetcher, resolve }), { checked: 0, verified: 0 });
});

test("a real delivery answered with 2xx keeps the agent's webhook verified", async () => {
  const db = makeD1();
  const poster = await agent(db, "deliver-poster", { notify_webhook: "https://hooks.example.com/in" });
  const filler = await agent(db, "deliver-filler");
  const b = await postBounty(db, poster.a, ENV, BOUNTY);
  await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  quiet(db, poster.agent_id);
  assert.ok(!(await isReachable(db, poster.agent_id)));
  await flushWebhooks(db, { fetcher: async () => new Response(null, { status: 200 }), resolve });
  assert.ok(await isReachable(db, poster.agent_id));
});

// ── expirations ─────────────────────────────────────────────────────────────

test("a bounty posted without a deadline gets the default", async () => {
  const db = makeD1();
  const p = await agent(db, "default-deadline");
  const b = await postBounty(db, p.a, ENV, BOUNTY);
  const d = Date.parse(b.deadline ?? (await getBounty(db, b.bounty_id, null)).bounty.deadline);
  assert.ok(Math.abs(d - (Date.now() + EXPIRY.default_days * DAY)) < 60_000);
});

test("the poster is warned once, three days out, and can extend once", async () => {
  const db = makeD1();
  const p = await agent(db, "warned-poster");
  const other = await agent(db, "not-the-poster");
  const b = await postBounty(db, p.a, ENV, { ...BOUNTY, deadline: at(2 * DAY) });
  assert.equal(await warnExpiring(db), 1);
  assert.equal(await warnExpiring(db), 0, "only once");
  const warned = (await inbox(db, p.agent_id)).filter((e) => e.type === "bounty.expiring");
  assert.equal(warned.length, 1);
  await assert.rejects(extendBounty(db, other.a, b.bounty_id, { days: 7 }), (e) => e.status === 403);
  await assert.rejects(extendBounty(db, p.a, b.bounty_id, { days: 0 }), /days must be/);
  await assert.rejects(extendBounty(db, p.a, b.bounty_id, { deadline: at(DAY) }), /later than the current/);
  await assert.rejects(extendBounty(db, p.a, b.bounty_id, { deadline: at(91 * DAY) }), /within 90 days/);
  const r = await extendBounty(db, p.a, b.bounty_id, { days: 7 });
  assert.ok(Math.abs(Date.parse(r.deadline) - (Date.now() + 9 * DAY)) < 60_000);
  await assert.rejects(extendBounty(db, p.a, b.bounty_id, { days: 7 }), /extended once/);
  // The warning comes again before the new deadline, and says no further extension.
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(DAY), b.bounty_id);
  assert.equal(await warnExpiring(db), 1);
  const last = (await inbox(db, p.agent_id)).filter((e) => e.type === "bounty.expiring").pop();
  assert.match(JSON.stringify(last), /already extended once/);
});

test("with nothing waiting it expires at the deadline; nothing more can be submitted", async () => {
  const db = makeD1();
  const p = await agent(db, "lonely-poster");
  const b = await postBounty(db, p.a, ENV, BOUNTY);
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(-60_000), b.bounty_id);
  await expireOverdue(db);
  assert.equal((await getBounty(db, b.bounty_id, null)).bounty.status, "expired");
  assert.ok((await inbox(db, p.agent_id)).some((e) => e.type === "bounty.expired"));
  await assert.rejects(extendBounty(db, p.a, b.bounty_id, { days: 7 }), /only an open bounty/);
});

test("work that arrived in time gets the review window before the bounty expires", async () => {
  const db = makeD1();
  const p = await agent(db, "slow-poster");
  const f = await agent(db, "on-time-filler");
  const late = await agent(db, "late-filler");
  const b = await postBounty(db, p.a, ENV, BOUNTY);
  const s = await submitToBounty(db, f.a, b.bounty_id, ...SUB);
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(-DAY), b.bounty_id);
  await expireOverdue(db);
  assert.equal((await getBounty(db, b.bounty_id, null)).bounty.status, "open", "still open for review");
  await assert.rejects(submitToBounty(db, late.a, b.bounty_id, ...SUB), /deadline has passed/);
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(-(STALE_DAYS + 1) * DAY), b.bounty_id);
  await expireOverdue(db);
  assert.equal((await getBounty(db, b.bounty_id, null)).bounty.status, "expired");
  const closed = (await inbox(db, f.agent_id)).find((e) => e.type === "submission.closed");
  assert.ok(closed, "the filler hears their submission closed");
  assert.equal(closed.submission_id, s.submission_id);
});

test("escrow-funded bounties are left to the contract", async () => {
  const db = makeD1();
  const p = await agent(db, "escrow-poster");
  const b = await postBounty(db, p.a, ENV, BOUNTY);
  set(db, "UPDATE bounties SET escrow_state = 'funded', deadline = ? WHERE id = ?", at(-30 * DAY), b.bounty_id);
  await expireOverdue(db);
  assert.equal((await getBounty(db, b.bounty_id, null)).bounty.status, "open");
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(DAY), b.bounty_id);
  assert.equal(await warnExpiring(db), 0);
  await assert.rejects(extendBounty(db, p.a, b.bounty_id, { days: 3 }), /fixed on-chain/);
});

test("the migration gives open bounties with no deadline one, never sooner than a week, and backfills verified webhooks", async () => {
  const db = makeD1();
  const p = await agent(db, "legacy-poster", { notify_webhook: "https://hooks.example.com/live" });
  const old = await postBounty(db, p.a, ENV, BOUNTY);
  const recent = await postBounty(db, p.a, ENV, { ...BOUNTY, title: "Find the second cheapest verified supplier" });
  set(db, "UPDATE bounties SET deadline = NULL, created_at = ? WHERE id = ?", at(-60 * DAY), old.bounty_id);
  set(db, "UPDATE bounties SET deadline = NULL, created_at = ? WHERE id = ?", at(-DAY), recent.bounty_id);
  const deliveredAt = at(-2 * DAY);
  set(
    db,
    "INSERT INTO inbox (agent_id, at, type, bounty_id, submission_id, data, webhook_pending, delivered_at) VALUES (?, ?, 'bounty.posted', ?, NULL, '{}', 0, ?)",
    p.agent_id, deliveredAt, old.bounty_id, deliveredAt,
  );
  quiet(db, p.agent_id);
  assert.equal(await isReachable(db, p.agent_id), false);
  const sql = readFileSync(new URL("../migrations/0031_reach_and_expiry.sql", import.meta.url), "utf8");
  db.raw.exec(sql.slice(sql.indexOf("UPDATE agents"), sql.indexOf("-- Expirations")));
  assert.equal(await isReachable(db, p.agent_id), true, "existing live webhook inherits delivered_at");
  db.raw.exec(sql.slice(sql.indexOf("UPDATE bounties")));
  const dl = (id) => Date.parse(db.raw.prepare("SELECT deadline FROM bounties WHERE id = ?").get(id).deadline);
  assert.ok(Math.abs(dl(old.bounty_id) - (Date.now() + 7 * DAY)) < 60_000, "old ones get a week");
  assert.ok(Math.abs(dl(recent.bounty_id) - (Date.now() + 29 * DAY)) < 60_000, "recent ones get 30 days from posting");
});

test("manual webhook verify cooldown blocks rapid spam until URL changes, and livefeed labels new routes/tools", async () => {
  const db = makeD1();
  const p = await agent(db, "throttled-hook", { notify_webhook: "https://hooks.example.com/in" });
  const now = Date.now();
  const fetcher = async () => new Response("ok", { status: 200 });
  const first = await pingWebhook(db, p.agent_id, { fetcher, resolve, now, minIntervalMs: 15_000 });
  assert.equal(first.verified, true);
  const second = await pingWebhook(db, p.agent_id, { fetcher, resolve, now: now + 2_000, minIntervalMs: 15_000 });
  assert.equal(second.throttled, true);
  await updateAgentProfile(db, p.a, { notify_webhook: "https://hooks.example.com/updated" });
  const third = await pingWebhook(db, p.agent_id, { fetcher, resolve, now: now + 3_000, minIntervalMs: 15_000 });
  assert.equal(third.verified, true);
  assert.equal(third.throttled, undefined);

  assert.equal(routeLabel("POST", "/v1/agents/me/webhook/verify"), "POST /v1/agents/me/webhook/verify");
  assert.equal(routeLabel("POST", "/v1/bounties/bty_0123456789abcdef/extend"), "POST /v1/bounties/:id/extend");
  assert.deepEqual(
    mcpLabels([
      { method: "tools/call", params: { name: "verify_webhook" } },
      { method: "tools/call", params: { name: "extend_bounty" } },
    ]),
    ["MCP verify_webhook", "MCP extend_bounty"],
  );
});

test("extendBounty rejects coercion, dual fields, and past deadlines during post-deadline review window", async () => {
  const db = makeD1();
  const p = await agent(db, "strict-extend-poster");
  const f = await agent(db, "strict-extend-filler");
  const b = await postBounty(db, p.a, ENV, BOUNTY);
  await submitToBounty(db, f.a, b.bounty_id, ...SUB);
  // Put bounty into its post-deadline review window (deadline 2 days ago, still open).
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(-2 * DAY), b.bounty_id);
  await assert.rejects(extendBounty(db, p.a, b.bounty_id, { days: true }), /whole number/);
  await assert.rejects(extendBounty(db, p.a, b.bounty_id, { days: [7] }), /whole number/);
  await assert.rejects(extendBounty(db, p.a, b.bounty_id, { deadline: 12 }), /ISO 8601/);
  await assert.rejects(extendBounty(db, p.a, b.bounty_id, { days: 7, deadline: at(7 * DAY) }), /not both/);
  await assert.rejects(extendBounty(db, p.a, b.bounty_id, { deadline: at(-DAY) }), /in the future/);
  const ok = await extendBounty(db, p.a, b.bounty_id, { days: 5 });
  assert.ok(Date.parse(ok.deadline) > Date.now() + 4 * DAY);
});

test("escrow late-paid/submitted fillers, partial settlement legs, team drafts, acceptBounty, milestones, and 168h delegates are safe across deadline", async () => {
  const db = makeD1();
  const poster = await agent(db, "edge-poster");
  const filler = await agent(db, "edge-filler");
  const mate = await agent(db, "edge-mate");
  const delegate = await agent(db, "edge-delegate");
  await setPayoutAddress(db, filler.a, "0x1111111111111111111111111111111111111111");
  await setPayoutAddress(db, mate.a, "0x4444444444444444444444444444444444444444");

  const ONCHAIN_ENV = {
    ...ENV,
    PLATFORM_FEE_ADDRESS: "0x2222222222222222222222222222222222222222",
    ESCROW_ADDRESS_BASE_SEPOLIA: "0x3333333333333333333333333333333333333333",
  };
  // 1) Late-paid escrow filler can still attach deliverable after board deadline passed.
  const escB = await postBounty(db, poster.a, ONCHAIN_ENV, { ...BOUNTY, settlement: "onchain" });
  set(
    db,
    "UPDATE bounties SET deadline = ?, escrow_state = 'paid', escrow_agent_id = ? WHERE id = ?",
    at(-2 * DAY), filler.agent_id, escB.bounty_id,
  );
  await assert.rejects(submitToBounty(db, mate.a, escB.bounty_id, ...SUB), /already paid/);
  const lateSub = await submitToBounty(db, filler.a, escB.bounty_id, ...SUB);
  assert.ok(lateSub.submission_id);

  // 2) Partially paid direct on-chain settlement leg prevents expireOverdue from stranding USDC.
  const legB = await postBounty(db, poster.a, ONCHAIN_ENV, { ...BOUNTY, settlement: "onchain" });
  const legSub = await submitToBounty(db, filler.a, legB.bounty_id, ...SUB);
  await settlementInstruction(db, ONCHAIN_ENV, poster.a, legB.bounty_id, legSub.submission_id);
  set(
    db,
    "UPDATE settlement_legs SET paid_tx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', paid_log = 0, paid_at = ? WHERE submission_id = ? AND role = 'contributor'",
    at(-DAY), legSub.submission_id,
  );
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(-(STALE_DAYS + 2) * DAY), legB.bounty_id);
  await expireOverdue(db);
  assert.equal((await getBounty(db, legB.bounty_id, null)).bounty.status, "open", "paid leg prevents expiry");

  // 3) joinSubmission and acceptBounty reject post-deadline calls; accepted bounty gets 15m sync grace.
  const teamB = await postBounty(db, poster.a, ONCHAIN_ENV, { ...BOUNTY, settlement: "onchain" });
  await submitToBounty(db, filler.a, teamB.bounty_id, ...SUB); // keeps bounty open in review window
  const draft = await submitToBounty(
    db, filler.a, teamB.bounty_id,
    "Team deliverable content with full verified catalogue references.",
    [{ agent_id: filler.agent_id, share_bp: 5000 }, { agent_id: mate.agent_id, share_bp: 5000 }],
    "Team preview with verified catalogue unit pricing and lead time.",
  );
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(-60_000), teamB.bounty_id);
  await assert.rejects(joinSubmission(db, mate.a, draft.submission_id), /deadline has passed/);
  await assert.rejects(acceptBounty(db, filler.a, teamB.bounty_id, ONCHAIN_ENV), /deadline has passed/);

  const accB = await postBounty(db, poster.a, ONCHAIN_ENV, { ...BOUNTY, settlement: "onchain" });
  await acceptBounty(db, filler.a, accB.bounty_id, ONCHAIN_ENV);
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(-5 * 60_000), accB.bounty_id);
  await expireOverdue(db);
  assert.equal((await getBounty(db, accB.bounty_id, null)).bounty.status, "open", "15m chain confirmation grace");
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(-20 * 60_000), accB.bounty_id);
  await expireOverdue(db);
  assert.equal((await getBounty(db, accB.bounty_id, null)).bounty.status, "expired");

  // 4) Partially awarded milestone bounty closes open milestones without staining posterReputation.
  const milPoster = await agent(db, "mil-poster");
  const milB = await postBounty(db, milPoster.a, ENV, {
    ...BOUNTY,
    reward_amount_cents: 2000,
    milestones: [
      { title: "Part 1", reward_amount_cents: 1000 },
      { title: "Part 2", reward_amount_cents: 1000 },
    ],
  });
  const milView = await getBounty(db, milB.bounty_id, null);
  const m1 = milView.bounty.milestones[0].id;
  const m2 = milView.bounty.milestones[1].id;
  const ms1 = await submitToBounty(db, filler.a, milB.bounty_id, SUB[0], undefined, SUB[2], m1);
  await reviewSubmission(db, milPoster.a, milB.bounty_id, ms1.submission_id, "accept", "good", "paid-offchain");
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(-60_000), milB.bounty_id);
  await expireOverdue(db);
  const m2Row = db.raw.prepare("SELECT status FROM milestones WHERE id = ?").get(m2);
  assert.equal(m2Row.status, "expired");
  const rep = await posterReputation(db, milPoster.agent_id);
  assert.equal(rep.abandoned_after_submissions, 0, "awarding the only submitted milestone is not abandonment");

  // 5) 168h review delegate still gets 48h after delegateOpensAt before expiry.
  const delB = await postBounty(db, poster.a, ENV, {
    ...BOUNTY,
    review_delegate: delegate.agent_id,
    review_after_hours: 168,
  });
  const delSub = await submitToBounty(db, filler.a, delB.bounty_id, ...SUB);
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(-(STALE_DAYS + 0.5) * DAY), delB.bounty_id);
  set(db, "UPDATE submissions SET pending_at = ? WHERE id = ?", at(-170 * 3_600_000), delSub.submission_id);
  await expireOverdue(db);
  assert.equal((await getBounty(db, delB.bounty_id, null)).bounty.status, "open", "delegate still within 48h window");

  // 6) Unconsented team draft on an expiring bounty stays hidden from the poster and does not stain reputation.
  const draftPoster = await agent(db, "draft-only-poster");
  const draftOnlyB = await postBounty(db, draftPoster.a, ENV, BOUNTY);
  const secretDraft = await submitToBounty(
    db, filler.a, draftOnlyB.bounty_id,
    "SECRET-DRAFT-CONTENT-9988 with verified supplier link.",
    [{ agent_id: filler.agent_id, share_bp: 5000 }, { agent_id: mate.agent_id, share_bp: 5000 }],
    "SECRET-DRAFT-PREVIEW-7766 unconsented draft preview must never leak.",
  );
  set(db, "UPDATE bounties SET deadline = ? WHERE id = ?", at(-60_000), draftOnlyB.bounty_id);
  await expireOverdue(db);
  const posterDraftView = await getBounty(db, draftOnlyB.bounty_id, draftPoster.a);
  assert.equal(posterDraftView.bounty.status, "expired");
  assert.ok(!JSON.stringify(posterDraftView).includes("SECRET-DRAFT"), "unconsented draft preview stays hidden from poster");
  const draftRow = db.raw.prepare("SELECT status FROM submissions WHERE id = ?").get(secretDraft.submission_id);
  assert.equal(draftRow.status, "withdrawn");
  assert.equal((await posterReputation(db, draftPoster.agent_id)).abandoned_after_submissions, 0);

  // 7) On-chain milestoned bounty where Milestone 1 settled on-chain still expires cleanly when Milestone 2 passes deadline,
  //    while keeping Milestone 1's accepted deliverable readable to the poster.
  const onMilPoster = await agent(db, "onchain-mil-poster");
  const onMilB = await postBounty(db, onMilPoster.a, ONCHAIN_ENV, {
    ...BOUNTY,
    settlement: "onchain",
    reward_amount_cents: 2000,
    milestones: [
      { title: "On-chain Part 1", reward_amount_cents: 1000 },
      { title: "On-chain Part 2", reward_amount_cents: 1000 },
    ],
  });
  const onMilView = await getBounty(db, onMilB.bounty_id, null);
  const om1 = onMilView.bounty.milestones[0].id;
  const om2 = onMilView.bounty.milestones[1].id;
  const oms1 = await submitToBounty(db, filler.a, onMilB.bounty_id, "ONCHAIN-M1-DELIVERABLE-4242 verified answer.", undefined, SUB[2], om1);
  await settlementInstruction(db, ONCHAIN_ENV, onMilPoster.a, onMilB.bounty_id, oms1.submission_id);
  const settledHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await reviewSubmission(db, onMilPoster.a, onMilB.bounty_id, oms1.submission_id, "accept", "paid", settledHash, true);
  set(
    db,
    "UPDATE settlement_legs SET open = 0, paid_tx = ?, paid_log = 0, paid_at = ? WHERE submission_id = ?",
    settledHash, at(-DAY), oms1.submission_id,
  );
  set(db, "UPDATE bounties SET settled_tx = ?, deadline = ? WHERE id = ?", settledHash, at(-60_000), onMilB.bounty_id);
  await expireOverdue(db);
  const afterOnMil = await getBounty(db, onMilB.bounty_id, onMilPoster.a, undefined, ONCHAIN_ENV);
  assert.equal(afterOnMil.bounty.status, "expired", "completed M1 settlement_legs do not block M2 expiry");
  assert.equal(db.raw.prepare("SELECT status FROM milestones WHERE id = ?").get(om2).status, "expired");
  assert.ok(JSON.stringify(afterOnMil).includes("ONCHAIN-M1-DELIVERABLE-4242"), "settled M1 deliverable stays unsealed for poster");
  assert.equal((await posterReputation(db, onMilPoster.agent_id)).abandoned_after_submissions, 0);
});
