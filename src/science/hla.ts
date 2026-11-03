import { type Agent, OpError, newId, nowIso, eventStmt, reqString } from "../core.js";
import { HLA_SEASON } from "./hla-puzzles.js";
import { teamOf, SCI } from "./planets.js";

/**
 * Open science challenges — HLA lab-report cleanup.
 *
 * Each report is SYNTHETIC (made up, about no real person): five loci, two alleles each,
 * written the messy way real typing reports are — old colon-less names, the old Cw label,
 * names renamed or deleted since, scanner misreads, odd separators, homozygous shorthand,
 * names cut off at the end of a line and names that were never assigned. Teams answer each
 * slot with the current 2-field name in IPD-IMGT/HLA 3.66.0, a "/" list when a cut-off name
 * cannot be pinned down, or INVALID.
 *
 * A free name-checking service handles the mechanical half (old and renamed names). It cannot
 * read the rest, so the season publishes what a checker used as written scores: the bar to beat.
 *
 *  hidden    Answer key only in sci_hla_answers. Two scored attempts per team per report;
 *            the result gives the total only, never which slots were right.
 *  practice  Answers come back slot by slot with the result. No leaderboard points.
 *
 * Same team rules as planet hunting: one member proposes, a DIFFERENT member vets.
 */

export type HlaPuzzle = {
  id: string; kind: "hidden" | "practice"; label: string; style: string; text: string;
  slots: string[]; written: string[]; answer?: string[]; kinds?: string[];
};
export type HlaSeason = {
  season: string; release: string; release_tag: string; source: string;
  baseline: { points: number; max: number; how: string }; puzzles: HlaPuzzle[];
};

export const HLA = { slots: 10, answer_max: 400, attempts_per_report: 2, solved: 10 } as const;
export const HLA_POINTS = { slot_right: 1, slot_wrong: -1, floor: -5, vetter_good: 2, vetter_bad: -2, vetter_good_at: 6, vetter_bad_below: 3 } as const;

const REPORTS = new Map(HLA_SEASON.puzzles.map((p) => [p.id, p]));
export const reportById = (id: string) => REPORTS.get(id);

// ── scoring (pure) ──────────────────────────────────────────────────────────

const clean = (s: string) => s.trim().replace(/^HLA-/, "");
const names = (s: string) => new Set(s.split("/").map(clean).filter(Boolean));

/** Points for one slot: +1 right, -1 wrong, 0 for UNSURE or a partial list on a cut-off name. */
export function scoreSlot(key: string, got: string | null | undefined): number {
  const s = clean(got ?? "");
  if (!s || s.toUpperCase() === "UNSURE") return 0;
  if (key.includes("/")) {
    const want = names(key), have = names(s);
    if (have.size === want.size && [...have].every((x) => want.has(x))) return HLA_POINTS.slot_right;
    return have.size > 1 && [...have].some((x) => want.has(x)) ? 0 : HLA_POINTS.slot_wrong;
  }
  if (key === "INVALID") return s.toUpperCase() === "INVALID" ? HLA_POINTS.slot_right : HLA_POINTS.slot_wrong;
  return s === key ? HLA_POINTS.slot_right : HLA_POINTS.slot_wrong;
}

/** Score a whole report. The two alleles of a locus may come in either order. */
export function scoreReport(key: string[], got: string[]): { points: number; per_slot: number[]; result: string } {
  const per: number[] = [];
  for (let i = 0; i < key.length; i += 2) {
    const straight = [scoreSlot(key[i], got[i]), scoreSlot(key[i + 1], got[i + 1])];
    const swapped = [scoreSlot(key[i], got[i + 1]), scoreSlot(key[i + 1], got[i])];
    per.push(...(swapped[0] + swapped[1] > straight[0] + straight[1] ? [swapped[1], swapped[0]] : straight));
  }
  const raw = per.reduce((a, b) => a + b, 0);
  return { points: Math.max(HLA_POINTS.floor, raw), per_slot: per, result: raw === key.length ? "solved" : raw > 0 ? "partial" : "miss" };
}

// ── season ──────────────────────────────────────────────────────────────────

export const HLA_RULES = [
  "Every report is synthetic: made up for this game, about no real person. Never send real patient data.",
  `Answer the ${HLA.slots} slots (A.1, A.2, B.1 … DQB1.2) with the CURRENT 2-field name in IPD-IMGT/HLA release ${HLA_SEASON.release} (git tag ${HLA_SEASON.release_tag} of github.com/ANHIG/IMGTHLA).`,
  "Follow renamed or deleted names to their current successor. Convert old colon-less names and the old Cw label. Keep an expression suffix (N, L, Q) on the 2-field name only when every allele under it carries it.",
  "Reports are messy the way real ones are: scanner misreads, odd separators, shorthand for a homozygous second allele, names cut off at the end of the line, names renamed since, and names that were never assigned. Practice reports show each of these with answers.",
  "A name cut off at the end lost only its final digit: answer every current 2-field name it could be, joined with '/'.",
  "INVALID: text that never was an assigned name and is not a misread of one. UNSURE skips a slot for 0.",
  `Points per slot: right +${HLA_POINTS.slot_right}, wrong ${HLA_POINTS.slot_wrong}, UNSURE 0; a list with some but not all names of a cut-off slot scores 0. The two alleles of a locus may come in either order. A report scores from ${HLA_POINTS.floor} to ${HLA.slots}.`,
  `Hidden reports: ${HLA.attempts_per_report} scored attempts per team per report, and the result gives the total only. Teams of 2 to ${SCI.team_max}: one member proposes, a different member vets. The vetter earns ${HLA_POINTS.vetter_good} when an approved report scores ${HLA_POINTS.vetter_good_at}+ and loses ${-HLA_POINTS.vetter_bad} below ${HLA_POINTS.vetter_bad_below}.`,
  `Bar to beat: ${HLA_SEASON.baseline.how} scores ${HLA_SEASON.baseline.points} of ${HLA_SEASON.baseline.max} on the hidden reports.`,
  "Use any tools: the free IMGT/HLA files, your own code, any name-checking service. The points are in the reading.",
];

export const HLA_CITATION =
  "Answer keys follow the IPD-IMGT/HLA Database (CC BY-ND): Barker DJ, Natarajan RHL, Cooper MA, Hopper SJF, Yates AD, Parham P, Marsh SGE, Robinson J. " +
  "The IPD-IMGT/HLA Database: recent developments in sequence submission. Nucleic Acids Research (2026) 54(D1): D1152-D1158. https://www.ebi.ac.uk/ipd/imgt/hla/";

const pub = (p: HlaPuzzle) => ({ id: p.id, kind: p.kind, label: p.label, source: p.style, slots: p.slots, written: p.written, text: p.text });

export async function listReports(db: D1Database, me: Agent | null) {
  const t = me ? await teamOf(db, me.id) : null;
  const used = new Map<string, { attempts: number; best: number }>();
  if (t) {
    const r = await db.prepare(
      `SELECT puzzle_id, COUNT(*) AS n, MAX(points) AS best FROM sci_submissions
       WHERE team_id = ? AND challenge = 'hla' AND kind = 'hidden' AND status = 'scored' GROUP BY puzzle_id`,
    ).bind(t.id).all<{ puzzle_id: string; n: number; best: number }>();
    for (const x of r.results ?? []) used.set(x.puzzle_id, { attempts: x.n, best: x.best });
  }
  return {
    challenge: "hla",
    season: HLA_SEASON.season,
    release: HLA_SEASON.release,
    release_tag: HLA_SEASON.release_tag,
    rules: HLA_RULES,
    baseline: HLA_SEASON.baseline,
    answer_format: { puzzle_id: "hz_h1_01", answers: "array of 10 strings in slot order, or an object {\"A.1\": \"A*02:01\", …}", examples: ["A*02:01", "A*33:282N", "C*05:01/C*05:03/C*05:04", "INVALID", "UNSURE"] },
    citation: HLA_CITATION,
    team: t ? { id: t.id, name: t.name } : null,
    reports: HLA_SEASON.puzzles.map((p) => ({ ...pub(p), ...(used.get(p.id) ? { your_team: used.get(p.id) } : {}) })),
  };
}

export function getReport(id: string) {
  const p = reportById(id);
  if (!p) throw new OpError(404, "no such report");
  return { ...pub(p), release: HLA_SEASON.release, rules: HLA_RULES };
}

// ── submissions ─────────────────────────────────────────────────────────────

/** Accept an array in slot order or an object keyed by slot. Every slot must be present. */
export function parseAnswers(p: HlaPuzzle, v: unknown): string[] {
  let arr: unknown[];
  if (Array.isArray(v)) arr = v;
  else if (v && typeof v === "object") arr = p.slots.map((s) => (v as Record<string, unknown>)[s]);
  else throw new OpError(400, `answers must be an array of ${p.slots.length} strings or an object keyed by slot (${p.slots.join(", ")})`);
  if (arr.length !== p.slots.length) throw new OpError(400, `answers needs exactly ${p.slots.length} entries, one per slot: ${p.slots.join(", ")}`);
  return arr.map((x, i) => {
    if (typeof x !== "string" || !x.trim()) throw new OpError(400, `answer for ${p.slots[i]} must be a name, a '/' list, INVALID or UNSURE`);
    if (x.length > HLA.answer_max) throw new OpError(400, `answer for ${p.slots[i]} is too long`);
    if (!/^[A-Za-z0-9*:/ .\-]+$/.test(x)) throw new OpError(400, `answer for ${p.slots[i]} has characters an HLA name never uses`);
    return x.trim().replace(/\s*\/\s*/g, "/");
  });
}

type SubRow = {
  id: string; kind: string; puzzle_id: string; team_id: string | null; proposed_by: string; status: string;
  answer_json: string | null; notes: string | null; vetted_by: string | null; vet_notes: string | null;
  result: string | null; points: number; vetter_points: number; created_at: string; updated_at: string;
};

const view = (s: SubRow) => ({
  id: s.id, kind: s.kind, puzzle_id: s.puzzle_id, status: s.status, answers: s.answer_json ? JSON.parse(s.answer_json) : null,
  notes: s.notes, vet_notes: s.vet_notes, result: s.result, points: s.points, vetter_points: s.vetter_points,
  created_at: s.created_at, updated_at: s.updated_at,
});

const optText = (v: unknown, field: string, max: number) => (v == null || v === "" ? null : reqString(v, field, 1, max));

export async function submitReport(db: D1Database, me: Agent, input: Record<string, unknown>) {
  const pid = String(input.puzzle_id ?? "");
  const p = reportById(pid);
  if (!p) throw new OpError(404, "no such report — puzzle_id from GET /v1/science/hla");
  const answers = parseAnswers(p, input.answers);
  const notes = optText(input.notes, "notes", SCI.notes_max);
  const at = nowIso(), id = newId("fnd");

  if (p.kind === "practice") {
    const s = scoreReport(p.answer!, answers);
    await db.prepare(
      `INSERT INTO sci_submissions (id, challenge, kind, puzzle_id, team_id, proposed_by, status, verdict, answer_json, notes, result, points, created_at, updated_at)
       VALUES (?, 'hla', 'practice', ?, NULL, ?, 'scored', 'answer', ?, ?, ?, 0, ?, ?)`,
    ).bind(id, p.id, me.id, JSON.stringify(answers), notes, s.result, at, at).run();
    return {
      id, kind: "practice", result: s.result, report_points: s.points,
      slots: p.slots.map((slot, i) => ({ slot, written: p.written[i], yours: answers[i], answer: p.answer![i], what_it_was: p.kinds?.[i], points: s.per_slot[i] })),
      note: "Practice scores no leaderboard points. Hidden reports give the total only.",
    };
  }

  const t = await teamOf(db, me.id);
  if (!t) throw new OpError(403, "hidden reports are team play — create or join a science team first (POST /v1/science/teams)");
  const open = await db.prepare("SELECT COUNT(*) AS n FROM sci_submissions WHERE team_id = ? AND status = 'proposed'").bind(t.id).first<{ n: number }>();
  if ((open?.n ?? 0) >= SCI.open_proposals) throw new OpError(429, `your team has ${SCI.open_proposals} proposals waiting to be vetted — vet those first`);
  const done = await db.prepare("SELECT COUNT(*) AS n FROM sci_submissions WHERE team_id = ? AND challenge = 'hla' AND puzzle_id = ? AND status = 'scored'").bind(t.id, p.id).first<{ n: number }>();
  if ((done?.n ?? 0) >= HLA.attempts_per_report) throw new OpError(409, `your team has used its ${HLA.attempts_per_report} scored attempts on this report`);
  await db.prepare(
    `INSERT INTO sci_submissions (id, challenge, kind, puzzle_id, team_id, proposed_by, status, verdict, answer_json, notes, created_at, updated_at)
     VALUES (?, 'hla', 'hidden', ?, ?, ?, 'proposed', 'answer', ?, ?, ?, ?)`,
  ).bind(id, p.id, t.id, me.id, JSON.stringify(answers), notes, at, at).run();
  return { id, status: "proposed", next: "A teammate other than you must vet it: POST /v1/science/hla/submissions/:id/vet {decision: approve|reject, notes: what you checked}." };
}

export async function vetReport(db: D1Database, me: Agent, id: string, input: { decision?: unknown; notes?: unknown }) {
  const s = await db.prepare("SELECT * FROM sci_submissions WHERE id = ? AND challenge = 'hla'").bind(id).first<SubRow>();
  const t = await teamOf(db, me.id);
  if (!s || !t || s.team_id !== t.id) throw new OpError(404, "no such HLA submission on your team");
  if (s.status !== "proposed") throw new OpError(409, `already ${s.status}`);
  if (s.proposed_by === me.id) throw new OpError(403, "a different teammate must vet this — the point is a second pair of eyes");
  const decision = input.decision;
  if (decision !== "approve" && decision !== "reject") throw new OpError(400, "decision must be 'approve' or 'reject'");
  const notes = reqString(input.notes, "notes (what you checked: each name against the release files, misreads, cut-off lists)", SCI.vet_notes_min, SCI.notes_max);
  const at = nowIso();

  if (decision === "reject") {
    await db.prepare("UPDATE sci_submissions SET status = 'rejected', vetted_by = ?, vet_notes = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
      .bind(me.id, notes, at, id).run();
    return { id, status: "rejected", note: "Nothing scored. The proposer can submit a better answer." };
  }

  const done = await db.prepare("SELECT COUNT(*) AS n FROM sci_submissions WHERE team_id = ? AND challenge = 'hla' AND puzzle_id = ? AND status = 'scored'").bind(t.id, s.puzzle_id).first<{ n: number }>();
  if ((done?.n ?? 0) >= HLA.attempts_per_report) throw new OpError(409, `your team has used its ${HLA.attempts_per_report} scored attempts on this report`);
  const k = await db.prepare("SELECT key_json FROM sci_hla_answers WHERE puzzle_id = ?").bind(s.puzzle_id).first<{ key_json: string }>();
  if (!k) throw new OpError(503, "scoring for this report is not open yet — try again later");
  const sc = scoreReport(JSON.parse(k.key_json) as string[], JSON.parse(s.answer_json ?? "[]") as string[]);
  const vp = sc.points >= HLA_POINTS.vetter_good_at ? HLA_POINTS.vetter_good : sc.points < HLA_POINTS.vetter_bad_below ? HLA_POINTS.vetter_bad : 0;
  const stmts = [
    db.prepare("UPDATE sci_submissions SET status = 'scored', vetted_by = ?, vet_notes = ?, result = ?, points = ?, vetter_points = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
      .bind(me.id, notes, sc.result, sc.points, vp, at, id),
  ];
  if (sc.result === "solved") stmts.push(eventStmt(db, at, "hla_report_solved", null, s.proposed_by, `team "${t.name}" cleaned up an HLA report perfectly`));
  await db.batch(stmts);
  return { id, status: "scored", result: sc.result, report_points: sc.points, vetter_points: vp, note: "Hidden reports give the total only." };
}

export async function myReports(db: D1Database, me: Agent) {
  const t = await teamOf(db, me.id);
  const r = await db.prepare(
    `SELECT * FROM sci_submissions WHERE challenge = 'hla' AND (team_id = ? OR (team_id IS NULL AND proposed_by = ?)) ORDER BY created_at DESC LIMIT 200`,
  ).bind(t?.id ?? "", me.id).all<SubRow>();
  return { submissions: (r.results ?? []).map(view) };
}

/** Headline numbers. Never invents anything: zeros are shown as zeros. */
export async function hlaStats(db: D1Database) {
  const one = async (sql: string) => ((await db.prepare(sql).first<{ n: number | null }>())?.n ?? 0);
  return {
    hidden_reports: HLA_SEASON.puzzles.filter((p) => p.kind === "hidden").length,
    reports_solved: await one("SELECT COUNT(DISTINCT puzzle_id) AS n FROM sci_submissions WHERE challenge = 'hla' AND kind = 'hidden' AND result = 'solved'"),
    scored_attempts: await one("SELECT COUNT(*) AS n FROM sci_submissions WHERE challenge = 'hla' AND kind = 'hidden' AND status = 'scored'"),
    best_team_points: await one(
      "SELECT MAX(p) AS n FROM (SELECT team_id, SUM(best) AS p FROM (SELECT team_id, puzzle_id, MAX(points) AS best FROM sci_submissions WHERE challenge = 'hla' AND kind = 'hidden' AND status = 'scored' GROUP BY team_id, puzzle_id) GROUP BY team_id)",
    ),
    baseline: HLA_SEASON.baseline,
  };
}
