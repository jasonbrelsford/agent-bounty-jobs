// Open science challenges: planet hunting. Teams, two-step vetting, hidden-star
// scoring against a private key, practice stars, open-sky review and the home section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey } from "../.test-build/core.js";
import {
  scoreClaim, POINTS, createTeam, joinTeam, myTeam, leaveTeam, listPuzzles, getPuzzle, puzzleCsv, submit, vet,
  reviewCandidate, candidates, scienceLeaderboard, planetStats, SCI,
} from "../.test-build/science/planets.js";
import { SEASON } from "../.test-build/science/planet-puzzles.js";
import { homeSection, sciencePage, planetPuzzlePage } from "../.test-build/science/page.js";

const agent = async (db, name) => authByKey(db, (await registerAgent(db, name, { contact_email: `${name}@example.com` })).api_key);
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));
const HID = SEASON.puzzles.find((p) => p.kind === "hidden").id;
const HID2 = SEASON.puzzles.filter((p) => p.kind === "hidden")[1].id;
const PRAC = SEASON.puzzles.find((p) => p.kind === "practice");
const ANS = { has_planet: 1, period_days: 3.2, t0_days: 1.1, depth_ppm: 800, duration_hours: 2.4 };
const putAnswer = (db, id, a) => db.prepare(
  "INSERT INTO sci_answers (puzzle_id, has_planet, period_days, t0_days, depth_ppm, duration_hours, source_tic, source_sector) VALUES (?, ?, ?, ?, ?, ?, 1, 90)",
).bind(id, a.has_planet, a.period_days ?? null, a.t0_days ?? null, a.depth_ppm ?? null, a.duration_hours ?? null).run();

async function team(db) {
  const h = await agent(db, "hunter-1");
  const v = await agent(db, "vetter-1");
  const t = await createTeam(db, h, { name: "Transit Crew" });
  await joinTeam(db, v, { team_id: t.team.id, join_code: t.team.join_code });
  return { h, v, t };
}

test("scoring: hit, depth off, alias, miss, false alarm, empty and missed planet", () => {
  const c = (o) => scoreClaim(ANS, { verdict: "planet", period_days: 3.2, t0: 1.1, depth_ppm: 800, ...o });
  assert.deepEqual([c({}).result, c({}).points], ["hit", POINTS.hit]);
  assert.equal(c({ t0: 1.1 + 3 * 3.2 + 0.03 }).result, "hit", "any later transit counts as the epoch");
  assert.equal(c({ depth_ppm: 5000 }).points, POINTS.hit_depth_off);
  assert.equal(c({ period_days: 6.4 }).result, "alias");
  assert.equal(c({ period_days: 1.6 }).result, "alias");
  assert.equal(c({ period_days: 3.3 }).result, "miss", "3% off is not within 1%");
  assert.equal(c({ t0: 2.0 }).result, "miss", "right period, wrong timing");
  assert.equal(scoreClaim(ANS, { verdict: "none" }).result, "missed_planet");
  assert.equal(scoreClaim({ has_planet: 0 }, { verdict: "planet", period_days: 2, t0: 1, depth_ppm: 100 }).points, POINTS.false_alarm);
  assert.equal(scoreClaim({ has_planet: 0 }, { verdict: "none" }).points, POINTS.correct_empty);
});

test("season data: real light curves, no answers for hidden stars", () => {
  const hidden = SEASON.puzzles.filter((p) => p.kind === "hidden");
  assert.ok(hidden.length >= 20);
  for (const p of hidden) {
    assert.equal(p.answer, undefined, "hidden answers must never ship in the code");
    assert.equal(p.tic_id, undefined, "hidden source stars must never ship in the code");
    assert.ok(p.flux_ppm.length > 1000);
  }
  const g = getPuzzle(HID);
  assert.equal(g.time_days.length, g.flux_ppm.length);
  assert.ok(puzzleCsv(HID).startsWith("time_days,flux_ppm\n"));
  assert.ok(PRAC.answer.period_days > 0);
});

test("teams: join code, one team per agent, size limit", async () => {
  const db = makeD1();
  const { h, t } = await team(db);
  await rejects(createTeam(db, h, { name: "Second" }), 409);
  const x = await agent(db, "stranger");
  await rejects(joinTeam(db, x, { team_id: t.team.id, join_code: "wrong" }), 404);
  for (let i = 0; i < SCI.team_max - 2; i++) await joinTeam(db, await agent(db, `member-${i}`), { team_id: t.team.id, join_code: t.team.join_code });
  await rejects(joinTeam(db, x, { team_id: t.team.id, join_code: t.team.join_code }), 409, /full/);
  const mine = await myTeam(db, h);
  assert.equal(mine.team.members.length, SCI.team_max);
  await leaveTeam(db, x).catch(() => {});
});

test("hidden star: propose, a different teammate vets, it scores; two attempts max", async () => {
  const db = makeD1();
  const { h, v } = await team(db);
  await putAnswer(db, HID, ANS);
  const s = await submit(db, h, { puzzle_id: HID, verdict: "planet", period_days: 3.21, t0: 1.12, depth_ppm: 760, notes: "BLS peak" });
  assert.equal(s.status, "proposed");
  await rejects(vet(db, h, s.id, { decision: "approve", notes: "I checked my own work" }), 403, /different teammate/);
  await rejects(vet(db, v, s.id, { decision: "approve", notes: "short" }), 400);
  const r = await vet(db, v, s.id, { decision: "approve", notes: "odd and even dips match, no secondary" });
  assert.equal(r.result, "hit");
  assert.equal(r.points, POINTS.hit);
  assert.equal(r.vetter_points, POINTS.vetter_good);
  const s2 = await submit(db, h, { puzzle_id: HID, verdict: "none" });
  const r2 = await vet(db, v, s2.id, { decision: "approve", notes: "flat after detrending, nothing there" });
  assert.equal(r2.result, "missed_planet");
  await rejects(submit(db, h, { puzzle_id: HID, verdict: "none" }), 409, /attempts/);
  const lb = await scienceLeaderboard(db);
  assert.equal(lb.teams[0].points, POINTS.hit + POINTS.vetter_good + POINTS.missed_planet + POINTS.vetter_bad);
  assert.equal(lb.teams[0].hits, 1);
  assert.equal((await planetStats(db)).hidden_planets_caught, 1);
  const list = await listPuzzles(db, h);
  assert.equal(list.puzzles.find((p) => p.id === HID).attempts_left, 0);
});

test("a rejection scores nothing and does not use an attempt; no key means scoring is not open", async () => {
  const db = makeD1();
  const { h, v } = await team(db);
  const s = await submit(db, h, { puzzle_id: HID2, verdict: "planet", period_days: 2, t0: 0.5, depth_ppm: 300 });
  await rejects(vet(db, v, s.id, { decision: "approve", notes: "folded and it looks real" }), 503, /not open/);
  const r = await vet(db, v, s.id, { decision: "reject", notes: "odd and even dips differ: eclipsing binary" });
  assert.equal(r.status, "rejected");
  assert.equal(r.points, undefined, "a rejection reveals nothing");
  assert.equal((await scienceLeaderboard(db)).teams.length, 0);
});

test("hidden and open-sky play need a team; practice does not and returns the answer", async () => {
  const db = makeD1();
  const solo = await agent(db, "solo");
  await rejects(submit(db, solo, { puzzle_id: HID, verdict: "none" }), 403, /team/);
  const a = PRAC.answer;
  const r = await submit(db, solo, { puzzle_id: PRAC.id, verdict: "planet", period_days: a.period_days, t0: a.t0_days, depth_ppm: a.depth_ppm });
  assert.equal(r.result, "hit");
  assert.equal(r.answer.period_days, a.period_days);
  await rejects(submit(db, solo, { puzzle_id: PRAC.id, verdict: "planet", period_days: 99, t0: 1, depth_ppm: 1 }), 400);
});

test("open sky: known stars are marked known, new ones wait for human review, review can promote", async () => {
  const db = makeD1();
  const { h, v } = await team(db);
  const claim = (tic) => submit(db, h, { tic_id: tic, sector: 90, period_days: 4.5, t0: 3300.1, depth_ppm: 1200, snr: 9.4, notes: "candidate from BLS" });
  await rejects(submit(db, h, { tic_id: 5, sector: 90, period_days: 4.5, t0: 3300.1, depth_ppm: 1200, snr: 3 }), 400, /snr/);
  const known = await claim(25155310);
  const k = await vet(db, v, known.id, { decision: "approve", notes: "clean transits, matches on both halves" }, async () => ({ known: "toi", label: "TOI-114.01 (KP)" }));
  assert.equal(k.status, "known");
  const fresh = await claim(123456789);
  await rejects(claim(123456789), 409, /already submitted/);
  const n = await vet(db, v, fresh.id, { decision: "approve", notes: "odd/even consistent, no secondary eclipse" }, async () => ({ known: null }));
  assert.equal(n.status, "review");
  let html = await homeSection({ DB: db });
  assert.match(html, /TIC 123456789/);
  assert.match(html, /candidate, waiting for human review/);
  assert.doesNotMatch(html, /25155310/, "already-known stars are not shown as finds");
  await rejects(reviewCandidate(db, known.id, { decision: "promote" }), 409);
  await reviewCandidate(db, fresh.id, { decision: "promote", note: "looks good; worth a CTOI" });
  const c = await candidates(db);
  assert.equal(c.candidates.find((x) => x.id === fresh.id).label, "candidate, passed human review");
  assert.equal((await scienceLeaderboard(db)).teams[0].promoted, 1);
  const offline = await claim(222);
  const u = await vet(db, v, offline.id, { decision: "approve", notes: "looks like a real transit" }, async () => null);
  assert.equal(u.result, "unchecked");
  assert.equal(u.status, "review");
});

test("home section and pages: empty state is honest, names are escaped", async () => {
  const db = makeD1();
  const html = await homeSection({ DB: db });
  assert.match(html, /No real-sky candidates yet/);
  assert.match(html, /<strong>0<\/strong> hidden test planets caught/);
  const h = await agent(db, "esc");
  await createTeam(db, h, { name: "<script>x</script>" });
  const page = await (await sciencePage({ DB: db })).text();
  assert.match(page, /Open science challenges/);
  const p = await (await planetPuzzlePage({ DB: db }, HID)).text();
  assert.match(p, /<svg/);
});
