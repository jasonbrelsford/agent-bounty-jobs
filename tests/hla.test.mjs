// Open science challenges: HLA lab-report cleanup. Scoring, season data with no hidden
// answers, practice play, team vetting against a private key, and the pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey } from "../.test-build/core.js";
import { createTeam, joinTeam, myTeam, scienceLeaderboard, planetStats, vet as planetVet } from "../.test-build/science/planets.js";
import { scoreSlot, scoreReport, parseAnswers, listReports, getReport, submitReport, vetReport, myReports, hlaStats, HLA, HLA_POINTS } from "../.test-build/science/hla.js";
import { HLA_SEASON } from "../.test-build/science/hla-puzzles.js";
import { homeSection, sciencePage, hlaReportPage } from "../.test-build/science/page.js";

const agent = async (db, name) => authByKey(db, (await registerAgent(db, name, { contact_email: `${name}@example.com` })).api_key);
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));
const hidden = HLA_SEASON.puzzles.filter((p) => p.kind === "hidden");
const practice = HLA_SEASON.puzzles.filter((p) => p.kind === "practice");
const HID = hidden[0];
const KEY = ["A*02:01", "A*24:02", "B*07:02", "B*07:02", "C*05:01/C*05:03/C*05:04", "INVALID", "DRB1*15:01", "DRB1*03:01", "DQB1*06:02", "DQB1*02:01"];
const putKey = (db, id, key) => db.prepare("INSERT INTO sci_hla_answers (puzzle_id, key_json) VALUES (?, ?)").bind(id, JSON.stringify(key)).run();

async function team(db) {
  const h = await agent(db, "reader-1");
  const v = await agent(db, "checker-1");
  const t = await createTeam(db, h, { name: "Typing Fixers" });
  await joinTeam(db, v, { team_id: t.team.id, join_code: t.team.join_code });
  return { h, v, t };
}

test("slot scoring: right, wrong, unsure, invalid, cut-off lists", () => {
  assert.equal(scoreSlot("A*02:01", "A*02:01"), 1);
  assert.equal(scoreSlot("A*02:01", "HLA-A*02:01"), 1, "an HLA- prefix is tolerated");
  assert.equal(scoreSlot("A*02:01", "A*02:01:01"), -1, "the answer is the 2-field name");
  assert.equal(scoreSlot("A*02:01", "UNSURE"), 0);
  assert.equal(scoreSlot("INVALID", "invalid"), 1);
  assert.equal(scoreSlot("INVALID", "A*02:01"), -1, "repairing a name that never existed is wrong");
  const cut = "C*05:01/C*05:03/C*05:04";
  assert.equal(scoreSlot(cut, "C*05:04 / C*05:01/C*05:03"), 1, "list order and spaces do not matter");
  assert.equal(scoreSlot(cut, "C*05:01/C*05:03"), 0, "a partial list scores nothing");
  assert.equal(scoreSlot(cut, "C*05:01"), -1, "guessing one name for a cut-off text is overclaiming");
  assert.equal(scoreSlot(cut, "C*05:01/C*05:02/C*05:03/C*05:04"), 0, "a list with an extra name scores nothing");
  assert.equal(scoreSlot("A*02:01", "A*02:01/A*02:02"), -1, "hedging on a readable name is wrong");
});

test("report scoring: either allele order per locus, floor, solved", () => {
  assert.deepEqual([scoreReport(KEY, KEY).points, scoreReport(KEY, KEY).result], [10, "solved"]);
  const swapped = [...KEY]; [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.equal(scoreReport(KEY, swapped).points, 10);
  assert.equal(scoreReport(KEY, Array(10).fill("UNSURE")).points, 0);
  assert.equal(scoreReport(KEY, Array(10).fill("A*99:99")).points, HLA_POINTS.floor);
  assert.equal(scoreReport(KEY, Array(10).fill("A*99:99")).result, "miss");
});

test("season data: synthetic reports, practice answers score perfectly, no hidden answers in the code", () => {
  assert.ok(hidden.length >= 20);
  assert.ok(practice.length >= 3);
  for (const p of HLA_SEASON.puzzles) {
    assert.match(p.text, /SYNTHETIC REPORT/);
    assert.match(p.text, /not a real person/);
    assert.equal(p.slots.length, HLA.slots);
    assert.equal(p.written.length, HLA.slots);
  }
  for (const p of hidden) {
    assert.equal(p.answer, undefined, "hidden answers must never ship in the code");
    assert.equal(p.kinds, undefined, "hidden slot kinds must never ship in the code");
  }
  for (const p of practice) assert.equal(scoreReport(p.answer, p.answer).points, HLA.slots);
  assert.ok(HLA_SEASON.baseline.points < HLA_SEASON.baseline.max / 2, "a name checker alone must not solve the season");
  assert.equal(HLA_SEASON.baseline.max, hidden.length * HLA.slots);
  const g = getReport(HID.id);
  assert.equal(g.answer, undefined);
  assert.equal(g.kinds, undefined);
  assert.deepEqual(g.written, HID.written, "each slot's text as written comes with the report");
});

test("answers: slot-keyed objects, exact length, no stray characters", () => {
  const obj = Object.fromEntries(HID.slots.map((s, i) => [s, KEY[i]]));
  assert.deepEqual(parseAnswers(HID, obj), KEY);
  assert.throws(() => parseAnswers(HID, KEY.slice(0, 9)), (e) => e.status === 400);
  assert.throws(() => parseAnswers(HID, [...KEY.slice(0, 9), "<script>"]), (e) => e.status === 400);
  assert.throws(() => parseAnswers(HID, [...KEY.slice(0, 9), ""]), (e) => e.status === 400);
});

test("practice: no team needed, answers come back slot by slot", async () => {
  const db = makeD1();
  const solo = await agent(db, "solo-reader");
  const p = practice[0];
  const r = await submitReport(db, solo, { puzzle_id: p.id, answers: p.answer });
  assert.equal(r.result, "solved");
  assert.equal(r.slots.length, 10);
  assert.equal(r.slots[0].answer, p.answer[0]);
  assert.ok(r.slots[0].what_it_was);
  const wrong = await submitReport(db, solo, { puzzle_id: p.id, answers: Array(10).fill("UNSURE") });
  assert.equal(wrong.report_points, 0);
  assert.equal((await scienceLeaderboard(db)).teams.length, 0, "practice scores no points");
  await rejects(submitReport(db, solo, { puzzle_id: HID.id, answers: KEY }), 403, /team/);
  await rejects(submitReport(db, solo, { puzzle_id: "hz_nope", answers: KEY }), 404);
});

test("hidden report: propose, a different teammate vets, total only, best attempt counts, two max", async () => {
  const db = makeD1();
  const { h, v } = await team(db);
  const s = await submitReport(db, h, { puzzle_id: HID.id, answers: KEY, notes: "checked against 3.66.0" });
  assert.equal(s.status, "proposed");
  await rejects(vetReport(db, v, s.id, { decision: "approve", notes: "each name checked in Allelelist" }), 503, /not open/);
  await putKey(db, HID.id, KEY);
  await rejects(vetReport(db, h, s.id, { decision: "approve", notes: "my own work looks fine" }), 403, /different teammate/);
  await rejects(planetVet(db, v, s.id, { decision: "approve", notes: "this is the planet route" }), 404, /planet/);
  const r = await vetReport(db, v, s.id, { decision: "approve", notes: "each name checked in Allelelist" });
  assert.deepEqual([r.result, r.report_points, r.vetter_points], ["solved", 10, HLA_POINTS.vetter_good]);
  assert.equal(r.per_slot, undefined, "hidden results never say which slots were right");
  assert.equal(r.slots, undefined);
  const worse = [...KEY]; worse[0] = "A*02:02";
  const s2 = await submitReport(db, h, { puzzle_id: HID.id, answers: worse });
  const r2 = await vetReport(db, v, s2.id, { decision: "approve", notes: "second try after a recheck" });
  assert.equal(r2.report_points, 8);
  await rejects(submitReport(db, h, { puzzle_id: HID.id, answers: KEY }), 409, /attempts/);
  const lb = await scienceLeaderboard(db);
  assert.equal(lb.teams[0].points, 10 + HLA_POINTS.vetter_good * 2, "best attempt per report counts; vetter points add up");
  assert.equal(lb.teams[0].hla_solved, 1);
  assert.equal(lb.teams[0].hits, 0);
  const st = await hlaStats(db);
  assert.deepEqual([st.reports_solved, st.scored_attempts, st.best_team_points], [1, 2, 10]);
  assert.equal((await planetStats(db)).hidden_planets_caught, 0, "HLA results never count as planets");
  const list = await listReports(db, h);
  assert.deepEqual(list.reports.find((x) => x.id === HID.id).your_team, { attempts: 2, best: 10 });
  assert.equal((await myReports(db, v)).submissions.length, 2);
  const mine = await myTeam(db, h);
  assert.equal(mine.recent[0].challenge, "hla");
});

test("a rejection scores nothing, reveals nothing and does not use an attempt", async () => {
  const db = makeD1();
  const { h, v } = await team(db);
  await putKey(db, HID.id, KEY);
  const s = await submitReport(db, h, { puzzle_id: HID.id, answers: Array(10).fill("UNSURE") });
  const r = await vetReport(db, v, s.id, { decision: "reject", notes: "too many skipped slots, redo it" });
  assert.equal(r.status, "rejected");
  assert.equal(r.report_points, undefined);
  for (let i = 0; i < HLA.attempts_per_report; i++) {
    const x = await submitReport(db, h, { puzzle_id: HID.id, answers: KEY });
    await vetReport(db, v, x.id, { decision: "approve", notes: "rechecked all ten slots" });
  }
});

test("pages: HLA section with honest zeros, report page escapes text, home shows the bar to beat", async () => {
  const db = makeD1();
  const page = await (await sciencePage({ DB: db })).text();
  assert.match(page, /HLA lab-report cleanup/);
  assert.match(page, /synthetic, about no real person/);
  assert.match(page, /CC BY-ND/);
  assert.match(page, new RegExp(`<b>${HLA_SEASON.baseline.points}</b>`));
  const rp = await (await hlaReportPage({ DB: db }, HID.id)).text();
  assert.match(rp, /<pre>SYNTHETIC REPORT/);
  assert.doesNotMatch(rp, /<script/);
  await rejects(hlaReportPage({ DB: db }, "nope"), 404);
  const home = await homeSection({ DB: db });
  assert.match(home, /HLA lab-report cleanup/);
  assert.match(home, /<strong>0<\/strong> of \d+ test reports fully cleaned/);
});
