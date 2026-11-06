// Weekly tournaments, monthly finals and people playing from the browser,
// against the real migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey, readInbox } from "../.test-build/core.js";
import { play, getGame, makeMove, resign, listGames, leaderboard, arenaSweep, myGames } from "../.test-build/arena.js";
import {
  nextWeekly, finalsOf, nextFinals, roundsFor, pairSwiss, ensureSchedule, joinTournament, leaveTournament,
  tournamentSweep, tournamentView, listTournaments, weeklyHint,
} from "../.test-build/tournament.js";
import { arenaPage, tournamentPage, playPage, gamePage } from "../.test-build/arenapage.js";

let n = 0;
async function agent(db, name, kind) {
  const r = await registerAgent(db, name, { contact_email: `p${++n}@example.com`, kind });
  return await authByKey(db, r.api_key);
}
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));
const later = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60_000);
const types = async (db, id) => (await readInbox(db, id)).events.map((e) => e.type);

test("schedule: weekly on Saturday 17:00 UTC, finals on the last Sunday", () => {
  assert.equal(nextWeekly(new Date("2026-11-02T12:00:00Z")).toISOString(), "2026-11-07T17:00:00.000Z");
  assert.equal(nextWeekly(new Date("2026-11-07T16:59:00Z")).toISOString(), "2026-11-07T17:00:00.000Z");
  assert.equal(nextWeekly(new Date("2026-11-07T17:00:00Z")).toISOString(), "2026-11-14T17:00:00.000Z");
  assert.equal(finalsOf(2026, 10).toISOString(), "2026-11-29T17:00:00.000Z");
  assert.equal(finalsOf(2026, 1).toISOString(), "2026-02-22T17:00:00.000Z");
  assert.equal(nextFinals(new Date("2026-11-29T17:00:00Z")).toISOString(), "2026-12-27T17:00:00.000Z");
});

test("rounds and Swiss pairing: no rematches when avoidable, byes rotate", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8, 9, 40].map(roundsFor), [2, 2, 3, 3, 4, 4, 5, 5]);
  const met = new Set(["a|b", "c|d"]);
  const { pairs, bye } = pairSwiss(["a", "b", "c", "d"], met, new Map());
  assert.equal(bye, null);
  for (const [x, y] of pairs) assert.ok(!met.has(x < y ? `${x}|${y}` : `${y}|${x}`), `rematch ${x}-${y}`);
  const odd = pairSwiss(["a", "b", "c"], new Set(), new Map([["c", 1]]));
  assert.equal(odd.bye, "b", "the lowest-ranked player without a bye sits out");
  assert.deepEqual(odd.pairs, [["a", "c"]]);
  // With two players a rematch is the only option, so it happens.
  assert.equal(pairSwiss(["a", "b"], new Set(["a|b"]), new Map()).pairs.length, 1);
});

test("people register as kind human and show as people on the ladder", async () => {
  const db = makeD1();
  const r = await registerAgent(db, "Jamie at the board", { kind: "human" });
  assert.equal(r.kind, "human");
  const me = await authByKey(db, r.api_key);
  const g = await play(db, me, { opponent: "house_pawn", color: "white" });
  assert.ok(g.legal_uci.includes("e2e4"), "the board client gets moves as from-to squares");
  assert.equal(g.white.kind, "human");
  await resign(db, me, g.id);
  const lb = await leaderboard(db);
  assert.equal(lb.ladder[0].kind, "human");
  const html = await (await arenaPage({ DB: db })).text();
  assert.match(html, /Jamie at the board <span class="mut">\(person\)<\/span>/);
  const pub = await listGames(db, "finished");
  assert.equal(pub.games[0].legal_uci, undefined);
  const bot = await registerAgent(db, "plain-bot", {});
  assert.equal(bot.kind, "agent");
});

test("weekly lifecycle: join, start, rounds advance, forfeit, winner qualifies for the finals", async () => {
  const db = makeD1();
  await ensureSchedule(db, new Date("2026-11-02T12:00:00Z"));
  const a = await agent(db, "alpha-agent");
  const b = await agent(db, "beta-agent");
  const c = await agent(db, "Casey", "human");
  const d = await agent(db, "delta-agent");
  const byId = { [a.id]: a, [b.id]: b, [c.id]: c, [d.id]: d };
  let t = await joinTournament(db, a);
  await joinTournament(db, b, "next");
  await joinTournament(db, c, t.id);
  await joinTournament(db, c, t.id); // twice is fine
  await joinTournament(db, d, t.id);
  t = await tournamentView(db, t.id, c);
  assert.equal(t.entrants, 4);
  assert.equal(t.you_are_in, true);
  assert.equal(t.kind, "weekly");
  // Leaving and rejoining before the start works.
  await leaveTournament(db, c, t.id);
  assert.equal((await tournamentView(db, t.id)).entrants, 3);
  await joinTournament(db, c, t.id);

  // Nothing happens before the start time.
  await tournamentSweep(db, later(t.starts_at, -1));
  assert.equal((await tournamentView(db, t.id)).status, "scheduled");

  await tournamentSweep(db, later(t.starts_at, 1));
  t = await tournamentView(db, t.id);
  assert.equal(t.status, "running");
  assert.equal(t.entrants, 4, "an even field gets no house bot");
  assert.equal(t.rounds_total, 3);
  assert.equal(t.rounds.length, 1);
  assert.equal(t.rounds[0].games.length, 2);
  await rejects(joinTournament(db, await agent(db, "late-comer"), t.id), 409, /started/);

  // Round 1: the first game is a no-show, so white forfeits (unrated); the other ends by resignation.
  let g = await getGame(db, t.rounds[0].games[0].id);
  assert.equal(g.tournament.id, t.id);
  assert.equal(g.tournament.round, 1);
  assert.ok((await types(db, g.white.id)).includes("tournament.round_started"));
  await db.prepare("UPDATE games SET move_deadline = ? WHERE id = ?").bind("2000-01-01T00:00:00.000Z", g.id).run();
  await arenaSweep(db);
  g = await getGame(db, g.id);
  assert.equal(g.termination, "forfeit");
  assert.equal(g.result, "0-1");
  assert.equal(g.rating_change.white, null, "a forfeit is not rated");
  const g2 = await getGame(db, t.rounds[0].games[1].id);
  await resign(db, byId[g2.white.id], g2.id);

  // Rounds 2 and 3: White resigns every game after one move each.
  for (let round = 2; round <= 3; round++) {
    await tournamentSweep(db, later(t.starts_at, round * 10));
    t = await tournamentView(db, t.id);
    assert.equal(t.current_round, round);
    const games = t.rounds.find((r) => r.round === round).games;
    assert.equal(games.length, 2);
    for (const x of games) {
      const gv = await getGame(db, x.id);
      await makeMove(db, byId[gv.white.id], gv.id, { move: "e4" });
      await makeMove(db, byId[gv.black.id], gv.id, { move: "e5" });
      await resign(db, byId[gv.white.id], gv.id);
    }
  }
  // Four players, three rounds: everyone meets everyone once.
  const pairs = t.rounds.flatMap((r) => r.games.map((x) => [x.white, x.black].sort().join("|")));
  assert.equal(new Set(pairs).size, 6);

  await tournamentSweep(db, later(t.starts_at, 40));
  t = await tournamentView(db, t.id);
  assert.equal(t.status, "finished");
  assert.ok(t.winner);
  assert.equal(t.standings.reduce((s, x) => s + x.points, 0), 6, "six games, a point each");
  const winnerInbox = (await readInbox(db, t.winner.id)).events.find((e) => e.type === "tournament.finished");
  assert.equal(winnerInbox.data.place, 1);
  assert.match(winnerInbox.data.qualified_for.name, /Monthly Finals/);

  const l = await listTournaments(db);
  const finals = l.next_finals;
  assert.equal(finals.kind, "finals");
  assert.equal(finals.starts_at, "2026-11-29T17:00:00.000Z");
  const fv = await tournamentView(db, finals.id);
  assert.equal(fv.entrants, 1);
  assert.equal(fv.standings[0].agent_id, t.winner.id);
  assert.equal(fv.standings[0].qualified_from, t.id);
  await rejects(joinTournament(db, a, finals.id), 403, /qualification/);

  // At the finals start, the month's best weekly finishers fill the empty seats.
  await tournamentSweep(db, later(finals.starts_at, 1));
  const fr = await tournamentView(db, finals.id);
  assert.equal(fr.status, "running");
  assert.equal(fr.entrants, 4);
  assert.equal(fr.standings.filter((s) => s.qualified_from === "top_up").length, 3);

  // Humans see their tournament game in their list, flagged as such.
  const mine = await myGames(db, c);
  assert.ok(mine.games.every((x) => x.tournament?.id === finals.id || x.status !== "active"));

  // Pages render with live markers and countdowns.
  const tp = await (await tournamentPage({ DB: db }, finals.id)).text();
  assert.match(tp, /Live now/);
  assert.match(tp, /Round 1/);
  const wp = await (await tournamentPage({ DB: db }, t.id)).text();
  assert.match(wp, /qualifies for the monthly finals/);
});

test("a weekly nobody entered is cancelled cleanly", async () => {
  const db = makeD1();
  await ensureSchedule(db, new Date("2026-11-02T12:00:00Z"));
  const t = (await listTournaments(db)).next_weekly;
  await tournamentSweep(db, later(t.starts_at, 1));
  const v = await tournamentView(db, t.id);
  assert.equal(v.status, "cancelled");
  assert.match(v.note, /Nobody entered/);
  assert.equal(v.entrants, 0, "the house bot never plays a field of its own");
  // The next week is already on the calendar.
  const l = await listTournaments(db);
  assert.ok(l.next_weekly);
});

const isBot = (id) => id.startsWith("house_");

test("house seats: a lone entrant gets three bots and full games, but it's practice with no title", async () => {
  const db = makeD1();
  await ensureSchedule(db, new Date("2026-11-02T12:00:00Z"));
  const solo = await agent(db, "lonely-agent");
  let t = await joinTournament(db, solo);
  assert.match(t.entry, /title is decided only by games between real players/);
  await tournamentSweep(db, later(t.starts_at, 1));
  t = await tournamentView(db, t.id);
  assert.equal(t.status, "running");
  assert.equal(t.entrants, 4, "filled to four");
  assert.equal(t.rounds_total, 3);
  assert.equal(t.standings.filter((s) => s.house).length, 3);
  assert.ok(t.standings.filter((s) => s.house).every((s) => s.qualified_from === "house"));
  assert.equal(t.rounds[0].games.length, 1, "bots don't play each other, so one game a round");
  const first = await getGame(db, t.rounds[0].games[0].id, solo);
  if (first.black?.id === solo.id) {
    assert.equal(first.moves.length, 1, "the house bot opened at once");
    assert.equal(first.your_turn, true);
  } else {
    const after = await makeMove(db, solo, first.id, { move: "e4" });
    assert.equal(after.moves.length, 2, "the house bot answers in the same call");
  }
  const seen = new Set();
  for (let round = 1; round <= 3; round++) {
    if (round > 1) { await tournamentSweep(db, later(t.starts_at, 20 * round)); t = await tournamentView(db, t.id); }
    assert.equal(t.current_round, round);
    const g = t.rounds.find((r) => r.round === round).games;
    assert.equal(g.length, 1);
    const gv = await getGame(db, g[0].id);
    seen.add(isBot(gv.white.id) ? gv.white.id : gv.black.id);
    if (gv.status === "active") await resign(db, solo, gv.id); // lose to every bot
  }
  assert.equal(seen.size, 3, "the lone entrant meets each bot once");
  assert.ok(!(await types(db, solo.id)).includes("tournament.bye"));
  await tournamentSweep(db, later(t.starts_at, 100));
  t = await tournamentView(db, t.id);
  assert.equal(t.status, "finished");
  assert.equal(t.winner, null, "no title without a game between two real players");
  assert.match(t.note, /Practice event/);
  const finals = await tournamentView(db, (await listTournaments(db)).next_finals.id);
  assert.equal(finals.standings.length, 0, "and no finals seat");
  const done = (await readInbox(db, solo.id)).events.find((e) => e.type === "tournament.finished");
  assert.equal(done.payload?.place ?? done.place ?? null, null);
  const page = await (await tournamentPage({ DB: db }, t.id)).text();
  assert.match(page, /Practice event/);
  assert.match(page, /Title pts/);
});

test("house seats: with two real players the title goes by their game, not by points against bots", async () => {
  const db = makeD1();
  await ensureSchedule(db, new Date("2026-11-02T12:00:00Z"));
  const a = await agent(db, "beats-bots");
  const b = await agent(db, "beats-a", "human");
  let t;
  for (const p of [a, b]) t = await joinTournament(db, p);
  await tournamentSweep(db, later(t.starts_at, 1));
  t = await tournamentView(db, t.id);
  assert.equal(t.entrants, 4);
  assert.equal(t.rounds_total, 3);
  let met = 0;
  for (let round = 1; round <= 3; round++) {
    if (round > 1) { await tournamentSweep(db, later(t.starts_at, 20 * round)); t = await tournamentView(db, t.id); }
    assert.equal(t.current_round, round);
    for (const row of t.rounds.find((x) => x.round === round).games) {
      const gv = await getGame(db, row.id);
      assert.ok(!(isBot(gv.white.id) && isBot(gv.black.id)), "two house bots are never paired");
      if (!isBot(gv.white.id) && !isBot(gv.black.id)) { met++; await resign(db, a, gv.id); continue; } // b beats a
      if (gv.white.id === b.id || gv.black.id === b.id) { await resign(db, b, gv.id); continue; } // b loses to the bots
      // a beats the bot (bots never resign, so settle it directly).
      await db.prepare("UPDATE games SET status = 'finished', result = ?, termination = 'resign' WHERE id = ?")
        .bind(gv.white.id === a.id ? "1-0" : "0-1", gv.id).run();
    }
  }
  assert.equal(met, 1, "the two real players meet exactly once");
  await tournamentSweep(db, later(t.starts_at, 100));
  t = await tournamentView(db, t.id);
  assert.equal(t.status, "finished");
  const sa = t.standings.find((s) => s.agent_id === a.id);
  const sb = t.standings.find((s) => s.agent_id === b.id);
  assert.ok(sa.points > sb.points, "a scored more overall, all of it against bots");
  assert.equal(sa.title_points, 0);
  assert.equal(sb.title_points, 1);
  assert.equal(t.winner.id, b.id, "b won the game that counts, so b takes the title");
  const finals = await tournamentView(db, (await listTournaments(db)).next_finals.id);
  assert.deepEqual(finals.standings.map((s) => s.agent_id), [b.id]);
});

test("house seats: an odd field of three gets one bot and no byes", async () => {
  const db = makeD1();
  await ensureSchedule(db, new Date("2026-11-02T12:00:00Z"));
  const ps = [await agent(db, "odd-one"), await agent(db, "odd-two"), await agent(db, "Odd Three", "human")];
  let t;
  for (const p of ps) t = await joinTournament(db, p);
  await tournamentSweep(db, later(t.starts_at, 1));
  t = await tournamentView(db, t.id);
  assert.equal(t.entrants, 4);
  assert.equal(t.standings.filter((s) => s.house).length, 1);
  assert.equal(t.rounds[0].games.length, 2);
  assert.ok(t.standings.every((s) => s.byes === 0));
  const houseGame = t.rounds[0].games.find((x) => /house bot/.test(x.white + x.black));
  assert.ok(houseGame, "someone plays the house bot instead of sitting out");
  for (const p of ps) assert.ok(!(await types(db, p.id)).includes("tournament.bye"));
});

test("pages: tournament countdown, escaping, the play client and live game polling", async () => {
  const db = makeD1();
  await ensureSchedule(db);
  const evil = await agent(db, "<img src=x onerror=alert(1)>");
  const l = await listTournaments(db);
  await joinTournament(db, evil, l.next_weekly.id);
  const tp = await (await tournamentPage({ DB: db }, l.next_weekly.id)).text();
  assert.match(tp, /data-until="/);
  assert.ok(!tp.includes("<img src=x"), "names are escaped");
  assert.equal((await tournamentPage({ DB: db }, "trn_0000000000000000")).status, 404);
  const ap = await (await arenaPage({ DB: db })).text();
  assert.match(ap, /Weekly Tournament/);
  assert.match(ap, /Monthly Finals/);
  const pp = await playPage();
  assert.equal(pp.status, 200);
  const ph = await pp.text();
  assert.match(ph, /\/v1\/agents\/register/);
  assert.match(ph, /kind:"human"/);
  const g = await play(db, evil, { opponent: "house_pawn", color: "white" });
  const gh = await (await gamePage({ DB: db }, g.id)).text();
  assert.match(gh, /id="live"/);
  assert.match(gh, /data-until="/);
});

test("arena pages: real head, readable countdown text, Enter goes to the tournament on the play page", async () => {
  const { untilText } = await import("../.test-build/arenapage.js");
  const now = Date.parse("2026-11-03T01:00:00Z");
  assert.equal(untilText("2026-11-07T17:00:00.000Z", now), "in 4d 16h");
  assert.equal(untilText("2026-11-03T03:30:00.000Z", now), "in 2h 30m");
  assert.equal(untilText("2026-11-03T00:00:00.000Z", now), "Starting now");
  const db = makeD1();
  const ap = await (await arenaPage({ DB: db })).text();
  assert.match(ap, /<html lang="en"><head><meta charset="utf-8">/);
  assert.ok(ap.includes("</head><body"));
  assert.ok(!/data-until="[^"]+">\d{4}-\d{2}-\d{2}T/.test(ap), "countdown fallback must not be a raw timestamp");
  assert.ok(ap.includes('href="/arena/play#tournament">Enter</a>'));
  const pp = await (await playPage()).text();
  assert.ok(pp.includes('<h2 id="tournament">'));
});

test("weekly hint: new players learn the next weekly, its entrants and how to join", async () => {
  const db = makeD1();
  const a = await agent(db, "Hint Reader");
  let h = await weeklyHint(db);
  assert.ok(h, "a weekly is always scheduled");
  assert.match(h.name, /^Weekly Tournament/);
  assert.equal(new Date(h.starts_at).getUTCDay(), 6);
  assert.equal(h.entrants, 0);
  assert.match(h.how_to_join, /tournament_join/);
  await joinTournament(db, a);
  h = await weeklyHint(db);
  assert.equal(h.entrants, 1);
  assert.equal(await weeklyHint({ prepare() { throw new Error("db down"); } }), null, "never throws");
});
