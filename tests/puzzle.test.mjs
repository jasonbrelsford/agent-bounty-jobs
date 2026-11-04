// The daily chess puzzle drill, against the real migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey } from "../.test-build/core.js";
import { PUZZLE_DATA } from "../.test-build/puzzledata.js";
import {
  puzzleView, puzzleMove, puzzlePractice, puzzleLeaderboard, streakOf, dayIndex, lesson,
  PUZZLE_EPOCH, DAILY_COUNT, PRACTICE_COUNT, _internal,
} from "../.test-build/puzzle.js";
import { puzzlePage, arenaPage } from "../.test-build/arenapage.js";

let n = 0;
async function agent(db, name, kind) {
  const r = await registerAgent(db, name, { contact_email: `z${++n}@example.com`, kind });
  return await authByKey(db, r.api_key);
}
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));
const day = (i, hour = 12) => new Date(Date.parse(PUZZLE_EPOCH + "T00:00:00Z") + i * 86_400_000 + hour * 3_600_000);
const toMove = (u) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });

/** Play a puzzle's whole solution through the API; returns the last result. */
async function solve(db, a, id, now) {
  const p = id.startsWith("pp_") ? _internal.practiceAt(Number(id.slice(3))) : _internal.puzzleAt(Number(id.slice(3)));
  let r;
  for (let i = 0; i < p.line.length; i += 2) {
    r = await puzzleMove(db, a, id, { move: p.line[i] }, now);
    if (r.status !== "active") break;
  }
  return r;
}

test("every puzzle replays legally, and every mate puzzle ends in mate", () => {
  assert.ok(PUZZLE_DATA.length >= 150, "enough for months of dailies");
  assert.equal(DAILY_COUNT + PRACTICE_COUNT, PUZZLE_DATA.length);
  const ids = new Set();
  for (const [id, fen, moves, rating, themes] of PUZZLE_DATA) {
    assert.ok(!ids.has(id), `duplicate ${id}`); ids.add(id);
    const c = new Chess(fen);
    const ms = moves.split(" ");
    assert.ok(ms.length >= 2 && ms.length % 2 === 0, `${id}: the opponent's move, then whole solver/reply pairs`);
    for (const u of ms) c.move(toMove(u));
    if (/mateIn\d/.test(themes)) assert.ok(c.isCheckmate(), `${id} should end in mate`);
    assert.ok(rating > 300 && rating < 3200);
  }
});

test("the schedule: one daily per UTC day, no peeking ahead, practice ids work", async () => {
  const db = makeD1();
  assert.equal(dayIndex(PUZZLE_EPOCH), 0);
  const v = await puzzleView(db, "today", null, day(3));
  assert.equal(v.id, "pz_0003");
  assert.equal(v.daily, true);
  assert.equal(v.day, "2026-11-07");
  assert.match(v.task, /^(White|Black) to move: /);
  assert.equal(v.next_puzzle_at, "2026-11-08T00:00:00.000Z");
  assert.equal(v.seconds_to_next, 12 * 3600);
  assert.ok(v.opponent_last_move, "the opponent's last move is shown");
  assert.equal(v.explanation, undefined);
  assert.equal(JSON.stringify(v).includes(_internal.puzzleAt(3).line[0]), false, "the answer is not in the public view");
  await rejects(puzzleView(db, "pz_0004", null, day(3)), 404);
  const past = await puzzleView(db, "pz_0001", null, day(3));
  assert.equal(past.daily, false);
  const pp = await puzzleView(db, "pp_0000", null, day(3));
  assert.equal(pp.daily, false);
  assert.equal(pp.day, null);
  await rejects(puzzleView(db, `pp_${String(PRACTICE_COUNT).padStart(4, "0")}`, null, day(3)), 404);
  // The schedule wraps instead of running out, and never serves a practice puzzle as a daily.
  const wrapped = await puzzleView(db, "today", null, day(DAILY_COUNT + 2));
  assert.equal(wrapped.fen, _internal.puzzleAt(2).fen);
});

test("solving today's puzzle: replies come back, then the lesson, the streak and the board", async () => {
  const db = makeD1();
  const a = await agent(db, "sharp-agent");
  const p = _internal.puzzleAt(0);
  const before = await puzzleView(db, "today", a, day(0));
  assert.equal(before.you.status, "not_started");
  assert.ok(before.you.legal_uci.includes(p.line[0]));
  let r = await puzzleMove(db, a, "today", { move: p.line[0] }, day(0));
  if (p.line.length > 2) {
    assert.equal(r.status, "active");
    assert.ok(r.opponent_reply);
    assert.equal(r.moves.length, 2);
    assert.match(r.message, /opponent answered/);
    for (let i = 2; i < p.line.length && r.status === "active"; i += 2) r = await puzzleMove(db, a, "today", { move: p.line[i] }, day(0));
  }
  assert.equal(r.status, "solved");
  assert.match(r.message, /streak/);
  assert.deepEqual(r.your_streak, { current: 1, best: 1 });
  assert.ok(r.explanation.idea.length > 20);
  assert.ok(r.explanation.habit.length > 20);
  assert.match(r.explanation.source, /Lichess puzzle/);
  await rejects(puzzleMove(db, a, "today", { move: p.line[0] }, day(0)), 409, /already solved/);
  const after = await puzzleView(db, "today", null, day(0));
  assert.equal(after.today.solved, 1);
  assert.equal(after.today.solvers[0].name, "sharp-agent");
});

test("a wrong move ends the attempt and shows the line; an illegal one doesn't count", async () => {
  const db = makeD1();
  const a = await agent(db, "hasty-agent");
  const p = _internal.puzzleAt(1);
  await rejects(puzzleMove(db, a, "today", { move: "Ke9" }, day(1)), 400, /illegal/);
  assert.equal((await puzzleView(db, "today", a, day(1))).you.status, "not_started");
  const wrong = new Chess(p.fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ""))
    .find((u) => u !== p.line[0] && (() => { const c = new Chess(p.fen); c.move(toMove(u)); return !c.isCheckmate(); })());
  const r = await puzzleMove(db, a, "today", { move: wrong }, day(1));
  assert.equal(r.status, "failed");
  assert.match(r.message, /The line was/);
  assert.equal(r.explanation.main_line, lesson(p).main_line);
  assert.deepEqual(r.your_streak, { current: 0, best: 0 });
  await rejects(puzzleMove(db, a, "today", { move: p.line[0] }, day(1)), 409, /already failed/);
});

test("streaks count consecutive days solved first try", async () => {
  assert.deepEqual(streakOf([], "2026-11-10"), { current: 0, best: 0 });
  assert.deepEqual(streakOf(["2026-11-08", "2026-11-09"], "2026-11-10"), { current: 2, best: 2 }, "today not done yet still keeps yesterday's run");
  assert.deepEqual(streakOf(["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"], "2026-11-10"), { current: 2, best: 3 });
  assert.deepEqual(streakOf(["2026-11-04"], "2026-11-10"), { current: 0, best: 1 });

  const db = makeD1();
  const a = await agent(db, "daily-agent");
  const b = await agent(db, "Pat", "human");
  for (const i of [0, 1, 2]) await solve(db, a, `pz_000${i}`, day(i));
  await solve(db, b, "pz_0002", day(2));
  // Solving a past daily later is practice: it doesn't build a streak.
  await solve(db, b, "pz_0000", day(2));
  const lb = await puzzleLeaderboard(db, day(2));
  assert.equal(lb.ladder[0].name, "daily-agent");
  assert.equal(lb.ladder[0].current, 3);
  assert.equal(lb.ladder[1].name, "Pat");
  assert.equal(lb.ladder[1].solved, 1);
});

test("practice: unscored, never today's, and you don't get the same one twice", async () => {
  const db = makeD1();
  const a = await agent(db, "practice-agent");
  const seen = new Set();
  for (let k = 0; k < 4; k++) {
    const pr = await puzzlePractice(db, a, day(0));
    assert.equal(pr.daily, false);
    assert.notEqual(pr.id, "pz_0000");
    assert.ok(!seen.has(pr.id)); seen.add(pr.id);
    const r = await solve(db, a, pr.id, day(0));
    assert.equal(r.status, "solved");
    assert.equal(r.your_streak, undefined);
  }
  assert.equal((await puzzleLeaderboard(db, day(0))).ladder.length, 0, "practice never reaches the streak ladder");
});

test("pages: the puzzle page and the arena link, with names escaped", async () => {
  const db = makeD1();
  const evil = await agent(db, "<img src=x onerror=alert(1)>");
  const today = dayIndex(new Date().toISOString().slice(0, 10));
  await solve(db, evil, `pz_${String(today).padStart(4, "0")}`, new Date());
  const html = await (await puzzlePage({ DB: db })).text();
  assert.match(html, /Daily chess puzzle/);
  assert.match(html, /id="pzboard"/);
  assert.match(html, /data-until="/);
  assert.match(html, /1 solved of 1/);
  assert.ok(!html.includes("<img src=x"), "names are escaped");
  assert.match(html, /Lichess puzzle database/);
  const ap = await (await arenaPage({ DB: db })).text();
  assert.match(ap, /href="\/arena\/puzzle"/);
});
