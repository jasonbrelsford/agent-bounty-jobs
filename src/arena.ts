import { Chess, type Move } from "chess.js";
import { type Agent, OpError, newId, nowIso, eventStmt } from "./core.js";
import { inboxStmt } from "./notify.js";

/**
 * Arena — games agents play to get better at thinking.
 *
 * Chess first. A game is correspondence-style: each side has `per_move_seconds`
 * to move, enforced lazily on read (the same pattern as bounty expiry) and by
 * the hourly sweep. Agents are not always running, so a live clock would just
 * measure uptime.
 *
 * House sparring bots solve the cold start: a new agent can play a rated game
 * the moment it registers instead of waiting for a human-scale crowd. They are
 * deliberately small (material + centre, shallow search) — a ladder to climb,
 * not a wall.
 *
 * After a game, `review` replays it with the same shallow engine and returns a
 * lesson per flagged move: the blunder, the better move, and the habit that
 * would have caught it. Reviews are only available once a game is over, so the
 * coach can never be used as in-game engine help.
 */

export const ARENA_GAMES = ["chess"] as const;
export type GameName = (typeof ARENA_GAMES)[number];

export const START_RATING = 1200;
export const PER_MOVE = { min: 60, max: 7 * 86_400, vs_house_default: 3_600, vs_agent_default: 86_400 } as const;
export const ARENA_LIMITS = { active_games: 20, open_seeks: 1, challenges: 5, reason_max: 280, approach_max: 600, waiting_days: 7 } as const;

type HouseBot = { name: string; rating: number; depth: number; style: string };
export const HOUSE: Record<string, HouseBot> = {
  house_pawn: { name: "Pawn (house bot)", rating: 600, depth: 0, style: "plays any legal move at random — for learning the protocol" },
  house_knight: { name: "Knight (house bot)", rating: 1000, depth: 2, style: "grabs loose material and sees your reply, nothing deeper" },
  house_rook: { name: "Rook (house bot)", rating: 1400, depth: 3, style: "looks three moves deep and punishes hanging pieces" },
};
export const isHouse = (id: string | null | undefined): id is string => !!id && id in HOUSE;

export type GameRow = {
  id: string; game: string; status: string; white_id: string | null; black_id: string | null;
  invited_id: string | null; fen: string; ply: number; rated: number; per_move_seconds: number;
  move_deadline: string | null; result: string | null; termination: string | null;
  white_rating_delta: number | null; black_rating_delta: number | null;
  white_approach: string | null; black_approach: string | null;
  tournament_id?: string | null; round?: number | null; created_at: string; updated_at: string;
};
type MoveRow = { ply: number; by_id: string; san: string; uci: string; reason: string | null; at: string };

// ── engine (shared by the house bots and the coach) ─────────────────────────

const VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100_000;
// Small centre bonus for minor pieces and pawns: enough to stop the bots
// shuffling rooks in the opening, not enough to be called positional play.
const CENTRE = [0, 1, 2, 3, 3, 2, 1, 0];

// The search uses chess.js's internal move generator directly. The public
// API re-generates every legal move to validate each make(), which made a
// depth-3 search take ~15s; the internals do the same work once per node.
type IMove = { from: number; to: number; piece: string; captured?: string; promotion?: string };
type Internals = {
  _board: ({ type: string; color: "w" | "b" } | undefined)[];
  _turn: "w" | "b";
  _moves(o: { legal: boolean }): IMove[];
  _makeMove(m: IMove): void;
  _undoMove(): unknown;
  _isKingAttacked(color: "w" | "b"): boolean;
};
const I = (c: Chess) => c as unknown as Internals;
const sqName = (i: number) => "abcdefgh"[i & 7] + (8 - (i >> 4));

/** Static eval from the side to move's point of view, in centipawns. */
export function evaluate(c: Chess): number {
  const x = I(c);
  let s = 0;
  for (let i = 0; i < 128; i++) {
    if (i & 0x88) { i += 7; continue; }
    const p = x._board[i];
    if (!p) continue;
    let v = VALUE[p.type];
    const row = i >> 4, file = i & 7;
    if (p.type === "n" || p.type === "b") v += 4 * (CENTRE[row] + CENTRE[file]);
    else if (p.type === "p") v += 3 * CENTRE[file] * Math.min(3, p.color === "w" ? 6 - row : row - 1);
    else if (p.type === "k" && (row === 0 || row === 7) && (file >= 6 || file <= 2)) v += 20; // castled-ish
    s += p.color === "w" ? v : -v;
  }
  return x._turn === "w" ? s : -s;
}

function ordered(c: Chess): IMove[] {
  // Captures first, most valuable victim first: a cheap ordering that makes
  // alpha-beta prune well enough for depth 3 inside a Worker request.
  return I(c)._moves({ legal: true }).sort(
    (a, b) => (b.captured ? VALUE[b.captured] : 0) - (a.captured ? VALUE[a.captured] : 0),
  );
}

function negamax(c: Chess, depth: number, alpha: number, beta: number, fromRoot: number): number {
  if (depth === 0) return evaluate(c);
  const x = I(c);
  const moves = ordered(c);
  if (moves.length === 0) return x._isKingAttacked(x._turn) ? -(MATE - fromRoot) : 0;
  for (const m of moves) {
    x._makeMove(m);
    const s = -negamax(c, depth - 1, -beta, -alpha, fromRoot + 1);
    x._undoMove();
    if (s >= beta) return beta;
    if (s > alpha) alpha = s;
  }
  return alpha;
}

/** Score every legal move to `depth` plies (the move itself counts as one). */
export function scoreMoves(c: Chess, depth: number): { move: Move; score: number }[] {
  const x = I(c);
  const pub = new Map(c.moves({ verbose: true }).map((m) => [uciOf(m), m]));
  const out: { move: Move; score: number }[] = [];
  for (const m of ordered(c)) {
    x._makeMove(m);
    // A move that leaves the opponent no moves is mate or stalemate right now.
    const score = depth <= 1 && I(c)._moves({ legal: true }).length === 0
      ? (x._isKingAttacked(x._turn) ? MATE - 1 : 0)
      : -negamax(c, Math.max(0, depth - 1), -Infinity, Infinity, 1);
    x._undoMove();
    const key = sqName(m.from) + sqName(m.to) + (m.promotion ?? "");
    const pm = pub.get(key);
    if (pm) out.push({ move: pm, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

const randInt = (n: number) => {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] % n;
};

export function houseMove(c: Chess, botId: string): Move {
  const bot = HOUSE[botId];
  const moves = c.moves({ verbose: true });
  if (!moves.length) throw new Error("house bot asked to move in a finished position");
  if (bot.depth === 0) return moves[randInt(moves.length)];
  const scored = scoreMoves(c, bot.depth);
  // Pick among moves within 15cp of the best so the bots do not repeat one game forever.
  const best = scored[0].score;
  const near = scored.filter((s) => s.score >= best - 15);
  return near[randInt(near.length)].move;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const addSeconds = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000).toISOString();

function gameName(raw: unknown): GameName {
  const g = raw == null ? "chess" : String(raw);
  if (!(ARENA_GAMES as readonly string[]).includes(g)) throw new OpError(400, `game must be one of ${ARENA_GAMES.join(", ")}`);
  return g as GameName;
}

/** Rebuild the game from its move list so repetition draws are detected. */
function replay(moves: MoveRow[]): Chess {
  const c = new Chess();
  for (const m of moves) c.move(uciToMove(m.uci));
  return c;
}

const uciToMove = (u: string) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4] : undefined });
const uciOf = (m: Move) => m.from + m.to + (m.promotion ?? "");

function parseMove(c: Chess, raw: unknown): Move {
  if (typeof raw !== "string" || !raw.trim()) throw new OpError(400, "move is required: SAN like Nf3 or UCI like g1f3 (e7e8q to promote)");
  const s = raw.trim();
  try { return c.move(s); } catch { /* fall through to UCI */ }
  if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(s)) {
    try { return c.move(uciToMove(s.toLowerCase())); } catch { /* illegal */ }
  }
  throw new OpError(400, `illegal move "${s}" in this position. Legal: ${c.moves().join(" ")}`);
}

function outcome(c: Chess): { result: string; termination: string } | null {
  if (c.isCheckmate()) return { result: c.turn() === "w" ? "0-1" : "1-0", termination: "checkmate" };
  if (c.isStalemate()) return { result: "1/2-1/2", termination: "stalemate" };
  if (c.isThreefoldRepetition()) return { result: "1/2-1/2", termination: "threefold_repetition" };
  if (c.isInsufficientMaterial()) return { result: "1/2-1/2", termination: "insufficient_material" };
  if (c.isDrawByFiftyMoves()) return { result: "1/2-1/2", termination: "fifty_move_rule" };
  return null;
}

const toMoveId = (g: GameRow, c: Chess) => (c.turn() === "w" ? g.white_id : g.black_id);

export async function names(db: D1Database, ids: (string | null)[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    if (!id || out[id]) continue;
    if (isHouse(id)) out[id] = HOUSE[id].name;
    else {
      const r = await db.prepare("SELECT name FROM agents WHERE id = ?").bind(id).first<{ name: string }>();
      out[id] = r?.name ?? id;
    }
  }
  return out;
}

async function kinds(db: D1Database, ids: (string | null)[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    if (!id || out[id]) continue;
    if (isHouse(id)) out[id] = "house";
    else {
      const r = await db.prepare("SELECT kind FROM agents WHERE id = ?").bind(id).first<{ kind: string }>();
      out[id] = r?.kind ?? "agent";
    }
  }
  return out;
}

export async function ratingOf(db: D1Database, id: string, game = "chess"): Promise<{ rating: number; games: number }> {
  if (isHouse(id)) return { rating: HOUSE[id].rating, games: 0 };
  const r = await db.prepare("SELECT rating, games FROM ratings WHERE agent_id = ? AND game = ?").bind(id, game)
    .first<{ rating: number; games: number }>();
  return r ?? { rating: START_RATING, games: 0 };
}

/** Elo with a provisional K for an agent's first 10 games. */
export function eloDelta(rating: number, opp: number, score: number, games: number): number {
  const k = games < 10 ? 40 : 20;
  const expected = 1 / (1 + 10 ** ((opp - rating) / 400));
  return Math.round(k * (score - expected));
}

export async function getRow(db: D1Database, id: string): Promise<GameRow> {
  const g = await db.prepare("SELECT * FROM games WHERE id = ?").bind(id).first<GameRow>();
  if (!g) throw new OpError(404, `no game ${id}`);
  return g;
}

const movesOf = async (db: D1Database, id: string) =>
  (await db.prepare("SELECT ply, by_id, san, uci, reason, at FROM game_moves WHERE game_id = ? ORDER BY ply").bind(id)
    .all<MoveRow>()).results;

/**
 * Statements that finish a game: result, rating changes, a feed event and an
 * inbox note to each agent. Returned, not run, so they join the caller's batch.
 */
export async function finishStmts(
  db: D1Database, g: GameRow, at: string, result: string, termination: string, expectPly: number,
): Promise<D1PreparedStatement[]> {
  const stmts: D1PreparedStatement[] = [];
  const w = g.white_id!, b = g.black_id!;
  const ws = result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
  let dw: number | null = null, db_: number | null = null;
  const rated = g.rated === 1 && termination !== "aborted" && termination !== "forfeit";
  if (rated) {
    const [rw, rb] = [await ratingOf(db, w, g.game), await ratingOf(db, b, g.game)];
    if (!isHouse(w)) dw = eloDelta(rw.rating, rb.rating, ws, rw.games);
    if (!isHouse(b)) db_ = eloDelta(rb.rating, rw.rating, 1 - ws, rb.games);
    for (const [id, d, score] of [[w, dw, ws], [b, db_, 1 - ws]] as const) {
      if (d === null) continue;
      stmts.push(db.prepare(
        `INSERT INTO ratings (agent_id, game, rating, games, wins, losses, draws, updated_at)
         VALUES (?1, ?2, ?3 + ?4, 1, ?5, ?6, ?7, ?8)
         ON CONFLICT(agent_id, game) DO UPDATE SET rating = rating + ?4, games = games + 1,
           wins = wins + ?5, losses = losses + ?6, draws = draws + ?7, updated_at = ?8`,
      ).bind(id, g.game, START_RATING, d, score === 1 ? 1 : 0, score === 0 ? 1 : 0, score === 0.5 ? 1 : 0, at));
    }
  }
  stmts.push(db.prepare(
    `UPDATE games SET status = ?, result = ?, termination = ?, move_deadline = NULL,
       white_rating_delta = ?, black_rating_delta = ?, updated_at = ?
     WHERE id = ? AND status = 'active' AND ply = ?`,
  ).bind(termination === "aborted" ? "aborted" : "finished", termination === "aborted" ? null : result, termination,
    dw, db_, at, g.id, expectPly));
  const n = await names(db, [w, b]);
  stmts.push(eventStmt(db, at, "game_finished", null, null,
    `${g.game}: ${n[w]} vs ${n[b]} — ${termination === "aborted" ? "aborted" : `${result} by ${termination.replace(/_/g, " ")}`} (${g.id})`));
  for (const id of [w, b])
    if (!isHouse(id))
      stmts.push(inboxStmt(db, at, id, "game.finished", null, null, {
        game_id: g.id, game: g.game, result, termination,
        rating_change: id === w ? dw : db_, review: `/v1/arena/chess/games/${g.id}/review`,
      }));
  return stmts;
}

/**
 * Lazy clock: a game whose side to move ran out of time is settled on read.
 * Fewer than two moves played = aborted and unrated (nobody really started).
 */
export async function settleClock(db: D1Database, g: GameRow): Promise<GameRow> {
  const now = nowIso();
  if (g.status === "waiting" && Date.parse(g.created_at) < Date.now() - ARENA_LIMITS.waiting_days * 86_400_000) {
    await db.prepare("UPDATE games SET status = 'aborted', termination = 'no_opponent', updated_at = ? WHERE id = ? AND status = 'waiting'")
      .bind(now, g.id).run();
    return getRow(db, g.id);
  }
  if (g.status !== "active" || !g.move_deadline || g.move_deadline > now) return g;
  const c = new Chess(g.fen);
  const loserIsWhite = c.turn() === "w";
  // In a tournament a no-show loses the game (unrated); elsewhere it just aborts.
  const stmts = g.ply < 2 && g.tournament_id
    ? await finishStmts(db, g, now, loserIsWhite ? "0-1" : "1-0", "forfeit", g.ply)
    : g.ply < 2
    ? await finishStmts(db, g, now, "1/2-1/2", "aborted", g.ply)
    : await finishStmts(db, g, now, loserIsWhite ? "0-1" : "1-0", "timeout", g.ply);
  await db.batch(stmts);
  return getRow(db, g.id);
}

/** Hourly sweep: settle overdue clocks and stale seeks, bounded per run. */
export async function arenaSweep(db: D1Database, limit = 50): Promise<number> {
  const now = nowIso();
  const stale = new Date(Date.now() - ARENA_LIMITS.waiting_days * 86_400_000).toISOString();
  const rows = (await db.prepare(
    `SELECT * FROM games WHERE (status = 'active' AND move_deadline < ?) OR (status = 'waiting' AND created_at < ?) LIMIT ?`,
  ).bind(now, stale, limit).all<GameRow>()).results;
  for (const g of rows) await settleClock(db, g);
  return rows.length;
}

// ── public shapes ───────────────────────────────────────────────────────────

export async function gameView(db: D1Database, g: GameRow, viewer?: Agent | null, moves?: MoveRow[]) {
  const ms = moves ?? await movesOf(db, g.id);
  const c = new Chess(g.fen);
  const n = await names(db, [g.white_id, g.black_id]);
  const k = await kinds(db, [g.white_id, g.black_id]);
  const ratings: Record<string, number> = {};
  for (const id of [g.white_id, g.black_id]) if (id) ratings[id] = (await ratingOf(db, id, g.game)).rating;
  const approachOf = (id: string) =>
    isHouse(id) ? `House bot: ${HOUSE[id].style}.` : id === g.white_id ? g.white_approach : g.black_approach;
  const side = (id: string | null) =>
    id ? { id, name: n[id], house: isHouse(id), kind: k[id], rating: ratings[id], approach: approachOf(id) ?? null } : null;
  const yourColor = viewer ? (viewer.id === g.white_id ? "white" : viewer.id === g.black_id ? "black" : null) : null;
  const toMove = g.status === "active" ? (c.turn() === "w" ? "white" : "black") : null;
  const yourTurn = !!yourColor && toMove === yourColor;
  let pgnMoves = "";
  ms.forEach((m, i) => { pgnMoves += (i % 2 === 0 ? `${i / 2 + 1}. ` : "") + m.san + " "; });
  return {
    id: g.id,
    game: g.game,
    status: g.status,
    rated: g.rated === 1,
    white: side(g.white_id),
    black: side(g.black_id),
    invited_id: g.invited_id,
    to_move: toMove,
    your_color: yourColor,
    your_turn: yourTurn,
    fen: g.fen,
    board: c.ascii(),
    in_check: g.status === "active" ? c.inCheck() : false,
    legal_moves: yourTurn ? c.moves() : undefined,
    legal_uci: yourTurn ? c.moves({ verbose: true }).map(uciOf) : undefined,
    tournament: g.tournament_id ? { id: g.tournament_id, round: g.round ?? null, page: `/arena/tournaments/${g.tournament_id}` } : null,
    last_move: ms.length ? { san: ms[ms.length - 1].san, uci: ms[ms.length - 1].uci } : null,
    moves: ms.map((m) => ({ ply: m.ply, san: m.san, uci: m.uci, by: m.by_id, reason: m.reason, at: m.at })),
    pgn: pgnMoves.trim() + (g.result ? ` ${g.result}` : ""),
    per_move_seconds: g.per_move_seconds,
    move_deadline: g.move_deadline,
    result: g.result,
    termination: g.termination,
    rating_change: g.status === "finished" ? { white: g.white_rating_delta, black: g.black_rating_delta } : undefined,
    review: g.status === "finished" ? `/v1/arena/chess/games/${g.id}/review` : undefined,
    page: `/arena/games/${g.id}`,
  };
}

export async function getGame(db: D1Database, id: string, viewer?: Agent | null) {
  return gameView(db, await settleClock(db, await getRow(db, id)), viewer);
}

// ── play: start, join or challenge ──────────────────────────────────────────

export async function play(db: D1Database, agent: Agent, input: Record<string, unknown>) {
  const game = gameName(input.game);
  const now = nowIso();
  const active = await db.prepare(
    "SELECT COUNT(*) AS n FROM games WHERE status IN ('active','waiting') AND (white_id = ?1 OR black_id = ?1)",
  ).bind(agent.id).first<{ n: number }>();
  if ((active?.n ?? 0) >= ARENA_LIMITS.active_games)
    throw new OpError(429, `you already have ${ARENA_LIMITS.active_games} games going — finish some first`);
  const rated = input.rated === false ? 0 : 1;
  const approach = input.approach == null ? null : String(input.approach).trim().slice(0, ARENA_LIMITS.approach_max) || null;

  // Join a specific waiting game (an open seek, or a challenge addressed to you).
  if (input.game_id != null) {
    const g = await settleClock(db, await getRow(db, String(input.game_id)));
    if (g.status !== "waiting") throw new OpError(409, `game ${g.id} is ${g.status}, not waiting for an opponent`);
    if (g.white_id === agent.id || g.black_id === agent.id) throw new OpError(409, "you cannot join your own game");
    if (g.invited_id && g.invited_id !== agent.id) throw new OpError(403, "that challenge is addressed to another agent");
    return join(db, g, agent, now, approach);
  }

  const opp = input.opponent == null ? "open" : String(input.opponent);
  const colorRaw = input.color == null ? "random" : String(input.color);
  if (!["white", "black", "random"].includes(colorRaw)) throw new OpError(400, "color must be white, black or random");
  const color = colorRaw === "random" ? (randInt(2) ? "white" : "black") : colorRaw;
  const perMoveDefault = isHouse(opp) ? PER_MOVE.vs_house_default : PER_MOVE.vs_agent_default;
  const perMove = input.per_move_seconds == null ? perMoveDefault : Number(input.per_move_seconds);
  if (!Number.isInteger(perMove) || perMove < PER_MOVE.min || perMove > PER_MOVE.max)
    throw new OpError(400, `per_move_seconds must be an integer ${PER_MOVE.min}-${PER_MOVE.max}`);

  if (opp === "open") {
    // Take the oldest open seek from someone else first: that is what makes a ladder a crowd.
    const seek = await db.prepare(
      `SELECT * FROM games WHERE game = ? AND status = 'waiting' AND invited_id IS NULL
         AND COALESCE(white_id, black_id) != ? AND created_at > ? ORDER BY created_at LIMIT 1`,
    ).bind(game, agent.id, new Date(Date.now() - ARENA_LIMITS.waiting_days * 86_400_000).toISOString()).first<GameRow>();
    if (seek) return join(db, seek, agent, now, approach);
    const mine = await db.prepare(
      "SELECT id FROM games WHERE status = 'waiting' AND invited_id IS NULL AND (white_id = ?1 OR black_id = ?1)",
    ).bind(agent.id).first<{ id: string }>();
    if (mine) throw new OpError(409, `you already have an open seek (${mine.id}); it pairs with the next agent who asks for an open game`);
    return createWaiting(db, agent, game, color, perMove, rated, null, now, approach);
  }

  if (isHouse(opp)) {
    const id = newId("gam");
    const white = color === "white" ? agent.id : opp;
    const black = color === "white" ? opp : agent.id;
    const c = new Chess();
    const stmts: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO games (id, game, status, white_id, black_id, fen, ply, rated, per_move_seconds, move_deadline,
           white_approach, black_approach, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, game, white, black, c.fen(), rated, perMove, addSeconds(now, perMove),
        white === agent.id ? approach : null, black === agent.id ? approach : null, now, now),
      eventStmt(db, now, "game_started", null, agent.id, `${game}: ${agent.name} vs ${HOUSE[opp].name} (${id})`),
    ];
    if (white === opp) {
      const m = houseMove(c, opp);
      c.move(m);
      stmts.push(
        db.prepare("INSERT INTO game_moves (game_id, ply, by_id, san, uci, reason, at) VALUES (?, 1, ?, ?, ?, NULL, ?)")
          .bind(id, opp, m.san, uciOf(m), now),
        db.prepare("UPDATE games SET fen = ?, ply = 1 WHERE id = ?").bind(c.fen(), id),
      );
    }
    await db.batch(stmts);
    return { started: true, ...(await getGame(db, id, agent)) };
  }

  // Direct challenge to another agent.
  const target = await db.prepare("SELECT id, name FROM agents WHERE id = ?").bind(opp).first<{ id: string; name: string }>();
  if (!target) throw new OpError(404, `opponent must be "open", a house bot (${Object.keys(HOUSE).join(", ")}) or an agent id`);
  if (target.id === agent.id) throw new OpError(400, "you cannot challenge yourself");
  const pending = await db.prepare(
    "SELECT COUNT(*) AS n FROM games WHERE status = 'waiting' AND invited_id IS NOT NULL AND (white_id = ?1 OR black_id = ?1)",
  ).bind(agent.id).first<{ n: number }>();
  if ((pending?.n ?? 0) >= ARENA_LIMITS.challenges) throw new OpError(429, `at most ${ARENA_LIMITS.challenges} open challenges at once`);
  return createWaiting(db, agent, game, color, perMove, rated, target.id, now, approach);
}

async function createWaiting(
  db: D1Database, agent: Agent, game: string, color: string, perMove: number, rated: number, invited: string | null, now: string,
  approach: string | null,
) {
  const id = newId("gam");
  const stmts = [
    db.prepare(
      `INSERT INTO games (id, game, status, white_id, black_id, invited_id, fen, ply, rated, per_move_seconds,
         white_approach, black_approach, created_at, updated_at)
       VALUES (?, ?, 'waiting', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, game, color === "white" ? agent.id : null, color === "black" ? agent.id : null, invited,
      new Chess().fen(), rated, perMove, color === "white" ? approach : null, color === "black" ? approach : null, now, now),
  ];
  if (invited)
    stmts.push(inboxStmt(db, now, invited, "game.challenge", null, null, {
      game_id: id, game, from: agent.name, from_id: agent.id, accept: `chess_play with game_id ${id}`,
    }));
  await db.batch(stmts);
  return {
    started: false,
    waiting: true,
    note: invited
      ? "Challenge sent to their inbox. The game starts when they accept; it lapses after 7 days."
      : `No open seek to pair with yet, so yours is posted. It pairs with the next agent who asks for an open game. Meanwhile, play a house bot: ${Object.keys(HOUSE).join(", ")}.`,
    ...(await getGame(db, id, agent)),
  };
}

async function join(db: D1Database, g: GameRow, agent: Agent, now: string, approach: string | null) {
  const white = g.white_id ?? agent.id;
  const black = g.black_id ?? agent.id;
  const col = white === agent.id ? "white_approach" : "black_approach";
  const res = await db.prepare(
    `UPDATE games SET status = 'active', white_id = ?, black_id = ?, move_deadline = ?, updated_at = ?, ${col} = ?
     WHERE id = ? AND status = 'waiting'`,
  ).bind(white, black, addSeconds(now, g.per_move_seconds), now, approach, g.id).run();
  if (!res.meta.changes) throw new OpError(409, "someone else took that game first — ask again");
  const n = await names(db, [white, black]);
  const stmts = [eventStmt(db, now, "game_started", null, agent.id, `${g.game}: ${n[white]} vs ${n[black]} (${g.id})`)];
  if (white !== agent.id)
    stmts.push(inboxStmt(db, now, white, "game.your_move", null, null, { game_id: g.id, game: g.game, opponent: agent.name }));
  await db.batch(stmts);
  return { started: true, ...(await getGame(db, g.id, agent)) };
}

// ── moves ───────────────────────────────────────────────────────────────────

export async function makeMove(db: D1Database, agent: Agent, id: string, input: Record<string, unknown>) {
  const g = await settleClock(db, await getRow(db, id));
  if (g.status !== "active") throw new OpError(409, `game is ${g.status}${g.result ? ` (${g.result})` : ""}`);
  const ms = await movesOf(db, id);
  const c = replay(ms);
  if (toMoveId(g, c) !== agent.id) throw new OpError(409, "not your move");
  let reason: string | null = null;
  if (input.reason != null) {
    reason = String(input.reason).trim().slice(0, ARENA_LIMITS.reason_max) || null;
  }
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  const startPly = g.ply;
  let ply = g.ply;
  const push = (m: Move, by: string, why: string | null) => {
    ply += 1;
    stmts.push(db.prepare("INSERT INTO game_moves (game_id, ply, by_id, san, uci, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, ply, by, m.san, uciOf(m), why, now));
  };
  push(parseMove(c, input.move), agent.id, reason);
  let end = outcome(c);
  // A house bot answers in the same request; agents never wait on it.
  const next = toMoveId(g, c);
  if (!end && isHouse(next)) {
    push(c.move(houseMove(c, next)), next, null);
    end = outcome(c);
  }
  // The ply guard is the race arbiter: a second concurrent move fails the PK
  // insert or matches zero rows, and the whole batch rolls back.
  stmts.push(db.prepare(
    "UPDATE games SET fen = ?, ply = ?, move_deadline = ?, updated_at = ? WHERE id = ? AND ply = ? AND status = 'active'",
  ).bind(c.fen(), ply, end ? null : addSeconds(now, g.per_move_seconds), now, id, startPly));
  if (end) {
    stmts.push(...await finishStmts(db, { ...g, fen: c.fen(), ply }, now, end.result, end.termination, ply));
  } else {
    const waiting = toMoveId(g, c)!;
    // Against a house bot the reply comes back in this same response, so the
    // mover needs no inbox ping (a long game used to bury game.finished under them).
    if (!isHouse(waiting) && waiting !== agent.id)
      stmts.push(inboxStmt(db, now, waiting, "game.your_move", null, null, {
        game_id: id, game: g.game, last_move: c.history().slice(-1)[0], deadline: addSeconds(now, g.per_move_seconds),
      }));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e))) throw new OpError(409, "the position changed while you were moving — fetch the game and try again");
    throw e;
  }
  const after = await getRow(db, id);
  if (after.ply !== ply) throw new OpError(409, "the position changed while you were moving — fetch the game and try again");
  return gameView(db, after, agent);
}

export async function resign(db: D1Database, agent: Agent, id: string) {
  const g = await settleClock(db, await getRow(db, id));
  if (g.status === "waiting" && (g.white_id === agent.id || g.black_id === agent.id)) {
    await db.prepare("UPDATE games SET status = 'aborted', termination = 'withdrawn', updated_at = ? WHERE id = ? AND status = 'waiting'")
      .bind(nowIso(), id).run();
    return getGame(db, id, agent);
  }
  if (g.status !== "active") throw new OpError(409, `game is ${g.status}`);
  if (agent.id !== g.white_id && agent.id !== g.black_id) throw new OpError(403, "not your game");
  const now = nowIso();
  await db.batch(await finishStmts(db, g, now, agent.id === g.white_id ? "0-1" : "1-0", "resign", g.ply));
  return getGame(db, id, agent);
}

export async function myGames(db: D1Database, agent: Agent, status?: unknown) {
  const s = status == null ? "current" : String(status);
  const where = s === "current" ? "status IN ('active','waiting')" : s === "all" ? "1=1" : "status = ?2";
  const stmt = db.prepare(
    `SELECT * FROM games WHERE (white_id = ?1 OR black_id = ?1 OR invited_id = ?1) AND ${where} ORDER BY updated_at DESC LIMIT 50`,
  );
  const rows = (await (s === "current" || s === "all" ? stmt.bind(agent.id) : stmt.bind(agent.id, s)).all<GameRow>()).results;
  const out = [];
  for (const r of rows) out.push(await gameView(db, await settleClock(db, r), agent));
  return {
    games: out.map(({ moves, board, legal_moves, legal_uci, ...rest }) => ({ ...rest, moves_played: moves.length })),
    your_turn_in: out.filter((g) => g.your_turn).map((g) => g.id),
    challenges_for_you: out.filter((g) => g.status === "waiting" && g.invited_id === agent.id).map((g) => g.id),
  };
}

export async function listGames(db: D1Database, status?: unknown, limit = 20) {
  const s = status == null ? "active" : String(status);
  if (!["active", "waiting", "finished"].includes(s)) throw new OpError(400, "status must be active, waiting or finished");
  const rows = (await db.prepare("SELECT * FROM games WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
    .bind(s, Math.min(Math.max(1, limit), 50)).all<GameRow>()).results;
  const out = [];
  for (const r of rows) {
    const { moves, legal_moves, legal_uci, ...rest } = await gameView(db, r);
    out.push({ ...rest, moves_played: moves.length });
  }
  return { games: out };
}

export async function leaderboard(db: D1Database, game = "chess") {
  gameName(game);
  const rows = (await db.prepare(
    `SELECT r.agent_id, a.name, a.kind, r.rating, r.games, r.wins, r.losses, r.draws
     FROM ratings r JOIN agents a ON a.id = r.agent_id WHERE r.game = ? ORDER BY r.rating DESC LIMIT 50`,
  ).bind(game).all<{ agent_id: string; name: string; kind: string; rating: number; games: number; wins: number; losses: number; draws: number }>()).results;
  const totals = await db.prepare(
    "SELECT COUNT(*) AS games, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS live FROM games WHERE game = ?",
  ).bind(game).first<{ games: number; live: number | null }>();
  return {
    game,
    ladder: rows.map((r, i) => ({ rank: i + 1, ...r, provisional: r.games < 10 })),
    house_bots: Object.entries(HOUSE).map(([id, b]) => ({ id, name: b.name, rating: b.rating, style: b.style })),
    games_played: totals?.games ?? 0,
    live_games: totals?.live ?? 0,
    start_rating: START_RATING,
  };
}

// ── coach ───────────────────────────────────────────────────────────────────

const LESSON = {
  missed_mate: "Checks, captures, threats — in that order. Before any quiet move, look at every check you have; one of them was mate.",
  allowed_mate: "Ask what your opponent's most forcing reply is. After this move they had mate in one.",
  blunder: "Blunder check: after choosing a move, list every capture and check your opponent then has. One of them wins material.",
  mistake: "Compare two candidate moves before committing. A better option was available that kept more material or pressure.",
} as const;

/**
 * Replay a finished game and flag the agent-side moves that cost the most.
 * Shallow and fast (depth 2 + mate-in-one checks), so it reliably finds hung
 * pieces and missed mates and says nothing about deep strategy. It says so.
 */
export async function reviewGame(db: D1Database, id: string, viewer?: Agent | null) {
  const g = await settleClock(db, await getRow(db, id));
  if (g.status !== "finished") throw new OpError(409, "reviews open when the game is over — the coach is not in-game help");
  const ms = await movesOf(db, id);
  const c = new Chess();
  const flagged: Record<string, unknown>[] = [];
  const counts = { blunder: 0, mistake: 0, missed_mate: 0, allowed_mate: 0 };
  const forId = viewer && (viewer.id === g.white_id || viewer.id === g.black_id) ? viewer.id : null;
  for (const m of ms) {
    const reviewThis = !isHouse(m.by_id) && (!forId || m.by_id === forId);
    if (reviewThis) {
      const legal = c.moves({ verbose: true });
      const mateMove = legal.find((x) => x.san.endsWith("#"));
      let kind: keyof typeof counts | null = null;
      let better: string | null = null;
      let lost = 0;
      if (mateMove && !m.san.endsWith("#")) { kind = "missed_mate"; better = mateMove.san; }
      else {
        const scored = scoreMoves(c, 2);
        const played = scored.find((s) => uciOf(s.move) === m.uci);
        if (played) {
          lost = scored[0].score - played.score;
          c.move(uciToMove(m.uci));
          const allowsMate = c.moves().some((x) => x.endsWith("#"));
          c.undo();
          if (allowsMate) { kind = "allowed_mate"; better = scored[0].move.san; }
          else if (lost >= 300) { kind = "blunder"; better = scored[0].move.san; }
          else if (lost >= 150) { kind = "mistake"; better = scored[0].move.san; }
        }
      }
      if (kind) {
        counts[kind]++;
        flagged.push({
          ply: m.ply, move_number: Math.ceil(m.ply / 2), played: m.san, by: m.by_id, kind,
          better, cost_centipawns: kind === "missed_mate" || kind === "allowed_mate" ? null : lost,
          your_reason: m.reason, lesson: LESSON[kind],
        });
      }
    }
    c.move(uciToMove(m.uci));
  }
  const worst = (Object.keys(counts) as (keyof typeof counts)[]).sort((a, b) => counts[b] - counts[a])[0];
  return {
    game_id: id,
    result: g.result,
    termination: g.termination,
    reviewed_for: forId ?? "both agent sides",
    summary: counts,
    focus_next_game: flagged.length ? LESSON[worst] : "No hung pieces or missed mates found. Next: play a stronger house bot or an open game.",
    flagged,
    method: "Shallow coach: two-ply search plus mate-in-one checks. It catches hung pieces and missed mates, not deep strategy.",
  };
}
