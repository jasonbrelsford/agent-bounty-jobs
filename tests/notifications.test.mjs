// Poster notifications, reachability, review delegation, the stale rule, and
// contact privacy — exercised end-to-end against the real migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { makeD1 } from "./d1shim.mjs";
import {
  registerAgent, authByKey, postBounty, submitToBounty, reviewSubmission, getBounty, listBounties,
  readInbox, readInboxFeed, updateAgentProfile, deleteContact, withdrawSubmission, sweepNotices,
  myActivity, adminAgentContact, adminNotice, validateEmail, nudge, isReachable,
} from "../.test-build/core.js";
import {
  validateWebhookUrl, isPublicIp, assertDeliverable, signPayload, flushWebhooks,
} from "../.test-build/notify.js";
import { dashboard } from "../.test-build/dashboard.js";

const ENV = { HUMAN_BOUNTIES: "off" };
const HOUR = 3_600_000, DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

async function agent(db, name, extra = {}) {
  const r = await registerAgent(db, name, extra);
  return { ...r, a: await authByKey(db, r.api_key) };
}
const reach = (db, name) => agent(db, name, { contact_email: `${name}@example.com` });

const BOUNTY = {
  title: "Find the cheapest verified supplier", description: "Unit price, MOQ, lead time and a source link please.",
  category: "sourcing", reward_amount_cents: 2500,
};
const SUB = ["Supplier Y: EUR 0.42/unit at 10k MOQ, source https://example.com/catalogue", undefined,
  "Verified EU supplier at EUR 0.42/unit for 10k MOQ, confirmed against their public catalogue."];

async function inboxTypes(db, id) {
  return (await readInbox(db, id)).events.map((e) => e.type);
}

// ── SSRF ────────────────────────────────────────────────────────────────────

test("webhook URLs: public https only", () => {
  assert.equal(validateWebhookUrl("https://hooks.example.com/x?y=1"), "https://hooks.example.com/x?y=1");
  assert.equal(validateWebhookUrl("https://8.8.8.8/h"), "https://8.8.8.8/h");
  for (const bad of [
    "http://hooks.example.com/x", "ftp://example.com", "https://localhost/x", "https://foo.localhost/",
    "https://127.0.0.1/", "https://10.1.2.3/", "https://172.16.0.1/", "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/", "https://0.0.0.0/",
    "https://[::1]/", "https://[fe80::1]/", "https://[fc00::1]/", "https://[::ffff:127.0.0.1]/",
    "https://0x7f.1/", "https://2130706433/", "https://user:pw@example.com/", "https://example.com:8443/",
    "https://intranet/", "https://db.internal/", "https://printer.local/", "not a url", "",
  ])
    assert.throws(() => validateWebhookUrl(bad), undefined, `should refuse ${bad}`);
});

test("isPublicIp classifies v4 and v6", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.ok(isPublicIp(ip), ip);
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.1.1", "192.0.2.5", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fd12::1", "ff02::1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::"])
    assert.ok(!isPublicIp(ip), ip);
});

test("delivery re-checks DNS and refuses private resolutions", async () => {
  await assertDeliverable("https://ok.example.com/h", async () => ["93.184.216.34"]);
  await assert.rejects(assertDeliverable("https://rebind.example.com/h", async () => ["93.184.216.34", "127.0.0.1"]));
  await assert.rejects(assertDeliverable("https://nx.example.com/h", async () => []));
});

test("signature is HMAC-SHA256 over t.body", async () => {
  const sig = await signPayload("whsec_abc", '{"a":1}', 1700000000);
  const want = createHmac("sha256", "whsec_abc").update('1700000000.{"a":1}').digest("hex");
  assert.equal(sig, `t=1700000000,v1=${want}`);
});

// ── contact validation & privacy ────────────────────────────────────────────

test("contact validation", async () => {
  const db = makeD1();
  assert.equal(validateEmail("Ops@Example.COM"), "Ops@example.com");
  for (const bad of ["nope", "a@b", "a b@example.com", "x@-bad.com", `${"a".repeat(250)}@example.com`])
    assert.throws(() => validateEmail(bad), undefined, bad);
  await assert.rejects(registerAgent(db, "bad-mail", { contact_email: "not-an-email" }), /contact_email/);
  await assert.rejects(registerAgent(db, "bad-hook", { notify_webhook: "http://example.com/h" }), /https/);
  await assert.rejects(registerAgent(db, "bad-field", { contact: { operator_name: "Bob" } }), /not a field/);
  const ok = await registerAgent(db, "good-agent", { contact: { email: "ops@example.com", webhook: "https://hooks.example.com/b" } });
  assert.match(ok.webhook_secret, /^whsec_[0-9a-f]{64}$/);
  assert.equal(ok.action_needed, undefined);
});

test("registration hands out an inbox and nudges the unreachable", async () => {
  const db = makeD1();
  const r = await registerAgent(db, "quiet-agent");
  assert.match(r.inbox_url, /\/v1\/agents\/me\/inbox$/);
  assert.match(r.inbox_feed_url, /\/v1\/inbox\/[0-9a-f]{64}$/);
  assert.match(r.action_needed, /Give us a webhook\/email, or check your inbox at .*\/v1\/agents\/me\/inbox/);
  const a = await authByKey(db, r.api_key);
  assert.ok(!a.reachable);
  assert.ok(nudge(a, { x: 1 }).action_needed);
  // Polling the inbox makes it reachable, and the hint stops.
  await readInbox(db, a.id);
  const a2 = await authByKey(db, r.api_key);
  assert.ok(a2.reachable);
  assert.equal(nudge(a2, { x: 1 }).action_needed, undefined);
});

test("contact details never leak into public responses", async () => {
  const db = makeD1();
  const poster = await agent(db, "private-poster", { contact_email: "secret-ops@example.com", notify_webhook: "https://hooks.example.com/agentlevel" });
  const other = await reach(db, "nosy-agent");
  const b = await postBounty(db, poster.a, ENV, { ...BOUNTY, notify_webhook: "https://hooks.example.com/bountylevel" });
  const leaks = ["secret-ops@example.com", "hooks.example.com", poster.webhook_secret, "whsec_", "inbox_feed", "contact_email"];
  const surfaces = {
    list: await listBounties(db, { status: "all" }),
    get_anon: await getBounty(db, b.bounty_id, null),
    get_other: await getBounty(db, b.bounty_id, other.a),
    dashboard: await (await dashboard({ DB: db }, "https://bounty.test")).text(),
  };
  for (const [name, v] of Object.entries(surfaces)) {
    const txt = typeof v === "string" ? v : JSON.stringify(v);
    for (const l of leaks) assert.ok(!txt.includes(l), `${name} leaked ${l}`);
  }
  assert.equal(surfaces.get_anon.bounty.poster_reachable, true);
  assert.match(surfaces.dashboard, /reachable/);
  // Only the agent itself and the admin path see it.
  const mine = await myActivity(db, poster.a);
  assert.equal(mine.reachability.contact_email, "secret-ops@example.com");
  assert.equal((await adminAgentContact(db, poster.agent_id)).contact_email, "secret-ops@example.com");
  assert.ok(!JSON.stringify(mine).includes(poster.webhook_secret), "secret is shown once, not on later reads");
});

test("contact can be patched and deleted", async () => {
  const db = makeD1();
  const p = await agent(db, "patchy", { contact_email: "a@example.com" });
  const r1 = await updateAgentProfile(db, p.a, { notify_webhook: "https://hooks.example.com/p" });
  assert.match(r1.webhook_secret, /^whsec_/);
  const r2 = await updateAgentProfile(db, p.a, { contact_email: null });
  assert.equal(r2.contact_email, null);
  assert.ok(r2.reachable, "webhook still set");
  await assert.rejects(updateAgentProfile(db, p.a, { operator_name: "x" }), /unknown field/);
  const d = await deleteContact(db, p.a);
  assert.equal(d.notify_webhook, null);
  assert.equal(d.webhook_secret_set, false);
  assert.equal(d.reachable, false);
});

// ── the ≥ $1 gate ───────────────────────────────────────────────────────────

test("posting $1+ needs a reachable poster; low-value posting and submitting stay open", async () => {
  const db = makeD1();
  const anon = await agent(db, "anon-poster");
  await assert.rejects(postBounty(db, anon.a, ENV, { ...BOUNTY, reward_amount_cents: 100 }), (e) => e.status === 403 && /reachable/.test(e.message));
  const small = await postBounty(db, anon.a, ENV, { ...BOUNTY, reward_amount_cents: 99 });
  const filler = await agent(db, "anon-filler");
  await submitToBounty(db, filler.a, small.bounty_id, ...SUB);
  await readInbox(db, anon.agent_id);   // inbox poll = reachable
  await postBounty(db, anon.a, ENV, { ...BOUNTY, reward_amount_cents: 100 });
});

// ── inbox, webhooks ─────────────────────────────────────────────────────────

test("poster is notified of new work and awards; submitter of the outcome", async () => {
  const db = makeD1();
  const poster = await reach(db, "notified-poster");
  const f1 = await reach(db, "filler-one"), f2 = await reach(db, "filler-two");
  const b = await postBounty(db, poster.a, ENV, BOUNTY);
  const s1 = await submitToBounty(db, f1.a, b.bounty_id, ...SUB);
  await submitToBounty(db, f2.a, b.bounty_id, ...SUB);
  await reviewSubmission(db, poster.a, b.bounty_id, s1.submission_id, "accept");
  assert.deepEqual(await inboxTypes(db, poster.agent_id), ["submission.received", "submission.received", "bounty.awarded"]);
  assert.deepEqual(await inboxTypes(db, f1.agent_id), ["submission.accepted"]);
  assert.deepEqual(await inboxTypes(db, f2.agent_id), ["submission.closed"]);
  const all = JSON.stringify((await readInbox(db, poster.agent_id)).events);
  assert.ok(!all.includes("EUR 0.42"), "no preview or content in inbox payloads");
  // Cursor works.
  const first = await readInbox(db, poster.agent_id, 0, 1);
  assert.equal((await readInbox(db, poster.agent_id, first.next_cursor)).events.length, 2);
});

test("webhooks are signed, never follow redirects, and retry", async () => {
  const db = makeD1();
  const poster = await agent(db, "hooked-poster", { notify_webhook: "https://hooks.example.com/in" });
  const filler = await reach(db, "plain-filler");
  const b = await postBounty(db, poster.a, ENV, BOUNTY);
  await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const calls = [];
  let status = 302;
  const fetcher = async (url, init) => { calls.push({ url, init }); return new Response(null, { status }); };
  const resolve = async () => ["93.184.216.34"];
  let r = await flushWebhooks(db, { fetcher, resolve });
  assert.deepEqual(r, { delivered: 0, failed: 1 });
  assert.equal(calls[0].init.redirect, "manual");
  assert.ok(calls[0].init.signal, "has a timeout signal");
  // Not due again until the backoff passes.
  assert.deepEqual(await flushWebhooks(db, { fetcher, resolve }), { delivered: 0, failed: 0 });
  status = 200;
  r = await flushWebhooks(db, { fetcher, resolve, now: Date.now() + 2 * 60_000 });
  assert.deepEqual(r, { delivered: 1, failed: 0 });
  const { init } = calls[1];
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(init.headers["x-bounty-signature"]);
  assert.equal(createHmac("sha256", poster.webhook_secret).update(`${t}.${init.body}`).digest("hex"), v1);
  assert.equal(JSON.parse(init.body).type, "submission.received");
  // A webhook pointed at a private address is refused at delivery.
  const evil = await agent(db, "evil-dns", { notify_webhook: "https://rebind.example.com/in" });
  await adminNotice(db, evil.agent_id, { message: "hello" });
  r = await flushWebhooks(db, { fetcher, resolve: async () => ["10.0.0.5"], now: Date.now() + DAY });
  assert.equal(r.failed, 1);
});

test("key-less feed shows only that agent's events and can be rotated", async () => {
  const db = makeD1();
  const p = await registerAgent(db, "feed-agent");
  const pa = await authByKey(db, p.api_key);
  await adminNotice(db, p.agent_id, { message: "Your payout dispute was resolved.", subject: "Dispute" });
  const other = await reach(db, "other-agent");
  await adminNotice(db, other.agent_id, { message: "not for you" });
  const tok = p.inbox_feed_url.split("/").pop();
  const feed = await readInboxFeed(db, tok);
  assert.deepEqual(feed.events.map((e) => e.type), ["operator.notice"]);
  assert.equal(feed.events[0].data.message, "Your payout dispute was resolved.");
  const rot = await updateAgentProfile(db, pa, { inbox_feed: "rotate" });
  await assert.rejects(readInboxFeed(db, tok), (e) => e.status === 404);
  assert.equal((await readInboxFeed(db, rot.inbox_feed_url.split("/").pop())).events.length, 1);
  await updateAgentProfile(db, pa, { inbox_feed: null });
  await assert.rejects(readInboxFeed(db, rot.inbox_feed_url.split("/").pop()));
});

// ── review delegation ───────────────────────────────────────────────────────

test("delegation must be opted into, valid, and reachable", async () => {
  const db = makeD1();
  const poster = await reach(db, "dlg-poster");
  const quiet = await agent(db, "quiet-delegate");
  await assert.rejects(postBounty(db, poster.a, ENV, { ...BOUNTY, review_delegate: quiet.agent_id }), (e) => e.status === 409);
  await assert.rejects(postBounty(db, poster.a, ENV, { ...BOUNTY, review_delegate: "operator" }), (e) => e.status === 503);
  await assert.rejects(postBounty(db, poster.a, ENV, { ...BOUNTY, review_delegate: poster.agent_id }), /yourself/);
  await assert.rejects(postBounty(db, poster.a, ENV, { ...BOUNTY, review_fee_bp: 100 }), /only apply/);
  const d = await reach(db, "real-delegate");
  for (const bad of [{ review_after_hours: 23 }, { review_after_hours: 169 }, { review_fee_bp: 2001 }, { review_fee_bp: -1 }])
    await assert.rejects(postBounty(db, poster.a, ENV, { ...BOUNTY, review_delegate: d.agent_id, ...bad }));
  await assert.rejects(
    postBounty(db, poster.a, { ...ENV, PLATFORM_FEE_ADDRESS: "0x" + "1".repeat(40) }, { ...BOUNTY, settlement: "onchain", review_delegate: d.agent_id }),
    /stated-settlement/,
  );
  const ok = await postBounty(db, poster.a, { ...ENV, OPERATOR_AGENT_ID: d.agent_id }, { ...BOUNTY, review_delegate: "operator" });
  assert.equal(ok.review_terms.after_hours, 48);
});

test("delegate acts only after the window, sees only overdue work, and its fee is frozen", async () => {
  const db = makeD1();
  const poster = await reach(db, "absent-poster");
  const del = await reach(db, "the-delegate");
  const f1 = await reach(db, "early-filler"), f2 = await reach(db, "late-filler");
  const b = await postBounty(db, poster.a, ENV, { ...BOUNTY, reward_amount_cents: 10_000, review_delegate: del.agent_id, review_after_hours: 48, review_fee_bp: 1000 });
  assert.match(b.review_terms.summary, /48h/);
  await assert.rejects(submitToBounty(db, del.a, b.bounty_id, ...SUB), /review delegate/);
  const s1 = await submitToBounty(db, f1.a, b.bounty_id, ...SUB);

  // Inside the window: no access, no action.
  let view = await getBounty(db, b.bounty_id, del.a);
  assert.equal(view.your_role, "review_delegate");
  assert.equal(view.submissions.length, 0);
  await assert.rejects(reviewSubmission(db, del.a, b.bounty_id, s1.submission_id, "accept"), (e) => e.status === 403);
  // A random agent can never act.
  await assert.rejects(reviewSubmission(db, f2.a, b.bounty_id, s1.submission_id, "reject"), (e) => e.status === 403);

  // Window passes for s1 only; s2 arrives fresh.
  db.raw.prepare("UPDATE submissions SET pending_at = ? WHERE id = ?").run(ago(49 * HOUR), s1.submission_id);
  const s2 = await submitToBounty(db, f2.a, b.bounty_id, ...SUB);
  view = await getBounty(db, b.bounty_id, del.a);
  assert.deepEqual(view.submissions.map((s) => s.id), [s1.submission_id]);
  assert.equal(view.submissions[0].content, SUB[0], "overdue submission is readable in full");
  await assert.rejects(reviewSubmission(db, del.a, b.bounty_id, s2.submission_id, "reject"), (e) => e.status === 403);
  await assert.rejects(reviewSubmission(db, del.a, b.bounty_id, s1.submission_id, "accept", undefined, "inv-1"), /payment_ref/);

  const sweep = await sweepNotices(db);
  assert.equal(sweep.delegate_unlocked, 1);
  assert.ok((await inboxTypes(db, del.agent_id)).includes("review.available"));

  const award = await reviewSubmission(db, del.a, b.bounty_id, s1.submission_id, "accept", "meets criteria");
  assert.equal(award.as, "review delegate");
  assert.equal(award.review_fee, "$10.00");
  assert.equal(award.payouts[0].amount_cents, 10_000 - 50 - 1000);
  const row = db.raw.prepare("SELECT status, awarded_by, review_fee_cents, fee_cents FROM bounties WHERE id = ?").get(b.bounty_id);
  assert.deepEqual({ ...row }, { status: "awarded", awarded_by: del.agent_id, review_fee_cents: 1000, fee_cents: 50 });
  const kinds = db.raw.prepare("SELECT kind FROM events WHERE bounty_id = ? ORDER BY seq").all(b.bounty_id).map((r) => r.kind);
  assert.ok(kinds.includes("delegate_access") && kinds.includes("delegate_review"), "delegate actions are logged");
  const awarded = (await readInbox(db, poster.agent_id)).events.find((e) => e.type === "bounty.awarded");
  assert.equal(awarded.data.by_delegate, true);
  // The poster gets the deliverable as usual.
  const pv = await getBounty(db, b.bounty_id, poster.a);
  assert.equal(pv.submissions.find((s) => s.id === s1.submission_id).content, SUB[0]);
});

test("the poster can always act first, with no review fee", async () => {
  const db = makeD1();
  const poster = await reach(db, "present-poster");
  const del = await reach(db, "idle-delegate");
  const f = await reach(db, "any-filler");
  const b = await postBounty(db, poster.a, ENV, { ...BOUNTY, review_delegate: del.agent_id, review_fee_bp: 2000 });
  const s = await submitToBounty(db, f.a, b.bounty_id, ...SUB);
  db.raw.prepare("UPDATE submissions SET pending_at = ? WHERE id = ?").run(ago(100 * HOUR), s.submission_id);
  const r = await reviewSubmission(db, poster.a, b.bounty_id, s.submission_id, "accept");
  assert.equal(r.review_fee, undefined);
  assert.equal(r.payouts[0].amount_cents, 2500 - 12);
});

// ── stale rule ──────────────────────────────────────────────────────────────

test("stale rule: flag, notify once, withdraw; nothing revealed or awarded", async () => {
  const db = makeD1();
  const poster = await reach(db, "gone-poster");
  const f = await reach(db, "waiting-filler");
  const b = await postBounty(db, poster.a, ENV, BOUNTY);
  const s = await submitToBounty(db, f.a, b.bounty_id, ...SUB);
  assert.equal((await listBounties(db, {}))[0].poster_unresponsive, false);
  await assert.rejects(withdrawSubmission(db, f.a, s.submission_id), /withdrawal opens/);

  db.raw.prepare("UPDATE submissions SET pending_at = ?, created_at = ? WHERE id = ?").run(ago(8 * DAY), ago(8 * DAY), s.submission_id);
  assert.equal((await listBounties(db, {}))[0].poster_unresponsive, true);
  assert.equal((await getBounty(db, b.bounty_id, null)).bounty.poster_unresponsive, true);
  assert.match(await (await dashboard({ DB: db }, "https://bounty.test")).text(), /poster unresponsive/);

  assert.equal((await sweepNotices(db)).stale_bounties, 1);
  assert.equal((await sweepNotices(db)).stale_bounties, 0, "notified once");
  assert.ok((await inboxTypes(db, poster.agent_id)).includes("bounty.poster_unresponsive"));
  assert.ok((await inboxTypes(db, f.agent_id)).includes("submission.withdrawable"));

  const other = await reach(db, "not-the-author");
  await assert.rejects(withdrawSubmission(db, other.a, s.submission_id), (e) => e.status === 403);
  await withdrawSubmission(db, f.a, s.submission_id);
  await assert.rejects(reviewSubmission(db, poster.a, b.bounty_id, s.submission_id, "accept"), (e) => e.status === 409);
  const after = await getBounty(db, b.bounty_id, null);
  assert.equal(after.bounty.status, "open");
  assert.equal(after.bounty.poster_unresponsive, false);
  assert.equal(after.submissions, undefined);
});

test("a delegated bounty is not flagged stale", async () => {
  const db = makeD1();
  const poster = await reach(db, "deleg-poster");
  const del = await reach(db, "deleg-agent");
  const f = await reach(db, "deleg-filler");
  const b = await postBounty(db, poster.a, ENV, { ...BOUNTY, review_delegate: del.agent_id });
  const s = await submitToBounty(db, f.a, b.bounty_id, ...SUB);
  db.raw.prepare("UPDATE submissions SET pending_at = ? WHERE id = ?").run(ago(8 * DAY), s.submission_id);
  assert.equal((await getBounty(db, b.bounty_id, null)).bounty.poster_unresponsive, false);
});

// ── existing bounties and the cleanup migration ────────────────────────────

test("pre-existing bounties keep their rules; cleanup closes only the operator's test bounties", async () => {
  const db = makeD1();
  const now = new Date().toISOString();
  db.raw.exec(`INSERT INTO agents (id, name, key_hash, created_at) VALUES
    ('agt_0000000000000001','settle-poster','h1','${now}'), ('agt_0000000000000002','musedin','h2','${now}')`);
  const ins = db.raw.prepare(`INSERT INTO bounties (id, poster_id, title, description, category, reward_amount_cents, status, created_at)
    VALUES (?, ?, ?, 'd', 'other', 100, 'open', ?)`);
  ins.run("bty_5a2f67bee134d97d", "agt_0000000000000001", "[SETTLE TEST] onchain settlement — ignore", now);
  ins.run("bty_0f9535ec56e7caf2", "agt_0000000000000001", "[SECRET CHECK] stated still fine — ignore", now);
  ins.run("bty_ef397d1c9f96d84e", "agt_0000000000000001", "[SECRET CHECK 2] onchain via secret — ignore", now);
  ins.run("bty_aaaaaaaaaaaaaaaa", "agt_0000000000000002", "[SETTLE TEST] lookalike from someone else", now);
  ins.run("bty_5596ca235334ac82", "agt_0000000000000002", "Re-walk on-chain verification payments", now);
  db.rerun("0011_close_operator_test_bounties.sql");
  const st = Object.fromEntries(db.raw.prepare("SELECT id, status, review_delegate, review_fee_bp FROM bounties").all().map((r) => [r.id, r]));
  assert.equal(st.bty_5a2f67bee134d97d.status, "cancelled");
  assert.equal(st.bty_0f9535ec56e7caf2.status, "cancelled");
  assert.equal(st.bty_ef397d1c9f96d84e.status, "cancelled");
  assert.equal(st.bty_aaaaaaaaaaaaaaaa.status, "open", "same title, different id: untouched");
  assert.equal(st.bty_5596ca235334ac82.status, "open");
  assert.equal(st.bty_5596ca235334ac82.review_delegate, null, "no delegate unless opted in");
  assert.equal(st.bty_5596ca235334ac82.review_fee_bp, 0);
  assert.ok(!(await isReachable(db, "agt_0000000000000002")));
});
