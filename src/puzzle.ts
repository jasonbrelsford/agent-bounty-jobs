import { Chess, type Move } from "chess.js";
import { type Agent, OpError, nowIso, eventStmt } from "./core.js";
import { names } from "./arena.js";
import { PUZZLE_DATA } from "./puzzledata.js";

/**
 * The daily chess puzzle drill. One puzzle a day (UTC), the same for everyone, taken from the
 * Lichess puzzle database (CC0): real positions from real games, rated and tagged by theme.
 * The first try is the one that counts, so a streak means solving it cold, every day. When it's
 * over the solver gets the full line, the idea behind it and the habit that finds it. Past
 * dailies and a separate practice set stay open as unscored practice.
 *
 * How a Lichess puzzle plays: its FEN is the position before the opponent's last move. That move
 * is played for you, then you find the solution; the opponent's forced replies come back in the
 * same result. Any move that gives checkmate also solves it, as on Lichess.
 */

export const PUZZLE_EPOCH = "2026-11-04"; // day 0 of the schedule
const DAY_MS = 86_400_000;

// The pool splits in two: the daily schedule, and a practice set that never becomes a daily.
export const DAILY_COUNT = Math.ceil(PUZZLE_DATA.length * 0.7);
export const PRACTICE_COUNT = PUZZLE_DATA.length - DAILY_COUNT;

type Puzzle = {
  id: string; index: number; practice: boolean; source_id: string; rating: number; themes: string[];
  fen: string; // the position you solve from, after the opponent's move
  last_move: string; // that move, in SAN
  line: string[]; // the solution in UCI: your moves with the forced replies between them
};

const uci = (m: Move) => m.from + m.to + (m.promotion ?? "");
const toMove = (u: string) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4] : undefined });

function build(row: (typeof PUZZLE_DATA)[number], id: string, index: number, practice: boolean): Puzzle {
  const [source_id, fen, moves, rating, themes] = row;
  const ms = moves.split(" ");
  const c = new Chess(fen);
  const last = c.move(toMove(ms[0]));
  return { id, index, practice, source_id, rating, themes: themes.split(" "), fen: c.fen(), last_move: last.san, line: ms.slice(1) };
}

const pid = (i: number) => `pz_${String(i).padStart(4, "0")}`;
const ppid = (i: number) => `pp_${String(i).padStart(4, "0")}`;
const puzzleAt = (i: number) => build(PUZZLE_DATA[((i % DAILY_COUNT) + DAILY_COUNT) % DAILY_COUNT], pid(i), i, false);
const practiceAt = (i: number) => build(PUZZLE_DATA[DAILY_COUNT + i], ppid(i), i, true);

export const dayOf = (d = new Date()) => d.toISOString().slice(0, 10);
export const dayIndex = (day: string) => Math.round((Date.parse(day + "T00:00:00Z") - Date.parse(PUZZLE_EPOCH + "T00:00:00Z")) / DAY_MS);
const dayFor = (index: number) => dayOf(new Date(Date.parse(PUZZLE_EPOCH + "T00:00:00Z") + index * DAY_MS));
const nextPuzzleAt = (now = new Date()) => new Date(Date.parse(dayOf(now) + "T00:00:00Z") + DAY_MS).toISOString();

function puzzleById(raw: unknown, now = new Date()): Puzzle {
  const today = dayIndex(dayOf(now));
  if (raw == null || raw === "" || raw === "today") return puzzleAt(today);
  const s = String(raw);
  const m = s.match(/^pz_(\d{4})$/);
  if (m && Number(m[1]) <= today) return puzzleAt(Number(m[1]));
  const q = s.match(/^pp_(\d{4})$/);
  if (q && Number(q[1]) < PRACTICE_COUNT) return practiceAt(Number(q[1]));
  throw new OpError(404, `no such puzzle (today's is ${pid(today)})`);
}

function parse(c: Chess, raw: unknown): Move {
  if (typeof raw !== "string" || !raw.trim()) throw new OpError(400, "move is required: SAN like Qh7# or UCI like d1h5 (e7e8q to promote)");
  const s = raw.trim();
  try { return c.move(s); } catch { /* try UCI */ }
  if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(s)) { try { return c.move(toMove(s.toLowerCase())); } catch { /* illegal */ } }
  throw new OpError(400, `illegal move "${s}" in this position. Legal: ${c.moves().join(" ")}`);
}

// ── the lesson ──────────────────────────────────────────────────────────────

const MATE_NAMES: Record<string, string> = {
  smotheredMate: "smothered mate", backRankMate: "back-rank mate", arabianMate: "Arabian mate", anastasiaMate: "Anastasia's mate",
  bodenMate: "Boden's mate", hookMate: "hook mate", doubleBishopMate: "double-bishop mate", dovetailMate: "dovetail mate",
  pillsburysMate: "Pillsbury's mate", operaMate: "Opera mate", morphysMate: "Morphy's mate", swallowstailMate: "swallow's-tail mate",
  blindSwineMate: "blind swine mate", killBoxMate: "kill-box mate", vukovicMate: "Vukovic mate", epauletteMate: "epaulette mate", cornerMate: "corner mate",
};

// In priority order: the first theme a puzzle has is the one its lesson is about.
const LESSONS: [string, string, string][] = [
  ["smotheredMate", "The king is walled in by its own pieces, and a knight gives the one check nothing can block.", "When the enemy king is boxed in by its own pieces, look at every knight check first."],
  ["backRankMate", "The king is stuck on its first rank behind its own pawns, and a rook or queen checks along it.", "When a king has no escape square off its back rank, ask whether you can land a heavy piece there, even at the cost of material."],
  ["doubleCheck", "A double check: two pieces give check at once, so the king must move and nothing can be blocked or captured.", "When a discovered check is possible, see whether the moving piece can give check too."],
  ["zugzwang", "Zugzwang: the opponent isn't threatened by a move so much as forced to make one, and every move makes things worse.", "In quiet endgames, count tempi. Sometimes the best move is the one that hands the obligation to move back to them."],
  ["fork", "A fork: one piece attacks two targets at once, and only one can be saved.", "Look for squares where one of your pieces would hit two loose or valuable pieces, often with check."],
  ["pin", "A pin: a piece can't move without exposing something more valuable behind it, so pile up on it.", "When two enemy pieces line up with their king or queen, look for a rook, bishop or queen move along that line."],
  ["skewer", "A skewer: attack the valuable piece first; when it moves, the one behind it falls.", "When an enemy king or queen lines up with another piece, check for a long-range attack through them."],
  ["discoveredCheck", "A discovered check: moving one piece unmasks a check from another, so the moving piece can go anywhere, even into danger.", "When your piece stands between your rook, bishop or queen and their king, ask what that piece could grab while the check is uncovered."],
  ["discoveredAttack", "A discovered attack: moving one piece uncovers an attack by another, and the moving piece makes a second threat.", "Look at what each of your long-range pieces would attack if the piece in front of it stepped aside."],
  ["deflection", "Deflection: force a defender away from the square or piece it guards.", "Find the piece doing an important defensive job, then look for a check or capture that drags it off that job."],
  ["attraction", "Attraction: a sacrifice lures a piece, often the king, onto a square where it can be hit.", "Ask which square you'd love their king or queen to stand on, then whether a sacrifice can force it there."],
  ["clearance", "Clearance: a piece gets out of the way, with tempo, to open a line or square for another.", "If one of your own pieces is blocking a strong move, look for a forcing way to move it first."],
  ["interference", "Interference: drop a piece between a defender and what it defends.", "When two enemy pieces protect each other along a line, look for a square on that line you can occupy."],
  ["intermezzo", "An in-between move: before the expected recapture, play a stronger forcing move first.", "Before you recapture on autopilot, check whether a check or bigger threat comes first."],
  ["capturingDefender", "Remove the defender: take the piece that holds the position together, and what it guarded falls.", "Ask what each enemy piece is defending. The one doing the most work is the one to remove."],
  ["hangingPiece", "Something is simply left unprotected. Taking it is the whole puzzle, if you check it's safe.", "After every opponent move, ask what is now undefended. Free material is the easiest win there is."],
  ["trappedPiece", "A piece with no safe squares: attack it and it's lost.", "Count the escape squares of their active pieces. A piece with none is a target."],
  ["promotion", "The pawn becomes a queen. Everything else in the line serves that.", "In endgames, count how many moves each passed pawn needs and what can stop it."],
  ["advancedPawn", "A far-advanced pawn is worth more than its material count. The line uses it.", "Treat a pawn on its sixth or seventh rank as a piece. Ask what it takes to promote it, or to stop it."],
  ["quietMove", "The key move gives no check and takes nothing, yet it leaves the opponent with no good answer.", "After you list every check and capture, ask which quiet move improves a piece or takes away their escape."],
  ["defensiveMove", "The best move here is a defensive one: prevent their idea before chasing your own.", "Before you attack, ask what the opponent is threatening right now."],
  ["sacrifice", "Material goes in to get something bigger back: mate, or more material, a few moves later.", "Don't stop calculating a forcing line just because it costs material. Look at what's left after the dust settles."],
  ["exposedKing", "The king has lost its shelter, and the line goes straight at it.", "When the enemy king is out in the open, look for checks that drive it into the rest of your army."],
  ["mateIn1", "One move ends the game. The mating piece covers the king and every square around it is covered or blocked.", "Before every move, list every check you have. Sometimes one of them is mate."],
  ["mateIn2", "A forced mate in two: the first move limits the replies, then mate follows against all of them.", "Start with checks and captures. Forcing moves shrink the tree enough to see to the end."],
  ["mateIn3", "A forced mate in three: each move is forcing, so the line can be calculated to the end.", "Start with checks. Calculate each forcing line until the king runs out of squares."],
  ["kingsideAttack", "An attack on the castled king: bring more attackers than there are defenders.", "Count the attackers and defenders near the king before you commit."],
];
const FALLBACK = ["Every move in the line is forcing or wins something concrete.", "Look at checks, captures and threats first, for both sides, before anything else."];

const NICE: Record<string, string> = Object.fromEntries(LESSONS.map(([t]) => [t, t.replace(/([A-Z])/g, " $1").toLowerCase()]));
const IGNORE = new Set(["short", "long", "veryLong", "oneMove", "opening", "middlegame", "endgame", "master", "masterVsMaster", "superGM", "crushing", "advantage", "equality", "mate"]);

export function lesson(p: Puzzle) {
  const c = new Chess(p.fen);
  const san = p.line.map((u) => c.move(toMove(u)).san);
  const theme = LESSONS.find(([t]) => p.themes.includes(t));
  const mate = p.themes.find((t) => MATE_NAMES[t]);
  const idea = (mate && !theme?.[0].includes("Mate") ? `This is a ${MATE_NAMES[mate]}. ` : "") + (theme ? theme[1] : FALLBACK[0]);
  return {
    main_line: san.join(" "), line_san: san, idea, habit: theme ? theme[2] : FALLBACK[1],
    themes: p.themes.filter((t) => !IGNORE.has(t)).map((t) => MATE_NAMES[t] ?? NICE[t] ?? t.replace(/([A-Z])/g, " $1").toLowerCase()),
    rating: p.rating,
    source: `Lichess puzzle ${p.source_id} (lichess.org/training/${p.source_id}), CC0`,
  };
}

// ── views ───────────────────────────────────────────────────────────────────

type AttemptRow = {
  agent_id: string; puzzle_id: string; day: string | null; status: string; fen: string; moves: string;
  started_at: string; finished_at: string | null;
};

function taskText(p: Puzzle): string {
  const side = new Chess(p.fen).turn() === "w" ? "White" : "Black";
  const n = p.themes.find((t) => /^mateIn\d$/.test(t));
  if (n) return `${side} to move: mate in ${["", "one", "two", "three", "four", "five"][Number(n.slice(6))] ?? n.slice(6)}`;
  if (p.themes.includes("equality")) return `${side} to move: find the move that saves the game`;
  return `${side} to move: find the winning line`;
}

function publicPuzzle(p: Puzzle, now: Date) {
  const today = dayIndex(dayOf(now));
  const daily = !p.practice && p.index === today;
  const c = new Chess(p.fen);
  return {
    id: p.id, day: p.practice ? null : dayFor(p.index), daily, task: taskText(p), rating: p.rating,
    fen: p.fen, side_to_move: c.turn() === "w" ? "white" : "black", opponent_last_move: p.last_move,
    your_moves_needed: Math.ceil(p.line.length / 2),
    next_puzzle_at: nextPuzzleAt(now), seconds_to_next: Math.max(0, Math.round((Date.parse(nextPuzzleAt(now)) - now.getTime()) / 1000)),
    rules: daily
      ? "One try: a wrong move ends the attempt. Solve it first try and today joins your streak. The opponent's forced replies come back after each of your moves."
      : "Practice: unscored. Today's puzzle is the one that counts for your streak.",
    page: "/arena/puzzle",
  };
}

async function attemptOf(db: D1Database, agentId: string, puzzleId: string) {
  return db.prepare("SELECT * FROM puzzle_attempts WHERE agent_id = ? AND puzzle_id = ?").bind(agentId, puzzleId).first<AttemptRow>();
}

function attemptView(p: Puzzle, a: AttemptRow | null) {
  const fen = a ? a.fen : p.fen;
  const done = !!a && a.status !== "active";
  const c = new Chess(fen);
  return {
    status: a ? a.status : "not_started", your_turn: !done, moves: a ? (JSON.parse(a.moves) as string[]) : [], fen,
    legal_moves: done ? undefined : c.moves(), legal_uci: done ? undefined : c.moves({ verbose: true }).map(uci),
    explanation: done ? lesson(p) : undefined,
  };
}

/** Days in a row solved first try, ending today (or yesterday, if today isn't done yet). */
export function streakOf(days: string[], today: string): { current: number; best: number } {
  const set = new Set(days);
  let best = 0, run = 0, prev: number | null = null;
  for (const d of [...set].sort()) {
    const i = dayIndex(d);
    run = prev !== null && i === prev + 1 ? run + 1 : 1; prev = i; best = Math.max(best, run);
  }
  let cur = 0, i = dayIndex(today);
  if (!set.has(today)) i -= 1;
  while (set.has(dayFor(i))) { cur++; i--; }
  return { current: cur, best };
}

async function solvedDays(db: D1Database, agentId: string): Promise<string[]> {
  const rs = await db.prepare("SELECT day FROM puzzle_attempts WHERE agent_id = ? AND day IS NOT NULL AND status = 'solved' ORDER BY day DESC LIMIT 400")
    .bind(agentId).all<{ day: string }>();
  return rs.results.map((r) => r.day);
}

async function todayBoard(db: D1Database, p: Puzzle) {
  const rs = await db.prepare("SELECT agent_id, status, finished_at FROM puzzle_attempts WHERE puzzle_id = ? AND day IS NOT NULL AND status != 'active' ORDER BY finished_at LIMIT 200")
    .bind(p.id).all<{ agent_id: string; status: string; finished_at: string }>();
  const nm = await names(db, rs.results.map((r) => r.agent_id));
  const solved = rs.results.filter((r) => r.status === "solved");
  return {
    tried: rs.results.length, solved: solved.length,
    solvers: solved.slice(0, 50).map((r) => ({ name: nm[r.agent_id] ?? r.agent_id, at: r.finished_at })),
  };
}

export async function puzzleView(db: D1Database, idRaw?: unknown, viewer?: Agent | null, now = new Date()) {
  const p = puzzleById(idRaw, now);
  const out: Record<string, unknown> = publicPuzzle(p, now);
  if (out.daily) out.today = await todayBoard(db, p);
  if (viewer) {
    out.you = attemptView(p, await attemptOf(db, viewer.id, p.id));
    out.your_streak = streakOf(await solvedDays(db, viewer.id), dayOf(now));
  }
  return out;
}

// ── playing ─────────────────────────────────────────────────────────────────

export async function puzzleMove(db: D1Database, agent: Agent, idRaw: unknown, input: Record<string, unknown>, now = new Date()) {
  const p = puzzleById(idRaw, now);
  const daily = !p.practice && p.index === dayIndex(dayOf(now));
  const a = await attemptOf(db, agent.id, p.id);
  if (a && a.status !== "active")
    throw new OpError(409, `you already ${a.status} ${p.id}. ${daily ? `The next daily puzzle opens at ${nextPuzzleAt(now)}.` : "Get another with GET /v1/arena/puzzles/practice."}`);
  const c = new Chess(a ? a.fen : p.fen);
  const moves: string[] = a ? JSON.parse(a.moves) : [];
  const step = moves.length; // index into the solution line
  const m = parse(c, input.move);
  moves.push(m.san);
  let status = "active";
  let reply: string | null = null;
  if (c.isCheckmate() || (uci(m) === p.line[step] && step + 1 >= p.line.length)) status = "solved";
  else if (uci(m) !== p.line[step]) status = "failed";
  else { reply = c.move(toMove(p.line[step + 1])).san; moves.push(reply); if (step + 2 >= p.line.length) status = "solved"; }

  const at = nowIso();
  const fen = c.fen();
  const done = status !== "active";
  const res = a
    // Compare-and-swap on the move list, so two racing requests can't both land.
    ? await db.prepare("UPDATE puzzle_attempts SET status = ?, fen = ?, moves = ?, finished_at = ? WHERE agent_id = ? AND puzzle_id = ? AND status = 'active' AND moves = ?")
        .bind(status, fen, JSON.stringify(moves), done ? at : null, agent.id, p.id, a.moves).run()
    : await db.prepare("INSERT INTO puzzle_attempts (agent_id, puzzle_id, day, status, fen, moves, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(agent.id, p.id, daily ? dayFor(p.index) : null, status, fen, JSON.stringify(moves), at, done ? at : null).run();
  if (!res.meta.changes) throw new OpError(409, "another move on this puzzle landed first; fetch it again");
  if (daily && status === "solved") await eventStmt(db, at, "puzzle_solved", null, agent.id, `${agent.name} solved the daily chess puzzle`).run();

  const view = attemptView(p, { agent_id: agent.id, puzzle_id: p.id, day: null, status, fen, moves: JSON.stringify(moves), started_at: at, finished_at: done ? at : null });
  return {
    puzzle: publicPuzzle(p, now), ...view, opponent_reply: reply ?? undefined,
    message: status === "solved" ? (daily ? "Solved. Today counts toward your streak." : "Solved (practice).")
      : status === "failed" ? `Not this time. The line was ${lesson(p).main_line}.`
      : `Right. The opponent answered ${reply}. Your move.`,
    your_streak: daily ? streakOf(await solvedDays(db, agent.id), dayOf(now)) : undefined,
  };
}

/** A puzzle you haven't tried yet for unscored practice: a past daily or one from the practice set. */
export async function puzzlePractice(db: D1Database, agent: Agent, now = new Date()) {
  const today = dayIndex(dayOf(now));
  const tried = new Set((await db.prepare("SELECT puzzle_id FROM puzzle_attempts WHERE agent_id = ?").bind(agent.id).all<{ puzzle_id: string }>()).results.map((r) => r.puzzle_id));
  const open: (() => Puzzle)[] = [];
  for (let i = Math.max(0, today - 365); i < today; i++) if (!tried.has(pid(i))) { const k = i; open.push(() => puzzleAt(k)); }
  for (let i = 0; i < PRACTICE_COUNT; i++) if (!tried.has(ppid(i))) { const k = i; open.push(() => practiceAt(k)); }
  if (!open.length) throw new OpError(404, "you've tried every practice puzzle. Come back for tomorrow's daily");
  const p = open[Math.floor(Math.random() * open.length)]();
  return { ...publicPuzzle(p, now), you: attemptView(p, null) };
}

export async function puzzleLeaderboard(db: D1Database, now = new Date()) {
  const rs = await db.prepare(
    "SELECT agent_id, COUNT(*) AS solved FROM puzzle_attempts WHERE day IS NOT NULL AND status = 'solved' GROUP BY agent_id ORDER BY solved DESC LIMIT 50",
  ).all<{ agent_id: string; solved: number }>();
  const nm = await names(db, rs.results.map((r) => r.agent_id));
  const today = dayOf(now);
  const rows = [];
  for (const r of rs.results) rows.push({ name: nm[r.agent_id] ?? r.agent_id, agent_id: r.agent_id, solved: r.solved, ...streakOf(await solvedDays(db, r.agent_id), today) });
  rows.sort((a, b) => b.current - a.current || b.best - a.best || b.solved - a.solved || a.name.localeCompare(b.name));
  return { ladder: rows.map((r, i) => ({ rank: i + 1, ...r })), note: "Ranked by current streak of daily puzzles solved first try, then best streak, then total solved." };
}

// Exported for tests.
export const _internal = { puzzleAt, practiceAt, PUZZLE_COUNT: PUZZLE_DATA.length };
