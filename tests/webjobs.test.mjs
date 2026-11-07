// People posting jobs from the website: the free-job rule, the abuse guards,
// and the pick-an-answer loop, against the real migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import {
  registerAgent, authByKey, postBounty, submitToBounty, getBounty, rewardLabel,
} from "../.test-build/core.js";
import {
  webPostProblem, postJobFromWeb, myJobs, postFormPage, handlePost, myJobPage, handleReview, postSignedOutPage, WEB_JOBS,
} from "../.test-build/webjobs.js";
import { formToken } from "../.test-build/auth.js";

const ENV = { HUMAN_BOUNTIES: "off" };
async function who(db, name) {
  const r = await registerAgent(db, name);
  return authByKey(db, r.api_key);
}
const JOB = {
  title: "Find three recycled mailer suppliers",
  description: "US suppliers of recycled cardboard mailers, with price per unit and minimum order.",
  category: "sourcing", criteria: "A list with price, minimum order and a link for each", days: "7",
};
const ANSWER = ["Full list: Supplier A $0.31/unit MOQ 500 https://a.example ...", undefined,
  "Three US suppliers found, prices from $0.28 to $0.35 per unit, minimums 250 to 1000."];

test("webPostProblem lets ordinary jobs through", () => {
  for (const ok of [
    "Compare prices for 10,000 units across 2024-2025",
    "Summarise https://example.com/a and https://example.com/b",
    "Find the cheapest flight data source, call volume 1,000,000 per day",
  ]) assert.equal(webPostProblem(ok), null, ok);
});

test("webPostProblem stops links spam, contact details and bot-check jobs", () => {
  assert.match(webPostProblem("a http://1.x b http://2.x c http://3.x d www.4.x"), /links/);
  assert.match(webPostProblem("email me at jo@example.com"), /email/);
  assert.match(webPostProblem("call 612-555-0199 or +1 (612) 555 0199"), /phone/);
  assert.match(webPostProblem("Solve CAPTCHAs for our signup flow"), /bot checks/);
});

test("a web job is free; the API still refuses a zero reward", async () => {
  const db = makeD1();
  const me = await who(db, "Jason");
  const r = await postJobFromWeb(db, me, ENV, JOB);
  assert.equal(r.reward, "$0.00");
  const { bounty } = await getBounty(db, r.bounty_id, null);
  assert.equal(bounty.reward_amount_cents, 0);
  assert.equal(bounty.status, "open");
  assert.ok(bounty.deadline);
  assert.equal(rewardLabel(0, "USD"), "Free");
  assert.equal(rewardLabel(250, "USD"), "$2.50 stated");
  await assert.rejects(
    postBounty(db, me, ENV, { title: JOB.title, description: JOB.description, category: "data", reward_amount_cents: 0 }),
    /reward_amount_cents/,
  );
  await assert.rejects(
    postBounty(db, me, ENV, { title: JOB.title, description: JOB.description, category: "data", settlement: "onchain" }, { free: true }),
    /free job/,
  );
});

test("a person can post a few jobs a day, not more", async () => {
  const db = makeD1();
  const me = await who(db, "Busy person");
  for (let i = 0; i < WEB_JOBS.per_day; i++) await postJobFromWeb(db, me, ENV, { ...JOB, title: `${JOB.title} ${i}` });
  await assert.rejects(postJobFromWeb(db, me, ENV, JOB), (e) => e.status === 429);
  // A day later the window has moved on.
  const r = await postJobFromWeb(db, me, ENV, JOB, Date.now() + 25 * 3_600_000);
  assert.ok(r.bounty_id);
});

test("bad input comes back as a message, not a crash", async () => {
  const db = makeD1();
  const me = await who(db, "Typo person");
  await assert.rejects(postJobFromWeb(db, me, ENV, { ...JOB, days: "999" }), (e) => e.status === 400);
  await assert.rejects(postJobFromWeb(db, me, ENV, { ...JOB, category: "nope" }), /category/);
  await assert.rejects(postJobFromWeb(db, me, ENV, { ...JOB, title: "short" }), /title/);
});

test("posting, an agent answering and the person picking it, through the pages", async () => {
  const db = makeD1();
  const env = { ...ENV, DB: db, SESSION_SECRET: "test-secret" };
  const me = await who(db, "Poster person");
  const filler = await who(db, "Helpful agent");

  // Signed out page offers sign-in only when a provider is set.
  assert.match(await postSignedOutPage({ ...env, GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" }).text(), /Post a job for AI agents/);

  const form = await postFormPage(env, me);
  assert.match(await form.text(), /name="t" value="[A-Za-z0-9_-]+"/);

  const fd = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  const req = (o) => new Request("https://bounty.test/post", { method: "POST", body: fd(o) });

  // Stale or missing form token is refused and the form comes back filled in.
  const bad = await handlePost(env, me, req({ ...JOB, t: "nope" }));
  assert.equal(bad.status, 403);
  assert.match(await bad.text(), /Find three recycled mailer suppliers/);

  const t = await formToken(env, me.id);
  const ok = await handlePost(env, me, req({ ...JOB, t }));
  assert.equal(ok.status, 303);
  const id = ok.headers.get("location").match(/bty_[0-9a-f]{16}/)[0];
  assert.equal((await myJobs(db, me)).length, 1);

  const sub = await submitToBounty(db, filler, id, ...ANSWER);
  let html = await (await myJobPage(env, me, id)).text();
  assert.match(html, /Pick this answer/);
  assert.match(html, /Three US suppliers found/);          // the preview
  assert.doesNotMatch(html, /Supplier A \$0\.31/);          // the full answer stays sealed

  // Someone else's job sends them to its public page.
  const stranger = await who(db, "Someone else");
  assert.equal((await myJobPage(env, stranger, id)).status, 302);

  const rv = new Request(`https://bounty.test/my-jobs/${id}/review`, {
    method: "POST", body: fd({ t, submission_id: sub.submission_id, decision: "accept" }),
  });
  html = await (await handleReview(env, me, id, rv)).text();
  assert.match(html, /Picked/);
  assert.match(html, /Supplier A \$0\.31/);                 // opened in full once picked
  const { bounty } = await getBounty(db, id, null);
  assert.equal(bounty.status, "awarded");
});
