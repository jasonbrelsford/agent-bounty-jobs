// Rare disease paper queue: exact paper batches, quotes checked against the
// paper, two independent agents per batch (a third on disagreement), spot
// checks, benching, and the public leads feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1, QUEUE_MIGRATIONS } from "./d1shim.mjs";
import { registerAgent, authByKey } from "../.test-build/core.js";
import {
  normDrug, diseaseMatch, sameClaim, paperConsensus, spotPass, normText,
  claim, report, giveBack, myQueue, queueInfo, queueLeads, reviewLead, unbench, DQ,
} from "../.test-build/queues/disease-queue.js";

const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));

// Paper texts the fake fetcher serves, by URL.
const TEXT = {
  PMC1: "A 4-month-old girl with an ulcerated infantile hemangioma was started on oral propranolol 2 mg/kg/day. The lesion\nshrank markedly within\neight weeks of starting propranolol.",
  PMC2: "We describe a man with idiopathic hypertrophic pyloric stenosis managed by laparoscopic pyloroplasty. No drug was given. ".repeat(12),
  PMC3: "Eculizumab was started for atypical hemolytic uremic syndrome and renal function recovered over three months. Dialysis was stopped.",
  PMC4: "Sirolimus (rapamycin) slowed the decline of lung function in this patient with lymphangioleiomyomatosis over two years.",
  PMC9: "Imatinib mesylate given before surgery shrank the dermatofibrosarcoma protuberans so that it could be removed completely.",
};
const url = (id) => `https://pmc-oa-opendata.s3.amazonaws.com/${id}.1/${id}.1.txt`;
const read = async (u) => Object.entries(TEXT).find(([id]) => url(id) === u)?.[1] ?? null;
const offline = async () => null;

function setup() {
  const main = makeD1();
  const q = makeD1(QUEUE_MIGRATIONS);
  q.raw.exec("INSERT INTO dq_rounds (id, note, created_at) VALUES ('D1', 'test', '2026-11-04')");
  for (const id of Object.keys(TEXT)) q.raw.exec(`INSERT INTO dq_papers VALUES ('${id}', ${id.slice(3)}, 'Paper ${id}', 'CC BY', '${url(id)}')`);
  q.raw.exec(`INSERT INTO dq_spot_answers VALUES ('PMC9', 'imatinib', '["dermatofibrosarcoma","dfsp"]')`);
  q.raw.exec(`INSERT INTO dq_batches (id, round, seq, papers_json, spot_pmcid) VALUES ('dqb_d1_00001', 'D1', 1, '["PMC1","PMC9","PMC2"]', 'PMC9')`);
  q.raw.exec(`INSERT INTO dq_batches (id, round, seq, papers_json, spot_pmcid) VALUES ('dqb_d1_00002', 'D1', 2, '["PMC3","PMC4"]', NULL)`);
  return { main, q };
}
const agent = async (db, name) => authByKey(db, (await registerAgent(db, `reader-${name}`, { contact_email: `${name}@example.com` })).api_key);

const C = {
  prop: { drug: "Propranolol", disease: "infantile hemangioma", effect: "improved", quote: "The lesion shrank markedly within eight weeks of starting propranolol." },
  ima: { drug: "imatinib mesylate", disease: "dermatofibrosarcoma protuberans", effect: "improved", quote: "Imatinib mesylate given before surgery shrank the dermatofibrosarcoma protuberans" },
  ecu: { drug: "eculizumab", disease: "aHUS", effect: "improved", quote: "Eculizumab was started for atypical hemolytic uremic syndrome and renal function recovered" },
  siro: { drug: "rapamycin", disease: "lymphangioleiomyomatosis", effect: "improved", quote: "slowed the decline of lung function in this patient with lymphangioleiomyomatosis" },
};
/** Answers for batch 1: propranolol on PMC1, nothing on PMC2, the spot paper caught. */
const batch1 = (over = {}, catchSpot = true) => [
  over.PMC1 ?? { pmcid: "PMC1", verdict: "claims", claims: [C.prop] },
  { pmcid: "PMC9", verdict: "claims", claims: catchSpot ? [C.ima] : [] },
  over.PMC2 ?? { pmcid: "PMC2", verdict: "claims", claims: [] },
];

test("drug names, disease names and agreement (pure)", () => {
  assert.equal(normDrug("Imatinib Mesylate (Gleevec) 400 mg daily"), "imatinib");
  assert.equal(normDrug("Glivec"), "imatinib");
  assert.equal(normDrug("Rapamycin"), "sirolimus");
  assert.equal(normDrug("oral propranolol"), "propranolol");
  assert.ok(diseaseMatch("aHUS", "atypical hemolytic uremic syndrome"), "an acronym matches its full name");
  assert.ok(diseaseMatch("infantile haemangioma", "ulcerated infantile hemangioma"), "British spelling and an extra word");
  assert.ok(!diseaseMatch("lymphangioleiomyomatosis", "tuberous sclerosis complex"));
  assert.ok(sameClaim(C.ecu, { ...C.ecu, drug: "Soliris", disease: "atypical haemolytic uraemic syndrome" }), "brand name and British spelling");
  assert.ok(!sameClaim(C.prop, { ...C.prop, effect: "side_effect" }), "a different effect is a different claim");

  const R = (...claims) => ({ verdict: "claims", claims });
  assert.equal(paperConsensus([R(), R()]).outcome, "no_claims");
  assert.equal(paperConsensus([R(C.prop), R({ ...C.prop, drug: "propranolol hydrochloride" })]).outcome, "agreed");
  assert.equal(paperConsensus([R(C.prop), R()]).outcome, "open", "one saw a drug, one didn't: ask a third");
  const three = paperConsensus([R(C.prop, C.ecu), R(C.prop), R(C.siro)]);
  assert.equal(three.outcome, "partial");
  assert.deepEqual(three.claims.map((c) => c.claim.drug), ["Propranolol"]);
  assert.equal(paperConsensus([R(C.prop), R(C.ecu), R(C.siro)]).outcome, "disputed");
  assert.equal(paperConsensus([{ verdict: "no_text", claims: [] }, { verdict: "no_text", claims: [] }]).outcome, "no_text");

  const spot = { drug: "imatinib", disease_terms_json: '["dermatofibrosarcoma","dfsp"]' };
  assert.ok(spotPass(spot, R({ ...C.ima, drug: "Gleevec", disease: "DFSP" })));
  assert.ok(!spotPass(spot, R()));
  assert.ok(!spotPass(spot, R({ ...C.ima, drug: "surgery" })));
  assert.equal(normText("Line‐\nbreak  and “quotes”"), 'linebreak and "quotes"');
});

test("two agents agree: batch settles, leads are made, spot paper never becomes a lead", async () => {
  const { main, q } = setup();
  const a = await agent(main, "a"), b = await agent(main, "b");
  const ja = await claim(q, a), jb = await claim(q, b);
  assert.equal(ja.job_id && jb.job_id && ja.papers.length, 3);
  assert.equal(jb.round, "D1");
  assert.ok(ja.papers.every((p) => p.text.startsWith("https://pmc-oa-opendata.s3.amazonaws.com/")));
  assert.ok(!JSON.stringify(ja).includes("spot"), "the job never says which paper is the check");
  const ra = await report(q, main, a, ja.job_id, { results: batch1() }, read);
  assert.equal(ra.quotes_checked, "every quote was found in its paper");
  assert.equal(ra.batch.status, "open");
  const rb = await report(q, main, b, jb.job_id, { results: batch1({ PMC1: { pmcid: "PMC1", verdict: "claims", claims: [{ ...C.prop, drug: "propranolol hydrochloride", disease: "infantile haemangioma" }] } }) }, read);
  assert.equal(rb.batch.status, "done");
  assert.equal(rb.batch.papers_agreed, 1);
  assert.equal(rb.batch.papers_without_drugs, 1);
  assert.equal(rb.batch.leads.length, 1);
  assert.equal(rb.batch.leads[0].drug, "propranolol");
  const feed = await queueLeads(q);
  assert.equal(feed.leads.length, 1);
  assert.equal(feed.leads[0].pmcid, "PMC1");
  assert.match(feed.leads[0].paper, /PMC1\/$/);
  assert.match(feed.wording, /Not treatment advice/);
  const mine = await myQueue(q, a);
  assert.equal(mine.you.spot_checks.caught, 1);
  assert.equal(mine.you.agreed, 2);
  const ev = main.raw.prepare("SELECT kind FROM events WHERE kind = 'disease_leads'").all();
  assert.equal(ev.length, 1);
  const rev = await reviewLead(q, feed.leads[0].id, { decision: "promote", note: "checked" });
  assert.equal(rev.status, "promoted");
});

test("made-up quotes and drugs not in the paper are refused, nothing saved", async () => {
  const { main, q } = setup();
  const a = await agent(main, "a");
  const j = await claim(q, a);
  await rejects(report(q, main, a, j.job_id, { results: batch1({ PMC1: { pmcid: "PMC1", verdict: "claims", claims: [{ ...C.prop, quote: "Propranolol cured the hemangioma completely in two days." }] } }) }, read), 422, /quote is not in the paper/);
  await rejects(report(q, main, a, j.job_id, { results: batch1({ PMC2: { pmcid: "PMC2", verdict: "claims", claims: [{ drug: "atropine", disease: "pyloric stenosis", effect: "improved", quote: "managed by laparoscopic pyloroplasty. No drug was given." }] } }) }, read), 422, /'atropine' is not named/);
  await rejects(report(q, main, a, j.job_id, { results: batch1({ PMC2: { pmcid: "PMC2", verdict: "no_text" } }) }, read), 422, /reads fine/);
  assert.equal(q.raw.prepare("SELECT COUNT(*) AS n FROM dq_reports").get().n, 0);
  // Files out of reach: the report is accepted but marked unchecked.
  const ok = await report(q, main, a, j.job_id, { results: batch1() }, offline);
  assert.match(ok.quotes_checked, /0 of 3/);
});

test("input checks", async () => {
  const { main, q } = setup();
  const a = await agent(main, "a");
  const j = await claim(q, a);
  await rejects(report(q, main, a, j.job_id, { results: batch1().slice(0, 2) }, read), 400, /missing: PMC2/);
  await rejects(report(q, main, a, j.job_id, { results: [...batch1(), { pmcid: "PMC3", verdict: "claims", claims: [] }] }, read), 400, /not in this job/);
  await rejects(report(q, main, a, j.job_id, { results: batch1({ PMC1: { pmcid: "PMC1", verdict: "claims", claims: [{ ...C.prop, effect: "cured" }] } }) }, read), 400, /effect must be/);
  await rejects(report(q, main, a, j.job_id, { results: batch1({ PMC1: { pmcid: "PMC1", verdict: "claims", claims: [{ ...C.prop, quote: "short" }] } }) }, read), 400, /quote must be/);
  await rejects(report(q, main, a, j.job_id, { results: batch1({ PMC1: { pmcid: "PMC1", verdict: "maybe" } }) }, read), 400, /verdict/);
});

test("disagreement brings in a third agent; deadlines, release and no repeats", async () => {
  const { main, q } = setup();
  const [a, b, c] = [await agent(main, "a"), await agent(main, "b"), await agent(main, "c")];
  const ja = await claim(q, a), jb = await claim(q, b);
  await report(q, main, a, ja.job_id, { results: batch1() }, read);
  const r2 = await report(q, main, b, jb.job_id, { results: batch1({ PMC1: { pmcid: "PMC1", verdict: "claims", claims: [] } }) }, read);
  assert.equal(r2.batch.status, "open");
  assert.match(r2.batch.note, /third agent/);
  const jc = await claim(q, c);
  assert.equal(jc.papers[0].pmcid, "PMC1", "the started batch is finished first");
  const r3 = await report(q, main, c, jc.job_id, { results: batch1() }, read);
  assert.equal(r3.batch.status, "done");
  assert.equal(r3.batch.papers_agreed, 1);

  // a's next job is batch 2; give it back, and it never comes back to a.
  const next = await claim(q, a);
  assert.equal(next.papers[0].pmcid, "PMC3");
  await giveBack(q, a, next.job_id);
  const none = await claim(q, a);
  assert.equal(none.job_id, null);
  // An expired lease frees the slot.
  const jb2 = await claim(q, b);
  q.raw.exec(`UPDATE dq_leases SET expires_at = '2000-01-01T00:00:00Z' WHERE id = '${jb2.job_id}'`);
  const jc2 = await claim(q, c);
  assert.equal(jc2.papers[0].pmcid, "PMC3");
  const info = await queueInfo(q);
  assert.equal(info.stats.batches, 2);
  assert.ok(info.rules.some((r) => /never treatment advice/.test(r)));
});

test("missing spot papers benches an agent; unbench restores it", async () => {
  const { main, q } = setup();
  q.raw.exec(`INSERT INTO dq_batches (id, round, seq, papers_json, spot_pmcid) VALUES ('dqb_d1_00003', 'D1', 3, '["PMC9","PMC3"]', 'PMC9')`);
  const a = await agent(main, "a");
  const j1 = await claim(q, a);
  await report(q, main, a, j1.job_id, { results: batch1({}, false) }, read);
  await claim(q, a).then((j) => giveBack(q, a, j.job_id)); // batch 2, skipped
  const j3 = await claim(q, a);
  assert.deepEqual(j3.papers.map((p) => p.pmcid), ["PMC9", "PMC3"]);
  const r = await report(q, main, a, j3.job_id, { results: [{ pmcid: "PMC9", verdict: "claims", claims: [] }, { pmcid: "PMC3", verdict: "claims", claims: [C.ecu] }] }, read);
  assert.equal(r.benched, true);
  await rejects(claim(q, a), 403, /benched/);
  assert.equal(q.raw.prepare("SELECT COUNT(*) AS n FROM dq_leases WHERE agent_id = ? AND counted = 1").get(a.id).n, 0, "reports on open batches stop counting");
  await unbench(q, a.id);
  const again = await claim(q, a);
  assert.equal(again.job_id, null, "no batch it hasn't held is left");
  assert.equal(DQ.needed, 2);
});
