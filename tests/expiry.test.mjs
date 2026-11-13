// The tighter reachable rule (verified webhook or a recent inbox check; email
// alone never counts) and bounty expirations (default deadline, one warning,
// one extension, a review window for work that arrived in time).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeD1 } from "./d1shim.mjs";
import {
  registerAgent, authByKey, postBounty, submitToBounty, readInbox, updateAgentProfile, isReachable,
  extendBounty, warnExpiring, expireOverdue, getBounty, EXPIRY, STALE_DAYS,
} from "../.test-build/core.js";
import { pingWebhook, repingWebhooks, flushWebhooks } from "../.test-build/notify.js";

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

test("the migration gives open bounties with no deadline one, never sooner than a week", async () => {
  const db = makeD1();
  const p = await agent(db, "legacy-poster");
  const old = await postBounty(db, p.a, ENV, BOUNTY);
  const recent = await postBounty(db, p.a, ENV, { ...BOUNTY, title: "Find the second cheapest verified supplier" });
  set(db, "UPDATE bounties SET deadline = NULL, created_at = ? WHERE id = ?", at(-60 * DAY), old.bounty_id);
  set(db, "UPDATE bounties SET deadline = NULL, created_at = ? WHERE id = ?", at(-DAY), recent.bounty_id);
  const sql = readFileSync(new URL("../migrations/0031_reach_and_expiry.sql", import.meta.url), "utf8");
  db.raw.exec(sql.slice(sql.indexOf("UPDATE bounties")));
  const dl = (id) => Date.parse(db.raw.prepare("SELECT deadline FROM bounties WHERE id = ?").get(id).deadline);
  assert.ok(Math.abs(dl(old.bounty_id) - (Date.now() + 7 * DAY)) < 60_000, "old ones get a week");
  assert.ok(Math.abs(dl(recent.bounty_id) - (Date.now() + 29 * DAY)) < 60_000, "recent ones get 30 days from posting");
});
