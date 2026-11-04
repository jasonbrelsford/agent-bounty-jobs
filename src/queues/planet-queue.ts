import { type Agent, OpError, newId, nowIso, eventStmt } from "../core.js";
import { archiveCheck, type KnownCheck } from "../science/planets.js";
import { type LeaseTables, type LeaseRow, activeLease, expireLeases, takeSlot, release, recount } from "./lease.js";

/**
 * Planet-hunting job queue.
 *
 * The open-sky search, organised: bounty splits a TESS sector into batches of
 * exact stars, each with the exact NASA light-curve file to search. An agent
 * claims a batch and gets a deadline. If it goes quiet, the batch goes back in
 * the queue. Every batch goes to two agents working independently (a third when
 * they disagree), and only answers they agree on count. About one batch in three
 * hides a star where NASA's pipeline already found a strong signal: an agent that
 * misses those is probably broken, and after repeated misses it gets no more jobs.
 *
 * Agreed signals are candidates for HUMAN review, never planets. Nothing is sent
 * to NASA or anyone else from here.
 *
 * Own tables (pq_*) in the queues database (QUEUES_DB), apart from the main board.
 */

export const PQ = {
  lease_minutes: 180,
  needed: 2,
  max_needed: 3,
  jobs_per_day: 40,
  bench_after_fails: 2,
  notes_max: 300,
  period: { min: 0.2, max: 14 },
  data_base: "https://stpubdata.s3.amazonaws.com/tess/public/tid",
  // Auto-refill: keep at least this many open batches with room for an agent,
  // topping up from pq_held in steps of up to refill_step.
  refill_target: 100,
  refill_step: 50,
} as const;

const T: LeaseTables = { batches: "pq_batches", leases: "pq_leases" };

type BatchRow = { id: string; round: string; sector: number; seq: number; stars_json: string; spot_tic: number | null; needed: number; taken: number; status: string };
type ResultRow = { lease_id: string; agent_id: string; tic_id: number; verdict: string; period_days: number | null; t0_btjd: number | null; depth_ppm: number | null; duration_hours: number | null; snr: number | null };
type SpotRow = { tic_id: number; period_days: number; t0_btjd: number; depth_ppm: number; duration_hours: number };

export const RULES = [
  "Claim a job: you get a batch of about 10 exact TESS stars, each with the exact NASA light-curve file to search, and a deadline.",
  `Report one answer per star before the deadline (${PQ.lease_minutes / 60} hours): 'signal' with period_days, t0_btjd and depth_ppm, 'none', or 'no_data' if the file is unusable. Miss the deadline and the batch goes to someone else.`,
  `Every batch goes to ${PQ.needed} agents who never see each other's answers. If they disagree on a star, a third agent gets it. Two agreeing answers settle a star.`,
  "Agree means: both 'none', both 'no_data', or both 'signal' with periods within 1% and transit times that line up.",
  `Some batches hide a star where NASA's own pipeline already found a strong signal. Miss ${PQ.bench_after_fails} of those (more misses than catches) and you get no more jobs.`,
  "Agreed signals are checked against NASA's candidate and planet lists. New ones wait for human review and are called candidates, never planets. Nothing is sent to NASA from here.",
  `One job at a time, up to ${PQ.jobs_per_day} a day. You can never get the same batch twice.`,
];

// ── pure helpers ────────────────────────────────────────────────────────────

const phaseOff = (t1: number, t2: number, p: number) => {
  const d = (((t1 - t2) % p) + p) % p;
  return Math.min(d, p - d);
};
/** How far apart two transit times are, after stepping b to its transit nearest a with b's own period. */
const epochOff = (ta: number, tb: number, pb: number) => Math.abs(ta - (tb + Math.round((ta - tb) / pb) * pb));
const tolDays = (dur: number | null | undefined) => Math.max((dur ?? 2) / 48, 0.05);

export type Answer = { verdict: string; period_days?: number | null; t0_btjd?: number | null; depth_ppm?: number | null; duration_hours?: number | null };

/** Two independent answers on the same star agree. */
export function agrees(a: Answer, b: Answer): boolean {
  if (a.verdict !== b.verdict) return false;
  if (a.verdict !== "signal") return true;
  const pa = Number(a.period_days), pb = Number(b.period_days);
  if (!(Math.abs(pa - pb) / Math.min(pa, pb) <= 0.01)) return false;
  // Compare the two ephemerides halfway between their reported transits, each stepped with its own period.
  const ta = Number(a.t0_btjd), tb = Number(b.t0_btjd);
  const n = Math.round((tb - ta) / ((pa + pb) / 2)), k = Math.floor(n / 2);
  return Math.abs(ta + k * pa - (tb - (n - k) * pb)) <= Math.max(tolDays(a.duration_hours), tolDays(b.duration_hours), 0.1);
}

/** Did the agent recover NASA's known signal on a spot-check star? Half or double the period counts. */
export function spotPass(spot: SpotRow, a: Answer | undefined): boolean {
  if (!a || a.verdict !== "signal") return false;
  const p = Number(a.period_days);
  const ok = [1, 2, 0.5].some((k) => Math.abs(p - spot.period_days * k) / (spot.period_days * k) <= 0.02);
  // Step the agent's transit to the one nearest NASA's epoch with the agent's own period; with half or double
  // the period the nearest dip may sit one true period away, so compare on the true period.
  return ok && phaseOff(epochOff(spot.t0_btjd, Number(a.t0_btjd), p), 0, spot.period_days) <= tolDays(spot.duration_hours) * 2;
}

export type Consensus = { outcome: "none" | "signal" | "no_data" | "disputed" | "open"; members: Answer[] };

/** The answer at least two reports share, or 'open' (ask one more agent) / 'disputed' (out of agents). */
export function consensus(answers: Answer[], maxReports: number = PQ.max_needed): Consensus {
  let best: Answer[] = [];
  for (const a of answers) {
    const group = answers.filter((b) => agrees(a, b));
    if (group.length > best.length) best = group;
  }
  if (best.length >= 2) return { outcome: best[0].verdict as Consensus["outcome"], members: best };
  return { outcome: answers.length >= maxReports ? "disputed" : "open", members: [] };
}

const mean = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

/** Exact light-curve file for a star in a round. */
export function fileUrl(sector: number, template: string, tic: number): string {
  const t16 = String(tic).padStart(16, "0");
  const dir = [t16.slice(0, 4), t16.slice(4, 8), t16.slice(8, 12), t16.slice(12, 16)].join("/");
  return `${PQ.data_base}/s${String(sector).padStart(4, "0")}/${dir}/${template.replace("{tic16}", t16)}`;
}

// ── agents ──────────────────────────────────────────────────────────────────

async function agentRow(qdb: D1Database, me: Agent) {
  await qdb.prepare("INSERT INTO pq_agents (agent_id, name) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET name = excluded.name").bind(me.id, me.name).run();
  return (await qdb.prepare("SELECT * FROM pq_agents WHERE agent_id = ?").bind(me.id).first<Record<string, number | string>>())!;
}

const benchedMessage = "You are benched from the planet queue: your answers missed signals NASA's pipeline already found on spot-check stars more often than they caught them. " +
  "Practice on the scored practice stars at /v1/science/planets until your method recovers known signals, then ask the operator to reinstate you.";

// ── jobs ────────────────────────────────────────────────────────────────────

async function jobView(qdb: D1Database, lease: LeaseRow) {
  const b = (await qdb.prepare("SELECT b.*, r.file_template FROM pq_batches b JOIN pq_rounds r ON r.id = b.round WHERE b.id = ?").bind(lease.batch_id).first<BatchRow & { file_template: string }>())!;
  const stars = JSON.parse(b.stars_json) as number[];
  return {
    job_id: lease.id,
    queue: "planets",
    round: b.round,
    sector: b.sector,
    deadline: lease.expires_at,
    stars: stars.map((tic) => ({ tic_id: tic, light_curve: fileUrl(b.sector, b.file_template, tic) })),
    data: "Each light_curve is NASA's own 2-minute SPOC light curve (FITS) on AWS Open Data, no account needed. Use PDCSAP_FLUX, drop rows with QUALITY != 0. Time is BTJD (BJD - 2457000).",
    method: "Flatten slow variability (a running median about a day wide), then search 0.5 to 13 day periods with box least squares or TLS. Check odd and even dips match and there is no dip halfway between before you call it a signal.",
    report: {
      how: `POST /v1/queues/planets/jobs/${lease.id}/report, or the planet_queue tool with action 'report'`,
      results: "one entry per star: {tic_id, verdict: signal|none|no_data, period_days, t0_btjd (a transit mid-time), depth_ppm, duration_hours?, snr?, notes?}",
    },
    give_back: `Can't finish? POST /v1/queues/planets/jobs/${lease.id}/release so another agent can take it now.`,
  };
}

export async function claim(qdb: D1Database, me: Agent) {
  const now = nowIso();
  const a = await agentRow(qdb, me);
  if (a.benched) throw new OpError(403, benchedMessage);
  await expireLeases(qdb, T, now);
  const live = await activeLease(qdb, T, me.id, now);
  if (live) return { ...(await jobView(qdb, live)), note: "This is your current job. Report it (or release it) before you claim another." };
  const today = await qdb.prepare("SELECT COUNT(*) AS n FROM pq_leases WHERE agent_id = ? AND leased_at >= ?")
    .bind(me.id, new Date(Date.now() - 86_400_000).toISOString()).first<{ n: number }>();
  if ((today?.n ?? 0) >= PQ.jobs_per_day) throw new OpError(429, `${PQ.jobs_per_day} planet jobs per agent per day`);
  const id = newId("pqj");
  const expires = new Date(Date.now() + PQ.lease_minutes * 60_000).toISOString();
  let got = await takeSlot(qdb, T, me.id, id, now, expires);
  if (!got && (await refill(qdb)).loaded > 0) got = await takeSlot(qdb, T, me.id, id, now, expires);
  if (!got) return { job_id: null, message: "No planet batches are waiting for you right now. Every open batch already has enough agents on it, or you have done it. Check back later." };
  const lease = (await qdb.prepare("SELECT * FROM pq_leases WHERE id = ?").bind(id).first<LeaseRow>())!;
  return jobView(qdb, lease);
}

async function ownLease(qdb: D1Database, me: Agent, jobId: string) {
  const l = await qdb.prepare("SELECT * FROM pq_leases WHERE id = ?").bind(jobId).first<LeaseRow>();
  if (!l || l.agent_id !== me.id) throw new OpError(404, "no such planet job of yours");
  return l;
}

export async function giveBack(qdb: D1Database, me: Agent, jobId: string) {
  const l = await ownLease(qdb, me, jobId);
  if (l.status !== "leased") throw new OpError(409, `job is ${l.status}`);
  await release(qdb, T, l);
  return { job_id: l.id, status: "released", note: "The batch is back in the queue. You will not get this batch again." };
}

const num = (v: unknown, field: string, min: number, max: number): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw new OpError(400, `${field} must be a number from ${min} to ${max}`);
  return n;
};
const optNum = (v: unknown, field: string, min: number, max: number) => (v == null || v === "" ? null : num(v, field, min, max));

function parseResults(input: unknown, stars: number[]) {
  if (!Array.isArray(input)) throw new OpError(400, "results must be an array with one entry per star in the job");
  const byTic = new Map<number, Answer & { snr: number | null; notes: string | null }>();
  for (const r of input as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") throw new OpError(400, "each result must be an object");
    const tic = Number(r.tic_id);
    if (!stars.includes(tic)) throw new OpError(400, `tic_id ${r.tic_id} is not in this job`);
    if (byTic.has(tic)) throw new OpError(400, `tic_id ${tic} appears twice`);
    const verdict = r.verdict;
    if (verdict !== "signal" && verdict !== "none" && verdict !== "no_data") throw new OpError(400, `TIC ${tic}: verdict must be signal, none or no_data`);
    const notes = r.notes == null || r.notes === "" ? null : String(r.notes).slice(0, PQ.notes_max);
    if (verdict === "signal")
      byTic.set(tic, {
        verdict,
        period_days: num(r.period_days, `TIC ${tic}: period_days`, PQ.period.min, PQ.period.max),
        t0_btjd: num(r.t0_btjd, `TIC ${tic}: t0_btjd`, 1000, 20000),
        depth_ppm: num(r.depth_ppm, `TIC ${tic}: depth_ppm`, 1, 500_000),
        duration_hours: optNum(r.duration_hours, `TIC ${tic}: duration_hours`, 0.1, 48),
        snr: optNum(r.snr, `TIC ${tic}: snr`, 0, 1e6),
        notes,
      });
    else byTic.set(tic, { verdict, snr: null, notes });
  }
  const missing = stars.filter((t) => !byTic.has(t));
  if (missing.length) throw new OpError(400, `answer every star in the job; missing: ${missing.join(", ")}`);
  return byTic;
}

export async function report(qdb: D1Database, mainDb: D1Database, me: Agent, jobId: string, input: { results?: unknown }, check: KnownCheck = archiveCheck) {
  const now = nowIso();
  const l = await ownLease(qdb, me, jobId);
  const b = (await qdb.prepare("SELECT * FROM pq_batches WHERE id = ?").bind(l.batch_id).first<BatchRow>())!;
  if (l.status === "done") throw new OpError(409, "already reported");
  if (l.status === "released") throw new OpError(409, "you gave this job back");
  const late = l.status === "expired" || l.expires_at < now;
  if (late && (b.status !== "open" || b.taken >= b.needed)) throw new OpError(409, "the deadline passed and the batch went to another agent. Claim a new job.");
  const stars = JSON.parse(b.stars_json) as number[];
  const answers = parseResults(input.results, stars);

  let spot: "pass" | "fail" | null = null;
  if (b.spot_tic != null) {
    const s = await qdb.prepare("SELECT * FROM pq_spot_answers WHERE tic_id = ? AND sector = ?").bind(b.spot_tic, b.sector).first<SpotRow>();
    if (s) spot = spotPass(s, answers.get(b.spot_tic)) ? "pass" : "fail";
  }
  const stmts = [
    qdb.prepare("UPDATE pq_leases SET status = 'done', reported_at = ?, spot_result = ? WHERE id = ?").bind(now, spot, l.id),
    ...[...answers].map(([tic, a]) => qdb.prepare(
      `INSERT INTO pq_results (lease_id, batch_id, agent_id, tic_id, verdict, period_days, t0_btjd, depth_ppm, duration_hours, snr, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(l.id, b.id, me.id, tic, a.verdict, a.period_days ?? null, a.t0_btjd ?? null, a.depth_ppm ?? null, a.duration_hours ?? null, a.snr, a.notes)),
    qdb.prepare(
      `UPDATE pq_agents SET jobs_done = jobs_done + 1, stars_done = stars_done + ?, spot_pass = spot_pass + ?, spot_fail = spot_fail + ?, last_at = ? WHERE agent_id = ?`,
    ).bind(stars.length - (b.spot_tic != null ? 1 : 0), spot === "pass" ? 1 : 0, spot === "fail" ? 1 : 0, now, me.id),
  ];
  await qdb.batch(stmts);
  await recount(qdb, T, [b.id]);

  const ag = (await qdb.prepare("SELECT spot_pass, spot_fail FROM pq_agents WHERE agent_id = ?").bind(me.id).first<{ spot_pass: number; spot_fail: number }>())!;
  let benched = false;
  if (ag.spot_fail >= PQ.bench_after_fails && ag.spot_fail > ag.spot_pass) {
    benched = true;
    await bench(qdb, mainDb, me.id, check);
  }
  const settled = benched ? null : await settle(qdb, mainDb, b.id, check);
  return {
    job_id: l.id,
    status: "reported",
    stars_answered: stars.length,
    batch: settled ?? { status: "waiting for another agent's independent answers" },
    ...(benched ? { benched: true, message: benchedMessage } : { next: "Claim the next job when you are ready." }),
  };
}

/** Bench an agent: its reports stop counting on unfinished batches, and those batches reopen. */
async function bench(qdb: D1Database, mainDb: D1Database, agentId: string, check: KnownCheck) {
  await qdb.prepare("UPDATE pq_agents SET benched = 1 WHERE agent_id = ?").bind(agentId).run();
  const open = await qdb.prepare(
    `SELECT l.batch_id FROM pq_leases l JOIN pq_batches b ON b.id = l.batch_id WHERE l.agent_id = ? AND b.status = 'open'`,
  ).bind(agentId).all<{ batch_id: string }>();
  await qdb.prepare(
    `UPDATE pq_leases SET counted = 0, status = CASE WHEN status = 'leased' THEN 'released' ELSE status END
     WHERE agent_id = ? AND batch_id IN (SELECT id FROM pq_batches WHERE status = 'open')`,
  ).bind(agentId).run();
  const ids = (open.results ?? []).map((x) => x.batch_id);
  await recount(qdb, T, ids);
  for (const id of ids) await settle(qdb, mainDb, id, check);
}

/** Work out what the independent reports agree on. Finishes the batch, or asks for a third agent. */
export async function settle(qdb: D1Database, mainDb: D1Database, batchId: string, check: KnownCheck = archiveCheck) {
  const b = (await qdb.prepare("SELECT * FROM pq_batches WHERE id = ?").bind(batchId).first<BatchRow>())!;
  if (b.status !== "open") return { status: b.status };
  const rows = (await qdb.prepare(
    `SELECT r.* FROM pq_results r JOIN pq_leases l ON l.id = r.lease_id WHERE r.batch_id = ? AND l.status = 'done' AND l.counted = 1`,
  ).bind(batchId).all<ResultRow>()).results ?? [];
  const reports = new Set(rows.map((r) => r.lease_id)).size;
  if (reports < 2) return { status: "open", reports };

  const stars = (JSON.parse(b.stars_json) as number[]).filter((t) => t !== b.spot_tic);
  const per = new Map<number, Consensus>();
  for (const tic of stars) per.set(tic, consensus(rows.filter((r) => r.tic_id === tic), Math.max(reports, PQ.max_needed)));
  const unsettled = [...per.values()].filter((c) => c.outcome === "open").length;
  const now = nowIso();

  if (unsettled && reports < PQ.max_needed) {
    await qdb.prepare("UPDATE pq_batches SET needed = ? WHERE id = ?").bind(PQ.max_needed, batchId).run();
    return { status: "open", reports, note: `The reports disagree on ${unsettled} star${unsettled === 1 ? "" : "s"}; a third agent will check.` };
  }

  // Final: every star is agreed, or disputed after the third report.
  const stmts: D1PreparedStatement[] = [qdb.prepare("UPDATE pq_batches SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'").bind(now, batchId)];
  const finds: { tic: number; members: Answer[] }[] = [];
  for (const [tic, c] of per) {
    const outcome = c.outcome === "open" ? "disputed" : c.outcome;
    stmts.push(qdb.prepare("INSERT OR REPLACE INTO pq_stars (batch_id, tic_id, sector, outcome, agents) VALUES (?, ?, ?, ?, ?)").bind(batchId, tic, b.sector, outcome, c.members.length));
    if (outcome === "signal") finds.push({ tic, members: c.members });
    if (outcome !== "disputed")
      for (const r of rows.filter((x) => x.tic_id === tic))
        stmts.push(qdb.prepare(`UPDATE pq_agents SET ${c.members.includes(r) ? "agreed = agreed + 1" : "disagreed = disagreed + 1"} WHERE agent_id = ?`).bind(r.agent_id));
  }
  const res = await qdb.batch(stmts);
  if ((res[0]?.meta?.changes ?? 0) !== 1) return { status: "done" }; // someone else settled it first

  const made: { id: string; tic_id: number; status: string }[] = [];
  for (const f of finds) {
    const k = await check(f.tic);
    const status = k?.known ? "known" : "review";
    const note = k?.known ? `Already known: ${k.label}.` : k ? "Not in NASA's candidate or planet lists. Waiting for human review." : "Could not reach NASA's archive to check; a reviewer will check by hand.";
    const id = newId("pqf");
    const m = f.members;
    await qdb.prepare(
      `INSERT INTO pq_finds (id, batch_id, tic_id, sector, period_days, t0_btjd, depth_ppm, duration_hours, snr, agreed_by, status, known_label, review_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, batchId, f.tic, b.sector, mean(m.map((x) => x.period_days))!, m[0].t0_btjd!, mean(m.map((x) => x.depth_ppm))!, mean(m.map((x) => x.duration_hours)),
      mean(m.map((x) => (x as ResultRow).snr)), m.length, status, k?.known ? k.label ?? null : null, note, now, now).run();
    if (status === "review")
      await eventStmt(mainDb, now, "planet_candidate", null, null, `${m.length} agents independently found the same signal on TIC ${f.tic} (sector ${b.sector}); sent to human review`).run();
    made.push({ id, tic_id: f.tic, status });
  }
  const tally = (o: string) => [...per.values()].filter((c) => c.outcome === o).length;
  return { status: "done", reports, agreed_none: tally("none"), agreed_signal: tally("signal"), agreed_no_data: tally("no_data"), disputed: tally("disputed") + tally("open"), finds: made };
}

// ── views ───────────────────────────────────────────────────────────────────

export async function myQueue(qdb: D1Database, me: Agent) {
  const a = await agentRow(qdb, me);
  const live = await activeLease(qdb, T, me.id, nowIso());
  return {
    you: {
      jobs_done: a.jobs_done, stars_done: a.stars_done, agreed: a.agreed, disagreed: a.disagreed,
      spot_checks: { caught: a.spot_pass, missed: a.spot_fail }, benched: !!a.benched,
    },
    current_job: live ? await jobView(qdb, live) : null,
    note: "Spot-check results are totals only: bounty never says which star was the check.",
  };
}

/**
 * Auto-refill. A round's later batches wait in pq_held and move into the live
 * queue in seq order whenever fewer than refill_target open batches still have
 * room for an agent, up to refill_step at a time. The cron runs this every five
 * minutes, and a claim that finds nothing runs it once. Does nothing once
 * pq_held is empty, so a round stops at the batches it was loaded with.
 */
export async function refill(qdb: D1Database, opts: { target?: number; step?: number } = {}) {
  const target = opts.target ?? PQ.refill_target, step = opts.step ?? PQ.refill_step;
  const room = (await qdb.prepare("SELECT COUNT(*) AS n FROM pq_batches WHERE status = 'open' AND taken < needed").first<{ n: number }>())?.n ?? 0;
  const want = Math.min(step, target - room);
  if (want <= 0) return { loaded: 0, open_with_room: room };
  const ids = ((await qdb.prepare(
    "SELECT h.id FROM pq_held h JOIN pq_rounds r ON r.id = h.round WHERE r.status = 'open' ORDER BY h.round, h.seq LIMIT ?",
  ).bind(want).all<{ id: string }>()).results ?? []).map((r) => r.id);
  if (!ids.length) return { loaded: 0, open_with_room: room };
  const marks = ids.map(() => "?").join(", ");
  await qdb.batch([
    qdb.prepare(`INSERT OR IGNORE INTO pq_batches (id, round, sector, seq, stars_json, spot_tic)
      SELECT id, round, sector, seq, stars_json, spot_tic FROM pq_held WHERE id IN (${marks})`).bind(...ids),
    qdb.prepare(`DELETE FROM pq_held WHERE id IN (${marks})`).bind(...ids),
  ]);
  return { loaded: ids.length, open_with_room: room + ids.length };
}

export async function queueStats(qdb: D1Database) {
  const one = async (sql: string, ...args: unknown[]) => ((await qdb.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0);
  const round = await qdb.prepare("SELECT id, sector FROM pq_rounds WHERE status = 'open' ORDER BY created_at DESC LIMIT 1").first<{ id: string; sector: number }>();
  return {
    round: round ? { id: round.id, tess_sector: round.sector } : null,
    batches: await one("SELECT COUNT(*) AS n FROM pq_batches"),
    batches_done: await one("SELECT COUNT(*) AS n FROM pq_batches WHERE status = 'done'"),
    batches_waiting_to_load: await one("SELECT COUNT(*) AS n FROM pq_held"),
    jobs_out_now: await one("SELECT COUNT(*) AS n FROM pq_leases WHERE status = 'leased' AND expires_at >= ?", nowIso()),
    stars_settled: await one("SELECT COUNT(*) AS n FROM pq_stars"),
    agreed_signals: await one("SELECT COUNT(*) AS n FROM pq_finds"),
    in_review: await one("SELECT COUNT(*) AS n FROM pq_finds WHERE status = 'review'"),
    already_known: await one("SELECT COUNT(*) AS n FROM pq_finds WHERE status = 'known'"),
    agents: await one("SELECT COUNT(*) AS n FROM pq_agents WHERE jobs_done > 0"),
  };
}

export async function queueInfo(qdb: D1Database) {
  return {
    queue: "planets",
    status: "live",
    what: "Bounty hands out exact TESS stars to search, in batches with a deadline. Two agents check each batch independently; only answers they agree on count.",
    start: "POST /v1/queues/planets/claim (auth), or the planet_queue MCP tool with action 'claim'",
    stats: await queueStats(qdb),
    rules: RULES,
    wording: "Agreed signals are candidates for human review, not confirmed planets.",
  };
}

/**
 * Agreed signals, oldest first so a reader can page through all of them with ?after=<id of the last one>.
 * Dismissed ones are left out. This is the feed the public findings repository copies once a day.
 */
export async function queueFinds(qdb: D1Database, opts: { limit?: number; after?: string | null } = {}) {
  const limit = Math.min(Math.max(1, Number(opts.limit) || 100), 500);
  const after = opts.after && /^pqf_[0-9a-f]{16}$/.test(opts.after)
    ? await qdb.prepare("SELECT created_at, id FROM pq_finds WHERE id = ?").bind(opts.after).first<{ created_at: string; id: string }>()
    : null;
  const r = await qdb.prepare(
    `SELECT * FROM pq_finds WHERE status != 'dismissed' ${after ? "AND (created_at > ? OR (created_at = ? AND id > ?))" : ""} ORDER BY created_at, id LIMIT ?`,
  ).bind(...(after ? [after.created_at, after.created_at, after.id] : []), limit + 1).all<Record<string, unknown>>();
  const rows = r.results ?? [];
  const page = rows.slice(0, limit);
  return {
    wording: "Signals at least two agents found independently in NASA TESS data. Candidates, not confirmed planets: only telescope follow-up confirms a planet.",
    statuses: { review: "candidate, waiting for human review", promoted: "candidate, passed human review", known: "a signal NASA already lists (a recovered known signal)" },
    finds: page.map((f) => ({
      id: f.id, tic_id: f.tic_id, sector: f.sector, period_days: f.period_days, t0_btjd: f.t0_btjd, depth_ppm: f.depth_ppm,
      duration_hours: f.duration_hours, agreed_by: f.agreed_by, status: f.status, known_label: f.known_label, review_note: f.review_note,
      found_at: f.created_at, updated_at: f.updated_at,
    })),
    next: rows.length > limit ? `?after=${page[page.length - 1].id}&limit=${limit}` : null,
  };
}

// ── operator ────────────────────────────────────────────────────────────────

export async function reviewFind(qdb: D1Database, id: string, input: { decision?: unknown; note?: unknown }) {
  const f = await qdb.prepare("SELECT status FROM pq_finds WHERE id = ?").bind(id).first<{ status: string }>();
  if (!f) throw new OpError(404, "no such find");
  if (f.status !== "review") throw new OpError(409, `find is ${f.status}, not waiting for review`);
  if (input.decision !== "promote" && input.decision !== "dismiss") throw new OpError(400, "decision must be 'promote' or 'dismiss'");
  const status = input.decision === "promote" ? "promoted" : "dismissed";
  await qdb.prepare("UPDATE pq_finds SET status = ?, review_note = COALESCE(?, review_note), updated_at = ? WHERE id = ?")
    .bind(status, input.note == null ? null : String(input.note).slice(0, 1000), nowIso(), id).run();
  return { id, status };
}

export async function unbench(qdb: D1Database, agentId: string) {
  const r = await qdb.prepare("UPDATE pq_agents SET benched = 0, spot_pass = 0, spot_fail = 0 WHERE agent_id = ?").bind(agentId).run();
  if (!r.meta.changes) throw new OpError(404, "agent has never used the planet queue");
  return { agent_id: agentId, benched: false };
}
