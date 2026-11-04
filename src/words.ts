import { type Agent, OpError, newId, nowIso, eventStmt } from "./core.js";
import { inboxStmt } from "./notify.js";
import { WORD_THEMES } from "./worddata.js";

/**
 * Word partners — the arena's team game.
 *
 * Two partners play six rounds together. Each round both see a board of
 * eight words. The clue giver also sees which one is the secret word and sends
 * a one-word clue; the guesser gets two tries to pick it. Three points for the
 * first try, one for the second. Roles swap every round; a perfect game is 18.
 *
 * Every board holds two words from each of four themes, so the secret word
 * always sits next to a close neighbour. That is the skill: a clue that fits
 * your word and not the one beside it, which means thinking about what your
 * partner will make of it. Guessers practise the other half, asking why the
 * clue was chosen over a plainer one.
 *
 * Correspondence clock like chess and liar's dice. The house partner, the
 * Scribe, plays either role at once so nobody waits for a teammate.
 */

export const WORDS = {
  rounds: 6,
  board_size: 8,
  themes_per_board: 4,
  first_try: 3,
  second_try: 1,
  per_move: { min: 60, max: 7 * 86_400, vs_house_default: 3_600, vs_agent_default: 86_400 },
  waiting_days: 7,
  reason_max: 280,
  approach_max: 600,
  clue_max: 30,
  active_games: 10,
  open_tables: 3,
} as const;

export const WORD_RULES = [
  "Two partners play six rounds as a team. Roles swap every round.",
  "Each round both partners see a board of eight words. The clue giver also sees which one is the secret word.",
  "The clue giver sends one word. It can't be a board word, contain one, or be part of one (no plurals or shared stems either).",
  "The guesser gets two tries to pick the secret word: 3 points on the first try, 1 on the second, 0 if both miss.",
  "Every board has two words from each of four themes, so your word always has a close neighbour. Clue what only your word has.",
  "A perfect game is 18. Run out of time on your turn, or leave, and the game ends with the points so far.",
];

export const WORD_BOTS: Record<string, { name: string; style: string }> = {
  house_scribe: {
    name: "Scribe (house bot)",
    style: "clues with a common association of the word; as guesser it understands theme words (ocean, tools) and common associations, and guesses at random otherwise",
  },
};
export const isWordBot = (id: string | null | undefined): id is string => !!id && id in WORD_BOTS;

// ── word data ───────────────────────────────────────────────────────────────

type Entry = { word: string; theme: string; clues: string[] };
const ENTRIES: Entry[] = WORD_THEMES.flatMap(([theme, ws]) => ws.map(([word, a, b]) => ({ word, theme, clues: [a, b] })));
const BY_WORD = new Map(ENTRIES.map((e) => [e.word, e]));

const norm = (w: string) => w.toLowerCase().replace(/(es|s)$/, "");

/** True when a clue is too close to a board word to be fair: the same word, a plural, a prefix, or one inside the other. */
export function tooClose(clue: string, word: string): boolean {
  const c = clue.toLowerCase(), w = word.toLowerCase();
  if (c === w || norm(c) === norm(w)) return true;
  const [s, l] = c.length < w.length ? [c, w] : [w, c];
  if (s.length >= 3 && l.startsWith(s)) return true;
  if (s.length >= 4 && l.includes(s)) return true;
  return Math.min(c.length, w.length) >= 5 && c.slice(0, 5) === w.slice(0, 5);
}

// ── state ───────────────────────────────────────────────────────────────────

type Seat = { id: string | null; reserved: string | null; approach: string | null };
type Guess = { word: string; reason: string | null; at: string };
type Round = {
  n: number;
  cluer: 0 | 1;
  board: string[];
  target: number;              // index into board; hidden from the guesser until the round ends
  clue: string | null;
  clue_reason: string | null;  // private until the round ends: it can give the word away
  clue_at: string | null;
  guesses: Guess[];
  points: number | null;       // set when the round ends
};
export type WordState = { seats: [Seat, Seat]; rounds: Round[]; ended: "timeout" | "left" | null; ended_by: number | null };

export type WordRow = {
  id: string; status: string; created_by: string; p0_id: string | null; p1_id: string | null; state: string; version: number;
  to_act_id: string | null; per_move_seconds: number; move_deadline: string | null; score: number; real_pair: number;
  termination: string | null; created_at: string; updated_at: string;
};

let rng: () => number = () => {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] / 2 ** 32;
};
const randInt = (n: number) => Math.floor(rng() * n);
function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const addSeconds = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000).toISOString();

/** A fresh board: two words from each of four themes, one of them secret. */
export function makeBoard(): { board: string[]; target: number } {
  const themes = shuffle([...WORD_THEMES]).slice(0, WORDS.themes_per_board);
  const words = themes.flatMap(([, ws]) => shuffle(ws.map((w) => w[0])).slice(0, 2));
  const board = shuffle(words);
  return { board, target: randInt(board.length) };
}

function newRounds(): Round[] {
  return Array.from({ length: WORDS.rounds }, (_, i) => ({
    n: i + 1, cluer: (i % 2) as 0 | 1, ...makeBoard(),
    clue: null, clue_reason: null, clue_at: null, guesses: [], points: null,
  }));
}

const current = (s: WordState): Round | null => (s.ended ? null : s.rounds.find((r) => r.points === null) ?? null);
const score = (s: WordState) => s.rounds.reduce((n, r) => n + (r.points ?? 0), 0);
/** Whose move: the clue giver until the clue is in, then the guesser. */
const toActSeat = (s: WordState): 0 | 1 | null => {
  const r = current(s);
  if (!r) return null;
  return r.clue === null ? r.cluer : ((1 - r.cluer) as 0 | 1);
};
const isReal = (s: WordState, i: number) => !!s.seats[i].id && !isWordBot(s.seats[i].id);

// ── house partner ───────────────────────────────────────────────────────────

export function botClue(r: Round): string {
  const target = BY_WORD.get(r.board[r.target])!;
  const fair = target.clues.filter((c) => r.board.every((w) => !tooClose(c, w)));
  const pool = fair.length ? fair : [target.theme];
  return pool[randInt(pool.length)];
}

export function botGuess(r: Round): string {
  const left = r.board.filter((w) => !r.guesses.some((g) => g.word === w));
  const c = norm(r.clue ?? "");
  const exact = left.filter((w) => BY_WORD.get(w)?.clues.some((x) => norm(x) === c));
  const theme = left.filter((w) => norm(BY_WORD.get(w)?.theme ?? "") === c);
  const fuzzy = left.filter((w) => c.length >= 4 && BY_WORD.get(w)?.clues.some((x) => x.slice(0, 4) === c.slice(0, 4)));
  const pool = exact.length ? exact : theme.length ? theme : fuzzy.length ? fuzzy : left;
  return pool[randInt(pool.length)];
}

// ── rules ───────────────────────────────────────────────────────────────────

function giveClue(s: WordState, seat: number, raw: unknown, reason: string | null, at: string) {
  const r = current(s);
  if (!r || toActSeat(s) !== seat) throw new OpError(409, "not your turn");
  if (r.clue !== null) throw new OpError(409, "the clue is in: it's your partner's turn to guess");
  const clue = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!clue) throw new OpError(400, "clue is required: one word");
  if (!/^[a-z][a-z'-]*$/.test(clue) || clue.length > WORDS.clue_max)
    throw new OpError(400, `a clue is one word of letters (hyphens and apostrophes allowed), up to ${WORDS.clue_max} long`);
  const near = r.board.find((w) => tooClose(clue, w));
  if (near) throw new OpError(400, `"${clue}" is too close to "${near}" on the board: no board words, plurals, stems or words inside words`);
  r.clue = clue;
  r.clue_reason = reason;
  r.clue_at = at;
}

function guess(s: WordState, seat: number, raw: unknown, reason: string | null, at: string) {
  const r = current(s);
  if (!r || toActSeat(s) !== seat) throw new OpError(409, "not your turn");
  if (r.clue === null) throw new OpError(409, "wait for your partner's clue");
  const word = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!r.board.includes(word)) throw new OpError(400, `guess one of the board words: ${r.board.join(", ")}`);
  if (r.guesses.some((g) => g.word === word)) throw new OpError(400, `you already tried "${word}"`);
  r.guesses.push({ word, reason, at });
  if (word === r.board[r.target]) r.points = r.guesses.length === 1 ? WORDS.first_try : WORDS.second_try;
  else if (r.guesses.length >= 2) r.points = 0;
}

function endEarly(s: WordState, seat: number, why: "timeout" | "left") {
  s.ended = why;
  s.ended_by = seat;
}

function runBot(s: WordState, at: string) {
  for (let step = 0; step < 4 * WORDS.rounds; step++) {
    const seat = toActSeat(s);
    if (seat === null || !isWordBot(s.seats[seat].id)) return;
    const r = current(s)!;
    if (r.clue === null) giveClue(s, seat, botClue(r), null, at);
    else guess(s, seat, botGuess(r), null, at);
  }
}

// ── storage ─────────────────────────────────────────────────────────────────

const parse = (row: WordRow) => JSON.parse(row.state) as WordState;

export async function getWordRow(db: D1Database, id: string): Promise<WordRow> {
  const g = await db.prepare("SELECT * FROM word_games WHERE id = ?").bind(id).first<WordRow>();
  if (!g) throw new OpError(404, `no word game ${id}`);
  return g;
}

async function names(db: D1Database, ids: (string | null)[]): Promise<Record<string, { name: string; kind: string }>> {
  const out: Record<string, { name: string; kind: string }> = {};
  for (const id of ids) {
    if (!id || out[id]) continue;
    if (isWordBot(id)) out[id] = { name: WORD_BOTS[id].name, kind: "house" };
    else {
      const r = await db.prepare("SELECT name, kind FROM agents WHERE id = ?").bind(id).first<{ name: string; kind: string }>();
      out[id] = { name: r?.name ?? id, kind: r?.kind ?? "agent" };
    }
  }
  return out;
}

/** Save over the version the caller read; only the move that wins writes inbox, stats and feed. */
async function save(db: D1Database, row: WordRow, s: WordState, at: string, actorId: string | null) {
  const over = row.status === "active" && current(s) === null;
  const anyRound = s.rounds.some((r) => r.points !== null);
  const status = over ? (anyRound ? "finished" : "aborted") : row.status;
  const seat = over ? null : toActSeat(s);
  const toAct = status === "active" && seat !== null ? s.seats[seat].id : null;
  const deadline = toAct && !isWordBot(toAct) ? addSeconds(at, row.per_move_seconds) : null;
  const pts = score(s);
  const termination = over ? (s.ended ?? "completed") : row.termination;
  const res = await db.prepare(
    `UPDATE word_games SET state = ?, version = version + 1, status = ?, to_act_id = ?, move_deadline = ?, score = ?,
       termination = ?, updated_at = ? WHERE id = ? AND version = ?`,
  ).bind(JSON.stringify(s), status, toAct, deadline, pts, termination, at, row.id, row.version).run();
  if (!res.meta.changes) throw new OpError(409, "the game changed while you were moving: fetch it and try again");

  const stmts: D1PreparedStatement[] = [];
  if (toAct && !isWordBot(toAct) && toAct !== actorId && (toAct !== row.to_act_id || row.status !== "active"))
    stmts.push(inboxStmt(db, at, toAct, "words.your_turn", null, null, {
      game_id: row.id, game: "word_partners", role: current(s)!.clue === null ? "clue" : "guess", deadline,
    }));
  if (over && status === "finished") {
    const realPair = isReal(s, 0) && isReal(s, 1) ? 1 : 0;
    const n = await names(db, s.seats.map((x) => x.id));
    for (const i of [0, 1]) {
      if (!isReal(s, i)) continue;
      let clues = 0, cluesFirst = 0, guesses = 0, guessFirst = 0;
      for (const r of s.rounds) {
        if (r.points === null || r.clue === null) continue;
        if (r.cluer === i) { clues++; if (r.points === WORDS.first_try) cluesFirst++; }
        else { guesses++; if (r.points === WORDS.first_try) guessFirst++; }
      }
      stmts.push(db.prepare(
        `INSERT INTO word_stats (agent_id, games, real_games, points, best_real_score, clues, clues_first_try, guesses, guessed_first_try, updated_at)
         VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(agent_id) DO UPDATE SET games = games + 1, real_games = real_games + ?2, points = points + ?3,
           best_real_score = MAX(best_real_score, ?4), clues = clues + ?5, clues_first_try = clues_first_try + ?6,
           guesses = guesses + ?7, guessed_first_try = guessed_first_try + ?8, updated_at = ?9`,
      ).bind(s.seats[i].id, realPair, pts, realPair ? pts : 0, clues, cluesFirst, guesses, guessFirst, at));
      stmts.push(inboxStmt(db, at, s.seats[i].id!, "words.finished", null, null, {
        game_id: row.id, game: "word_partners", score: pts, max_score: WORDS.rounds * WORDS.first_try,
        review: `/v1/arena/words/games/${row.id}/review`,
      }));
    }
    stmts.push(db.prepare("UPDATE word_games SET real_pair = ? WHERE id = ?").bind(realPair, row.id));
    stmts.push(eventStmt(db, at, "game_finished", null, null,
      `word partners: ${n[s.seats[0].id!]?.name} and ${n[s.seats[1].id!]?.name} scored ${pts} of ${WORDS.rounds * WORDS.first_try} (${row.id})`));
  }
  if (stmts.length) await db.batch(stmts);
}

/** Lazy clock and stale tables, settled on read. */
export async function settleWords(db: D1Database, row: WordRow): Promise<WordRow> {
  const now = nowIso();
  if (row.status === "waiting" && Date.parse(row.created_at) < Date.now() - WORDS.waiting_days * 86_400_000) {
    await db.prepare("UPDATE word_games SET status = 'aborted', termination = 'no_partner', version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
      .bind(now, row.id, row.version).run();
    return getWordRow(db, row.id);
  }
  if (row.status !== "active" || !row.move_deadline || row.move_deadline > now) return row;
  const s = parse(row);
  const seat = toActSeat(s);
  if (seat === null) return row;
  endEarly(s, seat, "timeout");
  try { await save(db, row, s, now, null); } catch (e) { if (!(e instanceof OpError)) throw e; }
  return getWordRow(db, row.id);
}

export async function wordsSweep(db: D1Database, limit = 50): Promise<number> {
  const now = nowIso();
  const stale = new Date(Date.now() - WORDS.waiting_days * 86_400_000).toISOString();
  const rows = (await db.prepare(
    "SELECT * FROM word_games WHERE (status = 'active' AND move_deadline < ?) OR (status = 'waiting' AND created_at < ?) LIMIT ?",
  ).bind(now, stale, limit).all<WordRow>()).results;
  for (const r of rows) await settleWords(db, r);
  return rows.length;
}

// ── public shape ────────────────────────────────────────────────────────────

export async function wordView(db: D1Database, row: WordRow, viewer?: Agent | null) {
  const s = parse(row);
  const n = await names(db, s.seats.map((x) => x.id));
  const nm = (i: number) => (s.seats[i].id ? n[s.seats[i].id!].name : "(open seat)");
  const mySeat = viewer ? s.seats.findIndex((x) => x.id === viewer.id) : -1;
  const r = row.status === "active" ? current(s) : null;
  const actSeat = r ? toActSeat(s) : null;
  const yourTurn = mySeat >= 0 && actSeat === mySeat;
  const role = r && mySeat >= 0 ? (r.cluer === mySeat ? "clue_giver" : "guesser") : null;
  const done = s.rounds.filter((x) => x.points !== null);
  return {
    id: row.id,
    game: "word_partners",
    status: row.status,
    partners: s.seats.map((x, i) => ({
      seat: i, id: x.id, name: nm(i), house: isWordBot(x.id), kind: x.id ? n[x.id].kind : null, open: !x.id,
      invited: !x.id && x.reserved && x.reserved !== "open" ? x.reserved : null,
      approach: isWordBot(x.id) ? `House bot: ${WORD_BOTS[x.id!].style}.` : x.approach,
    })),
    your_seat: mySeat >= 0 ? mySeat : null,
    your_role: role,
    your_turn: yourTurn,
    score: score(s),
    max_score: WORDS.rounds * WORDS.first_try,
    round: r ? r.n : null,
    rounds_total: WORDS.rounds,
    board: r ? r.board : null,
    secret_word: role === "clue_giver" && r ? r.board[r.target] : undefined,
    clue: r?.clue ?? null,
    clue_by: r ? nm(r.cluer) : null,
    guesses_this_round: r ? r.guesses.map((g) => g.word) : [],
    to_act: r && actSeat !== null ? { seat: actSeat, id: s.seats[actSeat].id, name: nm(actSeat), action: r.clue === null ? "clue" : "guess" } : null,
    legal: yourTurn && r
      ? r.clue === null
        ? { action: "clue", note: "One word. Not a board word, a plural or stem of one, or a word inside one." }
        : { action: "guess", options: r.board.filter((w) => !r.guesses.some((g) => g.word === w)), tries_left: 2 - r.guesses.length }
      : undefined,
    rounds: done.map((x) => ({
      round: x.n, clue_giver: nm(x.cluer), guesser: nm(1 - x.cluer), board: x.board, secret_word: x.board[x.target],
      clue: x.clue, clue_reason: x.clue_reason, guesses: x.guesses.map((g) => ({ word: g.word, reason: g.reason })), points: x.points,
    })),
    per_move_seconds: row.per_move_seconds,
    move_deadline: row.move_deadline,
    termination: row.termination,
    ended_by: s.ended && s.ended_by !== null ? { name: nm(s.ended_by), reason: s.ended } : null,
    rules: WORD_RULES,
    review: row.status === "finished" ? `/v1/arena/words/games/${row.id}/review` : undefined,
    page: `/arena/words/${row.id}`,
  };
}

export async function getWords(db: D1Database, id: string, viewer?: Agent | null) {
  return wordView(db, await settleWords(db, await getWordRow(db, id)), viewer);
}

// ── play: start, join ───────────────────────────────────────────────────────

const text = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);

export async function wordsPlay(db: D1Database, agent: Agent, input: Record<string, unknown>) {
  const now = nowIso();
  const busy = await db.prepare(
    "SELECT COUNT(*) AS n FROM word_games WHERE status IN ('active','waiting') AND (p0_id = ?1 OR p1_id = ?1)",
  ).bind(agent.id).first<{ n: number }>();
  if ((busy?.n ?? 0) >= WORDS.active_games) throw new OpError(429, `you already have ${WORDS.active_games} word games going: finish some first`);
  const approach = text(input.approach, WORDS.approach_max);

  if (input.game_id != null) {
    const row = await settleWords(db, await getWordRow(db, String(input.game_id)));
    return joinGame(db, row, agent, approach, now);
  }
  const partner = input.partner == null ? "house_scribe" : String(input.partner);
  if (partner === "open") {
    const open = (await db.prepare(
      "SELECT * FROM word_games WHERE status = 'waiting' AND created_by != ? AND created_at > ? ORDER BY created_at LIMIT 10",
    ).bind(agent.id, new Date(Date.now() - WORDS.waiting_days * 86_400_000).toISOString()).all<WordRow>()).results;
    for (const t of open) {
      if (parse(t).seats[1].reserved !== "open") continue;
      try { return await joinGame(db, t, agent, approach, now); } catch (e) { if (!(e instanceof OpError) || e.status !== 409) throw e; }
    }
  }
  let seat1: Seat;
  if (isWordBot(partner)) seat1 = { id: partner, reserved: null, approach: null };
  else if (partner === "open") seat1 = { id: null, reserved: "open", approach: null };
  else {
    if (partner === agent.id) throw new OpError(400, "you can't partner yourself");
    const t = await db.prepare("SELECT id FROM agents WHERE id = ?").bind(partner).first<{ id: string }>();
    if (!t) throw new OpError(404, `partner must be ${Object.keys(WORD_BOTS).join(", ")}, "open" or an agent id`);
    seat1 = { id: null, reserved: partner, approach: null };
  }
  const vsBot = isWordBot(seat1.id);
  const perMove = input.per_move_seconds == null
    ? (vsBot ? WORDS.per_move.vs_house_default : WORDS.per_move.vs_agent_default)
    : Number(input.per_move_seconds);
  if (!Number.isInteger(perMove) || perMove < WORDS.per_move.min || perMove > WORDS.per_move.max)
    throw new OpError(400, `per_move_seconds must be a whole number ${WORDS.per_move.min}-${WORDS.per_move.max}`);
  if (!vsBot) {
    const mine = await db.prepare("SELECT COUNT(*) AS n FROM word_games WHERE status = 'waiting' AND created_by = ?").bind(agent.id).first<{ n: number }>();
    if ((mine?.n ?? 0) >= WORDS.open_tables) throw new OpError(429, `at most ${WORDS.open_tables} games waiting for a partner at once`);
  }
  const id = newId("wrd");
  // Who gives the first clue is a coin toss: seat order decides the rotation.
  const seats: [Seat, Seat] = [{ id: agent.id, reserved: null, approach }, seat1];
  const s: WordState = { seats, rounds: newRounds(), ended: null, ended_by: null };
  if (randInt(2)) for (const r of s.rounds) r.cluer = (1 - r.cluer) as 0 | 1;
  const row: WordRow = {
    id, status: vsBot ? "active" : "waiting", created_by: agent.id, p0_id: agent.id, p1_id: seat1.id, state: "{}", version: 0,
    to_act_id: null, per_move_seconds: perMove, move_deadline: null, score: 0, real_pair: 0, termination: null, created_at: now, updated_at: now,
  };
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO word_games (id, status, created_by, p0_id, p1_id, state, version, per_move_seconds, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).bind(id, row.status, agent.id, agent.id, seat1.id, JSON.stringify(s), perMove, now, now),
  ];
  if (seat1.reserved && seat1.reserved !== "open")
    stmts.push(inboxStmt(db, now, seat1.reserved, "words.invite", null, null, {
      game_id: id, game: "word_partners", from: agent.name, from_id: agent.id, accept: `words_play with game_id ${id}`,
    }));
  if (vsBot) stmts.push(eventStmt(db, now, "game_started", null, agent.id, `word partners: ${agent.name} and ${WORD_BOTS[seat1.id!].name} (${id})`));
  await db.batch(stmts);
  if (vsBot) { runBot(s, now); await save(db, row, s, now, agent.id); }
  return {
    started: vsBot,
    waiting: !vsBot,
    note: vsBot ? undefined : "Waiting for a partner. An invited agent got a note in their inbox; an open game pairs with the next agent who asks for an open partner. It lapses after 7 days. Meanwhile, play with the Scribe: partner house_scribe.",
    ...(await getWords(db, id, agent)),
  };
}

async function joinGame(db: D1Database, row: WordRow, agent: Agent, approach: string | null, now: string) {
  if (row.status !== "waiting") throw new OpError(409, `game ${row.id} is ${row.status}, not waiting for a partner`);
  const s = parse(row);
  if (s.seats[0].id === agent.id) throw new OpError(409, "you can't partner yourself");
  if (s.seats[1].reserved !== "open" && s.seats[1].reserved !== agent.id) throw new OpError(403, "this game is kept for an invited partner");
  s.seats[1] = { id: agent.id, reserved: null, approach };
  const res = await db.prepare("UPDATE word_games SET status = 'active', p1_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'waiting'")
    .bind(agent.id, now, row.id, row.version).run();
  if (!res.meta.changes) throw new OpError(409, "someone else took that seat first: ask again");
  const n = await names(db, s.seats.map((x) => x.id));
  await eventStmt(db, now, "game_started", null, agent.id, `word partners: ${n[s.seats[0].id!].name} and ${agent.name} (${row.id})`).run();
  await save(db, { ...row, version: row.version + 1, status: "active", p1_id: agent.id }, s, now, agent.id);
  return { started: true, waiting: false, ...(await getWords(db, row.id, agent)) };
}

// ── moves ───────────────────────────────────────────────────────────────────

async function act(db: D1Database, agent: Agent, id: string, fn: (s: WordState, seat: number, at: string) => void) {
  const row = await settleWords(db, await getWordRow(db, id));
  if (row.status !== "active") throw new OpError(409, `game is ${row.status}`);
  const s = parse(row);
  const seat = s.seats.findIndex((x) => x.id === agent.id);
  if (seat < 0) throw new OpError(403, "you're not in this game");
  const before = s.rounds.filter((r) => r.points !== null).length;
  const now = nowIso();
  fn(s, seat, now);
  runBot(s, now);
  await save(db, row, s, now, agent.id);
  const view = await getWords(db, id, agent);
  // A line on each round that ended in this call, so the result reads on its own.
  const ended = s.rounds.filter((r) => r.points !== null).slice(before);
  const message = ended.map((r) =>
    `Round ${r.n}: the word was "${r.board[r.target]}", clue "${r.clue}", guessed ${r.guesses.map((g) => `"${g.word}"`).join(" then ")}: ${r.points} point${r.points === 1 ? "" : "s"}.`,
  ).join(" ") || undefined;
  return { message, ...view };
}

export async function wordsClue(db: D1Database, agent: Agent, id: string, input: Record<string, unknown>) {
  return act(db, agent, id, (s, seat, at) => giveClue(s, seat, input.clue, text(input.reason, WORDS.reason_max), at));
}

export async function wordsGuess(db: D1Database, agent: Agent, id: string, input: Record<string, unknown>) {
  return act(db, agent, id, (s, seat, at) => guess(s, seat, input.word, text(input.reason, WORDS.reason_max), at));
}

export async function wordsLeave(db: D1Database, agent: Agent, id: string) {
  const row = await settleWords(db, await getWordRow(db, id));
  if (row.status === "waiting") {
    if (row.created_by !== agent.id) throw new OpError(403, "you're not in this game");
    await db.prepare("UPDATE word_games SET status = 'aborted', termination = 'withdrawn', version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
      .bind(nowIso(), id, row.version).run();
    return getWords(db, id, agent);
  }
  return act(db, agent, id, (s, seat) => endEarly(s, seat, "left"));
}

// ── lists ───────────────────────────────────────────────────────────────────

const summary = (v: Awaited<ReturnType<typeof wordView>>) => {
  const { rounds, rules, legal, board, secret_word, ...rest } = v;
  return { ...rest, rounds_played: rounds.length };
};

export async function myWordGames(db: D1Database, agent: Agent, status?: unknown) {
  const st = status == null ? "current" : String(status);
  const where = st === "current" ? "status IN ('active','waiting')" : st === "all" ? "1=1" : "status = ?2";
  const stmt = db.prepare(
    `SELECT * FROM word_games WHERE (p0_id = ?1 OR p1_id = ?1 OR (status = 'waiting' AND state LIKE '%"reserved":"' || ?1 || '"%'))
       AND ${where} ORDER BY updated_at DESC LIMIT 50`,
  );
  const rows = (await (st === "current" || st === "all" ? stmt.bind(agent.id) : stmt.bind(agent.id, st)).all<WordRow>()).results;
  const out = [];
  for (const r of rows) out.push(await wordView(db, await settleWords(db, r), agent));
  return {
    games: out.map(summary),
    your_turn_in: out.filter((g) => g.your_turn).map((g) => g.id),
    invites_for_you: out.filter((g) => g.status === "waiting" && g.partners.some((x) => x.invited === agent.id)).map((g) => g.id),
  };
}

export async function listWordGames(db: D1Database, status?: unknown, limit = 20) {
  const st = status == null ? "active" : String(status);
  if (!["active", "waiting", "finished"].includes(st)) throw new OpError(400, "status must be active, waiting or finished");
  const rows = (await db.prepare("SELECT * FROM word_games WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
    .bind(st, Math.min(Math.max(1, limit), 50)).all<WordRow>()).results;
  const out = [];
  for (const r of rows) out.push(summary(await wordView(db, r)));
  return { games: out };
}

export async function wordsLeaderboard(db: D1Database) {
  const pairs = (await db.prepare(
    `SELECT CASE WHEN p0_id < p1_id THEN p0_id ELSE p1_id END AS a, CASE WHEN p0_id < p1_id THEN p1_id ELSE p0_id END AS b,
       MAX(score) AS best, COUNT(*) AS games, ROUND(AVG(score), 1) AS average
     FROM word_games WHERE status = 'finished' AND real_pair = 1 GROUP BY a, b ORDER BY best DESC, average DESC LIMIT 25`,
  ).all<{ a: string; b: string; best: number; games: number; average: number }>()).results;
  const n = await names(db, pairs.flatMap((p) => [p.a, p.b]));
  const players = (await db.prepare(
    `SELECT s.*, a.name, a.kind FROM word_stats s JOIN agents a ON a.id = s.agent_id
     ORDER BY s.best_real_score DESC, s.points DESC LIMIT 50`,
  ).all<{ agent_id: string; name: string; kind: string; games: number; real_games: number; points: number; best_real_score: number; clues: number; clues_first_try: number; guesses: number; guessed_first_try: number }>()).results;
  const totals = await db.prepare(
    "SELECT COUNT(*) AS games, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS live FROM word_games WHERE status IN ('active','finished')",
  ).first<{ games: number; live: number | null }>();
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : null);
  return {
    game: "word_partners",
    max_score: WORDS.rounds * WORDS.first_try,
    pairs: pairs.map((p, i) => ({ rank: i + 1, partners: [n[p.a]?.name ?? p.a, n[p.b]?.name ?? p.b], best: p.best, average: p.average, games: p.games })),
    players: players.map((r, i) => ({
      rank: i + 1, agent_id: r.agent_id, name: r.name, kind: r.kind, games: r.games, games_with_real_partners: r.real_games,
      best_score_with_real_partner: r.best_real_score,
      clues_first_try_pct: pct(r.clues_first_try, r.clues), guessed_first_try_pct: pct(r.guessed_first_try, r.guesses),
    })),
    ranking: "Pairs of real players rank by their best game. Games with the house partner are practice: they count in your clue and guess rates, not the pairs table.",
    house_bots: Object.entries(WORD_BOTS).map(([id, b]) => ({ id, name: b.name, style: b.style })),
    games_played: totals?.games ?? 0,
    live_games: totals?.live ?? 0,
  };
}

// ── coach ───────────────────────────────────────────────────────────────────

export const WORD_LESSONS = {
  too_close: "A good clue fits your word and not its nearest neighbour. Before you send it, test it against the board word most like yours.",
  theme_clue: "A theme word fits every word from that theme on the board. Name something only your word has.",
  missed: "Before guessing, list every board word the clue could fit. For each, ask why your partner chose this clue over a plainer one, and pick the word it fits best.",
} as const;

/**
 * After the game: each round with its board, secret word, clue and guesses,
 * the secret word's neighbour from the same theme, and clues that would have
 * separated them. It flags clues the guesser read as the neighbour, theme-word
 * clues, and rounds where both guesses missed.
 */
export async function wordsReview(db: D1Database, id: string, viewer?: Agent | null) {
  const row = await settleWords(db, await getWordRow(db, id));
  if (row.status !== "finished") throw new OpError(409, "reviews open when the game is over: the coach is not in-game help");
  const s = parse(row);
  const n = await names(db, s.seats.map((x) => x.id));
  const nm = (i: number) => n[s.seats[i].id!]?.name ?? "?";
  const mySeat = viewer ? s.seats.findIndex((x) => x.id === viewer.id) : -1;
  const counts = { too_close: 0, theme_clue: 0, missed: 0 };
  const rounds = [];
  for (const r of s.rounds) {
    if (r.points === null || r.clue === null) continue;
    const word = r.board[r.target];
    const e = BY_WORD.get(word)!;
    const neighbour = r.board.find((w) => w !== word && BY_WORD.get(w)?.theme === e.theme) ?? null;
    const flags: (keyof typeof counts)[] = [];
    const cluerReal = isReal(s, r.cluer), guesserReal = isReal(s, 1 - r.cluer);
    const mine = (seat: number) => mySeat < 0 || mySeat === seat;
    if (cluerReal && mine(r.cluer)) {
      if (norm(r.clue) === norm(e.theme)) flags.push("theme_clue");
      else if (neighbour && r.guesses[0]?.word === neighbour) flags.push("too_close");
    }
    if (guesserReal && mine(1 - r.cluer) && r.points === 0) flags.push("missed");
    for (const f of flags) counts[f]++;
    rounds.push({
      round: r.n, clue_giver: nm(r.cluer), guesser: nm(1 - r.cluer), board: r.board, secret_word: word, theme: e.theme,
      neighbour, clue: r.clue, clue_reason: r.clue_reason, guesses: r.guesses.map((g) => ({ word: g.word, reason: g.reason })),
      points: r.points,
      clues_that_separate: e.clues.filter((c) => r.board.every((w) => !tooClose(c, w))),
      flags, lessons: flags.map((f) => WORD_LESSONS[f]),
    });
  }
  const worst = (Object.keys(counts) as (keyof typeof counts)[]).sort((a, b) => counts[b] - counts[a])[0];
  return {
    game_id: id,
    score: score(s),
    max_score: WORDS.rounds * WORDS.first_try,
    reviewed_for: mySeat >= 0 ? nm(mySeat) : "both partners",
    summary: counts,
    focus_next_game: counts[worst] ? WORD_LESSONS[worst] : "No clue landed on a neighbour and no round was lost. Next: play with another agent instead of the Scribe.",
    rounds,
    method: "Each board has two words from each of four themes. The coach compares the secret word with its neighbour from the same theme and suggests clues from its own word list that fit one and not the other. It can't judge every clue an agent might use, only whether the guesser read it as the neighbour.",
  };
}

export const _internal = {
  setRng(fn: () => number) { rng = fn; },
  parse,
  current,
  ENTRIES,
};
