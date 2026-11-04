// Planet-hunting job queue: exact star batches, deadlines and reissue, two
// independent agents per batch (a third on disagreement), spot checks, benching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1, QUEUE_MIGRATIONS } from "./d1shim.mjs";
import { registerAgent, authByKey } from "../.test-build/core.js";
import {
  agrees, consensus, spotPass, fileUrl, claim, report, giveBack, myQueue, queueInfo, queueFinds, reviewFind, unbench, PQ,
} from "../.test-build/queues/planet-queue.js";

const TEMPLATE = "tess2025099153000-s0091-{tic16}-0288-s_lc.fits";
const SPOT = { tic: 900, period: 3.0, t0: 3776.0, dur: 2.4 };
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));
const notKnown = async () => ({ known: null });

function setup(batches = 3) {
  const main = makeD1();
  const q = makeD1(QUEUE_MIGRATIONS);
  q.raw.exec(`INSERT INTO pq_rounds (id, sector, file_template, created_at) VALUES ('Q1', 91, '${TEMPLATE}', '2026-11-04')`);
  q.raw.exec(`INSERT INTO pq_spot_answers VALUES (${SPOT.tic}, 91, ${SPOT.period}, ${SPOT.t0}, 5000, ${SPOT.dur}, 40)`);
  for (let i = 1; i <= batches; i++) {
    const stars = [i * 10 + 1, i * 10 + 2, i * 10 + 3];
    const spot = i === 1 ? SPOT.tic : null;
    if (spot) stars.splice(1, 0, spot);
    q.raw.exec(`INSERT INTO pq_batches (id, round, sector, seq, stars_json, spot_tic) VALUES ('pqb_q1_0000${i}', 'Q1', 91, ${i}, '${JSON.stringify(stars)}', ${spot ?? "NULL"})`);
  }
  return { main, q };
}
const agent = async (db, name) => authByKey(db, (await registerAgent(db, `hunter-${name}`, { contact_email: `${name}@example.com` })).api_key);

/** Answers for a job: 'none' everywhere, the spot star caught, plus overrides by TIC. */
function answers(job, over = {}, catchSpot = true) {
  return job.stars.map(({ tic_id }) =>
    over[tic_id] ?? (tic_id === SPOT.tic && catchSpot
      ? { tic_id, verdict: "signal", period_days: SPOT.period, t0_btjd: SPOT.t0 + 3 * SPOT.period + 0.01, depth_ppm: 5200 }
      : { tic_id, verdict: "none" }));
}
const SIG = (tic, p = 4.2) => ({ tic_id: tic, verdict: "signal", period_days: p, t0_btjd: 3775.5, depth_ppm: 900, duration_hours: 2 });

test("agreement, consensus and spot checks (pure)", () => {
  assert.ok(agrees({ verdict: "none" }, { verdict: "none" }));
  assert.ok(!agrees({ verdict: "none" }, { verdict: "no_data" }));
  assert.ok(agrees(SIG(1, 4.2), { ...SIG(1, 4.21), t0_btjd: 3775.5 + 4.21 * 5 + 0.02 }), "close periods and a later transit lines up");
  assert.ok(agrees({ ...SIG(1, 4.21), t0_btjd: 3775.5 + 4.21 * 5 }, SIG(1, 4.2)), "either order");
  assert.ok(!agrees(SIG(1, 4.2), SIG(1, 4.4)), "5% apart is not the same signal");
  assert.ok(!agrees(SIG(1, 4.2), SIG(1, 8.4)), "a double period is a disagreement: ask a third agent");
  assert.ok(!agrees(SIG(1, 4.2), { ...SIG(1, 4.2), t0_btjd: 3776.9 }), "same period, wrong timing");
  assert.equal(consensus([{ verdict: "none" }, { verdict: "none" }]).outcome, "none");
  assert.equal(consensus([{ verdict: "none" }, SIG(1)]).outcome, "open");
  assert.equal(consensus([{ verdict: "none" }, SIG(1), SIG(1)]).outcome, "signal");
  assert.equal(consensus([{ verdict: "none" }, SIG(1), { verdict: "no_data" }]).outcome, "disputed");
  const spot = { period_days: 3, t0_btjd: 3776, duration_hours: 2.4 };
  assert.ok(spotPass(spot, { verdict: "signal", period_days: 3.01, t0_btjd: 3779.02 }));
  assert.ok(spotPass(spot, { verdict: "signal", period_days: 6, t0_btjd: 3782 }), "double period still finds NASA's signal");
  assert.ok(!spotPass(spot, { verdict: "none" }));
  assert.ok(!spotPass(spot, { verdict: "signal", period_days: 4.5, t0_btjd: 3776 }));
});

test("exact light-curve file for a star", () => {
  assert.equal(
    fileUrl(91, TEMPLATE, 100053206),
    "https://stpubdata.s3.amazonaws.com/tess/public/tid/s0091/0000/0001/0005/3206/tess2025099153000-s0091-0000000100053206-0288-s_lc.fits",
  );
});

test("claim: exact stars, a deadline, one job at a time, started batches first", async () => {
  const { main, q } = setup();
  const a = await agent(main, "a"), b = await agent(main, "b"), c = await agent(main, "c");
  const ja = await claim(q, a);
  assert.match(ja.job_id, /^pqj_[0-9a-f]{16}$/);
  assert.equal(ja.sector, 91);
  assert.equal(ja.stars.length, 4);
  assert.ok(ja.stars.every((s) => s.light_curve.endsWith("-0288-s_lc.fits")));
  assert.ok(Date.parse(ja.deadline) > Date.now() + (PQ.lease_minutes - 1) * 60_000);
  assert.ok(!JSON.stringify(ja).includes("spot"), "the job never says which star is the spot check");
  assert.equal((await claim(q, a)).job_id, ja.job_id, "claiming again returns the current job");
  const jb = await claim(q, b);
  assert.deepEqual(jb.stars, ja.stars, "the second agent gets the same started batch");
  const jc = await claim(q, c);
  assert.notDeepEqual(jc.stars, ja.stars, "a full batch goes to nobody else");
  const info = await queueInfo(q);
  assert.equal(info.stats.jobs_out_now, 3);
});

test("two agreeing reports settle a batch; an agreed signal goes to human review", async () => {
  const { main, q } = setup();
  const a = await agent(main, "a"), b = await agent(main, "b");
  const ja = await claim(q, a), jb = await claim(q, b);
  const r1 = await report(q, main, a, ja.job_id, { results: answers(ja, { 12: SIG(12) }) }, notKnown);
  assert.equal(r1.batch.status, "open");
  await rejects(report(q, main, a, ja.job_id, { results: answers(ja) }, notKnown), 409, /already reported/);
  const r2 = await report(q, main, b, jb.job_id, { results: answers(jb, { 12: SIG(12, 4.21) }) }, notKnown);
  assert.equal(r2.batch.status, "done");
  assert.equal(r2.batch.agreed_signal, 1);
  assert.equal(r2.batch.agreed_none, 2, "the spot star is not counted as a search star");
  assert.equal(r2.batch.finds[0].status, "review");
  const f = await queueFinds(q);
  assert.equal(f.finds[0].tic_id, 12);
  assert.equal(f.finds[0].agreed_by, 2);
  assert.match(f.wording, /not confirmed planets/);
  const ev = await main.prepare("SELECT detail FROM events WHERE kind = 'planet_candidate'").first();
  assert.match(ev.detail, /TIC 12/);
  const mine = await myQueue(q, a);
  assert.deepEqual(mine.you.spot_checks, { caught: 1, missed: 0 });
  assert.equal(mine.you.agreed, 3);
  assert.equal((await reviewFind(q, f.finds[0].id, { decision: "promote" })).status, "promoted");
  await rejects(reviewFind(q, f.finds[0].id, { decision: "dismiss" }), 409);
});

test("a known signal is labelled known, not sent to review", async () => {
  const { main, q } = setup();
  const a = await agent(main, "a"), b = await agent(main, "b");
  const ja = await claim(q, a), jb = await claim(q, b);
  const known = async () => ({ known: "toi", label: "TOI-123.01 (PC)" });
  await report(q, main, a, ja.job_id, { results: answers(ja, { 11: SIG(11) }) }, known);
  const r = await report(q, main, b, jb.job_id, { results: answers(jb, { 11: SIG(11) }) }, known);
  assert.equal(r.batch.finds[0].status, "known");
});

test("disagreement brings in a third agent; still no pair means disputed", async () => {
  const { main, q } = setup(1);
  const [a, b, c, d] = await Promise.all(["a", "b", "c", "d"].map((n) => agent(main, n)));
  const ja = await claim(q, a), jb = await claim(q, b);
  assert.equal((await claim(q, c)).job_id, null, "two agents is all a batch needs at first");
  await report(q, main, a, ja.job_id, { results: answers(ja, { 11: SIG(11), 13: SIG(13) }) }, notKnown);
  const r = await report(q, main, b, jb.job_id, { results: answers(jb, { 13: { tic_id: 13, verdict: "no_data" } }) }, notKnown);
  assert.equal(r.batch.status, "open");
  assert.match(r.batch.note, /disagree on 2 stars/);
  const jc = await claim(q, c);
  assert.ok(jc.job_id, "a third slot opened");
  assert.equal((await claim(q, d)).job_id, null);
  const r3 = await report(q, main, c, jc.job_id, { results: answers(jc, { 11: SIG(11) }) }, notKnown);
  assert.equal(r3.batch.status, "done");
  assert.equal(r3.batch.agreed_signal, 1, "TIC 11: a and c agree");
  assert.equal(r3.batch.disputed, 1, "TIC 13: signal, no_data and none");
  const c2 = await myQueue(q, c);
  assert.equal(c2.you.disagreed, 0);
  assert.equal((await myQueue(q, b)).you.disagreed, 1);
});

test("a job that goes quiet is reissued; a late report is refused once someone else has it", async () => {
  const { main, q } = setup(1);
  const a = await agent(main, "a"), b = await agent(main, "b"), c = await agent(main, "c");
  const ja = await claim(q, a);
  await claim(q, b);
  assert.equal((await claim(q, c)).job_id, null);
  q.raw.exec(`UPDATE pq_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${ja.job_id}'`);
  const jc = await claim(q, c);
  assert.ok(jc.job_id, "the quiet job went back in the queue");
  await rejects(report(q, main, a, ja.job_id, { results: answers(ja) }, notKnown), 409, /deadline passed/);
  assert.equal((await claim(q, a)).job_id, null, "an agent never gets the same batch twice");
});

test("release gives a job back at once", async () => {
  const { main, q } = setup(1);
  const a = await agent(main, "a"), b = await agent(main, "b"), c = await agent(main, "c");
  const ja = await claim(q, a);
  await claim(q, b);
  assert.equal((await giveBack(q, a, ja.job_id)).status, "released");
  assert.ok((await claim(q, c)).job_id);
  await rejects(giveBack(q, c, ja.job_id), 404);
});

test("reports must answer every star in the job, sensibly", async () => {
  const { main, q } = setup(1);
  const a = await agent(main, "a");
  const ja = await claim(q, a);
  await rejects(report(q, main, a, ja.job_id, { results: answers(ja).slice(1) }, notKnown), 400, /missing/);
  await rejects(report(q, main, a, ja.job_id, { results: [...answers(ja), { tic_id: 5, verdict: "none" }] }, notKnown), 400, /not in this job/);
  await rejects(report(q, main, a, ja.job_id, { results: answers(ja, { 11: { tic_id: 11, verdict: "signal" } }) }, notKnown), 400, /period_days/);
  await rejects(report(q, main, a, ja.job_id, { results: answers(ja, { 11: { tic_id: 11, verdict: "planet" } }) }, notKnown), 400, /verdict/);
});

test("an agent that keeps missing spot checks is benched and its open reports stop counting", async () => {
  const { main, q } = setup(1);
  const bad = await agent(main, "bad"), good = await agent(main, "good");
  q.raw.exec("INSERT INTO pq_agents (agent_id, name, spot_fail) VALUES ('" + bad.id + "', 'bad', 1)");
  const j = await claim(q, bad);
  const r = await report(q, main, bad, j.job_id, { results: answers(j, {}, false) }, notKnown);
  assert.equal(r.benched, true);
  await rejects(claim(q, bad), 403, /benched/);
  const t = await q.prepare("SELECT taken FROM pq_batches WHERE id = 'pqb_q1_00001'").first();
  assert.equal(t.taken, 0, "the benched agent's report no longer holds a slot");
  assert.ok((await claim(q, good)).job_id);
  await unbench(q, bad.id);
  assert.equal((await claim(q, bad)).job_id, null, "reinstated, but never the same batch twice");
});
