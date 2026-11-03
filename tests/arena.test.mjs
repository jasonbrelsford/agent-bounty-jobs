// Arena: chess games against house bots and other agents, ratings, clocks and
// the coach review — against the real migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey, readInbox } from "../.test-build/core.js";
import {
  play, getGame, makeMove, resign, myGames, listGames, leaderboard, reviewGame, arenaSweep,
  houseMove, scoreMoves, eloDelta, START_RATING,
} from "../.test-build/arena.js";
import { publicEvents } from "../.test-build/livefeed.js";
import { gamePage } from "../.test-build/arenapage.js";

async function agent(db, name) {
  const r = await registerAgent(db, name, { contact_email: `${name}@example.com` });
  return await authByKey(db, r.api_key);
}
const rejects = (p, status, re) =>
  assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));
const types = async (db, id) => (await readInbox(db, id)).events.map((e) => e.type);

test("house bot game: start as white, the bot answers in the same call, play to a finish", async () => {
  const db = makeD1();
  const me = await agent(db, "chess-learner");
  let g = await play(db, me, { opponent: "house_pawn", color: "white" });
  assert.equal(g.started, true);
  assert.equal(g.status, "active");
  assert.equal(g.your_turn, true);
  assert.ok(g.legal_moves.includes("e4"));
  g = await makeMove(db, me, g.id, { move: "e4", reason: "take the centre" });
  assert.equal(g.moves.length, 2, "my move plus the bot's reply");
  assert.equal(g.moves[0].reason, "take the centre");
  assert.equal(g.your_turn, true);
  // Play the agent side with the Knight bot's brain until the game ends.
  let guard = 0;
  while (g.status === "active" && guard++ < 300) {
    const c = new Chess(g.fen);
    g = await makeMove(db, me, g.id, { move: houseMove(c, "house_knight").san });
  }
  assert.equal(g.status, "finished");
  assert.ok(["1-0", "0-1", "1/2-1/2"].includes(g.result));
  assert.equal(typeof g.rating_change.white, "number");
  assert.equal(g.rating_change.black, null, "house bots are pinned");
  const lb = await leaderboard(db);
  assert.equal(lb.ladder.length, 1);
  assert.equal(lb.ladder[0].rating, START_RATING + g.rating_change.white);
  assert.ok((await types(db, me.id)).includes("game.finished"));
});

test("as black against a house bot, the bot opens", async () => {
  const db = makeD1();
  const me = await agent(db, "black-side");
  const g = await play(db, me, { opponent: "house_rook", color: "black" });
  assert.equal(g.moves.length, 1);
  assert.equal(g.your_color, "black");
  assert.equal(g.your_turn, true);
});

test("illegal and out-of-turn moves are refused with the legal list", async () => {
  const db = makeD1();
  const a = await agent(db, "alpha-agent");
  const b = await agent(db, "bravo-agent");
  const seek = await play(db, a, { color: "white" });
  assert.equal(seek.waiting, true);
  const g = await play(db, b, {});
  assert.equal(g.id, seek.id, "an open request pairs with the waiting seek");
  await rejects(makeMove(db, b, g.id, { move: "e5" }), 409, /not your move/);
  await rejects(makeMove(db, a, g.id, { move: "Ke2" }), 400, /illegal move.*Legal: /);
  await makeMove(db, a, g.id, { move: "e2e4" }); // UCI accepted
  assert.ok((await types(db, b.id)).includes("game.your_move"));
  const after = await getGame(db, g.id, b);
  assert.equal(after.your_turn, true);
  assert.equal(after.last_move.san, "e4");
});

test("fool's mate ends the game, rates both agents and the review flags the losing move", async () => {
  const db = makeD1();
  const w = await agent(db, "white-agent");
  const bl = await agent(db, "black-agent");
  const g = await play(db, w, { color: "white" });
  await play(db, bl, { game_id: g.id });
  await makeMove(db, w, g.id, { move: "f3", reason: "flexible" });
  await makeMove(db, bl, g.id, { move: "e5" });
  await makeMove(db, w, g.id, { move: "g4", reason: "space on the kingside" });
  await rejects(reviewGame(db, g.id, w), 409, /when the game is over/);
  const end = await makeMove(db, bl, g.id, { move: "Qh4#" });
  assert.equal(end.status, "finished");
  assert.equal(end.result, "0-1");
  assert.equal(end.termination, "checkmate");
  assert.ok(end.rating_change.white < 0 && end.rating_change.black > 0);
  assert.equal(end.rating_change.white, -end.rating_change.black);
  const r = await reviewGame(db, g.id, w);
  assert.equal(r.reviewed_for, w.id);
  const g4 = r.flagged.find((f) => f.played === "g4");
  assert.ok(g4, "g4 allowed mate in one");
  assert.equal(g4.kind, "allowed_mate");
  assert.equal(g4.your_reason, "space on the kingside");
  assert.match(r.focus_next_game, /forcing reply/);
  const kinds = (await publicEvents(db, undefined, 40)).map((e) => e.kind);
  assert.ok(kinds.includes("game_started") && kinds.includes("game_finished"));
});

test("review catches a missed mate in one", async () => {
  const db = makeD1();
  const w = await agent(db, "misses-mates");
  const bl = await agent(db, "lucky-black");
  const g = await play(db, w, { color: "white" });
  await play(db, bl, { game_id: g.id });
  // Scholar's mate set-up; white plays Qxf7# ... except it doesn't.
  for (const [who, mv] of [[w, "e4"], [bl, "e5"], [w, "Qh5"], [bl, "Nc6"], [w, "Bc4"], [bl, "Nf6"], [w, "d3"], [bl, "a6"], [w, "a3"]])
    await makeMove(db, who, g.id, { move: mv });
  await resign(db, bl, g.id);
  const r = await reviewGame(db, g.id, w);
  assert.ok(r.flagged.some((f) => f.kind === "missed_mate" && f.better === "Qxf7#"));
});

test("direct challenge goes to the invitee's inbox and only they can accept", async () => {
  const db = makeD1();
  const a = await agent(db, "challenger");
  const b = await agent(db, "invitee");
  const c = await agent(db, "bystander");
  const ch = await play(db, a, { opponent: b.id });
  assert.equal(ch.waiting, true);
  assert.ok((await types(db, b.id)).includes("game.challenge"));
  assert.deepEqual((await myGames(db, b)).challenges_for_you, [ch.id]);
  await rejects(play(db, c, { game_id: ch.id }), 403);
  const g = await play(db, b, { game_id: ch.id });
  assert.equal(g.status, "active");
  // An open seek is never paired with a challenge addressed to someone else.
  assert.equal((await play(db, c, {})).waiting, true);
});

test("clock: running out of time loses; under two moves aborts unrated", async () => {
  const db = makeD1();
  const a = await agent(db, "slow-agent");
  const b = await agent(db, "fast-agent");
  const past = new Date(Date.now() - 1000).toISOString();

  const g1 = await play(db, a, { color: "white" });
  await play(db, b, { game_id: g1.id });
  db.raw.prepare("UPDATE games SET move_deadline = ? WHERE id = ?").run(past, g1.id);
  const aborted = await getGame(db, g1.id);
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.result, null);

  const g2 = await play(db, a, { color: "white" });
  await play(db, b, { game_id: g2.id });
  await makeMove(db, a, g2.id, { move: "d4" });
  await makeMove(db, b, g2.id, { move: "d5" });
  db.raw.prepare("UPDATE games SET move_deadline = ? WHERE id = ?").run(past, g2.id);
  assert.equal(await arenaSweep(db), 1);
  const lost = await getGame(db, g2.id);
  assert.equal(lost.status, "finished");
  assert.equal(lost.result, "0-1");
  assert.equal(lost.termination, "timeout");
  assert.equal((await listGames(db, "finished")).games.length, 1);
});

test("a second concurrent move at the same ply is refused, not double-applied", async () => {
  const db = makeD1();
  const a = await agent(db, "racer-white");
  const b = await agent(db, "racer-black");
  const g = await play(db, a, { color: "white" });
  await play(db, b, { game_id: g.id });
  const results = await Promise.allSettled([
    makeMove(db, a, g.id, { move: "e4" }),
    makeMove(db, a, g.id, { move: "d4" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const now = await getGame(db, g.id);
  assert.equal(now.moves.length, 1);
});

test("limits: one open seek, no self-play, resign withdraws a seek", async () => {
  const db = makeD1();
  const a = await agent(db, "eager-agent");
  const seek = await play(db, a, {});
  await rejects(play(db, a, {}), 409, /already have an open seek/);
  await rejects(play(db, a, { opponent: a.id }), 400);
  await rejects(play(db, a, { game_id: seek.id }), 409, /own game/);
  const w = await resign(db, a, seek.id);
  assert.equal(w.status, "aborted");
  await rejects(play(db, a, { opponent: "house_queen" }), 404);
});

test("engine: finds mate in one and the house bots get stronger with depth", () => {
  const c = new Chess("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1");
  assert.equal(scoreMoves(c, 2)[0].move.san, "Rd8#");
  assert.equal(houseMove(c, "house_knight").san, "Rd8#");
  // Elo sanity: beating a much stronger player gains more than beating a weaker one.
  assert.ok(eloDelta(1200, 1600, 1, 20) > eloDelta(1200, 800, 1, 20));
  assert.equal(eloDelta(1200, 1200, 0.5, 20), 0);
});

test("approach: each agent's summary of how it plays is shown with the game, and house bots describe themselves", async () => {
  const db = makeD1();
  const a = await agent(db, "explains-itself");
  const b = await agent(db, "quiet-one");
  const seek = await play(db, a, { color: "white", approach: "  Two-ply search with a blunder check. ".repeat(40) });
  const g = await play(db, b, { game_id: seek.id });
  assert.equal(g.white.approach.length, 600, "trimmed to the limit");
  assert.match(g.white.approach, /^Two-ply search/);
  assert.equal(g.black.approach, null);
  const h = await play(db, b, { opponent: "house_knight", color: "white", approach: "random mover" });
  assert.equal(h.white.approach, "random mover");
  assert.match(h.black.approach, /^House bot: /);
});

test("replay page: every position, reasons and coach flags are embedded, and caller text cannot break out", async () => {
  const db = makeD1();
  const w = await agent(db, "replay-white");
  const bl = await agent(db, "replay-black");
  const g = await play(db, w, { color: "white", approach: "<img src=x onerror=alert(1)>" });
  await play(db, bl, { game_id: g.id });
  await makeMove(db, w, g.id, { move: "f3", reason: "</script><script>alert(1)</script>" });
  await makeMove(db, bl, g.id, { move: "e5" });
  await makeMove(db, w, g.id, { move: "g4" });
  await makeMove(db, bl, g.id, { move: "Qh4#", reason: "mate" });
  const html = await (await gamePage({ DB: db }, g.id)).text();
  assert.ok(!html.includes("<img src=x"), "approach is escaped");
  assert.equal(html.split("</script>").length - 1, 4, "only the page's own four script tags close (data, replay, live, countdown)");
  const json = JSON.parse(html.match(/<script type="application\/json" id="replay">([\s\S]*?)<\/script>/)[1]);
  assert.equal(json.plies.length, 5, "start position plus four moves");
  assert.equal(json.plies[1].reason, "</script><script>alert(1)</script>");
  assert.equal(json.plies[3].flag.kind, "allowed_mate");
  assert.equal(json.plies[4].who, "replay-black");
  assert.match(html, /What the coach told each agent/);
});
