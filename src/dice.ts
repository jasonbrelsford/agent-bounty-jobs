import { type Agent, OpError, newId, nowIso, eventStmt } from "./core.js";
import { inboxStmt } from "./notify.js";

/**
 * Liar's dice — the arena's bluffing and odds game.
 *
 * Every player rolls five dice and sees only their own. Players take turns
 * raising a bid on how many dice at the table show a face ("four 5s"), or
 * calling the last bid a lie. Ones are wild. On a call every die is shown:
 * if the bid holds the caller loses a die, otherwise the bidder does. Lose all
 * your dice and you are out; the last player with dice wins.
 *
 * It teaches what chess cannot: reasoning about what you can't see, and
 * reading other players' claims as evidence. The count that wins is simple
 * (your matching dice plus a third of the hidden ones) and the coach review
 * after the game shows the odds behind every bid and call you made.
 *
 * Play is correspondence style like chess: each player has `per_move_seconds`
 * to act, enforced lazily on read and by the minute sweep. A player who runs
 * out of time is out of the game. House bots act inside the same request, so
 * an agent never waits on them.
 */

export const DICE = {
  start_dice: 5,
  seats_min: 2,
  seats_max: 6,
  per_move: { min: 60, max: 7 * 86_400, vs_house_default: 3_600, vs_agent_default: 86_400 },
  waiting_days: 7,
  reason_max: 280,
  approach_max: 600,
  active_games: 10,
  open_tables: 3,
  max_bot_steps: 500,
} as const;

export const DICE_RULES = [
  "Everyone starts with 5 dice and sees only their own.",
  "On your turn, raise the bid or call the last bid a lie (liar).",
  "A bid is a quantity and a face 2-6: 'at least four 5s among all dice at the table'. Ones are wild: they count as every face, so you can't bid on ones.",
  "A raise is a higher quantity of any face, or the same quantity of a higher face.",
  "On a call every die is shown. If the bid holds (enough dice match, ones included), the caller loses a die; if not, the bidder does.",
  "The player who lost a die opens the next round. Lose your last die and you're out. The last player with dice wins.",
  "Run out of time on your turn, or leave, and you're out of the game.",
];

type Bot = { name: string; style: string; level: 0 | 1 | 2 };
export const DICE_BOTS: Record<string, Bot> = {
  house_pawn: { name: "Pawn (house bot)", style: "bids at random and calls liar on a hunch, for learning the rules", level: 0 },
  house_knight: { name: "Knight (house bot)", style: "counts its own dice and plays the odds; it never bluffs", level: 1 },
  house_rook: { name: "Rook (house bot)", style: "plays the odds, reads your bids as evidence and bluffs now and then", level: 2 },
};
export const isDiceBot = (id: string | null | undefined): id is string => !!id && id in DICE_BOTS;

// ── state ───────────────────────────────────────────────────────────────────

type Seat = {
  id: string | null;          // who sits here; null while the seat is open
  reserved: string | null;    // "open", or the agent id an invited seat is kept for
  count: number;              // dice left
  out_round: number | null;   // the round they lost their last die or left
  out_reason: "dice" | "timeout" | "left" | null;
  approach: string | null;
};
type Bid = { seat: number; quantity: number; face: number; reason: string | null; at: string };
type Call = { seat: number; on: { seat: number; quantity: number; face: number }; actual: number; loser: number; reason: string | null; at: string };
type Round = {
  n: number;
  starter: number;
  dice: number[][];           // by seat; hidden until the round ends
  bids: Bid[];
  call: Call | null;
  voided: { seat: number; reason: "timeout" | "left"; at: string } | null;
};
export type DiceState = { seats: Seat[]; turn: number | null; rounds: Round[] };

export type DiceRow = {
  id: string; status: string; seats: number; created_by: string; state: string; version: number;
  to_act_id: string | null; per_move_seconds: number; move_deadline: string | null;
  winner_id: string | null; termination: string | null; created_at: string; updated_at: string;
};

let rng: () => number = () => {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] / 2 ** 32;
};
const randInt = (n: number) => Math.floor(rng() * n);
const roll = (n: number) => Array.from({ length: n }, () => 1 + randInt(6)).sort((a, b) => a - b);
const addSeconds = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000).toISOString();

const live = (s: DiceState) => s.seats.map((x, i) => (x.count > 0 ? i : -1)).filter((i) => i >= 0);
const current = (s: DiceState): Round | null => {
  const r = s.rounds[s.rounds.length - 1];
  return r && !r.call && !r.voided ? r : null;
};
const totalDice = (s: DiceState) => s.seats.reduce((n, x) => n + x.count, 0);
const nextLive = (s: DiceState, from: number) => {
  for (let k = 1; k <= s.seats.length; k++) {
    const i = (from + k) % s.seats.length;
    if (s.seats[i].count > 0) return i;
  }
  return null;
};
const isReal = (s: DiceState, i: number) => !!s.seats[i].id && !isDiceBot(s.seats[i].id);

/** Dice that count toward a face: that face, plus ones (wild). */
export const matching = (dice: number[], face: number) => dice.filter((d) => d === face || d === 1).length;

function startRound(s: DiceState, starter: number) {
  s.rounds.push({
    n: s.rounds.length + 1, starter,
    dice: s.seats.map((x) => roll(x.count)), bids: [], call: null, voided: null,
  });
  s.turn = starter;
}

// ── odds ────────────────────────────────────────────────────────────────────

const choose = (n: number, k: number) => {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
};

/** P(at least k of n hidden dice match a face), each die matching with p = 1/3 (the face or a wild one). */
export function atLeast(k: number, n: number, p = 1 / 3): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let sum = 0;
  for (let i = k; i <= n; i++) sum += choose(n, i) * p ** i * (1 - p) ** (n - i);
  return Math.min(1, sum);
}

/** The odds a bid is true, counting only your own dice. */
export function oddsFor(own: number[], total: number, quantity: number, face: number, evidence = 0): number {
  const hidden = total - own.length - evidence;
  return atLeast(quantity - matching(own, face) - evidence, Math.max(0, hidden));
}

/** Every smallest raise over a bid: for each face, the least quantity that beats it. */
export function minRaises(bid: { quantity: number; face: number } | null, total: number) {
  const out: { quantity: number; face: number }[] = [];
  for (let f = 2; f <= 6; f++) {
    const q = !bid ? 1 : f > bid.face ? bid.quantity : bid.quantity + 1;
    if (q <= total) out.push({ quantity: q, face: f });
  }
  return out;
}

// ── house bots ──────────────────────────────────────────────────────────────

type Decision = { kind: "bid"; quantity: number; face: number } | { kind: "liar" };

export function botDecide(s: DiceState, seat: number, botId: string): Decision {
  const bot = DICE_BOTS[botId];
  const r = current(s)!;
  const own = r.dice[seat];
  const total = totalDice(s);
  const last = r.bids[r.bids.length - 1] ?? null;
  const raises = minRaises(last, total);
  if (last && !raises.length) return { kind: "liar" };

  if (bot.level === 0) {
    if (last && (last.quantity > total / 2 || rng() < 0.2)) return { kind: "liar" };
    if (!last) return { kind: "bid", quantity: 1 + randInt(Math.max(1, Math.floor(total / 4))), face: 2 + randInt(5) };
    const pick = raises[randInt(raises.length)];
    return { kind: "bid", ...pick };
  }

  // Knight and Rook count. Rook also treats the last bidder's face as evidence
  // that they hold one more of it than chance would give.
  const ev = (face: number) => (bot.level === 2 && last && last.seat !== seat && last.face === face ? 1 : 0);
  if (!last) {
    let best = 2;
    for (let f = 3; f <= 6; f++) if (matching(own, f) > matching(own, best) || (matching(own, f) === matching(own, best) && rng() < 0.5)) best = f;
    const q = Math.max(1, Math.floor(matching(own, best) + (total - own.length) / 3));
    return { kind: "bid", quantity: q, face: best };
  }
  const pLast = oddsFor(own, total, last.quantity, last.face, ev(last.face));
  const scored = [];
  for (const m of raises) {
    scored.push({ ...m, p: oddsFor(own, total, m.quantity, m.face, ev(m.face)) });
    if (m.quantity + 1 <= total) scored.push({ quantity: m.quantity + 1, face: m.face, p: oddsFor(own, total, m.quantity + 1, m.face, ev(m.face)) });
  }
  scored.sort((a, b) => b.p - a.p || a.quantity - b.quantity);
  const best = scored[0];
  if (pLast < 0.4 || best.p < 0.3) return { kind: "liar" };
  if (bot.level === 2 && rng() < 0.15) {
    // A bluff: bid a face it barely holds, as long as the bid is still plausible.
    const bluff = scored.filter((x) => x.p >= 0.3).sort((a, b) => matching(own, a.face) - matching(own, b.face))[0];
    if (bluff) return { kind: "bid", quantity: bluff.quantity, face: bluff.face };
  }
  return { kind: "bid", quantity: best.quantity, face: best.face };
}

// ── rules ───────────────────────────────────────────────────────────────────

function bid(s: DiceState, seat: number, quantity: number, face: number, reason: string | null, at: string) {
  const r = current(s);
  if (!r || s.turn !== seat) throw new OpError(409, "not your turn");
  if (!Number.isInteger(face) || face < 1 || face > 6) throw new OpError(400, "face must be 2-6");
  if (face === 1) throw new OpError(400, "ones are wild, so you can't bid on ones: bid a face 2-6 and the ones count toward it");
  const total = totalDice(s);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > total)
    throw new OpError(400, `quantity must be a whole number from 1 to ${total} (the dice at the table)`);
  const last = r.bids[r.bids.length - 1];
  if (last && !(quantity > last.quantity || (quantity === last.quantity && face > last.face)))
    throw new OpError(400, `a raise must beat ${last.quantity} × ${last.face}: a higher quantity, or ${last.quantity} of a higher face`);
  r.bids.push({ seat, quantity, face, reason, at });
  s.turn = nextLive(s, seat);
}

function call(s: DiceState, seat: number, reason: string | null, at: string) {
  const r = current(s);
  if (!r || s.turn !== seat) throw new OpError(409, "not your turn");
  const last = r.bids[r.bids.length - 1];
  if (!last) throw new OpError(400, "there's no bid to call yet: you open this round, so make a bid");
  const actual = r.dice.reduce((n, d) => n + matching(d, last.face), 0);
  const loser = actual >= last.quantity ? seat : last.seat;
  r.call = { seat, on: { seat: last.seat, quantity: last.quantity, face: last.face }, actual, loser, reason, at };
  const L = s.seats[loser];
  L.count -= 1;
  if (L.count === 0) { L.out_round = r.n; L.out_reason = "dice"; }
  if (live(s).length > 1) startRound(s, L.count > 0 ? loser : nextLive(s, loser)!);
  else s.turn = null;
}

/** Out of the game: on time, or by leaving. The round in play is voided and re-rolled. */
function removeSeat(s: DiceState, seat: number, why: "timeout" | "left", at: string) {
  const x = s.seats[seat];
  if (x.count === 0) return;
  const r = current(s);
  x.count = 0;
  x.out_round = r?.n ?? s.rounds.length;
  x.out_reason = why;
  if (r) r.voided = { seat, reason: why, at };
  if (live(s).length > 1) startRound(s, nextLive(s, seat)!);
  else s.turn = null;
}

function runBots(s: DiceState, at: string) {
  for (let step = 0; step < DICE.max_bot_steps; step++) {
    if (s.turn === null || live(s).length < 2) return;
    const id = s.seats[s.turn].id;
    if (!isDiceBot(id)) return;
    // Bots never play on alone: once no real player has dice, the game is decided.
    if (!live(s).some((i) => isReal(s, i))) return;
    const d = botDecide(s, s.turn, id);
    if (d.kind === "liar") call(s, s.turn, null, at);
    else bid(s, s.turn, d.quantity, d.face, null, at);
  }
  throw new Error("dice: bots did not finish their turns");
}

/** Who won, once the game is decided. */
function outcome(s: DiceState): { winner: number; termination: string } | null {
  const l = live(s);
  if (l.length === 1) return { winner: l[0], termination: "last_player_standing" };
  if (l.length > 1 && !l.some((i) => isReal(s, i))) {
    const best = l.reduce((a, b) => (s.seats[b].count > s.seats[a].count ? b : a));
    return { winner: best, termination: "abandoned" };
  }
  return null;
}

// ── storage ─────────────────────────────────────────────────────────────────

const parse = (row: DiceRow) => JSON.parse(row.state) as DiceState;

export async function getDiceRow(db: D1Database, id: string): Promise<DiceRow> {
  const g = await db.prepare("SELECT * FROM dice_games WHERE id = ?").bind(id).first<DiceRow>();
  if (!g) throw new OpError(404, `no dice game ${id}`);
  return g;
}

async function names(db: D1Database, ids: (string | null)[]): Promise<Record<string, { name: string; kind: string }>> {
  const out: Record<string, { name: string; kind: string }> = {};
  for (const id of ids) {
    if (!id || out[id]) continue;
    if (isDiceBot(id)) out[id] = { name: DICE_BOTS[id].name, kind: "house" };
    else {
      const r = await db.prepare("SELECT name, kind FROM agents WHERE id = ?").bind(id).first<{ name: string; kind: string }>();
      out[id] = { name: r?.name ?? id, kind: r?.kind ?? "agent" };
    }
  }
  return out;
}

/**
 * Save a new state over the version the caller read. The UPDATE is the race
 * arbiter: if another move landed first it matches no row and nothing else
 * (inbox, stats, feed) is written.
 */
async function save(db: D1Database, row: DiceRow, s: DiceState, at: string, actorId: string | null) {
  const end = row.status === "active" ? outcome(s) : null;
  const realActed = s.rounds.some((r) => r.bids.some((b) => isReal(s, b.seat)) || (r.call && isReal(s, r.call.seat)));
  // Nobody real ever bid or called: the game never really started, so it is aborted, not scored.
  const status = end ? (realActed ? "finished" : "aborted") : row.status;
  const toAct = !end && status === "active" && s.turn !== null ? s.seats[s.turn].id : null;
  const deadline = toAct && !isDiceBot(toAct) ? addSeconds(at, row.per_move_seconds) : null;
  const winner = end && status === "finished" ? s.seats[end.winner].id : null;
  const res = await db.prepare(
    `UPDATE dice_games SET state = ?, version = version + 1, status = ?, to_act_id = ?, move_deadline = ?,
       winner_id = ?, termination = ?, updated_at = ? WHERE id = ? AND version = ?`,
  ).bind(JSON.stringify(s), status, toAct, deadline, winner, end?.termination ?? row.termination, at, row.id, row.version).run();
  if (!res.meta.changes) throw new OpError(409, "the table changed while you were moving: fetch the game and try again");

  const stmts: D1PreparedStatement[] = [];
  if (toAct && !isDiceBot(toAct) && toAct !== actorId && (toAct !== row.to_act_id || row.status !== "active"))
    stmts.push(inboxStmt(db, at, toAct, "dice.your_turn", null, null, { game_id: row.id, game: "liars_dice", deadline }));
  if (end) {
    const n = await names(db, s.seats.map((x) => x.id));
    const realSeats = s.seats.map((_, i) => i).filter((i) => isReal(s, i));
    if (status === "finished") {
      const realGame = realSeats.length >= 2 ? 1 : 0;
      for (const i of realSeats) {
        let calls = 0, right = 0, called = 0, held = 0;
        for (const r of s.rounds) {
          if (!r.call) continue;
          if (r.call.seat === i) { calls++; if (r.call.loser !== i) right++; }
          if (r.call.on.seat === i) { called++; if (r.call.loser !== i) held++; }
        }
        const won = i === end.winner ? 1 : 0;
        stmts.push(db.prepare(
          `INSERT INTO dice_stats (agent_id, games, wins, real_games, real_wins, calls, calls_right, bids_called, bids_held, updated_at)
           VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT(agent_id) DO UPDATE SET games = games + 1, wins = wins + ?2, real_games = real_games + ?3,
             real_wins = real_wins + ?4, calls = calls + ?5, calls_right = calls_right + ?6,
             bids_called = bids_called + ?7, bids_held = bids_held + ?8, updated_at = ?9`,
        ).bind(s.seats[i].id, won, realGame, won * realGame, calls, right, called, held, at));
        stmts.push(inboxStmt(db, at, s.seats[i].id!, "dice.finished", null, null, {
          game_id: row.id, game: "liars_dice", won: !!won, winner: n[s.seats[end.winner].id!]?.name,
          review: `/v1/arena/dice/games/${row.id}/review`,
        }));
      }
      stmts.push(eventStmt(db, at, "game_finished", null, null,
        `liar's dice: ${n[s.seats[end.winner].id!]?.name} won a ${s.seats.length}-player game (${row.id})`));
    }
  }
  if (stmts.length) await db.batch(stmts);
}

/** Lazy clock and stale tables, settled on read. */
export async function settleDice(db: D1Database, row: DiceRow): Promise<DiceRow> {
  const now = nowIso();
  if (row.status === "waiting" && Date.parse(row.created_at) < Date.now() - DICE.waiting_days * 86_400_000) {
    await db.prepare("UPDATE dice_games SET status = 'aborted', termination = 'no_opponent', version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
      .bind(now, row.id, row.version).run();
    return getDiceRow(db, row.id);
  }
  if (row.status !== "active" || !row.move_deadline || row.move_deadline > now) return row;
  const s = parse(row);
  if (s.turn === null) return row;
  removeSeat(s, s.turn, "timeout", now);
  runBots(s, now);
  try { await save(db, row, s, now, null); } catch (e) { if (!(e instanceof OpError)) throw e; }
  return getDiceRow(db, row.id);
}

export async function diceSweep(db: D1Database, limit = 50): Promise<number> {
  const now = nowIso();
  const stale = new Date(Date.now() - DICE.waiting_days * 86_400_000).toISOString();
  const rows = (await db.prepare(
    "SELECT * FROM dice_games WHERE (status = 'active' AND move_deadline < ?) OR (status = 'waiting' AND created_at < ?) LIMIT ?",
  ).bind(now, stale, limit).all<DiceRow>()).results;
  for (const r of rows) await settleDice(db, r);
  return rows.length;
}

// ── public shape ────────────────────────────────────────────────────────────

const face = (f: number) => `${f}s`;

export async function diceView(db: D1Database, row: DiceRow, viewer?: Agent | null) {
  const s = parse(row);
  const n = await names(db, s.seats.map((x) => x.id));
  const nm = (i: number) => (s.seats[i].id ? n[s.seats[i].id!].name : "(open seat)");
  const mySeat = viewer ? s.seats.findIndex((x) => x.id === viewer.id) : -1;
  const r = row.status === "active" ? current(s) : null;
  const total = totalDice(s);
  const last = r?.bids[r.bids.length - 1] ?? null;
  const yourTurn = mySeat >= 0 && r !== null && s.turn === mySeat;
  const done = s.rounds.filter((x) => x !== r);
  return {
    id: row.id,
    game: "liars_dice",
    status: row.status,
    seats: s.seats.map((x, i) => ({
      seat: i,
      id: x.id,
      name: nm(i),
      house: isDiceBot(x.id),
      kind: x.id ? n[x.id].kind : null,
      open: !x.id,
      invited: !x.id && x.reserved && x.reserved !== "open" ? x.reserved : null,
      dice_left: x.count,
      out: x.out_reason ? { round: x.out_round, reason: x.out_reason } : null,
      approach: isDiceBot(x.id) ? `House bot: ${DICE_BOTS[x.id!].style}.` : x.approach,
    })),
    your_seat: mySeat >= 0 ? mySeat : null,
    your_turn: yourTurn,
    your_dice: mySeat >= 0 && r ? r.dice[mySeat] : undefined,
    round: r ? r.n : null,
    total_dice: row.status === "active" ? total : undefined,
    to_act: r && s.turn !== null ? { seat: s.turn, id: s.seats[s.turn].id, name: nm(s.turn) } : null,
    current_bid: last ? { quantity: last.quantity, face: last.face, by: nm(last.seat), seat: last.seat, text: `${last.quantity} × ${face(last.face)}` } : null,
    // Reasons stay private until the round is called: they can give away a hand.
    bids_this_round: r ? r.bids.map((b) => ({ seat: b.seat, by: nm(b.seat), quantity: b.quantity, face: b.face, reason: b.seat === mySeat ? b.reason : undefined })) : [],
    legal: yourTurn
      ? { can_call_liar: !!last, raises: minRaises(last, total), max_quantity: total, note: "Any bid that beats the current one is legal; these are the smallest raise on each face." }
      : undefined,
    rounds: done.map((x) => ({
      round: x.n,
      dice: x.voided ? undefined : x.dice.map((d, i) => ({ seat: i, name: nm(i), dice: d })).filter((d) => d.dice.length),
      bids: x.bids.map((b) => ({ seat: b.seat, by: nm(b.seat), quantity: b.quantity, face: b.face, reason: b.reason })),
      call: x.call ? {
        by: nm(x.call.seat), seat: x.call.seat, on: `${x.call.on.quantity} × ${face(x.call.on.face)} by ${nm(x.call.on.seat)}`,
        actual: x.call.actual, bid_held: x.call.actual >= x.call.on.quantity, loser: nm(x.call.loser), loser_seat: x.call.loser,
        reason: x.call.reason,
        text: `${nm(x.call.seat)} called liar on ${x.call.on.quantity} × ${face(x.call.on.face)}. There were ${x.call.actual}, so ${nm(x.call.loser)} lost a die.`,
      } : null,
      voided: x.voided ? { seat: x.voided.seat, text: `${nm(x.voided.seat)} ${x.voided.reason === "timeout" ? "ran out of time" : "left"}, so the round was re-rolled.` } : null,
    })),
    per_move_seconds: row.per_move_seconds,
    move_deadline: row.move_deadline,
    winner: row.winner_id ? { id: row.winner_id, name: n[row.winner_id]?.name ?? row.winner_id } : null,
    termination: row.termination,
    rules: DICE_RULES,
    review: row.status === "finished" ? `/v1/arena/dice/games/${row.id}/review` : undefined,
    page: `/arena/dice/${row.id}`,
  };
}

export async function getDice(db: D1Database, id: string, viewer?: Agent | null) {
  return diceView(db, await settleDice(db, await getDiceRow(db, id)), viewer);
}

// ── play: start, join ───────────────────────────────────────────────────────

const text = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);

export async function dicePlay(db: D1Database, agent: Agent, input: Record<string, unknown>) {
  const now = nowIso();
  const busy = await db.prepare(
    `SELECT COUNT(*) AS n FROM dice_games g JOIN dice_seats s ON s.game_id = g.id
     WHERE s.agent_id = ? AND g.status IN ('active','waiting')`,
  ).bind(agent.id).first<{ n: number }>();
  if ((busy?.n ?? 0) >= DICE.active_games) throw new OpError(429, `you already have ${DICE.active_games} dice games going: finish some first`);
  const approach = text(input.approach, DICE.approach_max);

  if (input.game_id != null) {
    const row = await settleDice(db, await getDiceRow(db, String(input.game_id)));
    return joinTable(db, row, agent, approach, now);
  }

  const raw = input.opponents == null ? ["house_knight"] : Array.isArray(input.opponents) ? input.opponents.map(String) : [String(input.opponents)];
  if (raw.length < DICE.seats_min - 1 || raw.length > DICE.seats_max - 1)
    throw new OpError(400, `opponents: 1 to ${DICE.seats_max - 1} of house_pawn, house_knight, house_rook, "open" or an agent id`);

  // Quick match: one open seat asked for, so sit at the oldest table someone else opened.
  if (raw.length === 1 && raw[0] === "open") {
    const tables = (await db.prepare(
      "SELECT * FROM dice_games WHERE status = 'waiting' AND created_by != ? AND created_at > ? ORDER BY created_at LIMIT 10",
    ).bind(agent.id, new Date(Date.now() - DICE.waiting_days * 86_400_000).toISOString()).all<DiceRow>()).results;
    for (const t of tables) {
      if (parse(t).seats.some((x) => !x.id && x.reserved === "open")) {
        try { return await joinTable(db, t, agent, approach, now); } catch (e) { if (!(e instanceof OpError) || e.status !== 409) throw e; }
      }
    }
  }

  const seen = new Set<string>([agent.id]);
  const seats: Seat[] = [{ id: agent.id, reserved: null, count: DICE.start_dice, out_round: null, out_reason: null, approach }];
  for (const o of raw) {
    if (o !== "open") {
      if (seen.has(o)) throw new OpError(400, o === agent.id ? "you can't seat yourself twice" : `${o} is listed twice`);
      seen.add(o);
    }
    if (o === "open") seats.push({ id: null, reserved: "open", count: DICE.start_dice, out_round: null, out_reason: null, approach: null });
    else if (isDiceBot(o)) seats.push({ id: o, reserved: null, count: DICE.start_dice, out_round: null, out_reason: null, approach: null });
    else {
      const t = await db.prepare("SELECT id FROM agents WHERE id = ?").bind(o).first<{ id: string }>();
      if (!t) throw new OpError(404, `opponents: "${o}" is not a house bot (${Object.keys(DICE_BOTS).join(", ")}), "open" or an agent id`);
      seats.push({ id: null, reserved: o, count: DICE.start_dice, out_round: null, out_reason: null, approach: null });
    }
  }
  const allBots = seats.slice(1).every((x) => isDiceBot(x.id));
  const perMove = input.per_move_seconds == null
    ? (allBots ? DICE.per_move.vs_house_default : DICE.per_move.vs_agent_default)
    : Number(input.per_move_seconds);
  if (!Number.isInteger(perMove) || perMove < DICE.per_move.min || perMove > DICE.per_move.max)
    throw new OpError(400, `per_move_seconds must be a whole number ${DICE.per_move.min}-${DICE.per_move.max}`);
  if (!allBots) {
    const mine = await db.prepare("SELECT COUNT(*) AS n FROM dice_games WHERE status = 'waiting' AND created_by = ?").bind(agent.id).first<{ n: number }>();
    if ((mine?.n ?? 0) >= DICE.open_tables) throw new OpError(429, `at most ${DICE.open_tables} tables waiting for players at once`);
  }

  const id = newId("dic");
  const s: DiceState = { seats, turn: null, rounds: [] };
  const full = seats.every((x) => x.id);
  if (full) { startRound(s, randInt(seats.length)); runBots(s, now); }
  const row: DiceRow = {
    id, status: full ? "active" : "waiting", seats: seats.length, created_by: agent.id, state: "{}", version: 0,
    to_act_id: null, per_move_seconds: perMove, move_deadline: null, winner_id: null, termination: null, created_at: now, updated_at: now,
  };
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO dice_games (id, status, seats, created_by, state, version, per_move_seconds, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).bind(id, row.status, seats.length, agent.id, JSON.stringify({ seats, turn: null, rounds: [] }), perMove, now, now),
    ...seats.map((x, i) => (x.id ? db.prepare("INSERT INTO dice_seats (game_id, seat, agent_id) VALUES (?, ?, ?)").bind(id, i, x.id) : null))
      .filter((x): x is D1PreparedStatement => !!x),
  ];
  for (const x of seats)
    if (x.reserved && x.reserved !== "open")
      stmts.push(inboxStmt(db, now, x.reserved, "dice.invite", null, null, {
        game_id: id, game: "liars_dice", from: agent.name, from_id: agent.id, accept: `dice_play with game_id ${id}`,
      }));
  if (full) {
    const n = await names(db, seats.map((x) => x.id));
    stmts.push(eventStmt(db, now, "game_started", null, agent.id, `liar's dice: ${seats.map((x) => n[x.id!].name).join(", ")} (${id})`));
  }
  await db.batch(stmts);
  if (full) await save(db, row, s, now, agent.id);
  const view = await getDice(db, id, agent);
  return {
    started: full,
    waiting: !full,
    note: full
      ? undefined
      : "The table is open. It starts when every seat is taken; invited agents got a note in their inbox. It lapses after 7 days. Meanwhile, play the house bots: opponents [\"house_knight\"].",
    ...view,
  };
}

async function joinTable(db: D1Database, row: DiceRow, agent: Agent, approach: string | null, now: string) {
  if (row.status !== "waiting") throw new OpError(409, `game ${row.id} is ${row.status}, not waiting for players`);
  const s = parse(row);
  if (s.seats.some((x) => x.id === agent.id)) throw new OpError(409, "you're already at this table");
  let seat = s.seats.findIndex((x) => !x.id && x.reserved === agent.id);
  if (seat < 0) seat = s.seats.findIndex((x) => !x.id && x.reserved === "open");
  if (seat < 0) throw new OpError(403, "no seat here is open to you: the rest are kept for invited agents");
  s.seats[seat] = { ...s.seats[seat], id: agent.id, reserved: null, approach };
  const full = s.seats.every((x) => x.id);
  if (full) { startRound(s, randInt(s.seats.length)); runBots(s, now); }
  const res = await db.prepare("UPDATE dice_games SET state = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'waiting'")
    .bind(JSON.stringify(full ? { ...s, rounds: [], turn: null } : s), full ? "active" : "waiting", now, row.id, row.version).run();
  if (!res.meta.changes) throw new OpError(409, "someone else took a seat first: ask again");
  const stmts: D1PreparedStatement[] = [db.prepare("INSERT INTO dice_seats (game_id, seat, agent_id) VALUES (?, ?, ?)").bind(row.id, seat, agent.id)];
  if (full) {
    const n = await names(db, s.seats.map((x) => x.id));
    stmts.push(eventStmt(db, now, "game_started", null, agent.id, `liar's dice: ${s.seats.map((x) => n[x.id!].name).join(", ")} (${row.id})`));
  }
  await db.batch(stmts);
  if (full) await save(db, { ...row, version: row.version + 1, status: "active", to_act_id: null }, s, now, agent.id);
  return { started: full, waiting: !full, ...(await getDice(db, row.id, agent)) };
}

// ── moves ───────────────────────────────────────────────────────────────────

async function act(db: D1Database, agent: Agent, id: string, fn: (s: DiceState, seat: number, at: string) => void) {
  const row = await settleDice(db, await getDiceRow(db, id));
  if (row.status !== "active") throw new OpError(409, `game is ${row.status}${row.winner_id ? " (it's over)" : ""}`);
  const s = parse(row);
  const seat = s.seats.findIndex((x) => x.id === agent.id);
  if (seat < 0) throw new OpError(403, "you're not at this table");
  if (s.seats[seat].count === 0) throw new OpError(409, "you're out of this game");
  const now = nowIso();
  const roundsBefore = s.rounds.length;
  fn(s, seat, now);
  runBots(s, now);
  await save(db, row, s, now, agent.id);
  const view = await getDice(db, id, agent);
  // What happened since your move, in a line: the calls that ended rounds.
  const calls = s.rounds.slice(Math.max(0, roundsBefore - 1)).map((r) => r.call).filter(Boolean) as Call[];
  const n = await names(db, s.seats.map((x) => x.id));
  const nm = (i: number) => n[s.seats[i].id!]?.name ?? "?";
  const lines = calls.map((c) => `${nm(c.seat)} called liar on ${c.on.quantity} × ${face(c.on.face)}: there were ${c.actual}, so ${nm(c.loser)} lost a die.`);
  return { message: lines.join(" ") || undefined, ...view };
}

export async function diceBid(db: D1Database, agent: Agent, id: string, input: Record<string, unknown>) {
  const q = Number(input.quantity), f = Number(input.face);
  return act(db, agent, id, (s, seat, at) => bid(s, seat, q, f, text(input.reason, DICE.reason_max), at));
}

export async function diceLiar(db: D1Database, agent: Agent, id: string, input: Record<string, unknown>) {
  return act(db, agent, id, (s, seat, at) => call(s, seat, text(input.reason, DICE.reason_max), at));
}

export async function diceLeave(db: D1Database, agent: Agent, id: string) {
  const row = await settleDice(db, await getDiceRow(db, id));
  const now = nowIso();
  if (row.status === "waiting") {
    const s = parse(row);
    const seat = s.seats.findIndex((x) => x.id === agent.id);
    if (seat < 0) throw new OpError(403, "you're not at this table");
    if (row.created_by === agent.id) {
      await db.prepare("UPDATE dice_games SET status = 'aborted', termination = 'withdrawn', version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
        .bind(now, id, row.version).run();
    } else {
      s.seats[seat] = { ...s.seats[seat], id: null, reserved: "open", approach: null };
      const res = await db.prepare("UPDATE dice_games SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
        .bind(JSON.stringify(s), now, id, row.version).run();
      if (res.meta.changes) await db.prepare("DELETE FROM dice_seats WHERE game_id = ? AND agent_id = ?").bind(id, agent.id).run();
    }
    return getDice(db, id, agent);
  }
  return act(db, agent, id, (s, seat, at) => removeSeat(s, seat, "left", at));
}

// ── lists ───────────────────────────────────────────────────────────────────

const summary = (v: Awaited<ReturnType<typeof diceView>>) => {
  const { rounds, rules, legal, bids_this_round, your_dice, ...rest } = v;
  return { ...rest, rounds_played: rounds.length };
};

export async function myDiceGames(db: D1Database, agent: Agent, status?: unknown) {
  const st = status == null ? "current" : String(status);
  const where = st === "current" ? "g.status IN ('active','waiting')" : st === "all" ? "1=1" : "g.status = ?2";
  const stmt = db.prepare(
    `SELECT g.* FROM dice_games g WHERE (g.id IN (SELECT game_id FROM dice_seats WHERE agent_id = ?1)
       OR (g.status = 'waiting' AND g.state LIKE '%"reserved":"' || ?1 || '"%')) AND ${where} ORDER BY g.updated_at DESC LIMIT 50`,
  );
  const rows = (await (st === "current" || st === "all" ? stmt.bind(agent.id) : stmt.bind(agent.id, st)).all<DiceRow>()).results;
  const out = [];
  for (const r of rows) out.push(await diceView(db, await settleDice(db, r), agent));
  return {
    games: out.map(summary),
    your_turn_in: out.filter((g) => g.your_turn).map((g) => g.id),
    invites_for_you: out.filter((g) => g.status === "waiting" && g.seats.some((x) => x.invited === agent.id)).map((g) => g.id),
  };
}

export async function listDiceGames(db: D1Database, status?: unknown, limit = 20) {
  const st = status == null ? "active" : String(status);
  if (!["active", "waiting", "finished"].includes(st)) throw new OpError(400, "status must be active, waiting or finished");
  const rows = (await db.prepare("SELECT * FROM dice_games WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
    .bind(st, Math.min(Math.max(1, limit), 50)).all<DiceRow>()).results;
  const out = [];
  for (const r of rows) out.push(summary(await diceView(db, r)));
  return { games: out };
}

export async function diceLeaderboard(db: D1Database) {
  const rows = (await db.prepare(
    `SELECT s.*, a.name, a.kind FROM dice_stats s JOIN agents a ON a.id = s.agent_id
     ORDER BY s.real_wins DESC, s.wins DESC, s.games ASC LIMIT 50`,
  ).all<{ agent_id: string; name: string; kind: string; games: number; wins: number; real_games: number; real_wins: number; calls: number; calls_right: number; bids_called: number; bids_held: number }>()).results;
  const totals = await db.prepare(
    "SELECT COUNT(*) AS games, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS live FROM dice_games WHERE status IN ('active','finished')",
  ).first<{ games: number; live: number | null }>();
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : null);
  return {
    game: "liars_dice",
    ladder: rows.map((r, i) => ({
      rank: i + 1, agent_id: r.agent_id, name: r.name, kind: r.kind, games: r.games, wins: r.wins,
      wins_vs_real_players: r.real_wins, games_vs_real_players: r.real_games,
      calls: r.calls, call_accuracy_pct: pct(r.calls_right, r.calls),
      bids_called: r.bids_called, bids_held_pct: pct(r.bids_held, r.bids_called),
    })),
    ranking: "Wins against real players first, then all wins. Games against house bots alone are practice.",
    house_bots: Object.entries(DICE_BOTS).map(([id, b]) => ({ id, name: b.name, style: b.style })),
    games_played: totals?.games ?? 0,
    live_games: totals?.live ?? 0,
  };
}

// ── coach ───────────────────────────────────────────────────────────────────

export const DICE_LESSONS = {
  count: "The count: the dice in your hand that match the face (ones included), plus a third of the dice you can't see. If that reaches the bid, the bid is probably true.",
  missed_call: "When the bid on the table is probably false, any raise is less likely still. Call it instead of passing the risk back to yourself.",
  risky_call: "Count before you call. Your own matching dice plus a third of the hidden ones already reached this bid, so it was probably true.",
  needless_bluff: "A bluff is a tool, not a habit. A safe raise was there: take it and let the next player carry the risk.",
} as const;

/**
 * After the game: replay every round and score each bid and call a real
 * player made, from what that player could see (their own dice and the dice
 * count). It flags calls on bids that were probably true, raises over bids
 * that were probably false, and long-shot bluffs when a safe raise existed.
 */
export async function diceReview(db: D1Database, id: string, viewer?: Agent | null) {
  const row = await settleDice(db, await getDiceRow(db, id));
  if (row.status !== "finished") throw new OpError(409, "reviews open when the game is over: the coach is not in-game help");
  const s = parse(row);
  const n = await names(db, s.seats.map((x) => x.id));
  const nm = (i: number) => n[s.seats[i].id!]?.name ?? "?";
  const forSeat = viewer ? s.seats.findIndex((x) => x.id === viewer.id) : -1;
  const pct = (p: number) => Math.round(p * 100);
  const counts = { missed_call: 0, risky_call: 0, needless_bluff: 0 };
  const decisions: Record<string, unknown>[] = [];
  for (const r of s.rounds) {
    if (r.voided) continue;
    const total = r.dice.reduce((a, d) => a + d.length, 0);
    const acts: ({ kind: "bid"; b: Bid; prev: Bid | null } | { kind: "call"; c: Call; prev: Bid })[] =
      r.bids.map((b, k) => ({ kind: "bid" as const, b, prev: r.bids[k - 1] ?? null }));
    if (r.call) acts.push({ kind: "call", c: r.call, prev: r.bids[r.bids.length - 1] });
    for (const a of acts) {
      const seat = a.kind === "bid" ? a.b.seat : a.c.seat;
      if (!isReal(s, seat) || (forSeat >= 0 && seat !== forSeat)) continue;
      const own = r.dice[seat];
      const hidden = total - own.length;
      const prevOdds = a.prev ? oddsFor(own, total, a.prev.quantity, a.prev.face) : null;
      const safest = minRaises(a.prev, total).map((m) => ({ ...m, p: oddsFor(own, total, m.quantity, m.face) })).sort((x, y) => y.p - x.p)[0];
      let flag: keyof typeof counts | null = null;
      let d: Record<string, unknown>;
      if (a.kind === "bid") {
        const p = oddsFor(own, total, a.b.quantity, a.b.face);
        if (prevOdds !== null && prevOdds < 0.3) flag = "missed_call";
        else if (p < 0.25 && safest && safest.p >= 0.5) flag = "needless_bluff";
        const called = r.call && r.call.on.seat === seat && r.bids[r.bids.length - 1] === a.b ? r.call : null;
        d = {
          round: r.n, by: nm(seat), action: "bid", bid: `${a.b.quantity} × ${face(a.b.face)}`,
          over: a.prev ? `${a.prev.quantity} × ${face(a.prev.face)}` : null,
          your_dice: own, your_matching: matching(own, a.b.face), hidden_dice: hidden,
          expected: Math.round((matching(own, a.b.face) + hidden / 3) * 10) / 10,
          odds_your_bid_true_pct: pct(p),
          odds_last_bid_true_pct: prevOdds === null ? null : pct(prevOdds),
          safest_raise: safest ? { bid: `${safest.quantity} × ${face(safest.face)}`, odds_pct: pct(safest.p) } : null,
          outcome: called ? (called.loser === seat ? `called, and it failed: there were ${called.actual}` : `called, and it held: there were ${called.actual}`) : null,
          your_reason: a.b.reason,
        };
      } else {
        if (prevOdds! > 0.6) flag = "risky_call";
        d = {
          round: r.n, by: nm(seat), action: "liar", on: `${a.prev.quantity} × ${face(a.prev.face)} by ${nm(a.prev.seat)}`,
          your_dice: own, your_matching: matching(own, a.prev.face), hidden_dice: hidden,
          expected: Math.round((matching(own, a.prev.face) + hidden / 3) * 10) / 10,
          odds_last_bid_true_pct: pct(prevOdds!),
          outcome: a.c.loser === seat ? `wrong: there were ${a.c.actual}` : `right: there were only ${a.c.actual}`,
          your_reason: a.c.reason,
        };
      }
      if (flag) counts[flag]++;
      decisions.push({ ...d, flag, lesson: flag ? DICE_LESSONS[flag] : undefined });
    }
  }
  const worst = (Object.keys(counts) as (keyof typeof counts)[]).sort((a, b) => counts[b] - counts[a])[0];
  return {
    game_id: id,
    winner: row.winner_id ? n[row.winner_id]?.name : null,
    reviewed_for: forSeat >= 0 ? nm(forSeat) : "every real player",
    summary: counts,
    focus_next_game: counts[worst] ? DICE_LESSONS[worst] : "No risky calls, missed calls or needless bluffs found. Next: a table with the Rook, or with other agents.",
    the_count: DICE_LESSONS.count,
    decisions,
    method: "Odds from what you could see: your own dice and how many dice were at the table, with each hidden die matching a face one time in three (the face or a wild one). It ignores what other players' bids told you, so treat it as the baseline your reads should beat.",
  };
}

export const _internal = {
  setRng(fn: () => number) { rng = fn; },
  parse,
  current,
};
