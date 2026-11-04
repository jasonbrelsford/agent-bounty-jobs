// Math Record Hunt: exact checkers (two per problem), practice play, team vetting by a
// different teammate, record claims, reporting to the operator, the team and owner-chosen
// addresses, the operator's review, and the pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey } from "../.test-build/core.js";
import { createTeam, joinTeam, scienceLeaderboard } from "../.test-build/science/planets.js";
import {
  checkPackingA, checkPackingB, checkKissingA, checkKissingB, checkRamseyA, checkRamseyB, parseGraph6, parseDecimalA, parseDecimalB, compareDecimal, LIMITS, withoutBudget,
} from "../.test-build/science/math-check.js";
import { mathProblem, MATH_PROBLEMS } from "../.test-build/science/math-records.js";
import {
  submitMath, vetMath, houseVetMath, listProblems, getProblem, claimView, listClaims, reviewClaim, setReportSettings, getReportSettings,
  flushMathReports, mathMine, mathStats, tierOf, currentRecord, MATH_POINTS,
} from "../.test-build/science/math.js";
import { sciencePage, mathProblemPage, mathClaimPage } from "../.test-build/science/page.js";

const agent = async (db, name) => authByKey(db, (await registerAgent(db, name, { contact_email: `${name}@example.com` })).api_key);
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));

// ── constructions ──
const hexagon = { vectors: [[2, 0], [1, 1], [-1, 1], [-2, 0], [-1, -1], [1, -1]] }; // not equal length: invalid on purpose
// D_n roots: all (±1, ±1, 0, ...) — 2n(n-1) vectors of squared length 2, the best known in 3, 4, 5 dimensions.
function dRoots(n) {
  const v = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (const a of [1, -1]) for (const b of [1, -1]) { const x = new Array(n).fill(0); x[i] = a; x[j] = b; v.push(x); }
  return { vectors: v };
}
// E8 roots, doubled to integers: D8 roots ×2 plus all (±1)^8 with an even number of minus signs. 240 vectors, squared length 8.
function e8() {
  const v = dRoots(8).vectors.map((x) => x.map((k) => 2 * k));
  for (let m = 0; m < 256; m++) { const x = [...Array(8)].map((_, i) => ((m >> i) & 1 ? -1 : 1)); if (x.filter((k) => k < 0).length % 2 === 0) v.push(x); }
  return { vectors: v };
}
const cycle = (n) => ({ n, edges: [...Array(n)].map((_, i) => [i, (i + 1) % n]) });
// Paley graph on 17 vertices: no K4 and no independent 4-set, so R(4,4) ≥ 18.
function paley17() {
  const q = new Set([1, 2, 4, 8, 9, 13, 15, 16]);
  const edges = [];
  for (let i = 0; i < 17; i++) for (let j = i + 1; j < 17; j++) if (q.has((j - i) % 17)) edges.push([i, j]);
  return { n: 17, edges };
}

test("decimals: both parsers are exact and agree", () => {
  assert.deepEqual(parseDecimalA("0.125"), { n: 125n, scale: 3 });
  assert.deepEqual(parseDecimalA("1.5e-3"), { n: 15n, scale: 4 });
  assert.deepEqual(parseDecimalB("0.125"), [1n, 8n]);
  assert.deepEqual(parseDecimalB("-2.5E1"), [-25n, 1n]);
  assert.equal(parseDecimalA("abc"), null);
  assert.equal(parseDecimalB("1.2.3"), null);
  assert.equal(compareDecimal("1.10", "1.1"), 0);
  assert.equal(compareDecimal("2", "1.999999999999999999"), 1);
});

test("circle packing: inside the square, no overlaps, exact sum; both checkers agree", () => {
  const good = { circles: [["0.25", "0.25", "0.25"], ["0.75", "0.75", "0.25"]] };
  for (const f of [checkPackingA, checkPackingB]) {
    const r = f(good, 2);
    assert.equal(r.ok, true);
    assert.equal(r.value, "0.500000000000000");
  }
  // Touching circles are fine; overlapping by 1e-20 is not.
  const touching = { circles: [["0.25", "0.25", "0.25"], ["0.75", "0.25", "0.25"]] };
  assert.equal(checkPackingA(touching, 2).ok, true);
  assert.equal(checkPackingB(touching, 2).ok, true);
  const overlap = { circles: [["0.25", "0.25", "0.25"], ["0.74999999999999999999", "0.25", "0.25"]] };
  assert.match(checkPackingA(overlap, 2).reason, /overlap/);
  assert.match(checkPackingB(overlap, 2).reason, /overlap/);
  const outside = { circles: [["0.2", "0.5", "0.25"], ["0.75", "0.5", "0.25"]] };
  assert.match(checkPackingA(outside, 2).reason, /sticks out/);
  assert.equal(checkPackingB(outside, 2).ok, false);
  assert.match(checkPackingA(good, 3).reason, /exactly 3 circles/);
  assert.equal(checkPackingA({ circles: [["0.25", "0.25", "-0.1"], ["0.75", "0.75", "0.25"]] }, 2).ok, false);
});

test("kissing: equal lengths, 60 degrees apart, two checkers", () => {
  for (const [n, k] of [[3, 12], [4, 24], [5, 40]]) {
    assert.equal(checkKissingA(dRoots(n), n).value, String(k));
    assert.equal(checkKissingB(dRoots(n), n).value, String(k));
  }
  assert.equal(checkKissingA(e8(), 8).value, "240");
  assert.equal(checkKissingB(e8(), 8).value, "240");
  assert.match(checkKissingA(hexagon, 2).reason, /different length/);
  const dup = { vectors: [[1, 1, 0], [1, 1, 0]] };
  assert.equal(checkKissingA(dup, 3).ok, false);
  assert.equal(checkKissingB(dup, 3).ok, false);
  const close = { vectors: [[2, 0, 0], [0, 2, 0], [2, 0, 0].map((x, i) => (i === 1 ? 1 : x))] };
  assert.equal(checkKissingA(close, 3).ok, false);
  assert.match(checkKissingA({ vectors: [[0.5, 1]] }, 2).reason, /integers/);
});

test("ramsey: no s-clique and no t-independent set, both searches, graph6", () => {
  for (const f of [checkRamseyA, checkRamseyB]) {
    assert.equal(f(cycle(5), 3, 3).value, "5");
    assert.match(f(cycle(6), 3, 3).reason, /independent set of 3/);
    assert.match(f({ n: 3, edges: [[0, 1], [1, 2], [0, 2]] }, 3, 3).reason, /3-clique/);
    assert.equal(f(paley17(), 4, 4).value, "17");
  }
  // C5 in graph6 is "Dhc".
  const g = parseGraph6("Dhc");
  assert.equal(g.n, 5);
  assert.equal(checkRamseyA({ graph6: "Dhc" }, 3, 3).value, "5");
  assert.equal(typeof parseGraph6("D"), "string");
  assert.match(checkRamseyA({ n: 3, edges: [[0, 3]] }, 3, 3).reason, /not between/);
});

test("ramsey: a search over its work budget is never a pass", () => {
  const saved = LIMITS.ramsey_nodes;
  LIMITS.ramsey_nodes = 3;
  try {
    const a = checkRamseyA(paley17(), 4, 4), b = checkRamseyB(paley17(), 4, 4);
    assert.equal(a.ok, false); assert.equal(a.over_budget, true);
    assert.equal(b.ok, false); assert.equal(b.over_budget, true);
    assert.equal(withoutBudget(() => checkRamseyA(paley17(), 4, 4)).ok, true);
  } finally { LIMITS.ramsey_nodes = saved; }
});

test("records: every problem is sourced and dated; kissing 11 is 604", () => {
  assert.ok(MATH_PROBLEMS.length > 40);
  for (const p of MATH_PROBLEMS) { assert.match(p.source_url, /^https:\/\//); assert.equal(p.as_of, "2026-11-04"); }
  assert.equal(mathProblem("kissing-11").record, "604");
  assert.equal(mathProblem("kissing-8").kind, "practice");
  assert.equal(mathProblem("ramsey-4-13").record, "138");
  assert.equal(mathProblem("packing-26").record, "2.635983084919");
});

test("tiers: packing needs to clear rounding; integers by count", () => {
  const p = mathProblem("packing-26");
  assert.equal(tierOf(p, "2.635983084919", p.record), "matches");
  assert.equal(tierOf(p, "2.6359830849194", p.record), "matches", "inside the listed value's rounding");
  assert.equal(tierOf(p, "2.635983084940", p.record), "record_claim");
  assert.equal(tierOf(p, "2.6350", p.record), "close");
  assert.equal(tierOf(p, "2.0", p.record), "valid");
  const k = mathProblem("kissing-11");
  assert.equal(tierOf(k, "605", "604"), "record_claim");
  assert.equal(tierOf(k, "604", "604"), "matches");
});

test("practice: checked at once, no points, failed checks say why", async () => {
  const db = makeD1();
  const a = await agent(db, "solver-1");
  const r = await submitMath(db, a, { problem_id: "kissing-8", construction: e8() });
  assert.equal(r.result, "reached_maximum");
  const r2 = await submitMath(db, a, { problem_id: "ramsey-3-3", construction: cycle(5) });
  assert.equal(r2.status, "scored");
  await rejects(submitMath(db, a, { problem_id: "ramsey-3-3", construction: cycle(6) }), 422, /more than the proven maximum/);
  await rejects(submitMath(db, a, { problem_id: "ramsey-3-4", construction: cycle(8) }), 422, /independent set/);
  await rejects(submitMath(db, a, { problem_id: "nope", construction: {} }), 404);
  await rejects(submitMath(db, a, { problem_id: "packing-2", construction: { circles: [["0.25", "0.25", "0.25"], ["0.75", "0.75", "0.25"]] } }), 409, /team/);
  const l = await listProblems(db, null);
  assert.equal(l.problems.length, MATH_PROBLEMS.length);
});

async function team(db, opts = {}) {
  const b = await agent(db, "builder-1");
  const k = await agent(db, "breaker-1");
  const t = await createTeam(db, b, { name: "Square Packers" });
  await joinTeam(db, k, { team_id: t.team.id, join_code: t.team.join_code });
  return { b, k, t };
}

test("record play: a different teammate vets; scored by tier; leaderboard", async () => {
  const db = makeD1();
  const { b, k } = await team(db);
  const s = await submitMath(db, b, { problem_id: "packing-2", construction: { circles: [["0.25", "0.25", "0.25"], ["0.75", "0.75", "0.25"]] }, credits: { tuner: k.id } });
  assert.equal(s.status, "proposed");
  assert.equal(s.standing.tier, "valid");
  await rejects(vetMath(db, b, s.id, { decision: "approve", notes: "checked it myself twice" }), 403, /different teammate/);
  await rejects(submitMath(db, b, { problem_id: "packing-2", construction: { circles: [["0.25", "0.25", "0.25"], ["0.75", "0.75", "0.25"]] }, credits: { tuner: "agt_nobody" } }), 400, /credits/);
  const v = await vetMath(db, k, s.id, { decision: "approve", notes: "reran overlap checks, looked for rounding" });
  assert.equal(v.result, "valid");
  assert.equal(v.points, MATH_POINTS.valid);
  assert.equal(v.vetter_points, MATH_POINTS.vetter_good);
  const mine = await mathMine(db, b);
  assert.equal(mine.entries[0].credits.tuner, k.id);
  assert.equal(mine.entries[0].credits.breaker, k.id);
  const lb = await scienceLeaderboard(db);
  assert.equal(lb.teams[0].points, MATH_POINTS.valid + MATH_POINTS.vetter_good);
  const pr = await getProblem(db, "packing-2");
  assert.equal(pr.leaderboard[0].value, "0.500000000000000");
  // Reject scores nothing.
  const s2 = await submitMath(db, b, { problem_id: "packing-2", construction: { circles: [["0.2", "0.2", "0.2"], ["0.7", "0.7", "0.2"]] } });
  const r = await vetMath(db, k, s2.id, { decision: "reject", notes: "worse than our last entry" });
  assert.equal(r.status, "rejected");
});

test("a record claim: both checks, shown unconfirmed, reported to operator, team and owner URLs", async () => {
  const db = makeD1();
  const { b, k } = await team(db);
  const operator = await agent(db, "site-operator");
  await rejects(setReportSettings(db, k, { urls: ["http://example.org/x"] }), 400, /https/);
  await rejects(setReportSettings(db, k, { urls: ["https://localhost/x"] }), 400);
  await setReportSettings(db, k, { urls: ["https://reports.owner-site.com/hook?token=secret"] });
  assert.equal((await getReportSettings(db, k)).also_report_to.length, 1);

  const p = mathProblem("kissing-5");
  const saved = p.record;
  p.record = "39"; // pretend the record is one below what D5 gives, so a real construction beats it
  try {
    const s = await submitMath(db, b, { problem_id: "kissing-5", construction: dRoots(5), notes: "D5 root system" });
    assert.equal(s.standing.tier, "record_claim");
    const v = await vetMath(db, k, s.id, { decision: "approve", notes: "D5 is classical; checked the literature" }, { operatorId: operator.id });
    assert.equal(v.result, "record_claim");
    assert.equal(v.claim_status, "unconfirmed");

    const c = await claimView(db, v.claim_id);
    assert.equal(c.value, "40");
    assert.equal(c.beats, "39");
    assert.equal(c.by, "1");
    assert.equal(c.construction.vectors.length, 40);
    const to = c.reported_to.map((r) => `${r.to}|${r.status}`);
    assert.ok(to.includes("the site operator's inbox|delivered"));
    assert.ok(to.includes("builder-1's inbox|delivered"));
    assert.ok(to.includes("breaker-1's inbox|delivered"));
    assert.ok(to.includes("reports.owner-site.com (chosen by breaker-1's owner)|queued"));
    assert.ok(!JSON.stringify(c).includes("token=secret"), "the full URL stays private");
    const inbox = await db.prepare("SELECT agent_id, type FROM inbox WHERE type = 'math.record_claim'").all();
    assert.equal(inbox.results.length, 3);

    // Owner URL delivery: SSRF-checked, then POSTed.
    const sent = [];
    const out = await flushMathReports(db, { fetcher: async (url, init) => { sent.push({ url, init }); return new Response("ok"); }, resolve: async () => ["93.184.216.34"], origin: "https://bounty.example" });
    assert.equal(out.delivered, 1);
    assert.equal(sent[0].url, "https://reports.owner-site.com/hook?token=secret");
    assert.equal(JSON.parse(sent[0].init.body).claim.id, v.claim_id);
    assert.equal(JSON.parse(sent[0].init.body).page, `https://bounty.example/science/math/claims/${v.claim_id}`);
    const after = await claimView(db, v.claim_id);
    assert.ok(after.reported_to.some((r) => r.to.startsWith("reports.owner-site.com") && r.status === "delivered"));

    // A private address at delivery time is refused and logged.
    await setReportSettings(db, b, { urls: ["https://rebinds.example-owner.com/h"] });
    const s2 = await submitMath(db, b, { problem_id: "kissing-5", construction: dRoots(5) });
    const v2 = await vetMath(db, k, s2.id, { decision: "approve", notes: "same construction, second claim" }, {});
    const c2 = await claimView(db, v2.claim_id);
    assert.ok(c2.reported_to.some((r) => r.to === "the site operator's inbox" && r.status === "not_configured"));
    for (let i = 0; i < 5; i++) await flushMathReports(db, { fetcher: async () => new Response("ok"), resolve: async () => ["10.0.0.1"] });
    const c3 = await claimView(db, v2.claim_id);
    assert.ok(c3.reported_to.some((r) => r.to.startsWith("rebinds.example-owner.com") && r.status === "failed"));

    // The operator's review: confirmed raises points and becomes the value to beat.
    const done = await reviewClaim(db, v.claim_id, { decision: "confirmed", note: "keeper accepted" });
    assert.equal(done.status, "confirmed");
    assert.equal((await currentRecord(db, p)).value, "40");
    await rejects(reviewClaim(db, v.claim_id, { decision: "published" }), 400);
    const reviewed = await db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE type = 'math.claim_reviewed'").first();
    assert.equal(reviewed.n, 2);
    const stats = await mathStats(db);
    assert.equal(stats.confirmed_records, 1);
    assert.equal((await listClaims(db)).claims.length, 2);

    // Pages render the claim with where it went, escaped.
    const html = await (await mathClaimPage({ DB: db }, v.claim_id)).text();
    assert.match(html, /site operator&#39;s inbox|site operator's inbox/);
    assert.match(html, /reports\.owner-site\.com/);
    assert.ok(!html.includes("token=secret"));
  } finally { p.record = saved; }
});

test("team of one: the house check stands in, no vetter points", async () => {
  const db = makeD1();
  const a = await agent(db, "solo-1");
  await createTeam(db, a, { name: "Lone Ramsey" });
  const s = await submitMath(db, a, { problem_id: "ramsey-3-10", construction: cycle(5) });
  await rejects(vetMath(db, a, s.id, { decision: "approve", notes: "checked it, all good" }), 403);
  const v = await houseVetMath(db, a, s.id);
  assert.equal(v.status, "scored");
  assert.equal(v.result, "valid");
  assert.equal(v.vetter_points, 0);
});

test("pages: /science has the math section; problem page shows the source", async () => {
  const db = makeD1();
  const html = await (await sciencePage({ DB: db })).text();
  assert.match(html, /id="math"/);
  assert.match(html, /Math Record Hunt/);
  assert.match(html, /kissing-11/);
  const pp = await (await mathProblemPage({ DB: db }, "kissing-11")).text();
  assert.match(pp, /604/);
  assert.match(pp, /wikipedia\.org/);
});
