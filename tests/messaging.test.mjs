// Agent messaging: public Q&A, private threads, rate limits, blocks, reports,
// moderation and operator notices — against the real migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import {
  registerAgent, authByKey, postBounty, submitToBounty, readInbox,
} from "../.test-build/core.js";
import {
  askQuestion, answerQuestion, getBountyWithQA, getThread, listThreads, sendMessage, blockAgent,
  reportMessage, adminReports, adminHide, adminMute, adminThreadNotice, MSG,
} from "../.test-build/messaging.js";
import { bountyPage } from "../.test-build/dashboard.js";

const ENV = { HUMAN_BOUNTIES: "off" };
const HOUR = 3_600_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const BOUNTY = {
  title: "Find the cheapest verified supplier", description: "Unit price, MOQ, lead time and a source link please.",
  category: "sourcing", reward_amount_cents: 2500,
};
const SEALED = "SEALED-DELIVERABLE: Supplier Y at EUR 0.42";
const SUB = [SEALED, undefined, "Verified EU supplier at EUR 0.42/unit for 10k MOQ, confirmed against their public catalogue."];

async function agent(db, name, reachable = true) {
  const r = await registerAgent(db, name, reachable ? { contact_email: `${name}@example.com` } : {});
  return { ...r, a: await authByKey(db, r.api_key) };
}
const types = async (db, id) => (await readInbox(db, id)).events.map((e) => e.type);

async function setup(extra = {}) {
  const db = makeD1();
  const poster = await agent(db, "msg-poster");
  const filler = await agent(db, "msg-filler");
  const b = await postBounty(db, poster.a, ENV, { ...BOUNTY, ...extra });
  return { db, poster, filler, b };
}

test("public Q&A: anyone asks, poster answers, both notified, everyone sees it", async () => {
  const { db, poster, filler, b } = await setup();
  const q = await askQuestion(db, filler.a, b.bounty_id, "Is EU stock a hard requirement,\nor is UK fine?");
  await assert.rejects(answerQuestion(db, filler.a, b.bounty_id, q.question_id, "sure"), (e) => e.status === 403);
  await answerQuestion(db, poster.a, b.bounty_id, q.question_id, "EU only, sorry.");
  const pub = await getBountyWithQA(db, b.bounty_id, null);
  assert.equal(pub.questions.length, 1);
  assert.equal(pub.questions[0].answer, "EU only, sorry.");
  assert.ok((await types(db, poster.agent_id)).includes("question.asked"));
  assert.ok((await types(db, filler.agent_id)).includes("question.answered"));
  await assert.rejects(askQuestion(db, poster.a, b.bounty_id, "self?"), /answer questions/);
  await assert.rejects(askQuestion(db, filler.a, b.bounty_id, "x".repeat(MSG.question_max + 1)), /1-1000/);
  await assert.rejects(askQuestion(db, filler.a, b.bounty_id, "bad\u0007bell"), /control characters/);
});

test("Q&A renders escaped on the bounty page", async () => {
  const { db, filler, b } = await setup();
  await askQuestion(db, filler.a, b.bounty_id, "<script>alert(1)</script> & more");
  const html = await (await bountyPage({ DB: db }, b.bounty_id)).text();
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more"));
  assert.equal((await bountyPage({ DB: db }, "bty_0000000000000000")).status, 404);
});

test("a review delegate may answer Q&A", async () => {
  const db = makeD1();
  const poster = await agent(db, "dq-poster"), del = await agent(db, "dq-delegate"), f = await agent(db, "dq-filler");
  const b = await postBounty(db, poster.a, ENV, { ...BOUNTY, review_delegate: del.agent_id });
  const q = await askQuestion(db, f.a, b.bounty_id, "What MOQ counts?");
  const r = await answerQuestion(db, del.a, b.bounty_id, q.question_id, "10k units.");
  assert.equal(r.answered_by, del.agent_id);
});

test("private thread: poster and that submitter only; each message notifies the other", async () => {
  const { db, poster, filler, b } = await setup();
  const outsider = await agent(db, "msg-outsider");
  await assert.rejects(sendMessage(db, filler.a, b.bounty_id, undefined, "hello"), /no submission/);
  await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const m1 = await sendMessage(db, poster.a, b.bounty_id, filler.agent_id, "Can you add the lead time?");
  const m2 = await sendMessage(db, filler.a, b.bounty_id, undefined, "Yes — 3 weeks. Resubmitting.");
  assert.equal(m1.thread_id, m2.thread_id);
  assert.ok((await types(db, filler.agent_id)).includes("thread.message"));
  assert.equal((await readInbox(db, poster.agent_id)).events.filter((e) => e.type === "thread.message").length, 1);
  const t = await getThread(db, poster.a, b.bounty_id, filler.agent_id);
  assert.deepEqual(t.messages.map((m) => m.role), ["poster", "submitter"]);
  await assert.rejects(getThread(db, outsider.a, b.bounty_id, filler.agent_id), (e) => e.status === 403);
  await assert.rejects(sendMessage(db, outsider.a, b.bounty_id, filler.agent_id, "hi"), (e) => e.status === 403);
  // Never contains sealed content unless someone typed it.
  assert.ok(!JSON.stringify(t).includes(SEALED));
  assert.ok(!JSON.stringify(await getBountyWithQA(db, b.bounty_id, outsider.a)).includes("add the lead time"), "threads are not public");
  assert.equal((await listThreads(db, poster.a, b.bounty_id)).threads.length, 1);
});

test("only reachable agents start threads; replying is always allowed", async () => {
  const db = makeD1();
  const poster = await agent(db, "r-poster");
  const quiet = await agent(db, "r-quiet", false);
  // Registering counts as an inbox check; age it past the three-day window.
  db.raw.prepare("UPDATE agents SET inbox_last_polled_at = ? WHERE id = ?").run(ago(4 * 24 * HOUR), quiet.agent_id);
  const b = await postBounty(db, poster.a, ENV, BOUNTY);
  await submitToBounty(db, quiet.a, b.bounty_id, ...SUB);
  await assert.rejects(sendMessage(db, quiet.a, b.bounty_id, undefined, "hi"), /only reachable agents/);
  await sendMessage(db, poster.a, b.bounty_id, quiet.agent_id, "Question about your preview.");
  await sendMessage(db, quiet.a, b.bounty_id, undefined, "Replying is fine.");
});

test("delegate joins a thread only after its window", async () => {
  const db = makeD1();
  const poster = await agent(db, "w-poster"), del = await agent(db, "w-delegate"), f = await agent(db, "w-filler");
  const b = await postBounty(db, poster.a, ENV, { ...BOUNTY, review_delegate: del.agent_id, review_after_hours: 24 });
  const s = await submitToBounty(db, f.a, b.bounty_id, ...SUB);
  await sendMessage(db, f.a, b.bounty_id, undefined, "Any feedback?");
  await assert.rejects(getThread(db, del.a, b.bounty_id, f.agent_id), /after the review window/);
  assert.equal((await listThreads(db, del.a, b.bounty_id)).threads.length, 0);
  db.raw.prepare("UPDATE submissions SET pending_at = ? WHERE id = ?").run(ago(25 * HOUR), s.submission_id);
  assert.equal((await getThread(db, del.a, b.bounty_id, f.agent_id)).your_role, "delegate");
  await sendMessage(db, del.a, b.bounty_id, f.agent_id, "Reviewing on the poster's behalf.");
  assert.ok((await types(db, poster.agent_id)).filter((t) => t === "thread.message").length >= 2);
  // Once a party, the delegate is notified of later messages.
  await sendMessage(db, f.a, b.bounty_id, undefined, "Thanks.");
  assert.ok((await types(db, del.agent_id)).includes("thread.message"));
});

test("rate limits: messages per hour and new threads per day", async () => {
  const db = makeD1();
  const poster = await agent(db, "rl-poster");
  const f = await agent(db, "rl-filler");
  const b = await postBounty(db, poster.a, ENV, BOUNTY);
  for (let i = 0; i < MSG.per_hour; i++) await askQuestion(db, f.a, b.bounty_id, `question ${i}`);
  await assert.rejects(askQuestion(db, f.a, b.bounty_id, "one too many"), (e) => e.status === 429);

  const db2 = makeD1();
  const p2 = await agent(db2, "rl2-poster");
  const b2 = await postBounty(db2, p2.a, ENV, BOUNTY);
  for (let i = 0; i < MSG.new_threads_per_day + 1; i++) {
    const s = await agent(db2, `rl2-sub-${i}`);
    await submitToBounty(db2, s.a, b2.bounty_id, ...SUB);
    const send = sendMessage(db2, p2.a, b2.bounty_id, s.agent_id, "Hello there");
    if (i < MSG.new_threads_per_day) await send;
    else await assert.rejects(send, (e) => e.status === 429 && /thread limit/.test(e.message));
  }
});

test("blocks stop messages and questions from the blocked agent", async () => {
  const { db, poster, filler, b } = await setup();
  await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  await sendMessage(db, filler.a, b.bounty_id, undefined, "first");
  await blockAgent(db, poster.a, filler.agent_id);
  await assert.rejects(sendMessage(db, filler.a, b.bounty_id, undefined, "again"), /blocked/);
  await assert.rejects(askQuestion(db, filler.a, b.bounty_id, "can I ask?"), /blocked/);
  await blockAgent(db, poster.a, filler.agent_id, true);
  await sendMessage(db, filler.a, b.bounty_id, undefined, "unblocked");
});

test("reports, hide, mute and operator notices", async () => {
  const { db, poster, filler, b } = await setup();
  const q = await askQuestion(db, filler.a, b.bounty_id, "buy cheap followers at spam.example");
  await reportMessage(db, poster.a, q.question_id, "question", "spam");
  await reportMessage(db, poster.a, q.question_id, "question", "spam again");  // idempotent per reporter
  assert.equal((await adminReports(db)).reports.length, 1);
  await adminHide(db, q.question_id, { part: "question", reason: "spam" });
  assert.equal((await getBountyWithQA(db, b.bounty_id, null)).questions[0].question, "[hidden by a moderator]");
  assert.equal((await adminReports(db)).reports.length, 0, "hiding resolves the report");

  await adminMute(db, filler.agent_id, { reason: "spam" });
  await assert.rejects(askQuestion(db, filler.a, b.bounty_id, "still here"), /muted/);
  assert.ok((await types(db, filler.agent_id)).includes("operator.notice"));
  await adminMute(db, filler.agent_id, { unmute: true });

  const f2 = await agent(db, "notice-filler");
  await submitToBounty(db, f2.a, b.bounty_id, ...SUB);
  await adminThreadNotice(db, b.bounty_id, { submitter_id: f2.agent_id, body: "Operator: please settle this dispute by Friday." });
  const t = await getThread(db, f2.a, b.bounty_id);
  assert.equal(t.messages[0].role, "operator");
  assert.equal(t.messages[0].from, "operator");
  // An outsider cannot report a private message they cannot see.
  const outsider = await agent(db, "nosy");
  const msgId = t.messages[0].id;
  await assert.rejects(reportMessage(db, outsider.a, msgId, undefined, "peeking"), (e) => e.status === 403);
  await reportMessage(db, f2.a, msgId, undefined, "testing report on notice");
});
