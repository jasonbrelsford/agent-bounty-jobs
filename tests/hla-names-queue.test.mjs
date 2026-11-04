// HLA allele-name queue: exact open-access HLA papers, names checked against
// the paper, two independent agents per batch (a third on disagreement), spot
// checks, benching, and the public flags feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1, QUEUE_MIGRATIONS } from "./d1shim.mjs";
import { registerAgent, authByKey } from "../.test-build/core.js";
import {
  normName, styleOnly, paperConsensus, spotPass, claim, report, giveBack, myQueue, queueInfo, queueFlags, reviewFlag, unbench, HQ,
} from "../.test-build/queues/hla-names-queue.js";

const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));

const TEXT = {
  PMC1: "Patients carrying HLA-DRB1*0401 or DRB1 * 0404 had higher risk; HLA-DRB1∗1501 was protective. One typing read DRB1*17.",
  PMC2: "Frequencies of A*02:01 and Cw*0702 in controls are shown in Table 2. B*9501 was rare.",
  PMC3: "This paper is about cytokines and writes no allele names at all. ".repeat(20),
  PMC9: "Spot paper: A*0101, B*0801 and DQB1*0602 were typed; DRB1*15:01 was most common.",
};
const url = (id) => `https://pmc-oa-opendata.s3.amazonaws.com/${id}.1/${id}.1.txt`;
const read = async (u) => Object.entries(TEXT).find(([id]) => url(id) === u)?.[1] ?? null;
const offline = async () => null;

const N = (written, status, current = null) => ({ written, status, current });
const SPOT_KEY = [N("A*0101", "old_format", "A*01:01"), N("B*0801", "old_format", "B*08:01"), N("DQB1*0602", "old_format", "DQB1*06:02"), N("DRB1*15:01", "current", "DRB1*15:01")];
const ANS = {
  PMC1: [N("HLA-DRB1*0401", "old_format", "DRB1*04:01"), N("DRB1 * 0404", "old_format", "DRB1*04:04"), N("HLA-DRB1∗1501", "old_format", "DRB1*15:01"), N("DRB1*17", "not_assigned")],
  PMC2: [N("A*02:01", "current", "A*02:01"), N("Cw*0702", "old_format", "C*07:02"), N("B*9501", "renamed", "B*15:101")],
  PMC9: SPOT_KEY,
};
const entry = (id, names = ANS[id] ?? []) => ({ pmcid: id, verdict: "names", names });

function setup() {
  const main = makeD1();
  const q = makeD1(QUEUE_MIGRATIONS);
  q.raw.exec("INSERT INTO hq_rounds (id, release, release_tag, created_at) VALUES ('H1', '3.66.0', 'v3.66.0-alpha', '2026-11-04')");
  for (const id of Object.keys(TEXT)) q.raw.exec(`INSERT INTO hq_papers VALUES ('${id}', ${id.slice(3)}, 'Paper ${id}', 'CC BY', '${url(id)}')`);
  q.raw.prepare("INSERT INTO hq_spot_answers VALUES (?, ?)").run("PMC9", JSON.stringify(SPOT_KEY));
  q.raw.exec(`INSERT INTO hq_batches (id, round, seq, papers_json, spot_pmcid) VALUES ('hqb_h1_00001', 'H1', 1, '["PMC1","PMC9"]', 'PMC9')`);
  q.raw.exec(`INSERT INTO hq_batches (id, round, seq, papers_json, spot_pmcid) VALUES ('hqb_h1_00002', 'H1', 2, '["PMC2","PMC3"]', NULL)`);
  return { main, q };
}
const agent = async (db, name) => authByKey(db, (await registerAgent(db, `typer-${name}`, { contact_email: `${name}@example.com` })).api_key);

test("names, the 2010 style change and agreement (pure)", () => {
  assert.equal(normName("HLA-DRB1∗1501"), "DRB1*1501");
  assert.equal(normName("DRB1 * 0404"), "DRB1*0404");
  assert.equal(normName("HLADRB1*03"), "DRB1*03");
  assert.equal(styleOnly("A*0201"), "A*02:01");
  assert.equal(styleOnly("Cw*0702"), "C*07:02");
  assert.equal(styleOnly("Cw*07:02"), "C*07:02");
  assert.equal(styleOnly("A*020101N"), "A*02:01:01N");
  assert.equal(styleOnly("A*02011"), null, "odd digit counts have no style-only colon form");
  assert.equal(styleOnly("A*02:01"), null, "already current");
  const R = (...names) => ({ verdict: "names", names });
  assert.equal(paperConsensus([R(...ANS.PMC1), R(...[...ANS.PMC1].reverse())]).outcome, "agreed");
  assert.equal(paperConsensus([R(), R()]).outcome, "no_names");
  assert.equal(paperConsensus([R(...ANS.PMC1), R(...ANS.PMC1.slice(1))]).outcome, "open");
  const three = paperConsensus([R(...ANS.PMC1), R(...ANS.PMC1.slice(1)), R(...ANS.PMC1.slice(2))]);
  assert.equal(three.outcome, "partial");
  assert.equal(three.names.length, 3, "names two or more reports share");
  assert.ok(spotPass(SPOT_KEY, R(...SPOT_KEY)));
  assert.ok(spotPass(SPOT_KEY, R(...SPOT_KEY.slice(0, 3), N("DRB1*15:01", "current", "DRB1*15:01"))));
  assert.ok(!spotPass(SPOT_KEY, R(...SPOT_KEY.slice(0, 2))), "half the known names is a miss");
  assert.ok(!spotPass(SPOT_KEY, R(...SPOT_KEY.map((n) => ({ ...n, status: "current", current: normName(n.written) }))) ), "wrong standings miss");
});

test("two agents agree: batch settles and renamed or never-assigned names are flagged", async () => {
  const { main, q } = setup();
  const a = await agent(main, "a"), b = await agent(main, "b");
  const ja = await claim(q, a), jb = await claim(q, b);
  assert.equal(ja.papers.length, 2);
  assert.match(ja.release, /3\.66\.0.*v3\.66\.0-alpha/);
  assert.ok(!JSON.stringify(ja).includes("spot"));
  const ra = await report(q, main, a, ja.job_id, { results: [entry("PMC1"), entry("PMC9")] }, read);
  assert.equal(ra.names_checked, "every name was found in its paper");
  const rb = await report(q, main, b, jb.job_id, { results: [entry("PMC9"), entry("PMC1", [...ANS.PMC1].reverse())] }, read);
  assert.equal(rb.batch.status, "done");
  assert.equal(rb.batch.papers_agreed, 2);
  assert.deepEqual(rb.batch.flags.map((f) => [f.written, f.standing]), [["DRB1*17", "not_assigned"]]);
  const feed = await queueFlags(q);
  assert.equal(feed.flags.length, 1);
  assert.equal(feed.release, "IPD-IMGT/HLA 3.66.0");
  assert.equal((await myQueue(q, a)).you.spot_checks.caught, 1);
  const stats = (await queueInfo(q)).stats;
  assert.equal(stats.old_style_names, 6);
  assert.equal(stats.names_agreed, 8);
  assert.equal(main.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'hla_name_flags'").get().n, 1);
  assert.equal((await reviewFlag(q, feed.flags[0].id, { decision: "confirm" })).status, "confirmed");
});

test("names not in the paper, wrong styles and bad input are refused", async () => {
  const { main, q } = setup();
  const a = await agent(main, "a");
  const j = await claim(q, a);
  await rejects(report(q, main, a, j.job_id, { results: [entry("PMC1", [...ANS.PMC1, N("A*0301", "old_format", "A*03:01")]), entry("PMC9")] }, read), 422, /'A\*0301' is not written/);
  await rejects(report(q, main, a, j.job_id, { results: [entry("PMC1", [N("HLA-DRB1*0401", "old_format", "DRB1*04:10")]), entry("PMC9")] }, read), 400, /style change alone gives DRB1\*04:01/);
  await rejects(report(q, main, a, j.job_id, { results: [entry("PMC1", [N("HLA-DRB1*0401", "current", "DRB1*0401")]), entry("PMC9")] }, read), 400, /current must be today's name/);
  await rejects(report(q, main, a, j.job_id, { results: [entry("PMC1", [N("DRB1*17", "made_up")]), entry("PMC9")] }, read), 400, /status must be/);
  await rejects(report(q, main, a, j.job_id, { results: [entry("PMC1", [N("DR4", "current", "DRB1*04")]), entry("PMC9")] }, read), 400, /with its '\*'/);
  await rejects(report(q, main, a, j.job_id, { results: [entry("PMC1")] }, read), 400, /missing: PMC9/);
  assert.equal(q.raw.prepare("SELECT COUNT(*) AS n FROM hq_reports").get().n, 0);
  const ok = await report(q, main, a, j.job_id, { results: [entry("PMC1"), entry("PMC9")] }, offline);
  assert.match(ok.names_checked, /0 of 2/);
});

test("disagreement brings a third agent; no_text is refused on a readable paper; release and expiry", async () => {
  const { main, q } = setup();
  const [a, b, c] = [await agent(main, "a"), await agent(main, "b"), await agent(main, "c")];
  const ja = await claim(q, a), jb = await claim(q, b);
  await report(q, main, a, ja.job_id, { results: [entry("PMC1"), entry("PMC9")] }, read);
  const r2 = await report(q, main, b, jb.job_id, { results: [entry("PMC1", ANS.PMC1.slice(0, 3)), entry("PMC9")] }, read);
  assert.match(r2.batch.note, /third agent/);
  const jc = await claim(q, c);
  assert.equal(jc.papers[0].pmcid, "PMC1");
  const r3 = await report(q, main, c, jc.job_id, { results: [entry("PMC1"), entry("PMC9")] }, read);
  assert.equal(r3.batch.status, "done");
  assert.equal(r3.batch.flags.length, 1);

  const next = await claim(q, a);
  assert.equal(next.papers[0].pmcid, "PMC2");
  await rejects(report(q, main, a, next.job_id, { results: [entry("PMC2"), { pmcid: "PMC3", verdict: "no_text" }] }, read), 422, /reads fine/);
  const ok = await report(q, main, a, next.job_id, { results: [entry("PMC2"), entry("PMC3", [])] }, read);
  assert.equal(ok.batch.status, "open");
  const jb2 = await claim(q, b);
  await giveBack(q, b, jb2.job_id);
  assert.equal((await claim(q, b)).job_id, null, "a released batch never comes back to the same agent");
  const jc2 = await claim(q, c);
  q.raw.exec(`UPDATE hq_leases SET expires_at = '2000-01-01T00:00:00Z' WHERE id = '${jc2.job_id}'`);
  const late = await report(q, main, c, jc2.job_id, { results: [entry("PMC2"), entry("PMC3", [])] }, read);
  assert.equal(late.batch.status, "done", "late but nobody else took the slot: accepted");
  assert.ok((await queueInfo(q)).rules.some((r) => /Never send patient data/.test(r)));
});

test("missing spot papers benches an agent; unbench restores it", async () => {
  const { main, q } = setup();
  q.raw.exec(`INSERT INTO hq_batches (id, round, seq, papers_json, spot_pmcid) VALUES ('hqb_h1_00003', 'H1', 3, '["PMC9"]', 'PMC9')`);
  const a = await agent(main, "a");
  const j1 = await claim(q, a);
  await report(q, main, a, j1.job_id, { results: [entry("PMC1"), entry("PMC9", SPOT_KEY.slice(0, 1))] }, read);
  await claim(q, a).then((j) => giveBack(q, a, j.job_id));
  const j3 = await claim(q, a);
  const r = await report(q, main, a, j3.job_id, { results: [entry("PMC9", [])] }, read);
  assert.equal(r.benched, true);
  await rejects(claim(q, a), 403, /benched/);
  await unbench(q, a.id);
  assert.equal((await claim(q, a)).job_id, null);
  assert.equal(HQ.needed, 2);
});
