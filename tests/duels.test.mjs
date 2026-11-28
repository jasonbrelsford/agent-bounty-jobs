// Model vs model prisoner's dilemma, against the real migrations, with a fake model caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import {
  ROSTER, TOURNAMENT, DUEL, schedule, ensureTournament, seatPrompt, readAnswer, workersAiText, playRound, duelTick,
  duelResults, getDuel, listDuels, duelCsv, profile, playing,
} from "../.test-build/duels.js";
import { duelsPage, duelMatchPage, headlines } from "../.test-build/duelspage.js";

/** The same round robin with nobody left out, to test the Claude code paths. */
const WITH_CLAUDE = { ...TOURNAMENT, left_out: [] };

/** Fake models: Llama always cooperates, DeepSeek always defects, the rest play Tit for Tat. */
const lastTheirs = (prompt) => {
  const all = [...prompt.matchAll(/they ([CD]) \(/g)];
  return all.length ? all[all.length - 1][1] : null;
};
const fakeAsk = (calls = []) => async (p, prompt) => {
  calls.push(p.name);
  const move = p.family === "llama" ? "C" : p.family === "deepseek" ? "D" : lastTheirs(prompt) ?? "C";
  return { move, reason: `${p.name} <b>says</b> ${move}`, model: `${p.family}-test-1`, cost: p.provider === "anthropic" ? 0.001 : 0 };
};

test("the round robin: every pair twice, both seat orders, plus self-play", () => {
  const s = schedule();
  const n = TOURNAMENT.players.length;
  assert.equal(s.length, n * (n - 1) + n);
  const key = (a, b) => [a, b].sort().join("|");
  const pairs = new Map();
  for (const [a, b] of s) if (a !== b) pairs.set(key(a, b), (pairs.get(key(a, b)) ?? 0) + 1);
  assert.equal(pairs.size, (n * (n - 1)) / 2);
  assert.ok([...pairs.values()].every((v) => v === 2));
  assert.ok(s.some(([a, b]) => a === "claude-opus" && b === "llama-3.3-70b") && s.some(([a, b]) => a === "llama-3.3-70b" && b === "claude-opus"));
  assert.equal(s.filter(([a, b]) => a === b).length, n);
});

test("reading answers from models", () => {
  assert.deepEqual(readAnswer('{"move":"C","reason":"start nice"}'), { move: "C", reason: "start nice" });
  assert.deepEqual(readAnswer('<think>maybe {"move":"C"}</think>\nFinal: {"move": "defect", "reason": "they did"}'), { move: "D", reason: "they did" });
  assert.deepEqual(readAnswer('```json\n{"move": "c", "reason": "x"}\n```'), { move: "C", reason: "x" });
  assert.equal(readAnswer("I think I will cooperate"), null);
  assert.equal(readAnswer("no idea"), null);
  assert.equal(readAnswer('move: D, reason: "fine"').move, "D");
  assert.equal(readAnswer(`{"move":"C","reason":"${"x".repeat(500)}"}`).reason.length, DUEL.reason_max);
  assert.equal(workersAiText({ response: "hi" }), "hi");
  assert.equal(workersAiText({ response: { move: "C" } }), '{"move":"C"}');
  assert.equal(workersAiText({ choices: [{ message: { content: "yo" } }] }), "yo");
  assert.equal(workersAiText({ output: [{ type: "reasoning" }, { type: "message", content: [{ text: "a" }, { text: "b" }] }] }), "ab");
});

test("each seat sees its own side of the history", () => {
  const rounds = [{ a: "C", b: "D", ra: null, rb: null, at: "" }];
  assert.match(seatPrompt([], "a"), /first round/);
  assert.match(seatPrompt(rounds, "a"), /Round 1: you C, they D \(you \+0, they \+5\)/);
  assert.match(seatPrompt(rounds, "b"), /Round 1: you D, they C \(you \+5, they \+0\)/);
  assert.match(seatPrompt(rounds, "b"), /Round 2\. Your move\?/);
});

test("off unless switched on; Claude waits without a key", async () => {
  const db = makeD1();
  assert.deepEqual(await duelTick({ DB: db }, { ask: fakeAsk() }), { played: 0, reason: "off" });
  const calls = [];
  const r = await duelTick({ DB: db, MODEL_TOURNAMENT: "on" }, { ask: fakeAsk(calls), budgetMs: 60_000 });
  assert.ok(r.played > 0 && r.matches > 0 && r.matches <= DUEL.concurrent);
  assert.equal(r.claude, false);
  assert.ok(calls.every((c) => !c.startsWith("Claude")));
  // Created once only.
  assert.equal(await ensureTournament(db), false);
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM pd_duels").first()).n;
  assert.equal(n, schedule().length);
});

test("a full tournament: matches finish, results and profiles read right", async () => {
  const db = makeD1();
  const env = { DB: db, MODEL_TOURNAMENT: "on", ANTHROPIC_API_KEY: "test" };
  for (let i = 0; i < 20; i++) {
    const r = await duelTick(env, { ask: fakeAsk(), budgetMs: 60_000, t: WITH_CLAUDE });
    if (!r.played) break;
  }
  const r = await duelResults(db, WITH_CLAUDE);
  assert.equal(r.status.finished, schedule().length);
  assert.ok(r.claude_cost_usd_estimate > 0);
  const by = Object.fromEntries(r.standings.map((x) => [x.key, x]));
  assert.equal(by["llama-3.3-70b"].cooperate_pct, 100);
  assert.equal(by["llama-3.3-70b"].style, "Unconditional cooperator");
  assert.equal(by["deepseek-v4.1-flash"].style, "Defector");
  assert.equal(by["deepseek-v4.1-flash"].never_defected_first_pct, 0);
  assert.equal(by["claude-opus"].never_defected_first_pct, 100);
  assert.equal(by["claude-opus"].forgive_after_betrayal_pct, 0);
  assert.equal(by["claude-opus"].unprovoked_defection_pct, 0);
  assert.equal(by["claude-opus"].against_itself.mutual_cooperation_pct, 100);
  assert.deepEqual(by["claude-opus"].model_ids, ["claude-test-1"]);
  assert.ok(by["claude-opus"].quotes.opened.includes("says"));
  assert.equal(r.standings[0].rank, 1);
  // Tit for Tat vs Llama: 3 per round. DeepSeek vs Llama: 5 per round.
  const h = (me, them) => r.head_to_head.find((x) => x.model === me).against[them];
  assert.equal(h("claude-sonnet", "llama-3.3-70b").points_per_round, 3);
  assert.equal(h("deepseek-v4.1-flash", "llama-3.3-70b").points_per_round, 5);
  assert.equal(h("deepseek-v4.1-flash", "llama-3.3-70b").matches, 2);
  // Matches, CSV and pages.
  const list = await listDuels(db);
  const m = await getDuel(db, list[0].id);
  assert.equal(m.rounds.length, m.rounds_played);
  const csv = await duelCsv(db, WITH_CLAUDE);
  assert.match(csv.split("\n")[0], /^match_id,round,model_a/);
  assert.ok(csv.split("\n").length > 100);
  const html = await (await duelsPage(env)).text();
  assert.match(html, /Which AI models cooperate\?/);
  assert.match(html, /Unconditional cooperator/);
  assert.ok(!html.includes("<b>says</b>"), "model reasons are escaped");
  assert.match(html, /&lt;b&gt;says/);
  assert.ok(!html.includes('data-refresh'), "a finished tournament stops refreshing");
  assert.ok(headlines(r).length >= 3);
  const mp = await (await duelMatchPage(env, list[0].id)).text();
  assert.match(mp, /All model matches/);
  assert.ok(!mp.includes("<b>says</b>"));
});

test("a model that keeps failing stops its match; one failure is retried", async () => {
  const db = makeD1();
  await ensureTournament(db);
  const row = await db.prepare("SELECT * FROM pd_duels WHERE a != b AND a NOT LIKE 'claude%' AND b NOT LIKE 'claude%' ORDER BY seq LIMIT 1").first();
  let fail = true;
  const flaky = async (p, prompt) => {
    if (fail && p.family === ROSTER[row.b].family) throw Object.assign(new Error("no clear move"), { cost: 0 });
    return fakeAsk()(p, prompt);
  };
  assert.equal(await playRound(db, row, flaky), false);
  let r = await db.prepare("SELECT * FROM pd_duels WHERE id = ?").bind(row.id).first();
  assert.equal(r.fails, 1); assert.equal(r.status, "active"); assert.equal(JSON.parse(r.moves).length, 0);
  fail = false;
  assert.equal(await playRound(db, r, flaky), r.rounds_total > 1);
  r = await db.prepare("SELECT * FROM pd_duels WHERE id = ?").bind(row.id).first();
  assert.equal(r.fails, 0); assert.equal(JSON.parse(r.moves).length, 1);
  fail = true;
  for (let i = 0; i < DUEL.max_fails; i++) {
    r = await db.prepare("SELECT * FROM pd_duels WHERE id = ?").bind(row.id).first();
    await playRound(db, r, flaky);
  }
  r = await db.prepare("SELECT * FROM pd_duels WHERE id = ?").bind(row.id).first();
  assert.equal(r.status, "failed");
  assert.match(r.last_error, /no clear move/);
  assert.equal((await getDuel(db, row.id)).last_error.includes("no clear move"), true);
});

test("Claude stops at the spend cap", async () => {
  const db = makeD1();
  await ensureTournament(db);
  await db.prepare("UPDATE pd_duels SET cost_usd = ? WHERE seq = 1").bind(TOURNAMENT.claude_budget_usd).run();
  const calls = [];
  await duelTick({ DB: db, MODEL_TOURNAMENT: "on", ANTHROPIC_API_KEY: "test" }, { ask: fakeAsk(calls), budgetMs: 60_000, t: WITH_CLAUDE });
  assert.ok(calls.length > 0 && calls.every((c) => !c.startsWith("Claude")));
});

test("players left out are never played, counted or shown", async () => {
  const db = makeD1();
  const env = { DB: db, MODEL_TOURNAMENT: "on", ANTHROPIC_API_KEY: "test" };
  const calls = [];
  for (let i = 0; i < 20; i++) {
    const r = await duelTick(env, { ask: fakeAsk(calls), budgetMs: 60_000 });
    if (!r.played) break;
  }
  assert.ok(calls.length > 0 && calls.every((c) => !c.startsWith("Claude")), "even with a key, Claude is not called");
  const open = playing();
  assert.deepEqual(open.filter((k) => k.startsWith("claude")), []);
  const r = await duelResults(db);
  assert.equal(r.status.total, open.length * (open.length - 1) + open.length);
  assert.equal(r.status.finished, r.status.total);
  assert.equal(r.status.queued, 0);
  assert.deepEqual(r.standings.map((x) => x.key).sort(), [...open].sort());
  assert.ok(r.head_to_head.every((h) => !Object.keys(h.against).some((k) => k.startsWith("claude"))));
  assert.deepEqual(r.left_out, ["Claude Opus", "Claude Sonnet", "Claude Haiku"]);
  assert.doesNotMatch(r.how.settings, /Claude/);
  assert.ok((await listDuels(db)).every((m) => !m.a.startsWith("claude") && !m.b.startsWith("claude")));
  assert.doesNotMatch(await duelCsv(db), /claude/);
  const left = await db.prepare("SELECT id FROM pd_duels WHERE a LIKE 'claude%' LIMIT 1").first();
  await assert.rejects(getDuel(db, left.id), /no such match/);
  const html = await (await duelsPage(env)).text();
  assert.doesNotMatch(html, /Claude/);
  assert.match(html, /The round robin is complete/);
  assert.match(html, /pre\{[^}]*color:var\(--bx-ink-2\)/, "the prompt box sets dark text on its light background");
  assert.ok(!html.includes("data-refresh"));
});

test("profiles in plain words", () => {
  const empty = profile({ matches: 0, wins: 0, draws: 0, losses: 0, rounds: 0, points: 0, coop: 0, firstC: 0, afterD: 0, afterDC: 0, afterC: 0, afterCD: 0, nice: 0, exploited: 0, exploiting: 0, quotes: {} });
  assert.equal(empty.style, "No matches yet");
  const opp = profile({ matches: 4, wins: 3, draws: 0, losses: 1, rounds: 40, points: 120, coop: 24, firstC: 4, afterD: 10, afterDC: 2, afterC: 30, afterCD: 9, nice: 1, exploited: 2, exploiting: 9, quotes: {} });
  assert.equal(opp.style, "Opportunist");
  assert.match(opp.summary, /defected on a cooperating opponent 30%/);
});

test("Qwen and DeepSeek are asked for low reasoning effort; others get their defaults", async () => {
  const seen = [];
  const env = { DB: makeD1(), AI: { run: async (model, input) => { seen.push([model, input.reasoning_effort]); return { response: '{"move":"C","reason":"ok"}' }; } } };
  const { liveAsk } = await import("../.test-build/duels.js");
  const ask = liveAsk(env);
  for (const k of ["qwen3.8-27b", "deepseek-v4.1-flash", "llama-3.3-70b", "gemma-4-26b", "gpt-oss-120b"]) await ask(ROSTER[k], "Round 1. Your move?");
  assert.deepEqual(seen.map((x) => x[1]), ["low", "low", undefined, undefined, undefined]);
});
