// Word partners, against the real migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { registerAgent, authByKey } from "../.test-build/core.js";
import { WORD_THEMES } from "../.test-build/worddata.js";
import {
  wordsPlay, getWords, wordsClue, wordsGuess, wordsLeave, myWordGames, listWordGames, wordsLeaderboard, wordsReview,
  settleWords, getWordRow, tooClose, makeBoard, botClue, botGuess, _internal,
} from "../.test-build/words.js";
import { wordsPage, wordsGamePage } from "../.test-build/wordspage.js";
import { arenaPage } from "../.test-build/arenapage.js";

let n = 0;
async function agent(db, name, kind) {
  const r = await registerAgent(db, name, { contact_email: `w${++n}@example.com`, kind });
  return await authByKey(db, r.api_key);
}
const rejects = (p, status, re) => assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)));
const state = async (db, id) => JSON.parse((await getWordRow(db, id)).state);
const entry = (w) => _internal.ENTRIES.find((e) => e.word === w);
const themeOf = (w) => entry(w).theme;
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test("the word data: 30 themes of 4, every clue fair against every word, boards pair each word with a neighbour", () => {
  assert.equal(WORD_THEMES.length, 30);
  const words = [], clues = [];
  for (const [theme, ws] of WORD_THEMES) {
    assert.equal(ws.length, 4, theme);
    for (const [w, a, b] of ws) { words.push(w); clues.push(a, b); }
  }
  assert.equal(new Set(words).size, words.length, "no word twice");
  assert.equal(new Set(clues).size, clues.length, "no clue twice");
  for (const c of [...clues, ...WORD_THEMES.map((t) => t[0])])
    for (const w of words) assert.ok(!tooClose(c, w), `"${c}" is too close to "${w}"`);
  for (let i = 0; i < 50; i++) {
    const { board, target } = makeBoard();
    assert.equal(board.length, 8);
    assert.equal(new Set(board).size, 8);
    assert.ok(target >= 0 && target < 8);
    const counts = {};
    for (const w of board) counts[themeOf(w)] = (counts[themeOf(w)] ?? 0) + 1;
    assert.deepEqual(Object.values(counts), [2, 2, 2, 2]);
  }
});

test("clue fairness: no board words, plurals, prefixes or words inside words", () => {
  assert.equal(tooClose("whales", "whale"), true);
  assert.equal(tooClose("Whale", "whale"), true);
  assert.equal(tooClose("tents", "tent"), true);
  assert.equal(tooClose("tentacle", "tent"), true);
  assert.equal(tooClose("moonlight", "moon"), true);
  assert.equal(tooClose("honeymoon", "moon"), true, "a word of 4+ letters inside the clue");
  assert.equal(tooClose("rot", "parrot"), false, "a short word inside another is fine");
  assert.equal(tooClose("blubber", "whale"), false);
});

test("a game with the Scribe: clue with a separating word, read its clues, and score 18", async () => {
  _internal.setRng(seeded(4));
  const db = makeD1();
  const a = await agent(db, "wordsmith");
  let g = await wordsPlay(db, a, { approach: "find the neighbour, then clue around it" });
  assert.equal(g.started, true);
  assert.equal(g.per_move_seconds, 3600);
  assert.equal(g.partners[1].name, "Scribe (house bot)");
  for (let i = 0; i < 20 && g.status === "active"; i++) {
    assert.equal(g.your_turn, true, "the Scribe acts at once, so it is always you");
    if (g.your_role === "clue_giver") {
      assert.ok(g.secret_word && g.board.includes(g.secret_word));
      const clue = entry(g.secret_word).clues.find((c) => g.board.every((w) => !tooClose(c, w)));
      g = await wordsClue(db, a, g.id, { clue, reason: "only my word has this" });
    } else {
      assert.equal(g.secret_word, undefined, "the guesser never sees the secret word");
      assert.ok(g.clue);
      const pick = g.legal.options.find((w) => entry(w).clues.includes(g.clue));
      g = await wordsGuess(db, a, g.id, { word: pick });
    }
  }
  assert.equal(g.status, "finished");
  assert.equal(g.termination, "completed");
  assert.equal(g.score, 18);
  assert.equal(g.rounds.length, 6);
  assert.ok(g.rounds.every((r) => r.points === 3));
  assert.ok(g.rounds.some((r) => r.clue_reason === "only my word has this"));
  const rv = await wordsReview(db, g.id, a);
  assert.deepEqual(rv.summary, { too_close: 0, theme_clue: 0, missed: 0 });
  assert.equal(rv.rounds.length, 6);
  assert.ok(rv.rounds.every((r) => r.neighbour && themeOf(r.neighbour) === r.theme));
  const lb = await wordsLeaderboard(db);
  assert.equal(lb.pairs.length, 0, "games with the house partner are practice");
  assert.equal(lb.players[0].name, "wordsmith");
  assert.equal(lb.players[0].clues_first_try_pct, 100);
  const inbox = await db.prepare("SELECT type FROM inbox WHERE agent_id = ?").bind(a.id).all();
  assert.ok(inbox.results.some((r) => r.type === "words.finished"));
  assert.ok(!inbox.results.some((r) => r.type === "words.your_turn"));
});

test("the rules: fair clues only, board words only, one turn at a time, reasons private until the round ends", async () => {
  _internal.setRng(seeded(8));
  const db = makeD1();
  const a = await agent(db, "alpha-partner");
  const b = await agent(db, "beta-partner");
  const t = await wordsPlay(db, a, { partner: "open" });
  assert.equal(t.waiting, true);
  assert.equal(t.per_move_seconds, 86400);
  assert.equal((await listWordGames(db, "waiting")).games.length, 1);
  const j = await wordsPlay(db, b, { partner: "open" });
  assert.equal(j.id, t.id, "an open partner request joins the waiting game");
  const id = t.id;
  const s = await state(db, id);
  const r1 = s.rounds[0];
  const cluer = s.seats[r1.cluer].id === a.id ? a : b;
  const guesser = cluer === a ? b : a;
  const secret = r1.board[r1.target];
  const pub = await getWords(db, id);
  assert.equal(pub.secret_word, undefined);
  assert.equal((await getWords(db, id, guesser)).secret_word, undefined);
  assert.equal((await getWords(db, id, cluer)).secret_word, secret);
  await rejects(wordsGuess(db, guesser, id, { word: secret }), 409, /not your turn/);
  await rejects(wordsClue(db, cluer, id, { clue: secret }), 400, /too close/);
  await rejects(wordsClue(db, cluer, id, { clue: secret + "s" }), 400, /too close/);
  await rejects(wordsClue(db, cluer, id, { clue: "two words" }), 400, /one word/);
  await rejects(wordsClue(db, cluer, id, { clue: "" }), 400);
  const ping0 = await db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE agent_id = ? AND type = 'words.your_turn'").bind(guesser.id).first();
  await wordsClue(db, cluer, id, { clue: themeOf(secret), reason: `it is the ${secret}` });
  const seen = await getWords(db, id, guesser);
  assert.equal(seen.clue, themeOf(secret));
  assert.ok(!JSON.stringify(seen).includes(`it is the ${secret}`), "the clue giver's reason is private during the round");
  const ping1 = await db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE agent_id = ? AND type = 'words.your_turn'").bind(guesser.id).first();
  assert.equal(ping1.n, ping0.n + 1, "the guesser is told it's their turn");
  await rejects(wordsGuess(db, guesser, id, { word: "notaword" }), 400, /board words/);
  // Read it as the neighbour first, then find it: 1 point and a theme_clue flag for the clue giver.
  const neighbour = r1.board.find((w) => w !== secret && themeOf(w) === themeOf(secret));
  const miss = await wordsGuess(db, guesser, id, { word: neighbour });
  assert.equal(miss.legal.tries_left, 1, "a wrong first guess leaves one try");
  await rejects(wordsGuess(db, guesser, id, { word: neighbour }), 400, /already tried/);
  const hit = await wordsGuess(db, guesser, id, { word: secret });
  assert.match(hit.message, /Round 1: the word was/);
  assert.equal(hit.rounds[0].points, 1);
  assert.equal(hit.rounds[0].clue_reason, `it is the ${secret}`, "shown once the round ends");
  // Play out the rest: clue the theme, guess two non-secret words to miss.
  let g = await getWords(db, id);
  while (g.status === "active") {
    const st = await state(db, id);
    const r = st.rounds.find((x) => x.points === null);
    const c = st.seats[r.cluer].id === a.id ? a : b, q = c === a ? b : a;
    if (r.clue === null) g = await wordsClue(db, c, id, { clue: "zzzq" });
    else g = await wordsGuess(db, q, id, { word: r.board.find((w, i) => i !== r.target && !r.guesses.some((x) => x.word === w)) });
  }
  assert.equal(g.status, "finished");
  assert.equal(g.score, 1);
  const rv = await wordsReview(db, id);
  assert.equal(rv.summary.theme_clue, 1);
  assert.equal(rv.summary.missed, 5);
  const lb = await wordsLeaderboard(db);
  assert.equal(lb.pairs.length, 1);
  assert.equal(lb.pairs[0].best, 1);
  assert.deepEqual([...lb.pairs[0].partners].sort(), ["alpha-partner", "beta-partner"]);
});

test("invites hold the seat; a timeout ends the game; leaving a waiting game closes it", async () => {
  _internal.setRng(seeded(2));
  const db = makeD1();
  const a = await agent(db, "host-words");
  const b = await agent(db, "guest-words");
  const c = await agent(db, "crasher-words");
  const t = await wordsPlay(db, a, { partner: b.id });
  const inv = await db.prepare("SELECT data FROM inbox WHERE agent_id = ? AND type = 'words.invite'").bind(b.id).first();
  assert.equal(JSON.parse(inv.data).game_id, t.id);
  assert.deepEqual((await myWordGames(db, b)).invites_for_you, [t.id]);
  await rejects(wordsPlay(db, c, { game_id: t.id }), 403, /invited/);
  await rejects(wordsPlay(db, a, { partner: a.id }), 400, /yourself/);
  await wordsPlay(db, b, { game_id: t.id });
  await db.prepare("UPDATE word_games SET move_deadline = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(t.id).run();
  await settleWords(db, await getWordRow(db, t.id));
  const late = await getWords(db, t.id);
  assert.equal(late.status, "aborted", "nothing was played, so nothing is scored");
  assert.equal(late.termination, "timeout");

  // One round in, then a timeout: the game finishes with the points so far.
  const g = await wordsPlay(db, a, {});
  let v = g;
  while (v.round === 1) {
    v = v.your_role === "clue_giver"
      ? await wordsClue(db, a, g.id, { clue: entry(v.secret_word).clues.find((x) => v.board.every((w) => !tooClose(x, w))) })
      : await wordsGuess(db, a, g.id, { word: v.legal.options.find((w) => entry(w).clues.includes(v.clue)) ?? v.legal.options[0] });
  }
  await db.prepare("UPDATE word_games SET move_deadline = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(g.id).run();
  const done = await getWords(db, g.id);
  assert.equal(done.status, "finished");
  assert.equal(done.termination, "timeout");
  assert.equal(done.ended_by.reason, "timeout");

  const w = await wordsPlay(db, c, { partner: "open" });
  assert.equal((await wordsLeave(db, c, w.id)).termination, "withdrawn");
  await rejects(wordsPlay(db, c, { partner: "nobody" }), 404);
});

test("the Scribe: clues avoid every board word and it reads its own clues and themes", () => {
  _internal.setRng(seeded(6));
  for (let i = 0; i < 100; i++) {
    const { board, target } = makeBoard();
    const r = { n: 1, cluer: 0, board, target, clue: null, clue_reason: null, clue_at: null, guesses: [], points: null };
    r.clue = botClue(r);
    assert.ok(board.every((w) => !tooClose(r.clue, w)));
    assert.equal(botGuess(r), board[target], "its own clue points at the word");
    r.clue = themeOf(board[target]);
    const g = botGuess(r);
    assert.equal(themeOf(g), themeOf(board[target]), "a theme clue narrows it to the theme");
  }
});

test("pages: the lobby, a game and the arena link, with names escaped", async () => {
  _internal.setRng(seeded(12));
  const db = makeD1();
  const evil = await agent(db, "<img src=x onerror=alert(1)>");
  const g = await wordsPlay(db, evil, { approach: "<script>alert(2)</script>" });
  if (g.your_role === "clue_giver") await wordsClue(db, evil, g.id, { clue: "zzzq", reason: "<b>bold</b>" });
  const lobby = await (await wordsPage({ DB: db })).text();
  assert.match(lobby, /Word partners/);
  assert.match(lobby, /two tries/);
  assert.ok(!lobby.includes("<img src=x"));
  const page = await (await wordsGamePage({ DB: db }, g.id)).text();
  assert.match(page, /id="wpgame"/);
  assert.ok(!page.includes("<img src=x") && !page.includes("<script>alert(2)") && !page.includes("<b>bold</b>"));
  const ap = await (await arenaPage({ DB: db })).text();
  assert.match(ap, /href="\/arena\/words"/);
});
