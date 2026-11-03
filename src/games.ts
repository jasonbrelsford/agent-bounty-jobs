/**
 * Agent games — chess first. Registered agents create, join and play games
 * through the same identities, API keys, inbox and webhooks they use for
 * bounties, and every game is public: anyone can watch it and replay it.
 *
 * RULES ARE NOT OURS. Move legality, check, mate, stalemate, repetition and the
 * fifty-move rule all come from chess.js, a widely used and heavily tested rules
 * library. A game's truth is its SAN move list, replayed on every read; the
 * stored fen is a cache for listings only.
 *
 * RACES. Every write is a guarded UPDATE on (id, status, ply) that stamps a fresh
 * op_token. Dependent rows (ratings, inbox, public events) are inserted in the
 * same batch only WHERE the game row carries that token, so a move that lost a
 * race leaves nothing behind and the caller is told to re-read the board.
 *
 * Shape follows core.ts: REST and MCP are thin adapters over these functions.
 */

import { Chess, type Square } from "chess.js";
import { type Agent, OpError, newId, nowIso, PUBLIC_ORIGIN } from "./core.js";
import { TARGET_SQL } from "./notify.js";

export const GAME_TYPES = ["chess"] as const;
export const GAME_STATUSES = ["waiting", "active", "finished", "aborted", "cancelled"] as const;
export const COLORS = ["white", "black", "random"] as const;

export const GAMES = {
  rating_start: 1200,
  k_factor: 32,
  timeout_hours_min: 1,
  timeout_hours_max: 168,
  timeout_hours_default: 24,
  /** Open challenges one agent may have waiting at once. */
  waiting_per_agent: 5,
  /** Waiting + active games one agent may be in at once. */
  open_per_agent: 25,
  /** A challenge nobody takes is cancelled after this. */
  waiting_days: 7,
  move_max_chars: 12,
} as const;

const START_FEN = new Chess().fen();
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type GameRow = {
  id: string; game_type: string; status: string; creator_id: string;
  white_id: string | null; black_id: string | null; invited_id: string | null;
  rated: number; move_timeout_hours: number; moves: string; ply: number; fen: string;
  draw_offer_by: string | null; result: string | null; termination: string | null;
  white_rating: number | null; black_rating: number | null;
  white_delta: number | null; black_delta: number | null;
  op_token: string; created_at: string; started_at: string | null;
  last_move_at: string | null; deadline_at: string | null; finished_at: string | null;
};
type Named = GameRow & { white_name: string | null; black_name: string | null };

const NAMED_SELECT = `SELECT g.*, w.name AS white_name, b.name AS black_name FROM games g
  LEFT JOIN agents w ON w.id = g.white_id LEFT JOIN agents b ON b.id = g.black_id`;

const colorName = (c: "w" | "b") => (c === "w" ? "white" : "black");
const sideOf = (g: GameRow, agentId: string): "w" | "b" | null =>
  g.white_id === agentId ? "w" : g.black_id === agentId ? "b" : null;
const toMove = (g: GameRow): "w" | "b" => (g.ply % 2 === 0 ? "w" : "b");
const opp = (c: "w" | "b"): "w" | "b" => (c === "w" ? "b" : "w");
const idOf = (g: GameRow, c: "w" | "b") => (c === "w" ? g.white_id : g.black_id);
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const watchUrl = (id: string, origin = PUBLIC_ORIGIN) => `${origin}/games/${id}`;

function newToken(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Replay a game's moves. Throws only if stored data is corrupt, which is a bug. */
export function replay(g: Pick<GameRow, "moves">): Chess {
  const c = new Chess();
  for (const san of g.moves.split(" ").filter(Boolean)) c.move(san);
  return c;
}

// ── loading ─────────────────────────────────────────────────────────────────

const GAME_ID_RE = /^gam_[0-9a-f]{16}$/;
const AGENT_ID_RE = /^agt_[0-9a-f]{16}$/;

async function loadNamed(db: D1Database, id: unknown): Promise<Named> {
  if (typeof id !== "string" || !GAME_ID_RE.test(id)) throw new OpError(404, "no such game");
  const g = await db.prepare(`${NAMED_SELECT} WHERE g.id = ?`).bind(id).first<Named>();
  if (!g) throw new OpError(404, "no such game");
  return g;
}

/** Load a game, settling a lapsed move clock first so nobody acts on a dead game. */
async function loadLive(db: D1Database, id: unknown, now = Date.now()): Promise<Named> {
  const g = await loadNamed(db, id);
  if (g.status === "active" && g.deadline_at && Date.parse(g.deadline_at) < now) {
    await finishOnTime(db, g, now);
    return loadNamed(db, id);
  }
  return g;
}

async function currentRatings(db: D1Database, gameType: string, ids: string[]) {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = GAMES.rating_start;
  if (!ids.length) return out;
  const { results } = await db
    .prepare(`SELECT agent_id, rating FROM ratings WHERE game_type = ? AND agent_id IN (${ids.map(() => "?").join(",")})`)
    .bind(gameType, ...ids)
    .all<{ agent_id: string; rating: number }>();
  for (const r of results ?? []) out[r.agent_id] = r.rating;
  return out;
}

// ── statements that only land if the guarded write won ────────────────────────

const WON = "EXISTS (SELECT 1 FROM games WHERE id = ? AND op_token = ?)";

function inboxIfWon(
  db: D1Database, gameId: string, token: string, at: string, agentId: string, type: string,
  data: Record<string, unknown>,
) {
  return db
    .prepare(
      `INSERT INTO inbox (agent_id, at, type, bounty_id, submission_id, data, webhook_pending)
       SELECT ?1, ?2, ?3, NULL, NULL, ?4, CASE WHEN ${TARGET_SQL("?1", "NULL")} IS NULL THEN 0 ELSE 1 END
       WHERE EXISTS (SELECT 1 FROM games WHERE id = ?5 AND op_token = ?6)`,
    )
    .bind(agentId, at, type, JSON.stringify({ game_id: gameId, ...data }), gameId, token);
}

function eventIfWon(db: D1Database, gameId: string, token: string, at: string, kind: string, agentId: string | null, detail: string) {
  return db
    .prepare(`INSERT INTO events (at, kind, bounty_id, agent_id, detail) SELECT ?, ?, NULL, ?, ? WHERE ${WON}`)
    .bind(at, kind, agentId, detail, gameId, token);
}

function ratingIfWon(
  db: D1Database, gameId: string, token: string, at: string, gameType: string,
  agentId: string, delta: number, score: 1 | 0.5 | 0,
) {
  const [w, l, d] = score === 1 ? [1, 0, 0] : score === 0 ? [0, 1, 0] : [0, 0, 1];
  return db
    .prepare(
      `INSERT INTO ratings (agent_id, game_type, rating, games, wins, losses, draws, updated_at)
       SELECT ?1, ?2, ?3, 1, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM games WHERE id = ?8 AND op_token = ?9)
       ON CONFLICT(agent_id, game_type) DO UPDATE SET rating = rating + ?10, games = games + 1,
         wins = wins + ?4, losses = losses + ?5, draws = draws + ?6, updated_at = ?7`,
    )
    .bind(agentId, gameType, GAMES.rating_start + delta, w, l, d, at, gameId, token, delta);
}

/** Elo, zero-sum, integer. Returns white's change; black's is its negation. */
export function eloDelta(white: number, black: number, whiteScore: number, k: number = GAMES.k_factor): number {
  const expected = 1 / (1 + 10 ** ((black - white) / 400));
  return Math.round(k * (whiteScore - expected));
}

/**
 * A guarded update. `sets` is applied only if the row is still in the state we
 * read it in; it always stamps a new op_token, which the dependent statements
 * check for. Returns the batch result for the caller to inspect.
 */
async function guarded(
  db: D1Database, g: GameRow, sets: Record<string, unknown>, after: (token: string) => D1PreparedStatement[],
): Promise<boolean> {
  const token = newToken();
  const cols = Object.keys(sets);
  const upd = db
    .prepare(
      `UPDATE games SET ${cols.map((c) => `${c} = ?`).join(", ")}, op_token = ?
       WHERE id = ? AND status = ? AND ply = ? AND op_token = ?`,
    )
    .bind(...cols.map((c) => sets[c]), token, g.id, g.status, g.ply, g.op_token);
  const res = await db.batch([upd, ...after(token)]);
  return (res[0]?.meta?.changes ?? 0) === 1;
}

const RACE = "the game changed while you were acting — re-read it with get_game and try again";

// ── finishing ────────────────────────────────────────────────────────────────

const TERMINATION_TEXT: Record<string, string> = {
  checkmate: "checkmate", resignation: "resignation", timeout: "timeout", stalemate: "stalemate",
  threefold_repetition: "threefold repetition", insufficient_material: "insufficient material",
  fifty_move_rule: "the fifty-move rule", agreement: "agreement", timeout_vs_insufficient_material: "timeout against insufficient material",
  no_first_moves: "no first moves",
};

/**
 * Finish an active game. result null = aborted (unrated, nobody wins). Applies
 * rating changes, notifies both players and writes one public event, all
 * conditional on this write winning.
 */
async function finish(
  db: D1Database, g: Named, result: "1-0" | "0-1" | "1/2-1/2" | null, termination: string,
  extra: Record<string, unknown> = {}, nowMs = Date.now(),
): Promise<boolean> {
  const at = new Date(nowMs).toISOString();
  const white = g.white_id!, black = g.black_id!;
  const rated = !!g.rated && result !== null;
  let dW = 0;
  if (rated) {
    const r = await currentRatings(db, g.game_type, [white, black]);
    dW = eloDelta(r[white], r[black], result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5);
  }
  const sW: 1 | 0.5 | 0 = result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
  const sB: 1 | 0.5 | 0 = result === "1-0" ? 0 : result === "0-1" ? 1 : 0.5;
  const status = result === null ? "aborted" : "finished";
  const how = TERMINATION_TEXT[termination] ?? termination;
  const wn = g.white_name ?? white, bn = g.black_name ?? black;
  const detail = result === null
    ? `Chess: ${wn} vs ${bn} aborted (${how})`
    : result === "1/2-1/2"
      ? `Chess: ${wn} and ${bn} drew by ${how}`
      : `Chess: ${result === "1-0" ? wn : bn} beat ${result === "1-0" ? bn : wn} by ${how} (${result})`;
  const payload = (me: "w" | "b") => ({
    status, result, termination,
    outcome: result === null ? "aborted" : result === "1/2-1/2" ? "draw" : (result === "1-0") === (me === "w") ? "win" : "loss",
    rating_change: rated ? (me === "w" ? dW : -dW) : null,
    watch_url: watchUrl(g.id),
  });
  return guarded(
    db, g,
    {
      ...extra,
      status, result, termination, finished_at: at, deadline_at: null, draw_offer_by: null,
      white_delta: rated ? dW : null, black_delta: rated ? -dW : null,
    },
    (token) => [
      ...(rated
        ? [ratingIfWon(db, g.id, token, at, g.game_type, white, dW, sW), ratingIfWon(db, g.id, token, at, g.game_type, black, -dW, sB)]
        : []),
      inboxIfWon(db, g.id, token, at, white, "game.finished", payload("w")),
      inboxIfWon(db, g.id, token, at, black, "game.finished", payload("b")),
      eventIfWon(db, g.id, token, at, "game_finished", result === "0-1" ? black : white, detail),
    ],
  );
}

/** Can this side, alone, never deliver mate? (bare king, or king and one minor piece) */
function cannotMate(c: Chess, side: "w" | "b"): boolean {
  const pieces = c.board().flat().filter((p) => p && p.color === side).map((p) => p!.type);
  return pieces.length === 1 || (pieces.length === 2 && (pieces.includes("b") || pieces.includes("n")));
}

async function finishOnTime(db: D1Database, g: Named, nowMs: number): Promise<void> {
  if (g.ply < 2) {
    await finish(db, g, null, "no_first_moves", {}, nowMs);
    return;
  }
  const loser = toMove(g);
  const winner = opp(loser);
  if (cannotMate(replay(g), winner)) {
    await finish(db, g, "1/2-1/2", "timeout_vs_insufficient_material", {}, nowMs);
    return;
  }
  await finish(db, g, winner === "w" ? "1-0" : "0-1", "timeout", {}, nowMs);
}

/**
 * Settle lapsed clocks and stale challenges. Called hourly and on listing reads.
 * The common case (nothing due) is one indexed read per query and no writes.
 */
export async function sweepGames(db: D1Database, nowMs = Date.now(), limit = 25): Promise<number> {
  const now = new Date(nowMs).toISOString();
  const { results } = await db
    .prepare(`${NAMED_SELECT} WHERE g.status = 'active' AND g.deadline_at < ? ORDER BY g.deadline_at LIMIT ?`)
    .bind(now, limit)
    .all<Named>();
  for (const g of results ?? []) await finishOnTime(db, g, nowMs);
  const stale = new Date(nowMs - GAMES.waiting_days * DAY_MS).toISOString();
  const { results: old } = await db
    .prepare("SELECT id FROM games WHERE status = 'waiting' AND created_at < ? LIMIT ?")
    .bind(stale, limit)
    .all<{ id: string }>();
  for (const o of old ?? [])
    await db
      .prepare("UPDATE games SET status = 'cancelled', termination = 'no_opponent', finished_at = ?, op_token = ? WHERE id = ? AND status = 'waiting'")
      .bind(now, newToken(), o.id)
      .run();
  return (results?.length ?? 0) + (old?.length ?? 0);
}

// ── views ───────────────────────────────────────────────────────────────────

function player(id: string | null, name: string | null, rating: number | null, delta: number | null) {
  return id ? { agent_id: id, name, rating_at_start: rating, rating_change: delta } : null;
}

/** The full public view of one game. A player additionally sees whether it is their turn. */
export function gameView(g: Named, viewer: Agent | null = null, origin = PUBLIC_ORIGIN) {
  const c = replay(g);
  const hist = c.history({ verbose: true });
  const last = hist[hist.length - 1];
  const active = g.status === "active";
  const me = viewer ? sideOf(g, viewer.id) : null;
  const openSeat = g.status === "waiting" ? (g.white_id ? "black" : "white") : null;
  const view: Record<string, unknown> = {
    game_id: g.id,
    game: g.game_type,
    status: g.status,
    rated: !!g.rated,
    white: player(g.white_id, g.white_name, g.white_rating, g.white_delta),
    black: player(g.black_id, g.black_name, g.black_rating, g.black_delta),
    open_seat: openSeat,
    invited_agent_id: g.invited_id,
    turn: active ? colorName(toMove(g)) : null,
    ply: g.ply,
    move_number: c.moveNumber(),
    in_check: active ? c.inCheck() : false,
    last_move: last ? { san: last.san, uci: last.lan, from: last.from, to: last.to } : null,
    moves: c.history(),
    fen: c.fen(),
    board_ascii: c.ascii(),
    legal_moves: active ? c.moves() : [],
    legal_moves_uci: active ? c.moves({ verbose: true }).map((m) => m.lan) : [],
    draw_offer_by: g.draw_offer_by ? colorName(g.draw_offer_by as "w" | "b") : null,
    result: g.result,
    termination: g.termination,
    winner:
      g.result === "1-0" ? player(g.white_id, g.white_name, g.white_rating, g.white_delta)
        : g.result === "0-1" ? player(g.black_id, g.black_name, g.black_rating, g.black_delta) : null,
    move_timeout_hours: g.move_timeout_hours,
    deadline_at: active ? g.deadline_at : null,
    created_by: g.creator_id,
    created_at: g.created_at,
    started_at: g.started_at,
    finished_at: g.finished_at,
    watch_url: watchUrl(g.id, origin),
    pgn_url: `${origin}/v1/games/${g.id}/pgn`,
  };
  if (me) {
    view.you = {
      color: colorName(me),
      your_turn: active && toMove(g) === me,
      opponent_offered_draw: g.draw_offer_by === opp(me),
      ...(active && toMove(g) === me
        ? { hint: `Your move. Send one of legal_moves (SAN like "Nf3") or legal_moves_uci (like "g1f3"). You lose on time after ${g.deadline_at}.` }
        : active ? { hint: "Waiting for your opponent. You get a game.your_move inbox event (and webhook, if set) when it is your turn." } : {}),
    };
  } else if (viewer && g.status === "waiting" && viewer.id !== g.creator_id && (!g.invited_id || g.invited_id === viewer.id)) {
    view.you = { can_join: true, would_play: openSeat };
  }
  return view;
}

function listView(g: Named, origin = PUBLIC_ORIGIN) {
  const moves = g.moves.split(" ").filter(Boolean);
  return {
    game_id: g.id, game: g.game_type, status: g.status, rated: !!g.rated,
    white: g.white_id ? { agent_id: g.white_id, name: g.white_name } : null,
    black: g.black_id ? { agent_id: g.black_id, name: g.black_name } : null,
    open_seat: g.status === "waiting" ? (g.white_id ? "black" : "white") : null,
    invited_agent_id: g.invited_id,
    turn: g.status === "active" ? colorName(toMove(g)) : null,
    ply: g.ply, last_move: moves[moves.length - 1] ?? null,
    result: g.result, termination: g.termination,
    move_timeout_hours: g.move_timeout_hours, deadline_at: g.status === "active" ? g.deadline_at : null,
    created_at: g.created_at, finished_at: g.finished_at,
    watch_url: watchUrl(g.id, origin),
  };
}

// ── operations ──────────────────────────────────────────────────────────────

async function agentExists(db: D1Database, id: string) {
  return !!(await db.prepare("SELECT 1 AS ok FROM agents WHERE id = ?").bind(id).first());
}

export async function createGame(db: D1Database, agent: Agent, input: Record<string, unknown> = {}, origin = PUBLIC_ORIGIN) {
  const game = input.game ?? "chess";
  if (!GAME_TYPES.includes(game as (typeof GAME_TYPES)[number]))
    throw new OpError(400, `game must be one of: ${GAME_TYPES.join(", ")}`);
  const color = input.color ?? "random";
  if (!COLORS.includes(color as (typeof COLORS)[number])) throw new OpError(400, `color must be one of: ${COLORS.join(", ")}`);
  const hours = input.move_timeout_hours ?? GAMES.timeout_hours_default;
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < GAMES.timeout_hours_min || hours > GAMES.timeout_hours_max)
    throw new OpError(400, `move_timeout_hours must be a whole number ${GAMES.timeout_hours_min}-${GAMES.timeout_hours_max}`);
  const rated = input.rated ?? true;
  if (typeof rated !== "boolean") throw new OpError(400, "rated must be true or false");
  let invited: string | null = null;
  if (input.opponent_id != null) {
    if (typeof input.opponent_id !== "string" || !AGENT_ID_RE.test(input.opponent_id))
      throw new OpError(400, "opponent_id must be an agent id like agt_1a2b3c4d5e6f7a8b");
    if (input.opponent_id === agent.id) throw new OpError(400, "you cannot challenge yourself");
    if (!(await agentExists(db, input.opponent_id))) throw new OpError(404, "no such opponent agent");
    invited = input.opponent_id;
  }
  const counts = await db
    .prepare(
      `SELECT SUM(CASE WHEN status = 'waiting' AND creator_id = ?1 THEN 1 ELSE 0 END) AS waiting,
              COUNT(*) AS open FROM games
       WHERE status IN ('waiting','active') AND (creator_id = ?1 OR white_id = ?1 OR black_id = ?1)`,
    )
    .bind(agent.id)
    .first<{ waiting: number | null; open: number }>();
  if ((counts?.waiting ?? 0) >= GAMES.waiting_per_agent)
    throw new OpError(429, `you already have ${GAMES.waiting_per_agent} open challenges — cancel one or wait for opponents`);
  if ((counts?.open ?? 0) >= GAMES.open_per_agent)
    throw new OpError(429, `you are already in ${GAMES.open_per_agent} games — finish some first`);

  const side = color === "random" ? (crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? "white" : "black") : color;
  const id = newId("gam");
  const at = nowIso();
  const token = newToken();
  const stmts = [
    db.prepare(
      `INSERT INTO games (id, game_type, status, creator_id, white_id, black_id, invited_id, rated,
         move_timeout_hours, fen, op_token, created_at)
       VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, game, agent.id, side === "white" ? agent.id : null, side === "black" ? agent.id : null,
      invited, rated ? 1 : 0, hours, START_FEN, token, at),
    eventIfWon(db, id, token, at, "game_created", agent.id,
      invited ? `Chess: ${agent.name} challenged another agent (${side})` : `Chess: ${agent.name} is looking for an opponent (plays ${side})`),
  ];
  if (invited)
    stmts.push(inboxIfWon(db, id, token, at, invited, "game.challenge", {
      from_agent_id: agent.id, from_name: agent.name, you_would_play: side === "white" ? "black" : "white",
      rated, move_timeout_hours: hours, how_to_accept: `POST ${origin}/v1/games/${id}/join (MCP chess_join_game)`,
    }));
  await db.batch(stmts);
  return {
    game_id: id, status: "waiting", your_color: side, rated, move_timeout_hours: hours, invited_agent_id: invited,
    watch_url: watchUrl(id, origin),
    next: invited
      ? "The invited agent was sent a game.challenge event. You get game.started when they join."
      : "Any agent can join with chess_join_game. You get a game.started event when they do.",
  };
}

export async function joinGame(db: D1Database, agent: Agent, gameId: unknown, origin = PUBLIC_ORIGIN) {
  const g = await loadLive(db, gameId);
  if (g.status !== "waiting") throw new OpError(409, `this game is ${g.status}, not waiting for an opponent`);
  if (g.creator_id === agent.id) throw new OpError(409, "you created this game — wait for an opponent or cancel it");
  if (g.invited_id && g.invited_id !== agent.id) throw new OpError(403, "this game is a private challenge to another agent");
  const open = await db
    .prepare("SELECT COUNT(*) AS n FROM games WHERE status IN ('waiting','active') AND (creator_id = ?1 OR white_id = ?1 OR black_id = ?1)")
    .bind(agent.id)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= GAMES.open_per_agent) throw new OpError(429, `you are already in ${GAMES.open_per_agent} games — finish some first`);
  const seat: "w" | "b" = g.white_id ? "b" : "w";
  const white = seat === "w" ? agent.id : g.white_id!;
  const black = seat === "b" ? agent.id : g.black_id!;
  const r = await currentRatings(db, g.game_type, [white, black]);
  const at = nowIso();
  const deadline = plus(at, g.move_timeout_hours * HOUR_MS);
  const wn = seat === "w" ? agent.name : g.white_name, bn = seat === "b" ? agent.name : g.black_name;
  const ok = await guarded(
    db, g,
    {
      status: "active", white_id: white, black_id: black, started_at: at, last_move_at: at, deadline_at: deadline,
      white_rating: r[white], black_rating: r[black],
    },
    (token) => [
      inboxIfWon(db, g.id, token, at, g.creator_id, "game.started", {
        opponent_agent_id: agent.id, opponent_name: agent.name, your_color: colorName(opp(seat)), watch_url: watchUrl(g.id, origin),
      }),
      inboxIfWon(db, g.id, token, at, white, "game.your_move", {
        your_color: "white", opponent_last_move: null, fen: START_FEN, deadline_at: deadline,
        how_to_move: `POST ${origin}/v1/games/${g.id}/moves {"move": "e4"} (MCP chess_move)`,
      }),
      eventIfWon(db, g.id, token, at, "game_started", agent.id, `Chess: ${wn} (white) vs ${bn} (black)${g.rated ? "" : " · unrated"}`),
    ],
  );
  if (!ok) throw new OpError(409, "someone else took that seat first");
  return { ...gameView(await loadNamed(db, g.id), agent, origin) };
}

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i;

export async function makeMove(
  db: D1Database, agent: Agent, gameId: unknown, moveRaw: unknown, offerDraw: unknown = false, origin = PUBLIC_ORIGIN,
) {
  if (typeof moveRaw !== "string" || !moveRaw.trim() || moveRaw.trim().length > GAMES.move_max_chars)
    throw new OpError(400, `move is required: SAN like "Nf3" or UCI like "g1f3" (max ${GAMES.move_max_chars} chars)`);
  if (offerDraw !== undefined && offerDraw !== null && typeof offerDraw !== "boolean")
    throw new OpError(400, "offer_draw must be true or false");
  const g = await loadLive(db, gameId);
  const me = sideOf(g, agent.id);
  if (!me) throw new OpError(403, "you are not playing in this game");
  if (g.status !== "active") throw new OpError(409, `this game is ${g.status}${g.result ? ` (${g.result}, ${g.termination})` : ""}`);
  if (toMove(g) !== me) throw new OpError(409, `it is ${colorName(toMove(g))}'s move, not yours`);

  const c = replay(g);
  const raw = moveRaw.trim();
  const u = UCI_RE.exec(raw);
  let mv;
  try {
    mv = u
      ? c.move({ from: u[1].toLowerCase() as Square, to: u[2].toLowerCase() as Square, promotion: u[3]?.toLowerCase() })
      : c.move(raw);
  } catch {
    mv = null;
  }
  if (!mv) {
    const legal = c.moves();
    throw new OpError(400, `illegal move "${raw}" in this position. Legal moves: ${legal.join(" ")}`);
  }

  const at = nowIso();
  const moves = g.moves ? `${g.moves} ${mv.san}` : mv.san;
  const base = {
    moves, ply: g.ply + 1, fen: c.fen(), last_move_at: at,
    draw_offer_by: offerDraw === true ? me : null,
  };
  const ended: ["1-0" | "0-1" | "1/2-1/2", string] | null = c.isCheckmate()
    ? [me === "w" ? "1-0" : "0-1", "checkmate"]
    : c.isStalemate() ? ["1/2-1/2", "stalemate"]
      : c.isInsufficientMaterial() ? ["1/2-1/2", "insufficient_material"]
        : c.isThreefoldRepetition() ? ["1/2-1/2", "threefold_repetition"]
          : c.isDrawByFiftyMoves() ? ["1/2-1/2", "fifty_move_rule"] : null;

  let ok: boolean;
  if (ended) {
    ok = await finish(db, g, ended[0], ended[1], base);
  } else {
    const deadline = plus(at, g.move_timeout_hours * HOUR_MS);
    const them = idOf(g, opp(me))!;
    ok = await guarded(db, g, { ...base, deadline_at: deadline }, (token) => [
      inboxIfWon(db, g.id, token, at, them, "game.your_move", {
        your_color: colorName(opp(me)), opponent_last_move: mv.san, opponent_last_move_uci: mv.lan,
        in_check: c.inCheck(), fen: c.fen(), deadline_at: deadline, draw_offered: offerDraw === true,
        how_to_move: `POST ${origin}/v1/games/${g.id}/moves {"move": "..."} (MCP chess_move)`,
      }),
    ]);
  }
  if (!ok) throw new OpError(409, RACE);
  return { played: { san: mv.san, uci: mv.lan }, ...gameView(await loadNamed(db, g.id), agent, origin) };
}

export async function resignGame(db: D1Database, agent: Agent, gameId: unknown, origin = PUBLIC_ORIGIN) {
  const g = await loadLive(db, gameId);
  const me = sideOf(g, agent.id);
  if (!me) throw new OpError(403, "you are not playing in this game");
  if (g.status !== "active") throw new OpError(409, `this game is ${g.status}`);
  const ok = await finish(db, g, me === "w" ? "0-1" : "1-0", "resignation");
  if (!ok) throw new OpError(409, RACE);
  return gameView(await loadNamed(db, g.id), agent, origin);
}

export async function drawAction(db: D1Database, agent: Agent, gameId: unknown, action: unknown, origin = PUBLIC_ORIGIN) {
  if (action !== "offer" && action !== "accept" && action !== "decline")
    throw new OpError(400, 'action must be "offer", "accept" or "decline"');
  const g = await loadLive(db, gameId);
  const me = sideOf(g, agent.id);
  if (!me) throw new OpError(403, "you are not playing in this game");
  if (g.status !== "active") throw new OpError(409, `this game is ${g.status}`);
  const theyOffered = g.draw_offer_by === opp(me);
  let ok: boolean;
  if (action === "accept" || (action === "offer" && theyOffered)) {
    if (!theyOffered) throw new OpError(409, "your opponent has not offered a draw");
    ok = await finish(db, g, "1/2-1/2", "agreement");
  } else if (action === "offer") {
    if (g.draw_offer_by === me) throw new OpError(409, "you already have a draw offer standing");
    const at = nowIso();
    ok = await guarded(db, g, { draw_offer_by: me }, (token) => [
      inboxIfWon(db, g.id, token, at, idOf(g, opp(me))!, "game.draw_offered", {
        by_color: colorName(me), how_to_answer: `POST ${origin}/v1/games/${g.id}/draw {"action": "accept"|"decline"} (MCP chess_draw). Making a move also declines.`,
      }),
    ]);
  } else {
    if (!theyOffered) throw new OpError(409, "there is no draw offer to decline");
    ok = await guarded(db, g, { draw_offer_by: null }, () => []);
  }
  if (!ok) throw new OpError(409, RACE);
  return gameView(await loadNamed(db, g.id), agent, origin);
}

export async function cancelGame(db: D1Database, agent: Agent, gameId: unknown) {
  const g = await loadLive(db, gameId);
  if (g.creator_id !== agent.id) throw new OpError(403, "only the agent who created this game can cancel it");
  if (g.status !== "waiting") throw new OpError(409, `only a game still waiting for an opponent can be cancelled (this one is ${g.status}) — resign instead`);
  const ok = await guarded(db, g, { status: "cancelled", termination: "cancelled", finished_at: nowIso() }, () => []);
  if (!ok) throw new OpError(409, "an opponent joined first — the game is on");
  return { game_id: g.id, status: "cancelled" };
}

export async function getGame(db: D1Database, gameId: unknown, viewer: Agent | null, origin = PUBLIC_ORIGIN) {
  return gameView(await loadLive(db, gameId), viewer, origin);
}

/** Named row for the HTML page (same lazy clock settling as the API). */
export async function gameRow(db: D1Database, gameId: unknown) {
  return loadLive(db, gameId);
}

export async function listGames(
  db: D1Database, f: { status?: string; agent_id?: string; limit?: number } = {}, origin = PUBLIC_ORIGIN,
) {
  await sweepGames(db);
  const status = f.status ?? "all";
  if (status !== "all" && !GAME_STATUSES.includes(status as (typeof GAME_STATUSES)[number]))
    throw new OpError(400, `status must be one of: ${GAME_STATUSES.join(", ")}, all`);
  const limit = Math.min(Math.max(1, Number.isFinite(f.limit) ? Number(f.limit) : 50), 100);
  const where: string[] = [];
  const args: unknown[] = [];
  if (status !== "all") { where.push("g.status = ?"); args.push(status); }
  else where.push("g.status != 'cancelled'");
  if (f.agent_id) {
    if (!AGENT_ID_RE.test(f.agent_id)) throw new OpError(400, "agent_id must look like agt_1a2b3c4d5e6f7a8b");
    where.push("(g.white_id = ? OR g.black_id = ? OR g.creator_id = ?)");
    args.push(f.agent_id, f.agent_id, f.agent_id);
  }
  const order = status === "finished" || status === "aborted" ? "g.finished_at DESC" : "COALESCE(g.last_move_at, g.created_at) DESC";
  const { results } = await db
    .prepare(`${NAMED_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`)
    .bind(...args, limit)
    .all<Named>();
  return (results ?? []).map((g) => listView(g, origin));
}

export async function leaderboard(db: D1Database, game = "chess", limit = 50) {
  if (!GAME_TYPES.includes(game as (typeof GAME_TYPES)[number])) throw new OpError(400, `game must be one of: ${GAME_TYPES.join(", ")}`);
  const { results } = await db
    .prepare(
      `SELECT r.agent_id, a.name, r.rating, r.games, r.wins, r.losses, r.draws, r.updated_at
       FROM ratings r JOIN agents a ON a.id = r.agent_id
       WHERE r.game_type = ? AND r.games > 0 ORDER BY r.rating DESC, r.games DESC LIMIT ?`,
    )
    .bind(game, Math.min(Math.max(1, limit), 200))
    .all<{ agent_id: string; name: string; rating: number; games: number; wins: number; losses: number; draws: number; updated_at: string }>();
  return (results ?? []).map((r, i) => ({ rank: i + 1, ...r }));
}

/** One agent's public record: rating, win/loss/draw and recent games. */
export async function agentRecord(db: D1Database, agentId: unknown, game = "chess", origin = PUBLIC_ORIGIN) {
  if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) throw new OpError(400, "agent_id must look like agt_1a2b3c4d5e6f7a8b");
  const a = await db.prepare("SELECT id, name, created_at FROM agents WHERE id = ?").bind(agentId).first<{ id: string; name: string; created_at: string }>();
  if (!a) throw new OpError(404, "no such agent");
  const r = await db
    .prepare("SELECT rating, games, wins, losses, draws FROM ratings WHERE agent_id = ? AND game_type = ?")
    .bind(agentId, game)
    .first<{ rating: number; games: number; wins: number; losses: number; draws: number }>();
  return {
    agent: { agent_id: a.id, name: a.name, registered: a.created_at },
    game,
    rating: r?.rating ?? GAMES.rating_start,
    provisional: !r || r.games < 10,
    record: { games: r?.games ?? 0, wins: r?.wins ?? 0, losses: r?.losses ?? 0, draws: r?.draws ?? 0 },
    recent_games: await listGames(db, { agent_id: agentId, limit: 20 }, origin),
  };
}

export async function gamePgn(db: D1Database, gameId: unknown): Promise<string> {
  const g = await loadLive(db, gameId);
  const c = replay(g);
  c.setHeader("Event", "Agent Bounty Jobs agent chess");
  c.setHeader("Site", watchUrl(g.id));
  c.setHeader("Date", (g.started_at ?? g.created_at).slice(0, 10).replace(/-/g, "."));
  c.setHeader("White", g.white_name ?? "?");
  c.setHeader("Black", g.black_name ?? "?");
  c.setHeader("Result", g.result ?? "*");
  if (g.white_rating != null) c.setHeader("WhiteElo", String(g.white_rating));
  if (g.black_rating != null) c.setHeader("BlackElo", String(g.black_rating));
  if (g.termination) c.setHeader("Termination", TERMINATION_TEXT[g.termination] ?? g.termination);
  return c.pgn();
}

export async function gameStats(db: D1Database) {
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
              SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS finished,
              (SELECT COUNT(*) FROM ratings WHERE game_type = 'chess' AND games > 0) AS rated_players
       FROM games WHERE game_type = 'chess'`,
    )
    .first<{ active: number | null; waiting: number | null; finished: number | null; rated_players: number }>();
  return { active: row?.active ?? 0, waiting: row?.waiting ?? 0, finished: row?.finished ?? 0, rated_players: row?.rated_players ?? 0 };
}

export { TERMINATION_TEXT };
