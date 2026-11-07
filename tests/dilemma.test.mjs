// The prisoner's dilemma experiment, against the real migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey } from "../.test-build/core.js";
import {
  PD, STRATEGIES, houseMove, drawLength, modelFamily, dilemmaPlay, dilemmaMove, dilemmaLeave, getDilemma, myDilemmaMatches,
  listDilemma, dilemmaReview, dilemmaResults, dilemmaCsv, dilemmaSweep, _internal,
} from "../.test-build/dilemma.js";
import { dilemmaPage, dilemmaMatchPage } from "../.test-build/dilemmapage.js";
import { arenaPage } from "../.test-build/arenapage.js";

let n = 0;
async function agent(db, name) {
  const r = await registerAgent(db, name, { contact_email: `pd${++n}@example.com` });
  return await authByKey(db, r.api_key);
}
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));
/** Pin a match to a known opponent and length so a test can play it out. */
const pin = (db, id, opponent, rounds) => db.prepare("UPDATE pd_matches SET opponent = ?, rounds_total = ? WHERE id = ?").bind(opponent, rounds, id).run();
const play = (moves, a) => moves.map((x, i) => ({ a: a[i], o: x, reason: null, at: "" }));

test("the strategies play as their names say", () => {
  const vs = (key, agentMoves) => {
    const ms = [];
    for (const a of agentMoves) { const o = houseMove(key, "pdm_test", ms); ms.push({ a, o, reason: null, at: "" }); }
    return ms.map((m) => m.o).join("");
  };
  assert.equal(vs("tit_for_tat", ["C", "D", "C", "C"]), "CCDC");
  assert.equal(vs("suspicious_tit_for_tat", ["C", "C", "D"]), "DCC");
  assert.equal(vs("tit_for_two_tats", ["D", "C", "D", "D", "C"]), "CCCCD");
  assert.equal(vs("grudger", ["C", "D", "C", "C"]), "CCDD");
  assert.equal(vs("always_defect", ["C", "C"]), "DD");
  assert.equal(vs("always_cooperate", ["D", "D"]), "CC");
  // Pavlov: C; after (C vs C) stay C; after (C vs D) it got 0, shift to D; after (D vs D) it got 1, shift to C.
  assert.equal(vs("pavlov", ["C", "D", "D", "C"]), "CCDC");
  // Random strategies replay the same way for the same match and round.
  assert.equal(vs("random", ["C", "C", "C", "C", "C", "C"]), vs("random", ["D", "D", "D", "D", "D", "D"]));
  assert.equal(Object.keys(STRATEGIES).length, 9);
});

test("match length and model families", () => {
  let lo = 99, hi = 0;
  for (let i = 0; i < 2000; i++) { const l = drawLength(); lo = Math.min(lo, l); hi = Math.max(hi, l); }
  assert.equal(lo, PD.min_rounds);
  assert.ok(hi <= PD.max_rounds && hi > 20);
  assert.equal(modelFamily("claude-sonnet-4.5"), "claude");
  assert.equal(modelFamily("GPT-5 mini".toLowerCase()), "gpt");
  assert.equal(modelFamily("gemini 2.5 pro"), "gemini");
  assert.equal(modelFamily("qwen3.5:9b"), "qwen");
  assert.equal(modelFamily("my own"), "other");
  assert.equal(modelFamily(null), "not stated");
});

test("a match against Grudger: hidden while it runs, revealed and reviewed at the end", async () => {
  const db = makeD1();
  const me = await agent(db, "trusty");
  const other = await agent(db, "nosy");
  const g = await dilemmaPlay(db, me, { model: "Claude-Sonnet", approach: "open with C" });
  assert.equal(g.status, "active");
  assert.equal(g.opponent.id, "hidden");
  assert.equal(g.rounds_total, null);
  assert.equal(g.agent.model, "claude-sonnet");
  await pin(db, g.id, "grudger", 10);
  await rejects(dilemmaMove(db, other, g.id, { move: "cooperate" }), 403);
  await rejects(dilemmaMove(db, me, g.id, { move: "maybe" }), 400, /cooperate/);
  await rejects(dilemmaMove(db, me, g.id, { move: "C", reason: "x".repeat(281) }), 400);
  const r1 = await dilemmaMove(db, me, g.id, { move: "cooperate", reason: "good faith" });
  assert.deepEqual(r1.round, { n: 1, you: "C", opponent: "C", your_points: 3, their_points: 3 });
  assert.equal(r1.opponent.id, "hidden", "still hidden mid-match");
  assert.ok(!JSON.stringify(await getDilemma(db, g.id)).includes("grudger"), "the public view never names it early");
  await rejects(dilemmaReview(db, g.id), 409, /review opens/);
  const r2 = await dilemmaMove(db, me, g.id, { move: "D", reason: "testing them" });
  assert.equal(r2.round.opponent, "C");
  let last;
  for (let i = 3; i <= 10; i++) last = await dilemmaMove(db, me, g.id, { move: "C" });
  assert.equal(last.status, "finished");
  assert.equal(last.opponent.name, "Grudger");
  assert.match(last.message, /last round.*Grudger/);
  // C C, D C, then Grudger defects forever while we cooperate: 3 + 5 + 0*8 = 8 to us, 3 + 0 + 5*8 = 43 to them.
  assert.deepEqual([last.score.you, last.score.opponent], [8, 43]);
  await rejects(dilemmaMove(db, me, g.id, { move: "C" }), 409);
  const rv = await dilemmaReview(db, g.id);
  assert.equal(rv.opponent.name, "Grudger");
  assert.equal(rv.your_choices.exploited_by_them, 8);
  assert.equal(rv.your_choices.unprovoked_defections, 1);
  assert.equal(rv.your_choices.after_their_defection.forgave, 7);
  const allC = rv.fixed_policies_against_this_opponent.find((x) => x.policy === "always cooperate");
  assert.equal(allC.would_have_scored, 30);
  assert.ok(rv.lessons.some((l) => /always cooperate every round would have scored 30/.test(l)));
  assert.ok(rv.lessons.some((l) => /defected 1 times when they had just cooperated/.test(l)));
  const page = await (await dilemmaMatchPage({ DB: db }, g.id)).text();
  assert.match(page, /Grudger/);
  assert.match(page, /testing them/);
});

test("results: overall and by model, the ladder and the CSV", async () => {
  const db = makeD1();
  const nice = await agent(db, "nice-<b>");
  const mean = await agent(db, "mean");
  for (let k = 0; k < 3; k++) {
    const a = await dilemmaPlay(db, nice, { model: "claude-haiku" });
    await pin(db, a.id, "tit_for_tat", 8);
    for (let i = 0; i < 8; i++) await dilemmaMove(db, nice, a.id, { move: "C", reason: k === 0 && i === 0 ? '=cmd, "quoted"' : null });
  }
  const b = await dilemmaPlay(db, mean, { model: "gpt-5" });
  await pin(db, b.id, "tit_for_tat", 8);
  for (let i = 0; i < 8; i++) await dilemmaMove(db, mean, b.id, { move: "D" });
  const r = await dilemmaResults(db);
  assert.equal(r.overall.matches, 4);
  assert.equal(r.overall.agents, 2);
  assert.equal(r.overall.first_move_cooperate_pct, 75);
  const claude = r.by_model.find((x) => x.model === "claude");
  const gpt = r.by_model.find((x) => x.model === "gpt");
  assert.equal(claude.cooperate_pct, 100);
  assert.equal(claude.points_per_round, 3);
  assert.equal(gpt.cooperate_pct, 0);
  // mean vs Tit for Tat: D/C 5, then D/D 1 x7 = 12 over 8 rounds; after their cooperation it defected unprovoked.
  assert.equal(gpt.points_per_round, 1.5);
  assert.equal(gpt.unprovoked_defection_pct, 100);
  assert.equal(r.ladder.length, 1, "only agents with 3 matches");
  assert.equal(r.ladder[0].name, "nice-<b>");
  const tft = r.by_opponent.find((x) => x.id === "tit_for_tat");
  assert.equal(tft.matches, 4);
  const csv = await dilemmaCsv(db);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 1 + 32);
  assert.match(csv, /"'=cmd, ""quoted"""/, "cells are quoted and formula-safe");
  const html = await (await dilemmaPage({ DB: db }, "https://bounty.example")).text();
  assert.match(html, /Do AI agents cooperate\?/);
  assert.match(html, /nice-&lt;b&gt;/);
  assert.doesNotMatch(html, /nice-<b>/);
  assert.match(html, /<b>75%<\/b><span>open by cooperating/);
  assert.equal((await listDilemma(db, "finished")).length, 4);
});

test("limits, leaving, timeouts and empty matches", async () => {
  const db = makeD1();
  const me = await agent(db, "busy");
  await rejects(dilemmaPlay(db, me, { per_move_seconds: 5 }), 400);
  const ids = [];
  for (let i = 0; i < PD.active_matches; i++) ids.push((await dilemmaPlay(db, me, {})).id);
  await rejects(dilemmaPlay(db, me, {}), 429, /finish one/);
  // Leaving before any move aborts: nothing to count.
  const left = await dilemmaLeave(db, me, ids[0]);
  assert.equal(left.status, "aborted");
  // One move, then the clock runs out: the match ends where it stands and counts.
  await dilemmaMove(db, me, ids[1], { move: "C" });
  await db.prepare("UPDATE pd_matches SET move_deadline = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), ids[1]).run();
  await dilemmaSweep(db);
  const t = await getDilemma(db, ids[1]);
  assert.equal(t.status, "finished");
  assert.equal(t.termination, "timeout");
  assert.notEqual(t.opponent.id, "hidden");
  const mine = await myDilemmaMatches(db, me);
  assert.equal(mine.active.length, PD.active_matches - 2);
  assert.equal(mine.finished.length, 2);
  // The daily cap keeps one agent from outweighing the rest.
  await db.prepare("UPDATE pd_matches SET status = 'finished' WHERE agent_id = ?").bind(me.id).run();
  for (let i = ids.length; i < PD.per_day; i++)
    await db.prepare("INSERT INTO pd_matches (id, agent_id, opponent, rounds_total, status, per_move_seconds, created_at, updated_at) VALUES (?, ?, 'random', 8, 'finished', 60, ?, ?)")
      .bind(`pdm_${String(i).padStart(16, "0")}`, me.id, new Date().toISOString(), new Date().toISOString()).run();
  await rejects(dilemmaPlay(db, me, {}), 429, /a day/);
  const arena = await (await arenaPage({ DB: db })).text();
  assert.match(arena, /\/arena\/dilemma/);
});

test("the opponent stays out of every public listing until the end", async () => {
  const db = makeD1();
  const me = await agent(db, "quiet");
  const g = await dilemmaPlay(db, me, {});
  await pin(db, g.id, "always_defect", 9);
  await dilemmaMove(db, me, g.id, { move: "C" });
  const live = await listDilemma(db, "active");
  assert.equal(live[0].opponent, "hidden");
  const html = await (await dilemmaPage({ DB: db }, "https://x")).text();
  assert.ok(!html.includes("Always Defect</a>"));
  assert.equal(_internal.parse(await _internal.getRow(db, g.id)).length, 1);
  assert.deepEqual(play(["C"], ["C"])[0], { a: "C", o: "C", reason: null, at: "" });
});
