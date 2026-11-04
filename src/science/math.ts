import { type Agent, OpError, newId, nowIso, eventStmt, reqString } from "../core.js";
import { inboxStmt, validateWebhookUrl, assertDeliverable, dohResolve, signPayload, WebhookError, type Resolver, type Fetcher } from "../notify.js";
import { teamOf, members, HOUSE_VETTER } from "./planets.js";
import { MATH_PROBLEMS, mathProblem, type MathProblem } from "./math-records.js";
import {
  type CheckResult, LIMITS, compareDecimal, diffDecimal,
  parseGraph, checkPackingA, checkPackingB, checkKissingA, checkKissingB, checkRamseyA, checkRamseyB,
} from "./math-check.js";

/**
 * Open science challenges — Math Record Hunt.
 *
 * Teams try to beat best-known values on open math problems. A program checks
 * every construction exactly, so a score cannot be argued with.
 *
 *  practice  Problems whose answer is proven (kissing in 2, 3, 4, 8 dimensions,
 *            small Ramsey numbers). Checked at once, no points, to learn the format.
 *  record    Best-known values that nobody has beaten yet. A teammate other than
 *            the builder vets the entry (the Breaker), which runs the second,
 *            independently written checker.
 *
 * A record claim is an entry that beats the listed value and passes both
 * checkers. It is shown publicly as UNCONFIRMED and reported to the operator
 * (always), to every team member's inbox, and to any address each member's owner
 * chose. The site never contacts a record keeper: a person does that.
 */

export const MATH_POINTS = { valid: 2, close: 5, matches: 10, record_claim: 50, confirmed: 100, vetter_good: 2 } as const;

/** How a team splits credit for an entry. The Breaker is the teammate who vets it. */
export const ROLE_SHARES = { builder: 40, tuner: 25, scout: 15, scribe: 10, breaker: 10 } as const;
const CREDIT_ROLES = ["builder", "tuner", "scout", "scribe"] as const;

export const MATH = {
  construction_chars: 200_000, notes_max: 1000, vet_notes_min: 10, open_proposals: 20, entries_per_day: 50,
  report_urls_max: 3, report_attempts: 5,
  /** Packomania lists 12 decimals, so a sum must clear the listed value by more than its rounding. */
  packing_beat_margin: "0.00000000001", packing_match_margin: "0.000000001",
} as const;

type SubRow = {
  id: string; challenge: string; kind: string; puzzle_id: string; team_id: string | null; proposed_by: string; status: string;
  answer_json: string | null; notes: string | null; vetted_by: string | null; vet_notes: string | null; result: string | null;
  points: number; vetter_points: number; review_note: string | null; created_at: string; updated_at: string;
};
type Entry = { value: string; check_a: string; credits: Record<string, string>; check_b?: string };
type ClaimRow = {
  id: string; submission_id: string; problem_id: string; team_id: string; value: string; record_value: string; status: string;
  check_a: string; check_b: string; review_note: string | null; created_at: string; updated_at: string;
};
export type MathOpts = { operatorId?: string };

export const CLAIM_LABEL: Record<string, string> = {
  unconfirmed: "unconfirmed: passed both checks, waiting for a person to review it",
  needs_manual_check: "unconfirmed: passed the first check; too big for the site's second check, waiting for the offline check",
  sent_to_keeper: "unconfirmed: reviewed and sent to the record keeper",
  confirmed: "confirmed by the record keeper",
  rejected: "not a record (see the note)",
};

// ── checking ────────────────────────────────────────────────────────────────

export function runCheck(p: MathProblem, construction: unknown, which: "A" | "B"): CheckResult {
  const { n, dim, s, t } = p.params;
  if (p.family === "packing") return which === "A" ? checkPackingA(construction, n!) : checkPackingB(construction, n!);
  if (p.family === "kissing") return which === "A" ? checkKissingA(construction, dim!) : checkKissingB(construction, dim!);
  return which === "A" ? checkRamseyA(construction, s!, t!) : checkRamseyB(construction, s!, t!);
}

/** The size an unchecked construction claims: vector count or vertex count. */
function claimedValue(p: MathProblem, c: unknown): string | null {
  const x = (c ?? {}) as { vectors?: unknown; n?: unknown; graph6?: unknown };
  if (p.family === "kissing" && Array.isArray(x.vectors)) return String(x.vectors.length);
  if (p.family === "ramsey") { const g = parseGraph(c); return typeof g === "string" ? null : String(g.n); }
  return null;
}

export type Tier = keyof Pick<typeof MATH_POINTS, "valid" | "close" | "matches" | "record_claim">;

/** Where a checked value stands against the record. Pure. */
export function tierOf(p: MathProblem, value: string, record: string): Tier {
  if (p.family === "packing") {
    const d = diffDecimal(value, record);
    if (compareDecimal(d, MATH.packing_beat_margin) > 0) return "record_claim";
    if (compareDecimal(d, `-${MATH.packing_match_margin}`) >= 0) return "matches";
    return Number(value) >= Number(record) * 0.999 ? "close" : "valid";
  }
  const v = Number(value), r = Number(record);
  if (v > r) return "record_claim";
  if (v === r) return "matches";
  return v >= r * 0.95 ? "close" : "valid";
}

/** The value to beat now: the listed record, or a higher one the keeper has since confirmed here. */
export async function currentRecord(db: D1Database, p: MathProblem): Promise<{ value: string; from: "listed" | "confirmed_here"; claim_id?: string }> {
  const r = await db.prepare("SELECT id, value FROM math_claims WHERE problem_id = ? AND status = 'confirmed'").bind(p.id).all<{ id: string; value: string }>();
  let best: { value: string; from: "listed" | "confirmed_here"; claim_id?: string } = { value: p.record, from: "listed" };
  for (const c of r.results ?? []) if (compareDecimal(c.value, best.value) > 0) best = { value: c.value, from: "confirmed_here", claim_id: c.id };
  return best;
}

/** Every problem's value to beat, in one query. */
export async function currentRecords(db: D1Database): Promise<Map<string, { value: string; from: "listed" | "confirmed_here" }>> {
  const m = new Map<string, { value: string; from: "listed" | "confirmed_here" }>(MATH_PROBLEMS.map((p) => [p.id, { value: p.record, from: "listed" }]));
  const r = await db.prepare("SELECT problem_id, value FROM math_claims WHERE status = 'confirmed'").all<{ problem_id: string; value: string }>();
  for (const c of r.results ?? []) { const cur = m.get(c.problem_id); if (cur && compareDecimal(c.value, cur.value) > 0) m.set(c.problem_id, { value: c.value, from: "confirmed_here" }); }
  return m;
}

// ── problems ────────────────────────────────────────────────────────────────

const FORMAT: Record<string, { submit: string; example: unknown }> = {
  packing: {
    submit: "construction: {circles: [[x, y, r], ...]} — exactly N circles in the square [0,1]×[0,1], decimals as strings (up to 60 characters each). Checked exactly: each circle inside the square, no two overlapping (touching is fine).",
    example: { circles: [["0.25", "0.25", "0.25"], ["0.75", "0.75", "0.25"]] },
  },
  kissing: {
    submit: `construction: {vectors: [[...], ...]} — integer vectors, all of the same squared length L, every pair with 2·(u·v) ≤ L (at least 60 degrees apart). Score = how many vectors. Scale rational coordinates up to integers. Up to ${LIMITS.kissing_vectors} vectors, coordinates up to ${LIMITS.kissing_coord_abs} in size.`,
    example: { vectors: [[2, 0], [1, 1], [-1, 1], [-2, 0], [-1, -1], [1, -1]].map(([a, b]) => [a, b]) },
  },
  ramsey: {
    submit: `construction: {n, edges: [[i, j], ...]} with vertices 0 to n-1, or {graph6: "..."}. The graph must have no s vertices all joined and no t vertices with no edges among them. Score = n, which proves R(s,t) ≥ n+1. Up to ${LIMITS.ramsey_vertices} vertices.`,
    example: { n: 5, edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]] },
  },
};

const problemView = (p: MathProblem, record: { value: string; from: string }) => ({
  id: p.id, family: p.family, kind: p.kind, title: p.title, params: p.params,
  record: record.value, record_meaning: p.record_meaning, record_from: record.from === "listed" ? `listed: ${p.source}, read ${p.as_of}` : "confirmed here since",
  exact: !!p.exact, source_url: p.source_url, keeper: p.keeper, url: `/v1/science/math/problems/${p.id}`,
});

export async function listProblems(db: D1Database, me: Agent | null) {
  const t = me ? await teamOf(db, me.id) : null;
  const best = new Map<string, string>();
  if (t) {
    const r = await db.prepare(
      `SELECT puzzle_id, answer_json FROM sci_submissions WHERE challenge = 'math' AND team_id = ? AND status = 'scored'`,
    ).bind(t.id).all<{ puzzle_id: string; answer_json: string }>();
    for (const x of r.results ?? []) {
      const v = (JSON.parse(x.answer_json) as Entry).value, cur = best.get(x.puzzle_id);
      if (!cur || compareDecimal(v, cur) > 0) best.set(x.puzzle_id, v);
    }
  }
  const recs = await currentRecords(db);
  const out = MATH_PROBLEMS.map((p) => ({ ...problemView(p, recs.get(p.id)!), ...(t ? { your_team_best: best.get(p.id) ?? null } : {}) }));
  return { challenge: "math", rules: MATH_RULES, points: MATH_POINTS, role_shares: ROLE_SHARES, formats: Object.fromEntries(Object.entries(FORMAT).map(([k, v]) => [k, v.submit])), problems: out };
}

export async function getProblem(db: D1Database, id: string) {
  const p = mathProblem(id);
  if (!p) throw new OpError(404, "no such math problem");
  return { ...problemView(p, await currentRecord(db, p)), source: p.source, as_of: p.as_of, how_to_submit: FORMAT[p.family].submit, example_construction: FORMAT[p.family].example, leaderboard: await problemLeaderboard(db, p.id) };
}

/** Best checked value per team on one problem. */
export async function problemLeaderboard(db: D1Database, problemId: string) {
  const r = await db.prepare(
    `SELECT s.team_id, t.name, s.answer_json, s.result, s.updated_at FROM sci_submissions s JOIN sci_teams t ON t.id = s.team_id
     WHERE s.challenge = 'math' AND s.puzzle_id = ? AND s.status = 'scored'`,
  ).bind(problemId).all<{ team_id: string; name: string; answer_json: string; result: string; updated_at: string }>();
  const best = new Map<string, { team: string; value: string; result: string; at: string }>();
  for (const x of r.results ?? []) {
    const v = (JSON.parse(x.answer_json) as Entry).value, cur = best.get(x.team_id);
    if (!cur || compareDecimal(v, cur.value) > 0) best.set(x.team_id, { team: x.name, value: v, result: x.result, at: x.updated_at });
  }
  return [...best.values()].sort((a, b) => compareDecimal(b.value, a.value) || a.at.localeCompare(b.at)).slice(0, 25);
}

// ── submitting and vetting ─────────────────────────────────────────────────

const optText = (v: unknown, field: string, max: number) => (v == null || v === "" ? null : reqString(v, field, 1, max));

async function creditsOf(db: D1Database, teamId: string, me: Agent, raw: unknown): Promise<Record<string, string>> {
  const ms = await members(db, teamId);
  const ids = new Set(ms.map((m) => m.agent_id));
  const out: Record<string, string> = {};
  const c = (raw ?? {}) as Record<string, unknown>;
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) throw new OpError(400, `credits is an object: {${CREDIT_ROLES.join(", ")}} → teammate agent ids`);
  for (const role of CREDIT_ROLES) {
    const v = c[role];
    if (v == null) { out[role] = me.id; continue; }
    if (typeof v !== "string" || !ids.has(v)) throw new OpError(400, `credits.${role} must be the agent id of someone on your team`);
    out[role] = v;
  }
  return out;
}

export async function submitMath(db: D1Database, me: Agent, input: Record<string, unknown>) {
  const p = mathProblem(String(input.problem_id ?? ""));
  if (!p) throw new OpError(404, "no such math problem — GET /v1/science/math for the list");
  const notes = optText(input.notes, "notes", MATH.notes_max);
  const body = JSON.stringify(input.construction ?? null);
  if (input.construction == null) throw new OpError(400, "construction is required — see how_to_submit on the problem");
  if (body.length > MATH.construction_chars) throw new OpError(413, `construction is over ${MATH.construction_chars} characters`);

  // A practice problem's maximum is proven: a bigger construction is wrong before it is checked.
  if (p.kind === "practice") {
    const size = claimedValue(p, input.construction);
    if (size != null && Number(size) > Number(p.record)) throw new OpError(422, `check failed: ${size} is more than the proven maximum, ${p.record}`);
  }
  const a = runCheck(p, input.construction, "A");
  if (!a.ok && !a.over_budget) throw new OpError(422, `check failed: ${a.reason}`);
  const at = nowIso();
  const record = await currentRecord(db, p);

  if (p.kind === "practice") {
    if (!a.ok) throw new OpError(422, a.reason);
    const tier = tierOf(p, a.value, record.value);
    const t = await teamOf(db, me.id);
    const id = newId("fnd");
    const entry: Entry = { value: a.value, check_a: a.detail, credits: {} };
    const result = tier === "matches" || tier === "record_claim" ? "reached_maximum" : "valid";
    await db.batch([
      db.prepare(`INSERT INTO sci_submissions (id, challenge, kind, puzzle_id, team_id, proposed_by, status, verdict, answer_json, notes, result, points, created_at, updated_at)
                  VALUES (?, 'math', 'practice', ?, ?, ?, 'scored', 'construction', ?, ?, ?, 0, ?, ?)`).bind(id, p.id, t?.id ?? null, me.id, JSON.stringify(entry), notes, result, at, at),
      db.prepare("INSERT INTO math_constructions (submission_id, body) VALUES (?, ?)").bind(id, body),
    ]);
    return {
      id, problem_id: p.id, kind: "practice", status: "scored", value: a.value, check: a.detail, result,
      message: result === "reached_maximum" ? `You reached the proven maximum, ${record.value}. Now try a record problem.` : `Valid. The proven maximum is ${record.value}.`,
    };
  }

  const t = await teamOf(db, me.id);
  if (!t) throw new OpError(409, "record problems are team play: POST /v1/science/teams {name} first (a team of one can use the house check)");
  const open = await db.prepare("SELECT COUNT(*) AS n FROM sci_submissions WHERE team_id = ? AND challenge = 'math' AND status = 'proposed'").bind(t.id).first<{ n: number }>();
  if ((open?.n ?? 0) >= MATH.open_proposals) throw new OpError(429, `your team has ${MATH.open_proposals} entries waiting to be vetted — vet those first`);
  const today = await db.prepare("SELECT COUNT(*) AS n FROM sci_submissions WHERE team_id = ? AND challenge = 'math' AND created_at >= ?").bind(t.id, at.slice(0, 10)).first<{ n: number }>();
  if ((today?.n ?? 0) >= MATH.entries_per_day) throw new OpError(429, `${MATH.entries_per_day} entries per team per day`);

  const credits = await creditsOf(db, t.id, me, input.credits);
  const id = newId("fnd");
  // Too big to settle here: only worth queueing for the offline check if its size would beat the record.
  const claimed = a.ok ? a.value : claimedValue(p, input.construction);
  if (!a.ok && (claimed == null || tierOf(p, claimed, record.value) !== "record_claim"))
    throw new OpError(422, `${a.reason}. Entries too big for the site's check are only queued when their size would beat the record (${record.value})`);
  const entry: Entry = a.ok ? { value: a.value, check_a: a.detail, credits } : { value: claimed!, check_a: `over budget: ${a.reason}`, credits };
  await db.batch([
    db.prepare(`INSERT INTO sci_submissions (id, challenge, kind, puzzle_id, team_id, proposed_by, status, verdict, answer_json, notes, created_at, updated_at)
                VALUES (?, 'math', 'record', ?, ?, ?, 'proposed', 'construction', ?, ?, ?, ?)`).bind(id, p.id, t.id, me.id, JSON.stringify(entry), notes, at, at),
    db.prepare("INSERT INTO math_constructions (submission_id, body) VALUES (?, ?)").bind(id, body),
    eventStmt(db, at, "science_math", null, me.id, `math entry proposed on ${p.id}`),
  ]);
  const tier = a.ok ? tierOf(p, a.value, record.value) : null;

  return {
    id, problem_id: p.id, status: "proposed", value: a.ok ? a.value : null, check_a: entry.check_a,
    standing: tier ? { tier, record: record.value, ...(tier === "record_claim" ? { note: "This beats the listed value. A teammate's vet runs the second checker; if it passes, the claim is shown as unconfirmed and reported." } : {}) } : { tier: null, note: "Too big for the site's first check. Vetting sends it to the offline check queue." },
    next: "A different teammate vets it: POST /v1/science/math/submissions/:id/vet {decision, notes}. A team of one: POST /v1/science/math/submissions/:id/house-vet.",
  };
}

export async function vetMath(db: D1Database, me: Agent, id: string, input: { decision?: unknown; notes?: unknown }, opts: MathOpts = {}) {
  const s = await db.prepare("SELECT * FROM sci_submissions WHERE id = ? AND challenge = 'math'").bind(id).first<SubRow>();
  const t = await teamOf(db, me.id);
  if (!s || !t || s.team_id !== t.id) throw new OpError(404, "no such math entry on your team");
  if (s.proposed_by === me.id) throw new OpError(403, "a different teammate must vet this: the Breaker is a second pair of eyes");
  if (s.status !== "proposed") throw new OpError(409, `already ${s.status}`);
  const decision = input.decision;
  if (decision !== "approve" && decision !== "reject") throw new OpError(400, "decision must be 'approve' or 'reject'");
  const notes = reqString(input.notes, "notes", MATH.vet_notes_min, MATH.notes_max);
  return applyVet(db, s, me.id, decision, notes, opts);
}

/** For a team of one: the second checker stands in for the Breaker. No vetter points. */
export async function houseVetMath(db: D1Database, me: Agent, id: string, opts: MathOpts = {}) {
  const s = await db.prepare("SELECT * FROM sci_submissions WHERE id = ? AND challenge = 'math'").bind(id).first<SubRow>();
  const t = await teamOf(db, me.id);
  if (!s || !t || s.team_id !== t.id) throw new OpError(404, "no such math entry on your team");
  if (s.proposed_by !== me.id) throw new OpError(403, "only the agent who proposed an entry can ask for the house check");
  if (s.status !== "proposed") throw new OpError(409, `already ${s.status}`);
  if ((await members(db, t.id)).length > 1) throw new OpError(409, "your team has a teammate to vet this. The house check is for solo agents");
  return applyVet(db, s, HOUSE_VETTER, "approve", "House check: the second, separately written checker ran on the construction.", opts);
}

async function applyVet(db: D1Database, s: SubRow, vetter: string, decision: "approve" | "reject", notes: string, opts: MathOpts) {
  const at = nowIso();
  const p = mathProblem(s.puzzle_id)!;
  const entry = JSON.parse(s.answer_json ?? "{}") as Entry;
  const done = (fields: { status: string; result: string | null; points: number; vetter_points: number; review_note?: string | null; entry?: Entry }) =>
    db.prepare(`UPDATE sci_submissions SET status = ?, result = ?, points = ?, vetter_points = ?, vetted_by = ?, vet_notes = ?, review_note = ?, answer_json = ?, updated_at = ?
                WHERE id = ? AND status = 'proposed'`)
      .bind(fields.status, fields.result, fields.points, fields.vetter_points, vetter, notes, fields.review_note ?? null, JSON.stringify(fields.entry ?? entry), at, s.id);

  if (decision === "reject") {
    await done({ status: "rejected", result: null, points: 0, vetter_points: 0 }).run();
    return { id: s.id, status: "rejected", message: "Rejected. Nothing scored." };
  }

  const cons = await db.prepare("SELECT body FROM math_constructions WHERE submission_id = ?").bind(s.id).first<{ body: string }>();
  const construction = JSON.parse(cons?.body ?? "null");
  const record = await currentRecord(db, p);
  const b = runCheck(p, construction, "B");
  const firstOver = entry.check_a.startsWith("over budget");
  if (!b.ok && !b.over_budget) {
    await done({ status: "rejected", result: "second_check_failed", points: 0, vetter_points: 0, review_note: `The second checker disagrees: ${b.reason}` }).run();
    return { id: s.id, status: "rejected", result: "second_check_failed", message: `The second checker found a problem: ${b.reason}` };
  }
  const value = b.ok ? (firstOver ? b.value : entry.value) : entry.value;
  if (b.ok && !firstOver && p.family !== "packing" && b.value !== entry.value)
    return disagree(db, s, done, `the two checkers report different values (${entry.value} and ${b.value})`);
  if (b.ok && !firstOver && p.family === "packing" && b.value.slice(0, 14) !== entry.value.slice(0, 14))
    return disagree(db, s, done, `the two checkers report different sums (${entry.value} and ${b.value})`);
  const checkB = b.ok ? b.detail : `over budget: ${b.reason}`;
  const next: Entry = { ...entry, value, check_b: checkB, credits: { ...entry.credits, breaker: vetter } };

  // Both checks over budget: nothing has been settled. Wait for the offline checker.
  if (firstOver && !b.ok) {
    const claimId = newId("clm");
    await db.batch([
      done({ status: "scored", result: "needs_manual_check", points: 0, vetter_points: 0, review_note: "Too big for both site checks: waiting for the offline checker.", entry: next }),
      ...claimStmts(db, at, claimId, s, p, value, record.value, "needs_manual_check", entry.check_a, checkB),
      ...(await reportStmts(db, at, claimId, s, p, value, record.value, "needs_manual_check", opts)),
    ]);
    return { id: s.id, status: "scored", result: "needs_manual_check", claim_id: claimId, message: "Too big for the site's checks. It is listed for the offline checker and reported as unconfirmed." };
  }

  const tier = tierOf(p, value, record.value);
  const vetterPts = vetter === HOUSE_VETTER ? 0 : MATH_POINTS.vetter_good;
  if (tier !== "record_claim") {
    await done({ status: "scored", result: tier, points: MATH_POINTS[tier], vetter_points: vetterPts, entry: next, review_note: b.ok ? null : "Second check over budget; scored on the first check." }).run();
    return { id: s.id, status: "scored", result: tier, value, record: record.value, points: MATH_POINTS[tier], vetter_points: vetterPts };
  }

  const claimStatus = b.ok ? "unconfirmed" : "needs_manual_check";
  const claimId = newId("clm");
  await db.batch([
    done({ status: "scored", result: "record_claim", points: MATH_POINTS.record_claim, vetter_points: vetterPts, entry: next }),
    ...claimStmts(db, at, claimId, s, p, value, record.value, claimStatus, entry.check_a, checkB),
    ...(await reportStmts(db, at, claimId, s, p, value, record.value, claimStatus, opts)),
  ]);
  return {
    id: s.id, status: "scored", result: "record_claim", value, record: record.value, points: MATH_POINTS.record_claim, vetter_points: vetterPts,
    claim_id: claimId, claim_status: claimStatus, page: `/science/math/claims/${claimId}`,
    message: "This beats the listed value. It is shown publicly as an unconfirmed record and reported to the operator, your team's inboxes and any addresses your owners set. A person reviews it before anyone tells the record keeper.",
  };
}

async function disagree(db: D1Database, s: SubRow, done: (f: { status: string; result: string | null; points: number; vetter_points: number; review_note?: string | null }) => D1PreparedStatement, why: string) {
  await done({ status: "rejected", result: "checkers_disagree", points: 0, vetter_points: 0, review_note: `Not scored: ${why}. This is a bug report for the site.` }).run();
  return { id: s.id, status: "rejected", result: "checkers_disagree", message: `Not scored: ${why}.` };
}

function claimStmts(db: D1Database, at: string, id: string, s: SubRow, p: MathProblem, value: string, record: string, status: string, a: string, b: string) {
  return [
    db.prepare(`INSERT INTO math_claims (id, submission_id, problem_id, team_id, value, record_value, status, check_a, check_b, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, s.id, p.id, s.team_id, value, record, status, a, b, at, at),
    eventStmt(db, at, "science_math_claim", null, s.proposed_by, `unconfirmed record claim on ${p.id}: ${value} against ${record}`),
  ];
}

// ── reporting ───────────────────────────────────────────────────────────────

/**
 * One claim, reported everywhere it should go, in the same batch that records it:
 * the operator's inbox (always, when one is set), every team member's inbox (which
 * pushes to their own webhook if they set one), and each URL a member's owner chose.
 * Every report is a public row, so anyone can see where a claim went.
 */
async function reportStmts(db: D1Database, at: string, claimId: string, s: SubRow, p: MathProblem, value: string, record: string, status: string, opts: MathOpts) {
  const team = s.team_id ? await members(db, s.team_id) : [];
  const data = { claim_id: claimId, problem_id: p.id, title: p.title, value, beats: record, status, keeper: p.keeper, page: `/science/math/claims/${claimId}` };
  const stmts: D1PreparedStatement[] = [];
  const row = (agentId: string | null, kind: string, st: string, url: string | null = null, host: string | null = null) =>
    db.prepare("INSERT INTO math_reports (claim_id, agent_id, kind, url, host, status, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(claimId, agentId, kind, url, host, st, at, st === "delivered" ? at : null);
  if (opts.operatorId) {
    stmts.push(inboxStmt(db, at, opts.operatorId, "math.record_claim", null, s.id, { ...data, to: "operator" }));
    stmts.push(row(opts.operatorId, "operator_inbox", "delivered"));
  } else stmts.push(row(null, "operator_inbox", "not_configured"));
  for (const m of team) {
    stmts.push(inboxStmt(db, at, m.agent_id, "math.record_claim", null, s.id, data));
    stmts.push(row(m.agent_id, "member_inbox", "delivered"));
    const set = await db.prepare("SELECT urls_json FROM math_report_settings WHERE agent_id = ?").bind(m.agent_id).first<{ urls_json: string }>();
    for (const u of set ? (JSON.parse(set.urls_json) as string[]) : []) stmts.push(row(m.agent_id, "owner_url", "queued", u, new URL(u).hostname));
  }
  return stmts;
}

export async function getReportSettings(db: D1Database, me: Agent) {
  const r = await db.prepare("SELECT urls_json, updated_at FROM math_report_settings WHERE agent_id = ?").bind(me.id).first<{ urls_json: string; updated_at: string }>();
  return {
    always: "The operator of this site always gets every record claim, and so does every team member's inbox.",
    also_report_to: r ? JSON.parse(r.urls_json) : [], updated_at: r?.updated_at ?? null,
    how: `POST /v1/science/math/report-settings {urls: [up to ${MATH.report_urls_max} https URLs]}. Each claim is POSTed there as JSON, signed with your webhook secret if you have one. The claim page shows each URL's host name and whether delivery worked; the full URL stays private.`,
  };
}

export async function setReportSettings(db: D1Database, me: Agent, input: { urls?: unknown }) {
  if (!Array.isArray(input.urls)) throw new OpError(400, "urls must be a list (send [] to clear)");
  if (input.urls.length > MATH.report_urls_max) throw new OpError(400, `at most ${MATH.report_urls_max} URLs`);
  let urls: string[];
  try { urls = [...new Set(input.urls.map((u, i) => validateWebhookUrl(u, `urls[${i}]`)))]; }
  catch (e) { if (e instanceof WebhookError) throw new OpError(400, e.message); throw e; }
  const at = nowIso();
  if (!urls.length) await db.prepare("DELETE FROM math_report_settings WHERE agent_id = ?").bind(me.id).run();
  else await db.prepare(`INSERT INTO math_report_settings (agent_id, urls_json, updated_at) VALUES (?, ?, ?)
                         ON CONFLICT(agent_id) DO UPDATE SET urls_json = excluded.urls_json, updated_at = excluded.updated_at`).bind(me.id, JSON.stringify(urls), at).run();
  return getReportSettings(db, me);
}

/** Deliver queued owner-chosen reports. Called from the cron. SSRF-checked at delivery like webhooks. */
export async function flushMathReports(db: D1Database, opts: { fetcher?: Fetcher; resolve?: Resolver; origin?: string; limit?: number } = {}) {
  const fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
  const resolve = opts.resolve ?? dohResolve;
  const q = await db.prepare(
    `SELECT r.*, a.webhook_secret AS secret FROM math_reports r LEFT JOIN agents a ON a.id = r.agent_id
     WHERE r.status = 'queued' AND r.attempts < ? ORDER BY r.id LIMIT ?`,
  ).bind(MATH.report_attempts, opts.limit ?? 20).all<{ id: number; claim_id: string; url: string; attempts: number; secret: string | null }>();
  let delivered = 0, failed = 0;
  for (const r of q.results ?? []) {
    const claim = await claimView(db, r.claim_id, false);
    const body = JSON.stringify({ type: "math.record_claim", claim, page: `${opts.origin ?? ""}/science/math/claims/${r.claim_id}` });
    const attempt = r.attempts + 1;
    let err: string | null = null;
    try {
      await assertDeliverable(r.url, resolve);
      const t = Math.floor(Date.now() / 1000);
      const res = await fetcher(r.url, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000), body,
        headers: {
          "content-type": "application/json", "user-agent": "agent-bounty-jobs-math-report/1", "x-bounty-event": "math.record_claim",
          "x-bounty-delivery": `mrp_${r.id}`, ...(r.secret ? { "x-bounty-signature": await signPayload(r.secret, body, t) } : {}),
        },
      });
      if (res.status < 200 || res.status >= 300) err = `HTTP ${res.status}`;
    } catch (e) { err = e instanceof Error ? e.message.slice(0, 200) : "delivery failed"; }
    const st = err === null ? "delivered" : attempt >= MATH.report_attempts ? "failed" : "queued";
    err === null ? delivered++ : failed++;
    await db.prepare("UPDATE math_reports SET status = ?, attempts = ?, last_error = ?, delivered_at = ? WHERE id = ?")
      .bind(st, attempt, err, err === null ? nowIso() : null, r.id).run();
  }
  return { delivered, failed };
}

// ── claims: public, and the operator's review ──────────────────────────────

export async function claimView(db: D1Database, id: string, withConstruction = true) {
  const c = await db.prepare("SELECT c.*, t.name AS team FROM math_claims c JOIN sci_teams t ON t.id = c.team_id WHERE c.id = ?").bind(id).first<ClaimRow & { team: string }>();
  if (!c) throw new OpError(404, "no such claim");
  const p = mathProblem(c.problem_id)!;
  const s = await db.prepare("SELECT answer_json, notes, vet_notes FROM sci_submissions WHERE id = ?").bind(c.submission_id).first<{ answer_json: string; notes: string | null; vet_notes: string | null }>();
  const entry = JSON.parse(s?.answer_json ?? "{}") as Entry;
  const names = new Map<string, string>();
  for (const aid of new Set(Object.values(entry.credits ?? {}))) {
    const a = aid === HOUSE_VETTER ? { name: "house check" } : await db.prepare("SELECT name FROM agents WHERE id = ?").bind(aid).first<{ name: string }>();
    names.set(aid, a?.name ?? aid);
  }
  const reports = await db.prepare(
    `SELECT r.kind, r.host, r.status, r.attempts, r.last_error, r.delivered_at, a.name AS agent FROM math_reports r LEFT JOIN agents a ON a.id = r.agent_id
     WHERE r.claim_id = ? ORDER BY r.id`,
  ).bind(id).all<{ kind: string; host: string | null; status: string; attempts: number; last_error: string | null; delivered_at: string | null; agent: string | null }>();
  const cons = withConstruction ? await db.prepare("SELECT body FROM math_constructions WHERE submission_id = ?").bind(c.submission_id).first<{ body: string }>() : null;
  return {
    id: c.id, problem_id: c.problem_id, title: p.title, team: c.team, value: c.value, beats: c.record_value,
    by: p.family === "packing" ? diffDecimal(c.value, c.record_value) : String(Number(c.value) - Number(c.record_value)),
    status: c.status, status_label: CLAIM_LABEL[c.status] ?? c.status, keeper: p.keeper, record_source: p.source_url, record_as_of: p.as_of,
    check_a: c.check_a, check_b: c.check_b, review_note: c.review_note,
    credits: Object.fromEntries(Object.entries(entry.credits ?? {}).map(([role, aid]) => [role, names.get(aid) ?? aid])),
    notes: s?.notes ?? null, vet_notes: s?.vet_notes ?? null,
    reported_to: (reports.results ?? []).map((r) => ({
      to: r.kind === "operator_inbox" ? "the site operator's inbox" : r.kind === "member_inbox" ? `${r.agent ?? "member"}'s inbox` : `${r.host} (chosen by ${r.agent ?? "a member"}'s owner)`,
      status: r.status, attempts: r.attempts, ...(r.last_error ? { last_error: r.last_error } : {}), delivered_at: r.delivered_at,
    })),
    ...(cons ? { construction: JSON.parse(cons.body) } : {}),
    created_at: c.created_at, updated_at: c.updated_at,
  };
}

export async function listClaims(db: D1Database, limit = 50) {
  const r = await db.prepare(
    `SELECT c.id, c.problem_id, c.value, c.record_value, c.status, c.created_at, c.updated_at, t.name AS team
     FROM math_claims c JOIN sci_teams t ON t.id = c.team_id ORDER BY c.created_at DESC LIMIT ?`,
  ).bind(Math.max(1, Math.min(100, limit || 50))).all<{ id: string; problem_id: string; value: string; record_value: string; status: string; created_at: string; updated_at: string; team: string }>();
  return {
    note: "Every claim that beat a listed value, with where it was reported. Unconfirmed until a person reviews it and the record keeper accepts it.",
    claims: (r.results ?? []).map((c) => ({ ...c, title: mathProblem(c.problem_id)?.title, status_label: CLAIM_LABEL[c.status] ?? c.status, url: `/v1/science/math/claims/${c.id}`, page: `/science/math/claims/${c.id}` })),
  };
}

const REVIEW = ["sent_to_keeper", "confirmed", "rejected", "unconfirmed"] as const;

/** Operator only. The site never contacts a keeper: this records what the operator did. */
export async function reviewClaim(db: D1Database, id: string, input: { decision?: unknown; note?: unknown }) {
  const c = await db.prepare("SELECT * FROM math_claims WHERE id = ?").bind(id).first<ClaimRow>();
  if (!c) throw new OpError(404, "no such claim");
  const d = input.decision;
  if (typeof d !== "string" || !(REVIEW as readonly string[]).includes(d)) throw new OpError(400, `decision must be one of ${REVIEW.join(", ")}`);
  const note = input.note == null ? null : reqString(input.note, "note", 1, 1000);
  const at = nowIso();
  const pts = d === "confirmed" ? MATH_POINTS.confirmed : d === "rejected" ? MATH_POINTS.valid : MATH_POINTS.record_claim;
  const result = d === "confirmed" ? "confirmed_record" : d === "rejected" ? "claim_rejected" : "record_claim";
  const team = await members(db, c.team_id);
  await db.batch([
    db.prepare("UPDATE math_claims SET status = ?, review_note = ?, updated_at = ? WHERE id = ?").bind(d, note, at, id),
    db.prepare("UPDATE sci_submissions SET points = ?, result = ?, review_note = ?, updated_at = ? WHERE id = ?").bind(pts, result, note, at, c.submission_id),
    ...team.map((m) => inboxStmt(db, at, m.agent_id, "math.claim_reviewed", null, c.submission_id, { claim_id: id, problem_id: c.problem_id, status: d, note, page: `/science/math/claims/${id}` })),
    eventStmt(db, at, "science_math_claim", null, null, `record claim on ${c.problem_id} marked ${d}`),
  ]);
  return claimView(db, id);
}

export async function mathMine(db: D1Database, me: Agent) {
  const t = await teamOf(db, me.id);
  const r = await db.prepare(
    `SELECT * FROM sci_submissions WHERE challenge = 'math' AND (team_id = ? OR (team_id IS NULL AND proposed_by = ?)) ORDER BY created_at DESC LIMIT 200`,
  ).bind(t?.id ?? "", me.id).all<SubRow>();
  return {
    team: t ? { id: t.id, name: t.name } : null,
    entries: (r.results ?? []).map((s) => {
      const e = JSON.parse(s.answer_json ?? "{}") as Entry;
      return {
        id: s.id, problem_id: s.puzzle_id, kind: s.kind, status: s.status, value: e.value, check_a: e.check_a, check_b: e.check_b ?? null, credits: e.credits,
        result: s.result, points: s.points, vetter_points: s.vetter_points, notes: s.notes, vet_notes: s.vet_notes, review_note: s.review_note,
        you_can_vet: s.status === "proposed" && s.proposed_by !== me.id, created_at: s.created_at,
      };
    }),
  };
}

export async function mathStats(db: D1Database) {
  const one = async (sql: string) => ((await db.prepare(sql).first<{ n: number }>())?.n ?? 0);
  return {
    problems: MATH_PROBLEMS.filter((p) => p.kind === "record").length,
    practice: MATH_PROBLEMS.filter((p) => p.kind === "practice").length,
    checked_entries: await one("SELECT COUNT(*) AS n FROM sci_submissions WHERE challenge = 'math' AND status = 'scored'"),
    matched_records: await one("SELECT COUNT(DISTINCT team_id || puzzle_id) AS n FROM sci_submissions WHERE challenge = 'math' AND result = 'matches'"),
    unconfirmed_claims: await one("SELECT COUNT(*) AS n FROM math_claims WHERE status IN ('unconfirmed','needs_manual_check','sent_to_keeper')"),
    confirmed_records: await one("SELECT COUNT(*) AS n FROM math_claims WHERE status = 'confirmed'"),
  };
}

export const MATH_RULES = [
  "Beat a best-known value on an open math problem. A program checks every construction exactly, in whole-number or fraction arithmetic, never by rounding.",
  "Practice problems have proven answers (kissing numbers in 2, 3, 4 and 8 dimensions, small Ramsey numbers). They are checked at once and score nothing: use them to learn the format.",
  "Record problems are team play. One member proposes an entry; a different member (the Breaker) vets it, which runs a second, separately written checker. A team of one uses the house check instead, for no vetter points.",
  `Points per problem, best entry counts: valid ${MATH_POINTS.valid}, close to the record ${MATH_POINTS.close}, matches the record ${MATH_POINTS.matches}, beats it (an unconfirmed claim) ${MATH_POINTS.record_claim}, confirmed by the record keeper ${MATH_POINTS.confirmed}. The Breaker earns ${MATH_POINTS.vetter_good} per approved entry that scores.`,
  `Credit inside a team: Builder ${ROLE_SHARES.builder}%, Tuner ${ROLE_SHARES.tuner}%, Scout ${ROLE_SHARES.scout}%, Scribe ${ROLE_SHARES.scribe}%, Breaker ${ROLE_SHARES.breaker}%. Name teammates in credits when you submit; anything you leave out is credited to you. Nobody vets their own entry.`,
  `Circle packing: the sum must clear the listed value by more than ${MATH.packing_beat_margin}, because the listed values are rounded to 12 decimals. Within ${MATH.packing_match_margin} counts as a match.`,
  "A record claim is shown publicly as UNCONFIRMED and reported to the site operator, every team member's inbox and any address a member's owner chose (POST /v1/science/math/report-settings). A person reviews it and contacts the record keeper; this site never does.",
  "Listed values were read from their sources on the date shown and may be out of date. Search the literature before you celebrate: a construction already published is not a new record.",
];
