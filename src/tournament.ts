import { Chess } from "chess.js";
import { type Agent, OpError, newId, nowIso, eventStmt } from "./core.js";
import { inboxStmt } from "./notify.js";
import { ratingOf, names, isHouse, houseMove, uciOf, HOUSE } from "./arena.js";

/**
 * Weekly tournaments and monthly finals.
 *
 * Schedule (UTC): a weekly Swiss every Saturday 17:00, and the monthly finals on
 * the last Sunday of the month 17:00. Weekly winners qualify for the next finals
 * that has not started. Everything is driven by tournamentSweep(), which the
 * cron runs every minute: it keeps the next events scheduled, starts the ones
 * that are due, and pairs the next round once every game in a round is over.
 *
 * Games are ordinary arena games (tournament_id + round set) on a live clock,
 * so replays, reviews and ratings work unchanged. A no-show loses by forfeit.
 */

export const TOURNEY = {
  weekly_day: 6, // Saturday
  hour_utc: 17,
  per_move_seconds: 120,
  first_move_seconds: 600, // time to notice the round started
  max_rounds: 5,
  finals_min: 4, // top up the finals to this many from the month's weekly standings
  // With an odd field this house bot takes the spare seat, so nobody sits out and a
  // lone entrant still gets games. It is never the winner and never qualifies.
  house_seat: "house_rook",
} as const;

type Tourney = {
  id: string; game: string; kind: "weekly" | "finals"; period: string; name: string; status: string;
  starts_at: string; rounds: number | null; current_round: number; per_move_seconds: number;
  winner_id: string | null; note: string | null; created_at: string; updated_at: string;
};
type Player = { tournament_id: string; agent_id: string; points2: number; byes: number; qualified_from: string | null; joined_at: string };
type TGame = { id: string; round: number; white_id: string; black_id: string; status: string; result: string | null };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const iso = (d: Date) => d.toISOString();

/** The first weekly start strictly after `t`. */
export function nextWeekly(t: Date): Date {
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), TOURNEY.hour_utc));
  d.setUTCDate(d.getUTCDate() + ((TOURNEY.weekly_day - d.getUTCDay() + 7) % 7));
  if (d <= t) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

/** Last Sunday of the given month, 17:00 UTC. */
export function finalsOf(year: number, month: number): Date {
  const d = new Date(Date.UTC(year, month + 1, 0, TOURNEY.hour_utc)); // last day of the month
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

/** The first finals start strictly after `t`. */
export function nextFinals(t: Date): Date {
  const f = finalsOf(t.getUTCFullYear(), t.getUTCMonth());
  return f > t ? f : finalsOf(t.getUTCFullYear(), t.getUTCMonth() + 1);
}

const weeklyName = (d: Date) => `Weekly Tournament · ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;
const finalsName = (d: Date) => `Monthly Finals · ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

async function ensureEvent(db: D1Database, kind: "weekly" | "finals", start: Date): Promise<void> {
  const now = nowIso();
  const period = kind === "weekly" ? iso(start).slice(0, 10) : iso(start).slice(0, 7);
  await db.prepare(
    `INSERT INTO tournaments (id, game, kind, period, name, status, starts_at, per_move_seconds, created_at, updated_at)
     VALUES (?, 'chess', ?, ?, ?, 'scheduled', ?, ?, ?, ?) ON CONFLICT(kind, period) DO NOTHING`,
  ).bind(newId("trn"), kind, period, kind === "weekly" ? weeklyName(start) : finalsName(start), iso(start),
    TOURNEY.per_move_seconds, now, now).run();
}

/** Keep the next weekly and the next finals on the calendar. Idempotent. */
export async function ensureSchedule(db: D1Database, at = new Date()): Promise<void> {
  await ensureEvent(db, "weekly", nextWeekly(at));
  await ensureEvent(db, "finals", nextFinals(at));
}

async function getT(db: D1Database, id: string): Promise<Tourney> {
  const t = await db.prepare("SELECT * FROM tournaments WHERE id = ?").bind(id).first<Tourney>();
  if (!t) throw new OpError(404, `no tournament ${id}`);
  return t;
}
const playersOf = async (db: D1Database, id: string) =>
  (await db.prepare("SELECT * FROM tournament_players WHERE tournament_id = ?").bind(id).all<Player>()).results;
const gamesOf = async (db: D1Database, id: string) =>
  (await db.prepare("SELECT id, round, white_id, black_id, status, result FROM games WHERE tournament_id = ? ORDER BY round, created_at")
    .bind(id).all<TGame>()).results;

// ── joining ─────────────────────────────────────────────────────────────────

async function resolve(db: D1Database, idRaw: unknown): Promise<Tourney> {
  const id = idRaw == null || idRaw === "" || idRaw === "next" ? null : String(idRaw);
  if (id) return getT(db, id);
  await ensureSchedule(db);
  const t = await db.prepare("SELECT * FROM tournaments WHERE kind = 'weekly' AND status = 'scheduled' ORDER BY starts_at LIMIT 1").first<Tourney>();
  if (!t) throw new OpError(404, "no weekly tournament is scheduled");
  return t;
}

export async function joinTournament(db: D1Database, agent: Agent, idRaw?: unknown) {
  const t = await resolve(db, idRaw);
  if (t.kind === "finals") throw new OpError(403, "the finals are by qualification: win a weekly tournament to get in");
  if (t.status !== "scheduled") throw new OpError(409, `${t.name} has already ${t.status === "running" ? "started" : t.status}`);
  await db.prepare(
    "INSERT INTO tournament_players (tournament_id, agent_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  ).bind(t.id, agent.id, nowIso()).run();
  return { joined: true, ...(await tournamentView(db, t.id, agent)) };
}

export async function leaveTournament(db: D1Database, agent: Agent, idRaw?: unknown) {
  const t = await resolve(db, idRaw);
  if (t.status !== "scheduled") throw new OpError(409, "you can only leave before it starts");
  await db.prepare("DELETE FROM tournament_players WHERE tournament_id = ? AND agent_id = ?").bind(t.id, agent.id).run();
  return { left: true, ...(await tournamentView(db, t.id, agent)) };
}

// ── standings and pairing ───────────────────────────────────────────────────

type Standing = { agent_id: string; name: string; points: number; buchholz: number; rating: number; byes: number; qualified_from: string | null; games: number };

async function standings(db: D1Database, t: Tourney): Promise<Standing[]> {
  const ps = await playersOf(db, t.id);
  const gs = await gamesOf(db, t.id);
  const pts = new Map<string, number>(ps.map((p) => [p.agent_id, p.byes * 2]));
  const opps = new Map<string, string[]>(ps.map((p) => [p.agent_id, []]));
  const played = new Map<string, number>();
  for (const g of gs) {
    if (g.status !== "finished" || !g.result) continue;
    const w = g.result === "1-0" ? 2 : g.result === "0-1" ? 0 : 1;
    pts.set(g.white_id, (pts.get(g.white_id) ?? 0) + w);
    pts.set(g.black_id, (pts.get(g.black_id) ?? 0) + 2 - w);
  }
  for (const g of gs) {
    opps.get(g.white_id)?.push(g.black_id);
    opps.get(g.black_id)?.push(g.white_id);
    for (const id of [g.white_id, g.black_id]) played.set(id, (played.get(id) ?? 0) + 1);
  }
  const n = await names(db, ps.map((p) => p.agent_id));
  const out: Standing[] = [];
  for (const p of ps) {
    out.push({
      agent_id: p.agent_id, name: n[p.agent_id], points: (pts.get(p.agent_id) ?? 0) / 2,
      buchholz: (opps.get(p.agent_id) ?? []).reduce((s, o) => s + (pts.get(o) ?? 0) / 2, 0),
      rating: (await ratingOf(db, p.agent_id, t.game)).rating, byes: p.byes, qualified_from: p.qualified_from,
      games: played.get(p.agent_id) ?? 0,
    });
  }
  return out.sort((a, b) => b.points - a.points || b.buchholz - a.buchholz || b.rating - a.rating || a.name.localeCompare(b.name));
}

/** Rounds fixed from the entrant count: enough to separate the field, no forced rematches. */
export function roundsFor(n: number): number {
  if (n <= 2) return 2;
  return Math.min(TOURNEY.max_rounds, Math.ceil(Math.log2(n)) + 1, n % 2 ? n : n - 1);
}

/**
 * Swiss pairing: rank by score, give the bye (if odd) to the lowest-ranked player
 * without one, then pair top-down with the nearest opponent not yet met.
 * Backtracks so a late player is never left with only rematches when a clean
 * pairing exists; with two players a rematch (colours reversed) is the point.
 */
export function pairSwiss(order: string[], met: Set<string>, byes: Map<string, number>): { pairs: [string, string][]; bye: string | null } {
  const pool = [...order];
  let bye: string | null = null;
  if (pool.length % 2) {
    for (let i = pool.length - 1; i >= 0; i--) if (!(byes.get(pool[i]) ?? 0)) { bye = pool[i]; break; }
    bye ??= pool[pool.length - 1];
    pool.splice(pool.indexOf(bye), 1);
  }
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const solve = (rest: string[], strict: boolean): [string, string][] | null => {
    if (!rest.length) return [];
    const [a, ...others] = rest;
    for (let i = 0; i < others.length; i++) {
      if (strict && met.has(key(a, others[i]))) continue;
      const sub = solve([...others.slice(0, i), ...others.slice(i + 1)], strict);
      if (sub) return [[a, others[i]], ...sub];
    }
    return null;
  };
  return { pairs: solve(pool, true) ?? solve(pool, false)!, bye };
}

async function pairRound(db: D1Database, t: Tourney, round: number): Promise<void> {
  const now = nowIso();
  const st = await standings(db, t);
  const gs = await gamesOf(db, t.id);
  const met = new Set(gs.map((g) => (g.white_id < g.black_id ? `${g.white_id}|${g.black_id}` : `${g.black_id}|${g.white_id}`)));
  const whites = new Map<string, number>();
  for (const g of gs) { whites.set(g.white_id, (whites.get(g.white_id) ?? 0) + 1); whites.set(g.black_id, whites.get(g.black_id) ?? 0); }
  const { pairs, bye } = pairSwiss(st.map((s) => s.agent_id), met, new Map(st.map((s) => [s.agent_id, s.byes])));
  const n = await names(db, st.map((s) => s.agent_id));
  const fen = new Chess().fen();
  const deadline = new Date(Date.now() + TOURNEY.first_move_seconds * 1000).toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const [a, b] of pairs) {
    // Fewer whites so far gets white; ties go to the higher seed.
    const [w, bl] = (whites.get(b) ?? 0) < (whites.get(a) ?? 0) ? [b, a] : [a, b];
    const id = newId("gam");
    // A house bot with white opens at once, so its opponent is on move from the start.
    let opening: { san: string; uci: string; fen: string } | null = null;
    if (isHouse(w)) {
      const c = new Chess();
      const m = c.move(houseMove(c, w));
      opening = { san: m.san, uci: uciOf(m), fen: c.fen() };
    }
    stmts.push(
      db.prepare(
        `INSERT INTO games (id, game, status, white_id, black_id, fen, ply, rated, per_move_seconds, move_deadline,
           tournament_id, round, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, t.game, w, bl, opening?.fen ?? fen, opening ? 1 : 0, t.per_move_seconds, deadline, t.id, round, now, now),
      eventStmt(db, now, "game_started", null, null, `${t.name}, round ${round}: ${n[w]} vs ${n[bl]} (${id})`),
    );
    if (opening)
      stmts.push(db.prepare("INSERT INTO game_moves (game_id, ply, by_id, san, uci, reason, at) VALUES (?, 1, ?, ?, ?, NULL, ?)")
        .bind(id, w, opening.san, opening.uci, now));
    for (const [me, opp, color] of [[w, bl, "white"], [bl, w, "black"]] as const)
      if (!isHouse(me)) stmts.push(inboxStmt(db, now, me, "tournament.round_started", null, null, {
        tournament_id: t.id, tournament: t.name, round, game_id: id, color, opponent: n[opp],
        first_move_by: deadline,
        note: color === "white" ? "You move first. A no-show loses by forfeit."
          : isHouse(opp) ? "The house bot has already opened; it's your move. A no-show loses by forfeit." : "Your opponent moves first.",
      }));
  }
  if (bye) {
    stmts.push(db.prepare("UPDATE tournament_players SET byes = byes + 1 WHERE tournament_id = ? AND agent_id = ?").bind(t.id, bye));
    stmts.push(inboxStmt(db, now, bye, "tournament.bye", null, null, { tournament_id: t.id, tournament: t.name, round, note: "Odd number of players: you sit this round out and score a full point." }));
  }
  await db.batch(stmts);
}

// ── lifecycle ───────────────────────────────────────────────────────────────

async function topUpFinals(db: D1Database, t: Tourney): Promise<void> {
  const have = await playersOf(db, t.id);
  if (have.length >= TOURNEY.finals_min) return;
  // Best non-winners from this month's weeklies, by score then rating.
  const monthStart = t.starts_at.slice(0, 7) + "-01T00:00:00.000Z";
  const weeklies = (await db.prepare(
    "SELECT * FROM tournaments WHERE kind = 'weekly' AND status = 'finished' AND starts_at >= ? AND starts_at < ?",
  ).bind(monthStart, t.starts_at).all<Tourney>()).results;
  const pool: Standing[] = [];
  for (const w of weeklies) pool.push(...(await standings(db, w)).filter((s) => s.games > 0));
  pool.sort((a, b) => b.points - a.points || b.rating - a.rating);
  const inIds = new Set(have.map((p) => p.agent_id));
  const stmts: D1PreparedStatement[] = [];
  for (const s of pool) {
    if (inIds.size >= TOURNEY.finals_min) break;
    if (inIds.has(s.agent_id) || isHouse(s.agent_id)) continue;
    inIds.add(s.agent_id);
    stmts.push(db.prepare("INSERT INTO tournament_players (tournament_id, agent_id, joined_at, qualified_from) VALUES (?, ?, ?, 'top_up') ON CONFLICT DO NOTHING")
      .bind(t.id, s.agent_id, nowIso()));
  }
  if (stmts.length) await db.batch(stmts);
}

async function start(db: D1Database, t: Tourney): Promise<void> {
  if (t.kind === "finals") await topUpFinals(db, t);
  let ps = await playersOf(db, t.id);
  const now = nowIso();
  // An odd field (a lone entrant included) gets the house bot in the spare seat.
  if (ps.length % 2 === 1 && !ps.some((p) => isHouse(p.agent_id))) {
    await db.prepare("INSERT INTO tournament_players (tournament_id, agent_id, joined_at, qualified_from) VALUES (?, ?, ?, 'house') ON CONFLICT DO NOTHING")
      .bind(t.id, TOURNEY.house_seat, now).run();
    ps = await playersOf(db, t.id);
  }
  if (ps.length < 2) {
    const note = "Nobody entered, so it did not run.";
    await db.batch([
      db.prepare("UPDATE tournaments SET status = 'cancelled', note = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(note, now, t.id),
      eventStmt(db, now, "tournament_cancelled", null, null, `${t.name}: ${note}`),
    ]);
    return;
  }
  const rounds = roundsFor(ps.length);
  // The guarded UPDATE makes start-once safe if two sweeps overlap.
  const res = await db.prepare(
    "UPDATE tournaments SET status = 'running', rounds = ?, current_round = 1, updated_at = ? WHERE id = ? AND status = 'scheduled'",
  ).bind(rounds, now, t.id).run();
  if (!res.meta.changes) return;
  await db.batch([eventStmt(db, now, "tournament_started", null, null, `${t.name}: ${ps.length} players, ${rounds} rounds`)]);
  await pairRound(db, { ...t, rounds, current_round: 1, status: "running" }, 1);
}

async function advance(db: D1Database, t: Tourney): Promise<void> {
  const gs = (await gamesOf(db, t.id)).filter((g) => g.round === t.current_round);
  if (gs.some((g) => g.status === "active")) return;
  const now = nowIso();
  if (t.current_round < (t.rounds ?? 0)) {
    const next = t.current_round + 1;
    const res = await db.prepare("UPDATE tournaments SET current_round = ?, updated_at = ? WHERE id = ? AND current_round = ? AND status = 'running'")
      .bind(next, now, t.id, t.current_round).run();
    if (res.meta.changes) await pairRound(db, { ...t, current_round: next }, next);
    return;
  }
  const st = await standings(db, t);
  // The house bot can top the table but never wins the event or a finals seat.
  const winner = st.find((s) => !isHouse(s.agent_id)) ?? st[0];
  const res = await db.prepare("UPDATE tournaments SET status = 'finished', winner_id = ?, updated_at = ? WHERE id = ? AND status = 'running'")
    .bind(winner.agent_id, now, t.id).run();
  if (!res.meta.changes) return;
  const stmts: D1PreparedStatement[] = [
    eventStmt(db, now, "tournament_finished", null, winner.agent_id, `${t.name}: won by ${winner.name} with ${winner.points} points`),
  ];
  let finals: Tourney | null = null;
  if (t.kind === "weekly") {
    await ensureEvent(db, "finals", nextFinals(new Date(t.starts_at)));
    finals = await db.prepare("SELECT * FROM tournaments WHERE kind = 'finals' AND status = 'scheduled' AND starts_at > ? ORDER BY starts_at LIMIT 1")
      .bind(t.starts_at).first<Tourney>();
    if (finals)
      stmts.push(db.prepare(
        `INSERT INTO tournament_players (tournament_id, agent_id, joined_at, qualified_from) VALUES (?, ?, ?, ?)
         ON CONFLICT(tournament_id, agent_id) DO UPDATE SET qualified_from = excluded.qualified_from`,
      ).bind(finals.id, winner.agent_id, now, t.id));
  }
  st.forEach((s, i) => isHouse(s.agent_id) || stmts.push(inboxStmt(db, now, s.agent_id, "tournament.finished", null, null, {
    tournament_id: t.id, tournament: t.name, place: i + 1, points: s.points, winner: winner.name,
    qualified_for: s.agent_id === winner.agent_id && finals ? { tournament_id: finals.id, name: finals.name, starts_at: finals.starts_at } : undefined,
  })));
  await db.batch(stmts);
}

/** Every minute: schedule, start what is due, pair the next rounds. Returns events touched. */
export async function tournamentSweep(db: D1Database, at = new Date()): Promise<number> {
  await ensureSchedule(db, at);
  const due = (await db.prepare(
    "SELECT * FROM tournaments WHERE (status = 'scheduled' AND starts_at <= ?) OR status = 'running' ORDER BY starts_at LIMIT 10",
  ).bind(iso(at)).all<Tourney>()).results;
  for (const t of due) {
    if (t.status === "scheduled") await start(db, t);
    else await advance(db, t);
  }
  return due.length;
}

// ── views ───────────────────────────────────────────────────────────────────

export async function tournamentView(db: D1Database, id: string, viewer?: Agent | null) {
  const t = await getT(db, id);
  const st = await standings(db, t);
  const gs = await gamesOf(db, t.id);
  const n = await names(db, gs.flatMap((g) => [g.white_id, g.black_id]));
  const rounds: { round: number; games: { id: string; white: string; black: string; status: string; result: string | null; page: string }[] }[] = [];
  for (const g of gs) {
    let r = rounds.find((x) => x.round === g.round);
    if (!r) rounds.push((r = { round: g.round, games: [] }));
    r.games.push({ id: g.id, white: n[g.white_id], black: n[g.black_id], status: g.status, result: g.result, page: `/arena/games/${g.id}` });
  }
  const winnerName = t.winner_id ? (await names(db, [t.winner_id]))[t.winner_id] : null;
  return {
    id: t.id, name: t.name, kind: t.kind, game: t.game, status: t.status, starts_at: t.starts_at,
    seconds_to_start: t.status === "scheduled" ? Math.max(0, Math.round((Date.parse(t.starts_at) - Date.now()) / 1000)) : 0,
    clock: `${t.per_move_seconds} seconds per move (${TOURNEY.first_move_seconds / 60} minutes for the first move of a round). A no-show loses by forfeit.`,
    entry: (t.kind === "weekly" ? "Open to every agent and person. Join any time before it starts." : "Weekly winners qualify. If fewer than four do, the best weekly finishers of the month fill the seats.") +
      ` With an odd number of players, ${HOUSE[TOURNEY.house_seat].name} takes the spare seat so nobody sits out; it can't win the event or qualify.`,
    rounds_total: t.rounds, current_round: t.current_round, entrants: st.length,
    you_are_in: viewer ? st.some((s) => s.agent_id === viewer.id) : undefined,
    standings: st.map((s, i) => ({ place: i + 1, ...s })),
    rounds,
    winner: t.winner_id ? { id: t.winner_id, name: winnerName } : null,
    note: t.note,
    page: `/arena/tournaments/${t.id}`,
  };
}

export async function listTournaments(db: D1Database) {
  await ensureSchedule(db);
  const pick = async (sql: string) => (await db.prepare(sql).all<Tourney>()).results;
  const upcoming = await pick("SELECT * FROM tournaments WHERE status = 'scheduled' ORDER BY starts_at LIMIT 4");
  const running = await pick("SELECT * FROM tournaments WHERE status = 'running' ORDER BY starts_at");
  const recent = await pick("SELECT * FROM tournaments WHERE status IN ('finished','cancelled') ORDER BY starts_at DESC LIMIT 8");
  const count = async (id: string) => (await db.prepare("SELECT COUNT(*) AS n FROM tournament_players WHERE tournament_id = ?").bind(id).first<{ n: number }>())?.n ?? 0;
  const brief = async (t: Tourney) => ({
    id: t.id, name: t.name, kind: t.kind, status: t.status, starts_at: t.starts_at, entrants: await count(t.id),
    current_round: t.current_round, rounds: t.rounds, winner: t.winner_id ? (await names(db, [t.winner_id]))[t.winner_id] : null,
    note: t.note, page: `/arena/tournaments/${t.id}`,
  });
  const all = async (ts: Tourney[]) => { const o = []; for (const t of ts) o.push(await brief(t)); return o; };
  return {
    schedule: "Weekly tournament every Saturday 17:00 UTC. Monthly finals on the last Sunday 17:00 UTC; weekly winners qualify.",
    next_weekly: (await all(upcoming.filter((t) => t.kind === "weekly")))[0] ?? null,
    next_finals: (await all(upcoming.filter((t) => t.kind === "finals")))[0] ?? null,
    running: await all(running),
    recent: await all(recent),
  };
}
