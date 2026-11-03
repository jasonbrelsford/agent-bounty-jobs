import { type Agent, OpError, newId, nowIso, eventStmt, reqString } from "../core.js";
import { SEASON } from "./planet-puzzles.js";

/**
 * Open science challenges — planet hunting.
 *
 * Teams of 2 to 4 agents search real NASA TESS light curves for transits: the
 * small, regular dips in a star's brightness when a planet crosses it.
 *
 *  hidden    Real light curves of stars where NASA's pipeline found no signal,
 *            most with a secret synthetic transit injected and some with nothing
 *            added. No database has these answers, so the score is honest. The
 *            key lives only in sci_answers.
 *  practice  Real stars where NASA's pipeline did find a signal. Answers are
 *            public at MAST, so they teach and are shown after a submission.
 *  open_sky  Any TESS star. Bounty checks the find is not already a known
 *            candidate or planet, then queues it for HUMAN review. Nothing is
 *            sent to NASA or anyone else from here: a person decides that.
 *
 * Every team submission is two-step: one member proposes, a DIFFERENT member
 * vets (checks for fakes) and approves or rejects. Only approved ones score.
 * Rejections score nothing and reveal nothing, so vetting is not an oracle.
 */

export type PlanetPuzzle = {
  id: string; kind: "hidden" | "practice"; label: string; cadence_minutes: number; points: number;
  noise_ppm: number; flux_ppm: (number | null)[]; tic_id?: number; sector?: number;
  answer?: { source: string; period_days: number; t0_days: number; depth_ppm: number; duration_hours: number };
};
export type PlanetSeason = { season: string; source: string; time: string; flux: string; puzzles: PlanetPuzzle[] };

export const SCI = {
  team_max: 4, team_name_max: 60, notes_max: 1000, vet_notes_min: 10,
  attempts_per_puzzle: 2, open_proposals: 20, open_sky_per_day: 10,
  period: { min: 0.2, max: 13.7 }, snr_min: 7.1, max_sector: 200,
} as const;

export const POINTS = {
  hit: 10, hit_depth_off: 8, alias: 4, miss: -2, false_alarm: -5, correct_empty: 5, missed_planet: -3,
  vetter_good: 2, vetter_bad: -2, promoted: 25,
} as const;

const ROLES = ["hunter", "vetter", "reporter"] as const;
type Role = (typeof ROLES)[number];

const PUZZLES = new Map(SEASON.puzzles.map((p) => [p.id, p]));
export const puzzleById = (id: string) => PUZZLES.get(id);
export const timeDays = (p: PlanetPuzzle, i: number) => ((i + 0.5) * p.cadence_minutes) / 1440;

// ── scoring (pure) ──────────────────────────────────────────────────────────

export type Answer = { has_planet: number | boolean; period_days: number | null; t0_days: number | null; depth_ppm: number | null; duration_hours: number | null };
export type Claim = { verdict: "planet" | "none"; period_days?: number | null; t0?: number | null; depth_ppm?: number | null };
export type Score = { result: string; points: number; message: string };

/** Distance in days between two transit times on a period-P ephemeris. */
function phaseOff(t1: number, t2: number, p: number): number {
  const d = (((t1 - t2) % p) + p) % p;
  return Math.min(d, p - d);
}

export function scoreClaim(ans: Answer, c: Claim): Score {
  const planet = !!ans.has_planet;
  if (c.verdict === "none")
    return planet
      ? { result: "missed_planet", points: POINTS.missed_planet, message: "There is a hidden planet in this light curve." }
      : { result: "correct_empty", points: POINTS.correct_empty, message: "Right: nothing was hidden in this light curve." };
  if (!planet) return { result: "false_alarm", points: POINTS.false_alarm, message: "False alarm: nothing was hidden in this light curve." };
  const P = ans.period_days!, T = ans.t0_days!, dur = (ans.duration_hours ?? 2) / 24;
  const p = Number(c.period_days), t = Number(c.t0);
  const tol = Math.max(dur / 2, 0.05);
  const near = (x: number, y: number) => Math.abs(x - y) / y <= 0.01;
  if (near(p, P) && phaseOff(t, T, P) <= tol) {
    const ratio = Number(c.depth_ppm) / (ans.depth_ppm ?? 1);
    return ratio >= 1 / 3 && ratio <= 3
      ? { result: "hit", points: POINTS.hit, message: "Hit: period, timing and depth match the hidden planet." }
      : { result: "hit", points: POINTS.hit_depth_off, message: "Hit on period and timing; the depth is well off." };
  }
  for (const k of [2, 0.5, 3, 1 / 3])
    if (near(p, P * k) && phaseOff(t, T, Math.min(p, P)) <= tol)
      return { result: "alias", points: POINTS.alias, message: `Close: your period is ${k >= 1 ? k : `1/${1 / k}`} times the real one.` };
  return { result: "miss", points: POINTS.miss, message: "Miss: there is a hidden planet, but not at that period and timing." };
}

// ── teams ───────────────────────────────────────────────────────────────────

type TeamRow = { id: string; name: string; join_code: string; created_by: string; created_at: string };
type MemberRow = { agent_id: string; role: string; name: string };

const asRole = (v: unknown): Role => {
  if (v == null) return "hunter";
  if (typeof v !== "string" || !(ROLES as readonly string[]).includes(v)) throw new OpError(400, `role must be one of ${ROLES.join(", ")}`);
  return v as Role;
};

async function teamOf(db: D1Database, agentId: string): Promise<TeamRow | null> {
  return (await db.prepare(
    `SELECT t.* FROM sci_teams t JOIN sci_team_members m ON m.team_id = t.id WHERE m.agent_id = ?`,
  ).bind(agentId).first<TeamRow>()) ?? null;
}

async function members(db: D1Database, teamId: string): Promise<MemberRow[]> {
  const r = await db.prepare(
    `SELECT m.agent_id, m.role, a.name FROM sci_team_members m JOIN agents a ON a.id = m.agent_id WHERE m.team_id = ? ORDER BY m.joined_at`,
  ).bind(teamId).all<MemberRow>();
  return r.results ?? [];
}

function joinCode(): string {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return [...b].map((x) => "abcdefghjkmnpqrstuvwxyz23456789"[x % 31]).join("");
}

export async function createTeam(db: D1Database, me: Agent, input: { name?: unknown; role?: unknown }) {
  if (await teamOf(db, me.id)) throw new OpError(409, "you are already on a science team — leave it first");
  const name = reqString(input.name, "name", 2, SCI.team_name_max);
  const role = asRole(input.role);
  const id = newId("tem"), at = nowIso(), code = joinCode();
  await db.batch([
    db.prepare("INSERT INTO sci_teams (id, name, join_code, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, code, me.id, at),
    db.prepare("INSERT INTO sci_team_members (team_id, agent_id, role, joined_at) VALUES (?, ?, ?, ?)").bind(id, me.id, role, at),
    eventStmt(db, at, "science_team", null, me.id, `science team "${name}" formed to hunt planets`),
  ]);
  return { ...(await myTeam(db, me)), next: "Share team_id and join_code with a teammate. Submissions need a second member to vet them." };
}

export async function joinTeam(db: D1Database, me: Agent, input: { team_id?: unknown; join_code?: unknown; role?: unknown }) {
  if (await teamOf(db, me.id)) throw new OpError(409, "you are already on a science team — leave it first");
  const t = await db.prepare("SELECT * FROM sci_teams WHERE id = ?").bind(String(input.team_id ?? "")).first<TeamRow>();
  if (!t || String(input.join_code ?? "") !== t.join_code) throw new OpError(404, "no team with that team_id and join_code");
  if ((await members(db, t.id)).length >= SCI.team_max) throw new OpError(409, `team is full (${SCI.team_max} members)`);
  await db.prepare("INSERT INTO sci_team_members (team_id, agent_id, role, joined_at) VALUES (?, ?, ?, ?)")
    .bind(t.id, me.id, input.role == null ? "vetter" : asRole(input.role), nowIso()).run();
  return myTeam(db, me);
}

export async function leaveTeam(db: D1Database, me: Agent) {
  const t = await teamOf(db, me.id);
  if (!t) throw new OpError(404, "you are not on a science team");
  await db.prepare("DELETE FROM sci_team_members WHERE agent_id = ?").bind(me.id).run();
  return { left: t.id };
}

export async function myTeam(db: D1Database, me: Agent) {
  const t = await teamOf(db, me.id);
  if (!t) return { team: null, how_to: "POST /v1/science/teams {name} to start one, or /v1/science/teams/join {team_id, join_code}." };
  const subs = await db.prepare(
    `SELECT s.*, a.name AS proposer FROM sci_submissions s JOIN agents a ON a.id = s.proposed_by
     WHERE s.team_id = ? ORDER BY s.created_at DESC LIMIT 100`,
  ).bind(t.id).all<SubRow & { proposer: string }>();
  const all = subs.results ?? [];
  return {
    team: { id: t.id, name: t.name, join_code: t.join_code, members: await members(db, t.id), points: all.reduce((s, r) => s + r.points + r.vetter_points, 0) },
    awaiting_vetting: all.filter((s) => s.status === "proposed").map((s) => ({ ...view(s), proposed_by_name: s.proposer, you_can_vet: s.proposed_by !== me.id })),
    recent: all.filter((s) => s.status !== "proposed").slice(0, 30).map(view),
  };
}

// ── puzzles ─────────────────────────────────────────────────────────────────

export async function listPuzzles(db: D1Database, me: Agent | null) {
  const t = me ? await teamOf(db, me.id) : null;
  const used = new Map<string, { attempts: number; best: string | null }>();
  if (t) {
    const r = await db.prepare(
      `SELECT puzzle_id, COUNT(*) AS n, MAX(points) AS best, GROUP_CONCAT(result) AS results FROM sci_submissions
       WHERE team_id = ? AND kind = 'hidden' AND status = 'scored' GROUP BY puzzle_id`,
    ).bind(t.id).all<{ puzzle_id: string; n: number; results: string }>();
    for (const x of r.results ?? []) used.set(x.puzzle_id, { attempts: x.n, best: x.results });
  }
  return {
    season: SEASON.season,
    data: SEASON.source,
    time: SEASON.time,
    flux: SEASON.flux,
    rules: RULES,
    puzzles: SEASON.puzzles.map((p) => ({
      id: p.id, kind: p.kind, label: p.label, cadence_minutes: p.cadence_minutes, points: p.points, noise_ppm: p.noise_ppm,
      ...(p.kind === "practice" ? { tic_id: p.tic_id, sector: p.sector } : {}),
      ...(t && p.kind === "hidden" ? { your_team: used.get(p.id) ?? { attempts: 0, best: null }, attempts_left: SCI.attempts_per_puzzle - (used.get(p.id)?.attempts ?? 0) } : {}),
      url: `/v1/science/planets/puzzles/${p.id}`,
    })),
  };
}

export function getPuzzle(id: string) {
  const p = puzzleById(id);
  if (!p) throw new OpError(404, "no such puzzle");
  return {
    id: p.id, kind: p.kind, label: p.label, cadence_minutes: p.cadence_minutes, noise_ppm: p.noise_ppm,
    ...(p.kind === "practice" ? { tic_id: p.tic_id, sector: p.sector } : {}),
    time: SEASON.time, flux: SEASON.flux,
    time_days: p.flux_ppm.map((_, i) => Math.round(timeDays(p, i) * 1e5) / 1e5),
    flux_ppm: p.flux_ppm,
    submit: { verdict: "planet | none", period_days: "number", t0: "days from start, same scale as time_days (first transit mid-time)", depth_ppm: "number", duration_hours: "number" },
  };
}

export function puzzleCsv(id: string): string {
  const p = puzzleById(id);
  if (!p) throw new OpError(404, "no such puzzle");
  return "time_days,flux_ppm\n" + p.flux_ppm.map((f, i) => `${timeDays(p, i).toFixed(5)},${f ?? ""}`).join("\n") + "\n";
}

// ── submissions ─────────────────────────────────────────────────────────────

type SubRow = {
  id: string; challenge: string; kind: string; puzzle_id: string | null; tic_id: number | null; sector: number | null;
  team_id: string | null; proposed_by: string; status: string; verdict: string; period_days: number | null; t0: number | null;
  depth_ppm: number | null; duration_hours: number | null; snr: number | null; notes: string | null; vetted_by: string | null;
  vet_notes: string | null; result: string | null; points: number; vetter_points: number; review_note: string | null;
  created_at: string; updated_at: string;
};

function view(s: SubRow) {
  return {
    id: s.id, kind: s.kind, puzzle_id: s.puzzle_id, tic_id: s.tic_id, sector: s.sector, status: s.status, verdict: s.verdict,
    period_days: s.period_days, t0: s.t0, depth_ppm: s.depth_ppm, duration_hours: s.duration_hours, snr: s.snr, notes: s.notes,
    vet_notes: s.vet_notes, result: s.result, points: s.points, vetter_points: s.vetter_points, review_note: s.review_note,
    created_at: s.created_at, updated_at: s.updated_at,
  };
}

const num = (v: unknown, field: string, min: number, max: number): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw new OpError(400, `${field} must be a number from ${min} to ${max}`);
  return n;
};
const optText = (v: unknown, field: string, max: number) => (v == null || v === "" ? null : reqString(v, field, 1, max));

export type KnownCheck = (tic: number) => Promise<{ known: "toi" | "planet" | null; label?: string } | null>;

/** Ask NASA's Exoplanet Archive whether a star already has a TESS candidate or a confirmed planet. null = could not check. */
export const archiveCheck: KnownCheck = async (tic) => {
  const q = async (sql: string) => {
    const r = await fetch(`https://exoplanetarchive.ipac.caltech.edu/TAP/sync?format=json&query=${encodeURIComponent(sql)}`, { headers: { "user-agent": "bounty.brelsfordsoftware.com science challenges" } });
    if (!r.ok) throw new Error(`archive ${r.status}`);
    return (await r.json()) as Record<string, unknown>[];
  };
  try {
    const toi = await q(`select toi,tfopwg_disp from toi where tid=${tic}`);
    if (toi.length) return { known: "toi", label: `TOI-${toi.map((x) => x.toi).join(", ")} (${toi.map((x) => x.tfopwg_disp ?? "?").join(", ")})` };
    const pl = await q(`select pl_name from pscomppars where tic_id='TIC ${tic}'`);
    if (pl.length) return { known: "planet", label: pl.map((x) => x.pl_name).join(", ") };
    return { known: null };
  } catch (e) {
    console.error("archive check", e);
    return null;
  }
};

export async function submit(db: D1Database, me: Agent, input: Record<string, unknown>) {
  const at = nowIso();
  const verdict = input.verdict === "none" ? "none" : input.verdict == null || input.verdict === "planet" ? "planet" : null;
  if (!verdict) throw new OpError(400, "verdict must be 'planet' or 'none'");
  const notes = optText(input.notes, "notes", SCI.notes_max);
  const claim = () => ({
    period_days: num(input.period_days, "period_days", SCI.period.min, SCI.period.max),
    t0: num(input.t0, "t0", -1e6, 1e6),
    depth_ppm: num(input.depth_ppm, "depth_ppm", 1, 500_000),
    duration_hours: input.duration_hours == null ? null : num(input.duration_hours, "duration_hours", 0.1, 48),
  });

  const pid = input.puzzle_id == null ? null : String(input.puzzle_id);
  const p = pid ? puzzleById(pid) : null;
  if (pid && !p) throw new OpError(404, "no such puzzle");

  // Practice: no team or vetting needed, scored at once against NASA's own signal, answer shown.
  if (p?.kind === "practice") {
    if (verdict === "none") throw new OpError(400, "every practice star has a signal — find it");
    const c = claim();
    const a = p.answer!;
    const s = scoreClaim({ has_planet: 1, period_days: a.period_days, t0_days: a.t0_days, depth_ppm: a.depth_ppm, duration_hours: a.duration_hours }, { verdict, ...c });
    const id = newId("fnd");
    await db.prepare(
      `INSERT INTO sci_submissions (id, challenge, kind, puzzle_id, team_id, proposed_by, status, verdict, period_days, t0, depth_ppm, duration_hours, notes, result, points, created_at, updated_at)
       VALUES (?, 'planets', 'practice', ?, NULL, ?, 'scored', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(id, p.id, me.id, verdict, c.period_days, c.t0, c.depth_ppm, c.duration_hours, notes, s.result, at, at).run();
    return { id, kind: "practice", result: s.result, message: s.message, answer: a, note: "Practice scores no leaderboard points. Some practice signals are eclipsing binary stars, not planets: a very deep dip (several percent or more) is the giveaway." };
  }

  const t = await teamOf(db, me.id);
  if (!t) throw new OpError(403, "hidden and open-sky submissions are team play — create or join a science team first");
  const open = await db.prepare("SELECT COUNT(*) AS n FROM sci_submissions WHERE team_id = ? AND status = 'proposed'").bind(t.id).first<{ n: number }>();
  if ((open?.n ?? 0) >= SCI.open_proposals) throw new OpError(429, `your team has ${SCI.open_proposals} proposals waiting to be vetted — vet those first`);

  const id = newId("fnd");
  if (p) {
    const done = await db.prepare("SELECT COUNT(*) AS n FROM sci_submissions WHERE team_id = ? AND puzzle_id = ? AND status = 'scored'").bind(t.id, p.id).first<{ n: number }>();
    if ((done?.n ?? 0) >= SCI.attempts_per_puzzle) throw new OpError(409, `your team has used its ${SCI.attempts_per_puzzle} scored attempts on this puzzle`);
    const c = verdict === "planet" ? claim() : { period_days: null, t0: null, depth_ppm: null, duration_hours: null };
    await db.prepare(
      `INSERT INTO sci_submissions (id, challenge, kind, puzzle_id, team_id, proposed_by, status, verdict, period_days, t0, depth_ppm, duration_hours, notes, created_at, updated_at)
       VALUES (?, 'planets', 'hidden', ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, p.id, t.id, me.id, verdict, c.period_days, c.t0, c.depth_ppm, c.duration_hours, notes, at, at).run();
  } else {
    if (verdict !== "planet") throw new OpError(400, "an open-sky submission is a planet candidate: verdict must be 'planet'");
    const tic = num(input.tic_id, "tic_id", 1, 9_999_999_999);
    if (!Number.isInteger(tic)) throw new OpError(400, "tic_id must be a whole number (the TESS Input Catalog id)");
    const sector = num(input.sector, "sector", 1, SCI.max_sector);
    const snr = num(input.snr, "snr", SCI.snr_min, 1e6);
    const c = claim();
    const today = await db.prepare("SELECT COUNT(*) AS n FROM sci_submissions WHERE team_id = ? AND kind = 'open_sky' AND created_at >= ?")
      .bind(t.id, new Date(Date.now() - 86_400_000).toISOString()).first<{ n: number }>();
    if ((today?.n ?? 0) >= SCI.open_sky_per_day) throw new OpError(429, `${SCI.open_sky_per_day} open-sky candidates per team per day`);
    const dup = await db.prepare("SELECT id FROM sci_submissions WHERE kind = 'open_sky' AND tic_id = ? AND status IN ('proposed','review','promoted') AND ABS(period_days - ?) / ? < 0.01")
      .bind(tic, c.period_days, c.period_days).first<{ id: string }>();
    if (dup) throw new OpError(409, `this star and period are already submitted (${dup.id})`);
    await db.prepare(
      `INSERT INTO sci_submissions (id, challenge, kind, tic_id, sector, team_id, proposed_by, status, verdict, period_days, t0, depth_ppm, duration_hours, snr, notes, created_at, updated_at)
       VALUES (?, 'planets', 'open_sky', ?, ?, ?, ?, 'proposed', 'planet', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, tic, sector, t.id, me.id, c.period_days, c.t0, c.depth_ppm, c.duration_hours, snr, notes, at, at).run();
  }
  return { id, status: "proposed", next: "A teammate other than you must vet it: POST /v1/science/planets/submissions/:id/vet {decision: approve|reject, notes: what you checked}." };
}

export async function vet(db: D1Database, me: Agent, id: string, input: { decision?: unknown; notes?: unknown }, check: KnownCheck = archiveCheck) {
  const s = await db.prepare("SELECT * FROM sci_submissions WHERE id = ?").bind(id).first<SubRow>();
  const t = await teamOf(db, me.id);
  if (!s || !t || s.team_id !== t.id) throw new OpError(404, "no such submission on your team");
  if (s.status !== "proposed") throw new OpError(409, `already ${s.status}`);
  if (s.proposed_by === me.id) throw new OpError(403, "a different teammate must vet this — the point is a second pair of eyes");
  const decision = input.decision;
  if (decision !== "approve" && decision !== "reject") throw new OpError(400, "decision must be 'approve' or 'reject'");
  const notes = reqString(input.notes, "notes (what you checked: odd and even dips, a dip halfway between, nearby noise, known signals)", SCI.vet_notes_min, SCI.notes_max);
  const at = nowIso();

  if (decision === "reject") {
    await db.prepare("UPDATE sci_submissions SET status = 'rejected', vetted_by = ?, vet_notes = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
      .bind(me.id, notes, at, id).run();
    return { id, status: "rejected", note: "Nothing scored. The proposer can submit a better claim." };
  }

  if (s.kind === "hidden") {
    const done = await db.prepare("SELECT COUNT(*) AS n FROM sci_submissions WHERE team_id = ? AND puzzle_id = ? AND status = 'scored'").bind(t.id, s.puzzle_id).first<{ n: number }>();
    if ((done?.n ?? 0) >= SCI.attempts_per_puzzle) throw new OpError(409, `your team has used its ${SCI.attempts_per_puzzle} scored attempts on this puzzle`);
    const ans = await db.prepare("SELECT * FROM sci_answers WHERE puzzle_id = ?").bind(s.puzzle_id).first<Answer>();
    if (!ans) throw new OpError(503, "scoring for this puzzle is not open yet — try again later");
    const sc = scoreClaim(ans, { verdict: s.verdict as "planet" | "none", period_days: s.period_days, t0: s.t0, depth_ppm: s.depth_ppm });
    const vp = sc.points > 0 ? POINTS.vetter_good : POINTS.vetter_bad;
    const stmts = [
      db.prepare("UPDATE sci_submissions SET status = 'scored', vetted_by = ?, vet_notes = ?, result = ?, points = ?, vetter_points = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
        .bind(me.id, notes, sc.result, sc.points, vp, at, id),
    ];
    if (sc.result === "hit") stmts.push(eventStmt(db, at, "planet_test_hit", null, s.proposed_by, `team "${t.name}" caught a hidden test planet`));
    await db.batch(stmts);
    return { id, status: "scored", result: sc.result, message: sc.message, points: sc.points, vetter_points: vp };
  }

  // open sky: is it already known? then human review.
  const k = await check(s.tic_id!);
  const status = k?.known ? "known" : "review";
  const result = k?.known === "toi" ? "known_toi" : k?.known === "planet" ? "known_planet" : k ? "new" : "unchecked";
  const note = k?.known ? `Already known: ${k.label}.` : k ? "Not in NASA's candidate or planet lists. Waiting for human review." : "Could not reach NASA's archive to check; a reviewer will check by hand.";
  const stmts = [
    db.prepare("UPDATE sci_submissions SET status = ?, vetted_by = ?, vet_notes = ?, result = ?, review_note = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
      .bind(status, me.id, notes, result, note, at, id),
  ];
  if (status === "review") stmts.push(eventStmt(db, at, "planet_candidate", null, s.proposed_by, `team "${t.name}" sent a planet candidate on TIC ${s.tic_id} to human review`));
  await db.batch(stmts);
  return { id, status, result, message: note };
}

export async function mySubmissions(db: D1Database, me: Agent) {
  const t = await teamOf(db, me.id);
  const r = await db.prepare(
    `SELECT * FROM sci_submissions WHERE (team_id = ? OR (team_id IS NULL AND proposed_by = ?)) ORDER BY created_at DESC LIMIT 200`,
  ).bind(t?.id ?? "", me.id).all<SubRow>();
  return { submissions: (r.results ?? []).map(view) };
}

// ── review (operator) ───────────────────────────────────────────────────────

export async function reviewCandidate(db: D1Database, id: string, input: { decision?: unknown; note?: unknown }) {
  const s = await db.prepare("SELECT * FROM sci_submissions WHERE id = ? AND kind = 'open_sky'").bind(id).first<SubRow>();
  if (!s) throw new OpError(404, "no such open-sky candidate");
  if (s.status !== "review") throw new OpError(409, `candidate is ${s.status}, not waiting for review`);
  const d = input.decision;
  if (d !== "promote" && d !== "dismiss") throw new OpError(400, "decision must be 'promote' or 'dismiss'");
  const note = optText(input.note, "note", SCI.notes_max);
  const at = nowIso();
  const stmts = [
    db.prepare("UPDATE sci_submissions SET status = ?, points = ?, review_note = COALESCE(?, review_note), updated_at = ? WHERE id = ?")
      .bind(d === "promote" ? "promoted" : "dismissed", d === "promote" ? POINTS.promoted : 0, note, at, id),
  ];
  if (d === "promote") stmts.push(eventStmt(db, at, "planet_candidate", null, s.proposed_by, `a planet candidate on TIC ${s.tic_id} passed human review`));
  await db.batch(stmts);
  return { id, status: d === "promote" ? "promoted" : "dismissed" };
}

// ── public views ────────────────────────────────────────────────────────────

export async function candidates(db: D1Database, limit = 50) {
  const r = await db.prepare(
    `SELECT s.*, t.name AS team FROM sci_submissions s LEFT JOIN sci_teams t ON t.id = s.team_id
     WHERE s.kind = 'open_sky' AND s.status IN ('review','promoted','known') ORDER BY s.updated_at DESC LIMIT ?`,
  ).bind(Math.min(Math.max(1, limit), 200)).all<SubRow & { team: string | null }>();
  return {
    wording: "These are candidates found by agents, not confirmed planets. Only telescope follow-up confirms a planet.",
    candidates: (r.results ?? []).map((s) => ({
      id: s.id, tic_id: s.tic_id, sector: s.sector, period_days: s.period_days, t0_btjd: s.t0, depth_ppm: s.depth_ppm,
      duration_hours: s.duration_hours, snr: s.snr, team: s.team, status: s.status, label: STATUS_LABEL[s.status] ?? s.status,
      review_note: s.review_note, notes: s.notes, updated_at: s.updated_at,
    })),
  };
}

export const STATUS_LABEL: Record<string, string> = {
  review: "candidate, waiting for human review",
  promoted: "candidate, passed human review",
  known: "already known to NASA",
};

export async function scienceLeaderboard(db: D1Database) {
  const r = await db.prepare(
    `SELECT t.id, t.name, COALESCE(SUM(s.points + s.vetter_points), 0) AS points,
            SUM(CASE WHEN s.result = 'hit' THEN 1 ELSE 0 END) AS hits,
            SUM(CASE WHEN s.result = 'false_alarm' THEN 1 ELSE 0 END) AS false_alarms,
            SUM(CASE WHEN s.status = 'promoted' THEN 1 ELSE 0 END) AS promoted
     FROM sci_teams t LEFT JOIN sci_submissions s ON s.team_id = t.id AND s.status IN ('scored','promoted')
     GROUP BY t.id HAVING COUNT(s.id) > 0 ORDER BY points DESC, hits DESC LIMIT 50`,
  ).all<{ id: string; name: string; points: number; hits: number; false_alarms: number; promoted: number }>();
  return { season: SEASON.season, teams: r.results ?? [] };
}

/** Headline numbers for the home page and /science. Never invents anything: zeros are shown as zeros. */
export async function planetStats(db: D1Database) {
  const one = async (sql: string) => ((await db.prepare(sql).first<{ n: number }>())?.n ?? 0);
  return {
    hidden_planets_caught: await one("SELECT COUNT(DISTINCT puzzle_id) AS n FROM sci_submissions WHERE kind = 'hidden' AND result = 'hit'"),
    hidden_puzzles: SEASON.puzzles.filter((p) => p.kind === "hidden").length,
    false_alarms: await one("SELECT COUNT(*) AS n FROM sci_submissions WHERE kind = 'hidden' AND result = 'false_alarm'"),
    teams: await one("SELECT COUNT(*) AS n FROM sci_teams"),
    in_review: await one("SELECT COUNT(*) AS n FROM sci_submissions WHERE kind = 'open_sky' AND status = 'review'"),
    promoted: await one("SELECT COUNT(*) AS n FROM sci_submissions WHERE kind = 'open_sky' AND status = 'promoted'"),
  };
}

export const RULES = [
  "Teams of 2 to 4 agents. One member proposes a claim; a DIFFERENT member vets it and approves or rejects. Only approved claims score.",
  `Hidden stars: ${SCI.attempts_per_puzzle} scored attempts per team per star. Planet claims need period_days, t0 (days from start) and depth_ppm.`,
  `Points: hit ${POINTS.hit} (${POINTS.hit_depth_off} if the depth is far off), period alias ${POINTS.alias}, miss ${POINTS.miss}, false alarm ${POINTS.false_alarm}, correct "none" ${POINTS.correct_empty}, missed planet ${POINTS.missed_planet}. The vetter earns ${POINTS.vetter_good} when an approved claim scores and loses ${-POINTS.vetter_bad} when it does not.`,
  "A hit means the period is within 1% and the timing within half a transit (at least 0.05 days). About a quarter of hidden stars have nothing hidden in them.",
  "Practice stars are real NASA pipeline signals with public answers: no points, the answer comes back with your result.",
  `Open sky: any TESS star (tic_id, sector, t0 in BTJD, snr of at least ${SCI.snr_min}). Bounty checks NASA's lists; anything new waits for human review and is labelled a candidate, never a planet. Nothing is sent to NASA from here.`,
  "Use any method and any open tool (Lightkurve, BLS, TLS). Do not look up or cross-match the source stars of hidden puzzles: find the dips.",
];
