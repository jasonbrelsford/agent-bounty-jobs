// Live activity panel: the public feed leaks nothing private, replayed lines are
// always labelled, request counts are aggregate-only, and the feed is rate-limited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey, postBounty, submitToBounty, reviewSubmission } from "../.test-build/core.js";
import { askQuestion, answerQuestion, sendMessage, adminHide } from "../.test-build/messaging.js";
import {
  publicEvents, replayPool, feedResponse, WindowLimiter, FEED_LIMIT_PER_MIN, RequestCounter,
  requestAggregates, routeLabel, mcpLabels, minuteOf, SETTLE_MS,
} from "../.test-build/livefeed.js";
import { LIVE_CORE_JS, LIVE_BOOT_JS, MODE_TEXT } from "../.test-build/liveclient.js";
import { dashboard } from "../.test-build/dashboard.js";

const ENV = { HUMAN_BOUNTIES: "off" };
const PREVIEW = "PREVIEW-SECRET-7f3a: verified EU supplier at EUR 0.42/unit for 10k MOQ, confirmed.";
const SEALED = "SEALED-SECRET-91bc: Supplier Y, EUR 0.42, catalogue https://example.com/x";
const THREAD = "THREAD-SECRET-55aa: please resend with the invoice";
const EMAIL = "secret-contact-3c1d@example.com";
const HIDDEN_Q = "HIDDEN-QUESTION-0e0e is this allowed?";

async function agent(db, name, extra = {}) {
  const r = await registerAgent(db, name, extra);
  return { ...r, a: await authByKey(db, r.api_key) };
}

async function busyBoard() {
  const db = makeD1();
  const poster = await agent(db, "lf-poster", { contact_email: EMAIL });
  const filler = await agent(db, "lf-filler", { contact_email: "f@example.com" });
  const b = await postBounty(db, poster.a, ENV, {
    title: "Find the cheapest verified supplier", description: "Unit price, MOQ, lead time and a source link please.",
    category: "sourcing", reward_amount_cents: 2500,
  });
  const q = await askQuestion(db, filler.a, b.bounty_id, "Is UK stock acceptable?");
  await answerQuestion(db, poster.a, b.bounty_id, q.question_id, "EU only, sorry.");
  const hq = await askQuestion(db, filler.a, b.bounty_id, HIDDEN_Q);
  await adminHide(db, hq.question_id, { part: "question", reason: "test" });
  const s = await submitToBounty(db, filler.a, b.bounty_id, SEALED, undefined, PREVIEW);
  await sendMessage(db, poster.a, b.bounty_id, filler.agent_id, THREAD);
  await sendMessage(db, filler.a, b.bounty_id, undefined, THREAD + " (reply)");
  // A human signup: their display name comes from OAuth and must stay off the feed.
  const at = new Date().toISOString();
  db.raw.prepare("INSERT INTO agents (id, name, key_hash, kind, created_at) VALUES ('agt_human0000000001', 'Jane Q Realname', 'x', 'human', ?)").run(at);
  db.raw.prepare("INSERT INTO events (at, kind, bounty_id, agent_id, detail) VALUES (?, 'agent_registered', NULL, 'agt_human0000000001', 'Jane Q Realname joined as a human via github')").run(at);
  db.raw.prepare("INSERT INTO events (at, kind, bounty_id, agent_id, detail) VALUES (?, 'payout_address_set', NULL, ?, 'an agent set a payout address')").run(at, filler.agent_id);
  await reviewSubmission(db, poster.a, b.bounty_id, s.submission_id, "accept", "great", "ref-1", false);
  return { db, poster, filler, b, q };
}

const req = (ip = "203.0.113.9") => new Request("https://x/v1/events", { headers: { "cf-connecting-ip": ip } });

test("public feed: real events and public Q&A text, never sealed or private data", async () => {
  const { db, poster, filler, b } = await busyBoard();
  const res = await feedResponse({ DB: db }, req(), new URL("https://x/v1/events?replay=1"), new WindowLimiter());
  assert.equal(res.status, 200);
  const raw = await res.text();
  const body = JSON.parse(raw);
  const kinds = body.events.map((e) => e.kind);
  for (const k of ["agent_registered", "bounty_posted", "question_asked", "question_answered", "submission_received", "bounty_awarded"])
    assert.ok(kinds.includes(k), `missing ${k}`);
  // Public Q&A text is there…
  assert.ok(body.events.some((e) => e.kind === "question_asked" && e.question === "Is UK stock acceptable?"));
  assert.ok(body.events.some((e) => e.kind === "question_answered" && e.answer === "EU only, sorry."));
  // …but nothing sealed, private, hidden, or identifying.
  for (const secret of [PREVIEW, "PREVIEW-SECRET", SEALED, "SEALED-SECRET", THREAD, "THREAD-SECRET", EMAIL, HIDDEN_Q,
    "Jane Q Realname", poster.api_key, filler.api_key, "203.0.113.9", "payout address", "great", "ref-1"])
    assert.ok(!raw.includes(secret), `feed leaked: ${secret}`);
  assert.ok(!kinds.includes("thread_started") && !kinds.includes("payout_address_set") && !kinds.includes("message_hidden"));
  assert.ok(body.events.some((e) => e.text === "a human signed up"));
  // No raw identifiers beyond what the board shows publicly.
  for (const e of body.events) assert.deepEqual(Object.keys(e).filter((k) => !["seq", "at", "kind", "label", "text", "bounty_id", "question", "answer"].includes(k)), []);
  assert.ok(Array.isArray(body.replay) && body.replay.length > 0);
  assert.ok(!JSON.stringify(body.replay).includes("SECRET"));
  assert.equal(res.headers.get("cache-control"), "no-store");

  // Incremental: nothing new after the cursor; a new event appears.
  assert.equal((await publicEvents(db, body.next_since)).length, 0);
  await askQuestion(db, filler.a, (await postBounty(db, poster.a, ENV, {
    title: "Second bounty here", description: "Another description that is long enough.", category: "research", reward_amount_cents: 50,
  })).bounty_id, "New question?");
  const more = await publicEvents(db, body.next_since);
  assert.deepEqual(more.map((e) => e.kind), ["bounty_posted", "question_asked"]);
  void b;
});

test("public feed: events of a policy-removed bounty disappear", async () => {
  const { db, b } = await busyBoard();
  db.raw.prepare("UPDATE bounties SET status = 'removed' WHERE id = ?").run(b.bounty_id);
  const evs = await publicEvents(db, null, 100);
  assert.ok(evs.every((e) => e.bounty_id !== b.bounty_id));
});

test("replay pool favours awards and Q&A and only contains real logged events", async () => {
  const { db } = await busyBoard();
  const pool = await replayPool(db, 3);
  assert.equal(pool.length, 3);
  const kinds = pool.map((e) => e.kind);
  assert.ok(kinds.includes("bounty_awarded") && kinds.includes("question_answered"));
  const all = (await publicEvents(db, null, 100)).map((e) => e.seq);
  for (const e of pool) assert.ok(all.includes(e.seq));
});

test("rate limit: 429 with retry-after past the per-minute limit, per client, resets next window", async () => {
  const db = makeD1();
  const lim = new WindowLimiter();
  const url = new URL("https://x/v1/events");
  const t0 = Date.now();
  for (let i = 0; i < FEED_LIMIT_PER_MIN; i++)
    assert.equal((await feedResponse({ DB: db }, req("198.51.100.1"), url, lim, t0)).status, 200);
  const blocked = await feedResponse({ DB: db }, req("198.51.100.1"), url, lim, t0 + 1000);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "30");
  assert.ok(!(await blocked.text()).includes("198.51.100.1"));
  assert.equal((await feedResponse({ DB: db }, req("198.51.100.2"), url, lim, t0 + 1000)).status, 200);
  assert.equal((await feedResponse({ DB: db }, req("198.51.100.1"), url, lim, t0 + 61_000)).status, 200);
  // The shared binding is honoured too.
  const env = { DB: db, FEED_LIMITER: { limit: async () => ({ success: false }) } };
  assert.equal((await feedResponse(env, req("198.51.100.3"), url, new WindowLimiter())).status, 429);
});

test("request activity: route templates only, settled minutes summed across isolates", async () => {
  assert.equal(routeLabel("GET", "/v1/bounties/bty_0123456789abcdef"), "GET /v1/bounties/:id");
  assert.equal(routeLabel("POST", "/v1/bounties/bty_0123456789abcdef/award"), "POST /v1/bounties/:id/award");
  assert.equal(routeLabel("GET", "/v1/inbox/secret-feed-token"), "GET /v1/inbox/:feed");
  assert.equal(routeLabel("GET", "/v1/events"), null);   // the panel's own polling
  assert.equal(routeLabel("GET", "/"), null);
  assert.equal(routeLabel("GET", "/v1/whatever/<script>"), null);
  assert.deepEqual(mcpLabels({ method: "tools/call", params: { name: "list_bounties" } }), ["MCP list_bounties"]);
  assert.deepEqual(mcpLabels({ method: "tools/call", params: { name: "<img src=x> evil" } }), ["MCP tools/call"]);
  assert.deepEqual(mcpLabels([{ method: "initialize" }, { method: "x/secret" }]), ["MCP initialize"]);

  const db = makeD1();
  const now = Date.now();
  const past = now - SETTLE_MS - 60_000;
  const a = new RequestCounter(), b = new RequestCounter();
  a.count("GET /v1/bounties", past); a.count("GET /v1/bounties", past); b.count("GET /v1/bounties", past);
  b.count("MCP list_bounties", past);
  a.count("GET /v1/bounties", now);   // current minute: not settled yet
  await a.flush(db); await b.flush(db);
  const aggs = await requestAggregates(db, null, now);
  assert.deepEqual(aggs, [
    { minute: minuteOf(past), label: "GET /v1/bounties", n: 3 },
    { minute: minuteOf(past), label: "MCP list_bounties", n: 1 },
  ]);
  assert.deepEqual(await requestAggregates(db, minuteOf(past), now), []);
  const stored = db.raw.prepare("SELECT counts FROM request_minutes").all().map((r) => r.counts).join(" ");
  assert.ok(!/\d+\.\d+\.\d+\.\d+|Bearer|bk_/.test(stored));
});

// ── client: replay labelling ────────────────────────────────────────────────

const Core = new Function(`return ${LIVE_CORE_JS};`)();
function fakeView() {
  const v = { lines: [], modes: [] };
  v.append = (l) => v.lines.push(l);
  v.setMode = (m, text) => v.modes.push({ m, text });
  v.header = () => v.modes.at(-1)?.text;
  return v;
}
const ev = (seq, at, kind = "bounty_posted", extra = {}) => ({ seq, at: new Date(at).toISOString(), kind, label: kind, text: `event ${seq}`, bounty_id: null, ...extra });
const MIN = 60_000;

test("replay: after 10 idle minutes every replayed line says REPLAY and the header says so; a real event interrupts as LIVE", () => {
  const v = fakeView();
  const c = Core.Controller(v, {});
  const t0 = Date.UTC(2026, 10, 2, 12, 0, 0);
  c.setPool([ev(1, t0 - 60 * MIN, "bounty_awarded"), ev(2, t0 - 50 * MIN, "question_answered", { question: "Q?", answer: "A." })]);
  c.backlog([ev(3, t0 - MIN)], [], t0);
  assert.equal(v.lines[0].tag, "LOG");
  assert.equal(c.mode(), "live");
  assert.equal(v.header(), "Live activity");

  for (let t = t0; t < t0 + 9 * MIN - 1; t += 1000) c.tick(t);
  assert.equal(c.mode(), "live");
  assert.equal(v.lines.length, 1, "no replay before the idle threshold");

  for (let t = t0 + 9 * MIN; t <= t0 + 10 * MIN; t += 1000) c.tick(t);
  assert.equal(c.mode(), "replay");
  assert.equal(v.header(), "Replay · no live activity right now");
  assert.equal(v.header(), MODE_TEXT.replay);
  for (let t = t0 + 10 * MIN; t <= t0 + 11 * MIN; t += 1000) c.tick(t);
  const replayed = v.lines.slice(1);
  assert.ok(replayed.length >= 10);
  assert.ok(replayed.every((l) => l.tag === "REPLAY"), "every replayed line is labelled REPLAY");
  // Replayed lines keep their ORIGINAL timestamps, not now.
  assert.ok(replayed.some((l) => l.time === "11:00:00Z"));
  assert.ok(replayed.some((l) => l.extra.join(" ").includes("A › A.")));

  const before = v.lines.length;
  c.live([ev(9, t0 + 11 * MIN)], [], t0 + 11 * MIN);
  assert.equal(c.mode(), "live");
  assert.equal(v.header(), "Live activity");
  assert.equal(v.lines.at(-1).tag, "LIVE");
  assert.equal(v.lines.at(-1).text, "event 9");
  for (let t = t0 + 11 * MIN; t < t0 + 15 * MIN; t += 1000) c.tick(t);
  assert.equal(v.lines.length, before + 1, "replay stops once something real happens");
});

test("replay: page opened after a quiet spell starts in replay; nothing to replay means quiet, never invented lines", () => {
  const t0 = Date.UTC(2026, 10, 2, 12, 0, 0);
  const v = fakeView();
  const c = Core.Controller(v, {});
  c.setPool([ev(1, t0 - 3 * 3_600_000)]);
  c.backlog([ev(1, t0 - 3 * 3_600_000)], [], t0);
  assert.equal(c.mode(), "replay");
  c.tick(t0 + 1000);
  assert.equal(v.lines.at(-1).tag, "REPLAY");

  const v2 = fakeView();
  const c2 = Core.Controller(v2, {});
  c2.backlog([], [], t0);
  for (let t = t0; t < t0 + 20 * MIN; t += 1000) c2.tick(t);
  assert.equal(c2.mode(), "quiet");
  assert.equal(v2.lines.length, 0);
  // Request aggregates are real activity: shown LIVE, never labelled otherwise.
  c2.live([], [{ minute: "2026-11-02T12:19", label: "GET /v1/bounties", n: 3 }], t0 + 20 * MIN);
  assert.equal(c2.mode(), "live");
  assert.equal(v2.lines.at(-1).tag, "LIVE");
  assert.equal(v2.lines.at(-1).text, "GET /v1/bounties · 3 req/min");
});

test("dashboard: panel present with honest legend, escaped script, no innerHTML", async () => {
  const { db } = await busyBoard();
  const html = await (await dashboard({ DB: db }, "https://x")).text();
  assert.ok(html.includes('id="live"') && html.includes('role="log"') && html.includes('aria-live="polite"'));
  // Narrow screens: panel comes straight after the tiles in source order.
  const iTiles = html.indexOf('class="a-tiles"'), iLive = html.indexOf('class="a-live"'), iRest = html.indexOf('class="a-rest"');
  assert.ok(iTiles < iLive && iLive < iRest);
  assert.ok(html.includes("prefers-reduced-motion"));
  assert.ok(!LIVE_BOOT_JS.includes("innerHTML"));
  assert.ok(!html.includes('http-equiv="refresh" content="120">\n<title>') || html.includes("<noscript><meta"));
  // The inline script is syntactically valid.
  assert.doesNotThrow(() => new Function(LIVE_BOOT_JS));
});
