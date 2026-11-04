// Liar's dice, against the real migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey } from "../.test-build/core.js";
import {
  dicePlay, getDice, diceBid, diceLiar, diceLeave, myDiceGames, listDiceGames, diceLeaderboard, diceReview,
  settleDice, getDiceRow, atLeast, oddsFor, minRaises, matching, botDecide, _internal,
} from "../.test-build/dice.js";
import { dicePage, diceGamePage } from "../.test-build/dicepage.js";
import { arenaPage } from "../.test-build/arenapage.js";

let n = 0;
async function agent(db, name, kind) {
  const r = await registerAgent(db, name, { contact_email: `d${++n}@example.com`, kind });
  return await authByKey(db, r.api_key);
}
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));
const state = async (db, id) => JSON.parse((await getDiceRow(db, id)).state);
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A sensible player: call when the bid looks unlikely by the count, else take the safest smallest raise. */
async function playTurn(db, a, id) {
  const g = await getDice(db, id, a);
  assert.equal(g.your_turn, true);
  const own = g.your_dice, total = g.total_dice, last = g.current_bid;
  if (last && oddsFor(own, total, last.quantity, last.face) < 0.45) return diceLiar(db, a, id, { reason: "count says no" });
  const best = g.legal.raises.map((m) => ({ ...m, p: oddsFor(own, total, m.quantity, m.face) })).sort((x, y) => y.p - x.p)[0];
  if (!best) return diceLiar(db, a, id, {});
  return diceBid(db, a, id, { quantity: best.quantity, face: best.face, reason: "safest raise" });
}

test("the odds: a third of hidden dice match, ones are wild, smallest raises", () => {
  assert.equal(atLeast(0, 5), 1);
  assert.equal(atLeast(6, 5), 0);
  assert.ok(Math.abs(atLeast(1, 3) - (1 - (2 / 3) ** 3)) < 1e-9);
  assert.equal(matching([1, 1, 4, 4, 6], 4), 4);
  assert.equal(oddsFor([1, 4, 4, 2, 3], 10, 3, 4), 1, "three 4s in hand, ones included");
  assert.deepEqual(minRaises(null, 10).map((m) => m.quantity), [1, 1, 1, 1, 1]);
  assert.deepEqual(minRaises({ quantity: 3, face: 4 }, 10), [
    { quantity: 4, face: 2 }, { quantity: 4, face: 3 }, { quantity: 4, face: 4 }, { quantity: 3, face: 5 }, { quantity: 3, face: 6 },
  ]);
  assert.deepEqual(minRaises({ quantity: 10, face: 6 }, 10), [], "nothing beats the top bid: you must call");
});

test("a game against the house bots plays to the end, and the coach reviews it", async () => {
  _internal.setRng(seeded(7));
  const db = makeD1();
  const a = await agent(db, "dicer");
  const g0 = await dicePlay(db, a, { opponents: ["house_pawn", "house_knight", "house_rook"], approach: "count, then raise the safest face" });
  assert.equal(g0.started, true);
  assert.equal(g0.seats.length, 4);
  assert.equal(g0.per_move_seconds, 3600);
  assert.equal(g0.total_dice, 20);
  assert.equal(g0.your_dice.length, 5);
  assert.equal(g0.your_turn, true, "bots play until it's your turn");
  const id = g0.id;
  for (let i = 0; i < 300; i++) {
    const g = await getDice(db, id, a);
    if (g.status !== "active") break;
    await playTurn(db, a, id);
  }
  const g = await getDice(db, id, a);
  assert.equal(g.status, "finished");
  assert.ok(g.winner);
  assert.ok(["last_player_standing", "abandoned"].includes(g.termination));
  assert.ok(g.rounds.length >= 1);
  // Every called round shows its dice, and the count on the call is right.
  for (const r of g.rounds.filter((x) => x.call)) {
    const f = Number(r.call.on.split(" × ")[1][0]);
    assert.equal(r.dice.reduce((s, d) => s + matching(d.dice, f), 0), r.call.actual);
  }
  const rv = await diceReview(db, id, a);
  assert.equal(rv.reviewed_for, "dicer");
  assert.ok(rv.decisions.length > 0);
  assert.ok(rv.decisions.every((d) => d.by === "dicer"));
  assert.ok(rv.decisions.every((d) => typeof d.odds_last_bid_true_pct === "number" || d.action === "bid"));
  assert.match(rv.the_count, /third of the dice you can't see/);
  const lb = await diceLeaderboard(db);
  assert.equal(lb.ladder[0].name, "dicer");
  assert.equal(lb.ladder[0].games, 1);
  assert.equal(lb.ladder[0].games_vs_real_players, 0, "bots alone are practice");
  assert.equal(lb.ladder[0].wins_vs_real_players, 0);
  const inbox = await db.prepare("SELECT type FROM inbox WHERE agent_id = ?").bind(a.id).all();
  assert.ok(inbox.results.some((r) => r.type === "dice.finished"));
  assert.ok(!inbox.results.some((r) => r.type === "dice.your_turn"), "no turn pings when bots answer in the same call");
});

test("the rules are enforced: a raise must beat the bid, ones are wild, no calling an empty round", async () => {
  _internal.setRng(seeded(3));
  const db = makeD1();
  const a = await agent(db, "rules-agent");
  let g = await dicePlay(db, a, { opponents: ["house_knight"] });
  for (let i = 0; i < 20 && !(g.your_turn && !g.current_bid); i++) {
    // Get to a round we open: call whatever the bot bid.
    g = g.your_turn ? await diceLiar(db, a, g.id, {}) : await getDice(db, g.id, a);
    if (g.status !== "active") { g = await dicePlay(db, a, { opponents: ["house_knight"] }); }
  }
  assert.equal(g.current_bid, null);
  await rejects(diceLiar(db, a, g.id, {}), 400, /no bid to call/);
  await rejects(diceBid(db, a, g.id, { quantity: 2, face: 1 }), 400, /ones are wild/);
  await rejects(diceBid(db, a, g.id, { quantity: g.total_dice + 1, face: 3 }), 400, new RegExp(`1 to ${g.total_dice}`));
  await rejects(diceBid(db, a, g.id, { quantity: 0, face: 3 }), 400);
  const s = await state(db, g.id);
  const bot = s.seats.findIndex((x) => x.id === "house_knight");
  // The bot answers at once; if it raised, a lower bid must be refused.
  const after = await diceBid(db, a, g.id, { quantity: 1, face: 2 });
  if (after.status === "active" && after.current_bid && after.current_bid.seat === bot) {
    await rejects(diceBid(db, a, g.id, { quantity: 1, face: 2 }), 400, /must beat/);
  }
  const other = await agent(db, "bystander");
  await rejects(diceBid(db, other, g.id, { quantity: 5, face: 5 }), 403);
});

test("two agents at an open table: dice stay hidden, reasons stay private until the call", async () => {
  _internal.setRng(seeded(11));
  const db = makeD1();
  const a = await agent(db, "alice-agent");
  const b = await agent(db, "bob-agent");
  const t = await dicePlay(db, a, { opponents: ["open"] });
  assert.equal(t.waiting, true);
  assert.equal(t.per_move_seconds, 86400);
  assert.equal((await listDiceGames(db, "waiting")).games.length, 1);
  const joined = await dicePlay(db, b, { opponents: ["open"] });
  assert.equal(joined.id, t.id, "quick match sits you at the open table");
  assert.equal(joined.started, true);
  const id = t.id;
  const s = await state(db, id);
  const turn = s.turn;
  const [first, second] = s.seats[turn].id === a.id ? [a, b] : [b, a];
  const firstSeat = turn, secondSeat = 1 - turn;
  const pub = await getDice(db, id);
  assert.equal(pub.your_dice, undefined);
  const theirs = await getDice(db, id, second);
  assert.deepEqual(theirs.your_dice, s.rounds[0].dice[secondSeat]);
  assert.equal(JSON.stringify(theirs).includes(JSON.stringify(s.rounds[0].dice[firstSeat])) && JSON.stringify(s.rounds[0].dice[firstSeat]) !== JSON.stringify(s.rounds[0].dice[secondSeat]), false, "the other player's dice are not in your view");
  await rejects(diceBid(db, second, id, { quantity: 1, face: 3 }), 409, /not your turn/);
  await diceBid(db, first, id, { quantity: 2, face: 5, reason: "I hold two 5s" });
  const seen = await getDice(db, id, second);
  assert.equal(seen.current_bid.text, "2 × 5s");
  assert.equal(seen.bids_this_round[0].reason, undefined, "the bidder's reason is private during the round");
  assert.equal((await getDice(db, id, first)).bids_this_round[0].reason, "I hold two 5s");
  const ping = await db.prepare("SELECT type FROM inbox WHERE agent_id = ? AND type = 'dice.your_turn'").bind(second.id).all();
  assert.ok(ping.results.length >= 1, "the next player is told it's their turn");
  const called = await diceLiar(db, second, id, {});
  assert.match(called.message, /called liar on 2 × 5s/);
  assert.equal(called.rounds[0].bids[0].reason, "I hold two 5s", "revealed once called");
  assert.ok(called.rounds[0].dice.length === 2);
  // Play it out between the two of them.
  for (let i = 0; i < 300; i++) {
    const g = await getDice(db, id);
    if (g.status !== "active") break;
    await playTurn(db, g.to_act.id === a.id ? a : b, id);
  }
  const end = await getDice(db, id);
  assert.equal(end.status, "finished");
  assert.equal(end.termination, "last_player_standing");
  const lb = await diceLeaderboard(db);
  assert.equal(lb.ladder.length, 2);
  assert.equal(lb.ladder[0].wins_vs_real_players, 1);
  assert.equal(lb.ladder[0].name, end.winner.name);
  assert.equal(lb.ladder[1].games_vs_real_players, 1);
  const rv = await diceReview(db, id);
  assert.equal(rv.reviewed_for, "every real player");
  assert.ok(rv.decisions.some((d) => d.by === "alice-agent") && rv.decisions.some((d) => d.by === "bob-agent"));
});

test("invites hold a seat; a timeout puts the player out", async () => {
  _internal.setRng(seeded(5));
  const db = makeD1();
  const a = await agent(db, "host-agent");
  const b = await agent(db, "guest-agent");
  const c = await agent(db, "crasher-agent");
  const t = await dicePlay(db, a, { opponents: [b.id, "house_rook"] });
  assert.equal(t.waiting, true);
  const inv = await db.prepare("SELECT data FROM inbox WHERE agent_id = ? AND type = 'dice.invite'").bind(b.id).first();
  assert.equal(JSON.parse(inv.data).game_id, t.id);
  assert.deepEqual((await myDiceGames(db, b)).invites_for_you, [t.id]);
  await rejects(dicePlay(db, c, { game_id: t.id }), 403, /invited/);
  const g = await dicePlay(db, b, { game_id: t.id });
  assert.equal(g.started, true);
  // Whoever must act now lets the clock run out.
  const row = await getDiceRow(db, t.id);
  const late = row.to_act_id;
  assert.ok(late === a.id || late === b.id);
  await db.prepare("UPDATE dice_games SET move_deadline = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(t.id).run();
  await settleDice(db, await getDiceRow(db, t.id));
  const after = await getDice(db, t.id);
  const seat = after.seats.find((x) => x.id === late);
  assert.equal(seat.dice_left, 0);
  assert.equal(seat.out.reason, "timeout");
  assert.ok(after.status === "active" || after.status === "finished");
});

test("leaving: a table you opened closes; walking out on the bots before playing aborts", async () => {
  _internal.setRng(seeded(9));
  const db = makeD1();
  const a = await agent(db, "leaver");
  const t = await dicePlay(db, a, { opponents: ["open"] });
  const closed = await diceLeave(db, a, t.id);
  assert.equal(closed.status, "aborted");
  assert.equal(closed.termination, "withdrawn");
  let g = await dicePlay(db, a, { opponents: ["house_knight"] });
  // Leave on the first turn, before acting: the game never really started.
  if (g.your_turn) {
    const left = await diceLeave(db, a, g.id);
    const real = left.rounds.some((r) => r.bids.some((b) => b.seat === left.your_seat) || (r.call && r.call.seat === left.your_seat));
    assert.equal(left.status, real ? "finished" : "aborted");
    if (!real) assert.equal((await diceLeaderboard(db)).ladder.length, 0, "an aborted game isn't scored");
  }
  await rejects(dicePlay(db, a, { opponents: ["house_knight", "house_knight"] }), 400, /twice/);
  await rejects(dicePlay(db, a, { opponents: ["nobody"] }), 404);
  await rejects(dicePlay(db, a, { opponents: [] }), 400);
});

test("bots: the Knight calls an impossible bid and never bids on ones", () => {
  _internal.setRng(seeded(1));
  const s = {
    seats: [
      { id: "agt_x", reserved: null, count: 5, out_round: null, out_reason: null, approach: null },
      { id: "house_knight", reserved: null, count: 5, out_round: null, out_reason: null, approach: null },
    ],
    turn: 1,
    rounds: [{ n: 1, starter: 0, dice: [[2, 3, 4, 5, 6], [2, 3, 3, 5, 6]], bids: [{ seat: 0, quantity: 8, face: 4, reason: null, at: "" }], call: null, voided: null }],
  };
  assert.deepEqual(botDecide(s, 1, "house_knight"), { kind: "liar" });
  s.rounds[0].bids = [{ seat: 0, quantity: 1, face: 2, reason: null, at: "" }];
  for (const bot of ["house_pawn", "house_knight", "house_rook"]) {
    for (let i = 0; i < 30; i++) {
      const d = botDecide(s, 1, bot);
      if (d.kind === "bid") { assert.ok(d.face >= 2 && d.face <= 6); assert.ok(d.quantity > 1 || d.face > 2); assert.ok(d.quantity <= 10); }
    }
  }
});

test("the coach flags a call on a bid your own dice already proved", async () => {
  const db = makeD1();
  const a = await agent(db, "overcaller");
  const at = new Date().toISOString();
  const st = {
    seats: [
      { id: a.id, reserved: null, count: 0, out_round: 1, out_reason: "dice", approach: null },
      { id: "house_knight", reserved: null, count: 1, out_round: null, out_reason: null, approach: null },
    ],
    turn: null,
    rounds: [{
      n: 1, starter: 1, dice: [[1, 4, 4], [2]], voided: null,
      bids: [{ seat: 1, quantity: 3, face: 4, reason: null, at }],
      call: { seat: 0, on: { seat: 1, quantity: 3, face: 4 }, actual: 3, loser: 0, reason: "felt high", at },
    }],
  };
  await db.prepare(`INSERT INTO dice_games (id, status, seats, created_by, state, version, per_move_seconds, winner_id, termination, created_at, updated_at)
    VALUES ('dic_00000000000000aa', 'finished', 2, ?, ?, 3, 3600, 'house_knight', 'last_player_standing', ?, ?)`).bind(a.id, JSON.stringify(st), at, at).run();
  const rv = await diceReview(db, "dic_00000000000000aa", a);
  assert.equal(rv.summary.risky_call, 1);
  assert.equal(rv.decisions[0].odds_last_bid_true_pct, 100);
  assert.equal(rv.decisions[0].your_reason, "felt high");
  assert.match(rv.focus_next_game, /Count before you call/);
  await rejects(diceReview(db, (await dicePlay(db, a, { opponents: ["open"] })).id), 409, /game is over/);
});

test("pages: the dice lobby, a table and the arena link, with names escaped", async () => {
  _internal.setRng(seeded(13));
  const db = makeD1();
  const evil = await agent(db, "<img src=x onerror=alert(1)>");
  const g = await dicePlay(db, evil, { opponents: ["house_pawn"], approach: "<script>alert(2)</script>" });
  const lobby = await (await dicePage({ DB: db })).text();
  assert.match(lobby, /Liar's dice/);
  assert.match(lobby, /Ones are wild/);
  assert.ok(!lobby.includes("<img src=x"), "names are escaped");
  const table = await (await diceGamePage({ DB: db }, g.id)).text();
  assert.match(table, /id="dzgame"/);
  assert.ok(!table.includes("<img src=x") && !table.includes("<script>alert(2)"), "names and approaches are escaped");
  const ap = await (await arenaPage({ DB: db })).text();
  assert.match(ap, /href="\/arena\/dice"/);
});
