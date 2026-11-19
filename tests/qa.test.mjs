// The free QA tasks are checked by the house: wrong answers are turned down with
// a reason, the first right one is awarded, and a fresh copy is always open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey, submitToBounty } from "../.test-build/core.js";
import { qaSweep, checkAnswer, QA_TASKS, QA_SHA_INPUT, QA_SHA_DIGEST, LLMS_FIRST_LINE } from "../.test-build/qa.js";

const ENV = { HUMAN_BOUNTIES: "off" };
const LINES = 140;
const PREVIEW = "My answer to the free QA task, checked by the house.";

async function setup() {
  const db = makeD1();
  const qa = await registerAgent(db, "brelsford-qa", {});
  const env = { ...ENV, QA_AGENT_ID: qa.agent_id };
  return { db, env, qa };
}
async function agent(db, name) {
  const r = await registerAgent(db, name, {});
  return { ...r, a: await authByKey(db, r.api_key) };
}
const openQa = (db, qaId) =>
  db.raw.prepare("SELECT id, title FROM bounties WHERE poster_id = ? AND status = 'open'").all(qaId);
const subStatus = (db, id) => db.raw.prepare("SELECT status, review_note FROM submissions WHERE id = ?").get(id);

test("the published digest is right", () => {
  assert.equal(createHash("sha256").update(QA_SHA_INPUT).digest("hex"), QA_SHA_DIGEST);
});

test("checkAnswer: hash, line count and description", () => {
  assert.ok(checkAnswer("sha", `Digest: ${QA_SHA_DIGEST}`, LINES).ok);
  assert.ok(checkAnswer("sha", QA_SHA_DIGEST.toUpperCase(), LINES).ok);
  assert.ok(!checkAnswer("sha", "0".repeat(64), LINES).ok);
  assert.ok(!checkAnswer("sha", `${QA_SHA_DIGEST} or ${"a".repeat(64)}`, LINES).ok, "no guessing several");

  const now = "2026-11-20T00:00:00.000Z";
  assert.ok(checkAnswer("lines", `Line count: 141 lines. First line: ${LLMS_FIRST_LINE}`, LINES, now).ok);
  assert.ok(checkAnswer("lines", `awk 'END{print NR}' llms.txt -> 140\n${LLMS_FIRST_LINE}`, LINES, now).ok);
  assert.ok(!checkAnswer("lines", `Line count: 119. ${LLMS_FIRST_LINE}`, LINES, now).ok, "too far off now");
  assert.ok(!checkAnswer("lines", "Line count: 140. # Bounty Arena", LINES, now).ok, "first line must be exact");
  // Sent before the house checked, while the file was smaller: still right then.
  assert.ok(checkAnswer("lines", `Line count: 119. ${LLMS_FIRST_LINE}`, LINES, "2026-11-10T00:31:35.572Z").ok);
  assert.ok(!checkAnswer("lines", `Line count: 12. ${LLMS_FIRST_LINE}`, LINES, "2026-11-10T00:31:35.572Z").ok);

  assert.ok(checkAnswer("describe", "A board where AI agents post and take bounties, play games and do science.", LINES).ok);
  assert.ok(!checkAnswer("describe", "A nice website.", LINES).ok);
  assert.ok(!checkAnswer("describe", "agent bounty " + "word ".repeat(40), LINES).ok, "40 words or more fails");
  assert.ok(checkAnswer("describe", "Agents take bounties here.\n\nWord count: 4. " + "note ".repeat(50), LINES).ok, "notes after a blank line don't count");
});

test("the sweep posts the three tasks when none are open, and only once", async () => {
  const { db, env, qa } = await setup();
  assert.deepEqual(await qaSweep(db, env, LINES), { accepted: 0, rejected: 0, reposted: 3 });
  assert.equal(openQa(db, qa.agent_id).length, 3);
  assert.deepEqual(await qaSweep(db, env, LINES), { accepted: 0, rejected: 0, reposted: 0 });
});

test("wrong answers are rejected with a reason, the first right one wins, and a fresh copy opens", async () => {
  const { db, env, qa } = await setup();
  await qaSweep(db, env, LINES);
  const sha = openQa(db, qa.agent_id).find((b) => b.title === QA_TASKS.sha.title);
  const wrong = await agent(db, "wrong-hash");
  const first = await agent(db, "first-right");
  const second = await agent(db, "second-right");
  const w = await submitToBounty(db, wrong.a, sha.id, "0".repeat(64), undefined, PREVIEW);
  const f = await submitToBounty(db, first.a, sha.id, `Digest: ${QA_SHA_DIGEST}`, undefined, PREVIEW);
  const s = await submitToBounty(db, second.a, sha.id, QA_SHA_DIGEST, undefined, PREVIEW);

  const r = await qaSweep(db, env, LINES);
  assert.equal(r.rejected, 1);
  assert.equal(r.accepted, 1);
  assert.equal(r.reposted, 1);
  assert.equal(subStatus(db, w.submission_id).status, "rejected");
  assert.match(subStatus(db, w.submission_id).review_note, /isn't the SHA-256/);
  assert.equal(subStatus(db, f.submission_id).status, "accepted");
  assert.equal(subStatus(db, s.submission_id).status, "closed");
  const old = db.raw.prepare("SELECT status FROM bounties WHERE id = ?").get(sha.id);
  assert.equal(old.status, "awarded");
  const fresh = openQa(db, qa.agent_id).filter((b) => b.title === QA_TASKS.sha.title);
  assert.equal(fresh.length, 1);
  assert.notEqual(fresh[0].id, sha.id);
});

test("bounties from anyone else are never touched", async () => {
  const { db, env } = await setup();
  const other = await agent(db, "someone-else");
  // Same title, different poster.
  const { postBounty } = await import("../.test-build/core.js");
  const b = await postBounty(db, other.a, env, { ...QA_TASKS.sha, category: "other", reward_amount_cents: 1 });
  const filler = await agent(db, "filler");
  const sub = await submitToBounty(db, filler.a, b.bounty_id, "0".repeat(64), undefined, PREVIEW);
  await qaSweep(db, env, LINES);
  assert.equal(subStatus(db, sub.submission_id).status, "pending");
});

test("unset QA_AGENT_ID does nothing", async () => {
  const db = makeD1();
  assert.deepEqual(await qaSweep(db, ENV, LINES), { accepted: 0, rejected: 0, reposted: 0 });
});
