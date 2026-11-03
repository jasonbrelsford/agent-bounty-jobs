// Agent chess: create/join/move/finish, ratings, races, clocks and the public
// pages — end to end against the real migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey, readInbox, boardStats } from "../.test-build/core.js";
import {
  createGame, joinGame, makeMove, resignGame, drawAction, cancelGame, getGame, listGames,
  leaderboard, agentRecord, gamePgn, sweepGames, eloDelta, GAMES,
} from "../.test-build/games.js";
import { gamesPage, gamePage } from "../.test-build/gamespages.js";
import { publicEvents } from "../.test-build/livefeed.js";

const HOUR = 3_600_000;

async function agent(db, name) {
  const r = await registerAgent(db, name, {});
  return { id: r.agent_id, a: await authByKey(db, r.api_key) };
}
const types = async (db, id) => (await readInbox(db, id)).events.map((e) => e.type);

/** Two agents and a started game with `w` as white. */
async function started(opts = {}) {
  const db = makeD1();
  const w = await agent(db, "white-bot");
  const b = await agent(db, "black-bot");
  const g = await createGame(db, w.a, { color: "white", ...opts });
  await joinGame(db, b.a, g.game_id);
  return { db, w, b, id: g.game_id };
}
async function play(db, w, b, id, sans) {
  let last;
  for (let i = 0; i < sans.length; i++) last = await makeMove(db, (i % 2 === 0 ? w : b).a, id, sans[i]);
  return last;
}

test("create → join → moves in SAN and UCI → checkmate, ratings and notifications", async () => {
  const { db, w, b, id } = await started();
  assert.ok((await types(db, w.id)).includes("game.started"));
  assert.ok((await types(db, w.id)).includes("game.your_move"));

  let v = await getGame(db, id, w.a);
  assert.equal(v.status, "active");
  assert.equal(v.turn, "white");
  assert.equal(v.you.your_turn, true);
  assert.equal(v.legal_moves.length, 20);

  await makeMove(db, w.a, id, "f3");
  await makeMove(db, b.a, id, "e7e5"); // UCI
  assert.ok((await types(db, w.id)).filter((t) => t === "game.your_move").length >= 2);
  await makeMove(db, w.a, id, "g4");
  v = await makeMove(db, b.a, id, "Qh4#");
  assert.equal(v.status, "finished");
  assert.equal(v.result, "0-1");
  assert.equal(v.termination, "checkmate");
  assert.equal(v.winner.agent_id, b.id);
  assert.equal(v.black.rating_change, 16);
  assert.equal(v.white.rating_change, -16);

  const board = await leaderboard(db);
  assert.deepEqual(board.map((r) => [r.agent_id, r.rating, r.wins, r.losses]), [[b.id, 1216, 1, 0], [w.id, 1184, 0, 1]]);
  assert.ok((await types(db, w.id)).includes("game.finished"));
  const rec = await agentRecord(db, b.id);
  assert.equal(rec.rating, 1216);
  assert.equal(rec.record.wins, 1);
  assert.equal(rec.recent_games.length, 1);

  const pgn = await gamePgn(db, id);
  assert.match(pgn, /\[White "white-bot"\]/);
  assert.match(pgn, /1\. f3 e5 2\. g4 Qh4# 0-1/);
  await assert.rejects(makeMove(db, w.a, id, "a3"), (e) => e.status === 409);
});

test("turn order, illegal moves and outsiders are refused with useful errors", async () => {
  const { db, w, b, id } = await started();
  const x = await agent(db, "kibitzer");
  await assert.rejects(makeMove(db, b.a, id, "e5"), /white's move/);
  await assert.rejects(makeMove(db, w.a, id, "e5"), (e) => e.status === 400 && /Legal moves: .*e4/.test(e.message));
  await assert.rejects(makeMove(db, x.a, id, "e4"), (e) => e.status === 403);
  await assert.rejects(makeMove(db, w.a, id, ""), (e) => e.status === 400);
  await assert.rejects(makeMove(db, w.a, id, "e4", "yes"), /offer_draw/);
  await assert.rejects(getGame(db, "gam_nope", null), (e) => e.status === 404);
  await makeMove(db, w.a, id, "e2e4");
  const v = await getGame(db, id, null);
  assert.equal(v.last_move.san, "e4");
  assert.equal(v.you, undefined);
});

test("promotion in UCI and SAN", async () => {
  const { db, w, b, id } = await started({ rated: false });
  const v = await play(db, w, b, id, ["a4", "h5", "a5", "h4", "a6", "h3", "axb7", "hxg2", "bxa8=Q", "gxh1n"]);
  assert.deepEqual(v.moves.slice(-2), ["bxa8=Q", "gxh1=N"]);
  assert.equal(v.status, "active");
});

test("joining: seats, self-join, private challenges and the first-joiner race", async () => {
  const db = makeD1();
  const c = await agent(db, "creator");
  const p = await agent(db, "invitee");
  const q = await agent(db, "stranger");
  await assert.rejects(createGame(db, c.a, { opponent_id: c.id }), /yourself/);
  await assert.rejects(createGame(db, c.a, { color: "purple" }), /color/);
  await assert.rejects(createGame(db, c.a, { move_timeout_hours: 0 }), /move_timeout_hours/);
  await assert.rejects(createGame(db, c.a, { game: "go" }), /game must be/);
  const g = await createGame(db, c.a, { opponent_id: p.id, color: "black" });
  assert.ok((await types(db, p.id)).includes("game.challenge"));
  await assert.rejects(joinGame(db, c.a, g.game_id), /you created/);
  await assert.rejects(joinGame(db, q.a, g.game_id), (e) => e.status === 403);
  const v = await joinGame(db, p.a, g.game_id);
  assert.equal(v.white.agent_id, p.id);
  assert.equal(v.black.agent_id, c.id);
  await assert.rejects(joinGame(db, q.a, g.game_id), (e) => e.status === 409);

  const open = await createGame(db, c.a, {});
  const both = await Promise.allSettled([joinGame(db, p.a, open.game_id), joinGame(db, q.a, open.game_id)]);
  assert.equal(both.filter((r) => r.status === "fulfilled").length, 1);
});

test("a stale write loses the race and leaves no ratings, inbox or events behind", async () => {
  const { db, w, b, id } = await started();
  // Simulate a concurrent writer: bump op_token between read and write.
  const before = (await readInbox(db, b.id)).events.length;
  const realBatch = db.batch.bind(db);
  db.batch = async (stmts) => { db.raw.exec(`UPDATE games SET op_token = 'other' WHERE id = '${id}'`); db.batch = realBatch; return realBatch(stmts); };
  await assert.rejects(makeMove(db, w.a, id, "e4"), (e) => e.status === 409 && /re-read/.test(e.message));
  assert.equal((await readInbox(db, b.id)).events.length, before);
  const v = await getGame(db, id, null);
  assert.equal(v.ply, 0);
});

test("draws: offer, decline by playing on, accept; resign; cancel", async () => {
  const { db, w, b, id } = await started();
  await makeMove(db, w.a, id, "e4", true);
  let v = await getGame(db, id, b.a);
  assert.equal(v.draw_offer_by, "white");
  assert.equal(v.you.opponent_offered_draw, true);
  await makeMove(db, b.a, id, "e5"); // playing on declines
  assert.equal((await getGame(db, id, null)).draw_offer_by, null);
  await assert.rejects(drawAction(db, w.a, id, "accept"), /not offered/);
  await drawAction(db, w.a, id, "offer");
  assert.ok((await types(db, b.id)).includes("game.draw_offered"));
  await assert.rejects(drawAction(db, w.a, id, "offer"), /already/);
  v = await drawAction(db, b.a, id, "accept");
  assert.equal(v.result, "1/2-1/2");
  assert.equal(v.termination, "agreement");
  assert.equal(v.white.rating_change, 0);

  const g2 = await started();
  v = await resignGame(g2.db, g2.b.a, g2.id);
  assert.equal(v.result, "1-0");
  assert.equal(v.termination, "resignation");

  const d3 = makeD1();
  const c = await agent(d3, "creator-bot");
  const o = await agent(d3, "other-bot");
  const g = await createGame(d3, c.a, {});
  await assert.rejects(cancelGame(d3, o.a, g.game_id), (e) => e.status === 403);
  assert.equal((await cancelGame(d3, c.a, g.game_id)).status, "cancelled");
  await assert.rejects(joinGame(d3, o.a, g.game_id), (e) => e.status === 409);
});

test("auto draws from the rules library: stalemate-free threefold repetition", async () => {
  const { db, w, b, id } = await started();
  const v = await play(db, w, b, id, ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]);
  assert.equal(v.status, "finished");
  assert.equal(v.termination, "threefold_repetition");
  assert.equal(v.result, "1/2-1/2");
});

test("clocks: the side to move loses on time; no first moves aborts unrated", async () => {
  const { db, w, b, id } = await started();
  await play(db, w, b, id, ["e4", "e5"]);
  // White to move; push the deadline into the past.
  db.raw.exec(`UPDATE games SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id}'`);
  const v = await getGame(db, id, null);
  assert.equal(v.status, "finished");
  assert.equal(v.result, "0-1");
  assert.equal(v.termination, "timeout");
  assert.equal(v.black.rating_change, 16);

  const g2 = await started();
  g2.db.raw.exec(`UPDATE games SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE id = '${g2.id}'`);
  assert.equal(await sweepGames(g2.db), 1);
  const v2 = await getGame(g2.db, g2.id, null);
  assert.equal(v2.status, "aborted");
  assert.equal(v2.result, null);
  assert.equal((await leaderboard(g2.db)).length, 0);

  // Challenges nobody takes are cancelled after a week.
  const d3 = makeD1();
  const c = await agent(d3, "creator-bot");
  const g = await createGame(d3, c.a, {});
  await sweepGames(d3, Date.now() + (GAMES.waiting_days + 1) * 24 * HOUR);
  assert.equal((await getGame(d3, g.game_id, null)).status, "cancelled");
});

test("open-game limits stop challenge spam", async () => {
  const db = makeD1();
  const c = await agent(db, "spammer");
  for (let i = 0; i < GAMES.waiting_per_agent; i++) await createGame(db, c.a, {});
  await assert.rejects(createGame(db, c.a, {}), (e) => e.status === 429);
});

test("elo is zero-sum and favours the underdog", () => {
  assert.equal(eloDelta(1200, 1200, 1), 16);
  assert.equal(eloDelta(1200, 1400, 1), 24);
  assert.equal(eloDelta(1400, 1200, 0.5), -8);
});

test("listing, public pages escape agent names, feed shows games", async () => {
  const db = makeD1();
  const w = await agent(db, "<img src=x onerror=alert(1)>");
  const b = await agent(db, "honest-bot");
  const g = await createGame(db, w.a, { color: "white" });
  assert.equal((await listGames(db, { status: "waiting" })).length, 1);
  await joinGame(db, b.a, g.game_id);
  await makeMove(db, w.a, g.game_id, "e4");
  const live = await listGames(db, { status: "active" });
  assert.equal(live.length, 1);
  assert.equal(live[0].last_move, "e4");
  assert.equal((await listGames(db, { agent_id: b.id })).length, 1);
  await assert.rejects(listGames(db, { status: "nope" }), /status/);

  const html = await (await gamePage({ DB: db }, g.game_id)).text();
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x"));
  assert.match(html, /http-equiv="refresh"/);
  assert.equal((await gamePage({ DB: db }, "gam_0000000000000000")).status, 404);
  const index = await (await gamesPage({ DB: db }, new URL("https://x.test/games"))).text();
  assert.ok(!index.includes("<img src=x"));
  assert.match(index, /honest-bot/);
  const filtered = await (await gamesPage({ DB: db }, new URL(`https://x.test/games?agent=${b.id}`))).text();
  assert.match(filtered, /honest-bot/);

  const kinds = (await publicEvents(db, null)).map((e) => e.kind);
  assert.ok(kinds.includes("game_started"));
  assert.ok((await boardStats(db)).events_last_24h > 0);
});
