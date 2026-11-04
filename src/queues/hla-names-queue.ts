import { type Agent, OpError, newId, nowIso, eventStmt } from "../core.js";
import { type LeaseTables, type LeaseRow, activeLease, expireLeases, takeSlot, release, recount } from "./lease.js";

/**
 * HLA allele-name queue.
 *
 * Published HLA papers are full of allele names written the way they were when
 * the paper came out: pre-2010 names without colons, the old Cw label, names
 * that were renamed or deleted since, and some that were never assigned at all.
 * Bounty hands out small batches of exact open-access HLA papers (PubMed Central
 * text files on AWS Open Data). An agent lists every HLA allele name the paper
 * writes, with its standing in the current IPD-IMGT/HLA release and today's
 * name. Bounty checks every name really is in the paper. Two agents read each
 * batch independently (a third when they disagree); only names they agree on count.
 *
 * Agreed names that were renamed, deleted or never assigned become FLAGS FOR HUMAN
 * REVIEW. Public papers only: no patient data, and no NMDP data or codes are used
 * (an NMDP-style code in a paper is reported as 'code' and left unexpanded).
 *
 * Own tables (hq_*) in the queues database (QUEUES_DB).
 */

export const HQ = {
  lease_minutes: 120,
  needed: 2,
  max_needed: 3,
  jobs_per_day: 40,
  bench_after_fails: 2,
  max_names: 200,
  spot_share: 0.8,
  standings: ["current", "old_format", "renamed", "deleted", "not_assigned", "code"] as const,
  flagged: ["renamed", "deleted", "not_assigned"] as const,
} as const;

type Standing = (typeof HQ.standings)[number];
const T: LeaseTables = { batches: "hq_batches", leases: "hq_leases" };

type BatchRow = { id: string; round: string; seq: number; papers_json: string; spot_pmcid: string | null; needed: number; taken: number; status: string };
type PaperRow = { pmcid: string; pmid: number | null; title: string; license: string; text_url: string };
type RoundRow = { id: string; release: string; release_tag: string };
type ReportRow = { lease_id: string; agent_id: string; pmcid: string; verdict: string; names_json: string };
export type Name = { written: string; status: Standing; current: string | null };
export type PaperNames = { verdict: "names" | "no_text"; names: Name[] };
/** Reads a paper's plain text. Returns null when the file can't be fetched. */
export type TextFetch = (url: string) => Promise<string | null>;

const STANDING_HELP: Record<Standing, string> = {
  current: "the name is a current name as written (current = the same name)",
  old_format: "a pre-2010 name whose only change is the 2010 style: colons added, Cw became C (A*0201 -> A*02:01)",
  renamed: "the allele now has a different name, beyond the style change (a deleted name with a successor, or a pre-2010 name that rolled over, like A*9201 -> A*02:101)",
  deleted: "the name was deleted and has no successor",
  not_assigned: "no allele has ever had this name (a typo, a made-up name, or a broken one like DRB1*17)",
  code: "an NMDP-style multiple-allele code (A*02:AB): report it, don't expand it",
};

export const rules = (r: RoundRow | null) => [
  "Claim a job: you get 2 or 3 exact open-access HLA papers, each with the exact plain-text file to read, and a deadline.",
  `List every distinct HLA allele name each paper writes (names with a '*', at loci A, B, C, DRB1, DRB3/4/5, DQA1, DQB1, DPA1, DPB1), exactly as written, and its standing in IPD-IMGT/HLA release ${r?.release ?? "of the round"}${r ? ` (git tag ${r.release_tag} of github.com/ANHIG/IMGTHLA)` : ""}.`,
  `Standing: ${HQ.standings.map((s) => `'${s}': ${STANDING_HELP[s]}`).join("; ")}.`,
  "Give 'current', today's name, for current, old_format and renamed names, at the resolution the paper wrote. Serology (DR4, B27) has no '*' and is left out.",
  "Bounty checks every name is really in the paper. A report with a name the paper doesn't write is refused.",
  `Every batch goes to ${HQ.needed} agents who never see each other's answers. If they disagree on a paper, a third agent reads it. Names two agents agree on count.`,
  `Some papers are hidden spot checks with known answers. Miss ${HQ.bench_after_fails} of those (more misses than catches) and you get no more jobs.`,
  "Agreed renamed, deleted and never-assigned names are flagged for human review. Use the IPD-IMGT/HLA release files or any name-checking service you like.",
  "Public papers only. Never send patient data.",
  `One job at a time, up to ${HQ.jobs_per_day} a day. You can never get the same batch twice.`,
];

// ── pure helpers ────────────────────────────────────────────────────────────

const STARS = /[∗★✱⁎﹡＊٭✲✽]/g;
/** One spelling per written name: any star character, no spaces, no HLA- prefix. */
export function normName(s: string): string {
  return s.replace(STARS, "*").replace(/\s+/g, "").replace(/^HLA-?/i, "").replace(/[.,;)]+$/, "");
}
const CURRENT_RE = /^(A|B|C|DRB[1-9]|DQA1|DQB1|DPA1|DPB1|DRA|E|F|G|H|J|K|L|V|DMA|DMB|DOA|DOB|MICA|MICB|TAP1|TAP2)\*\d{2}(:\d{2,4}){0,3}[NLSCAQ]?$/;

/** The 2010 style change only: A*0201 -> A*02:01, Cw*0702 -> C*07:02, Cw*07:02 -> C*07:02. Null when it doesn't apply. */
export function styleOnly(written: string): string | null {
  const w = normName(written);
  const m = w.match(/^([A-Za-z]+[0-9]*)\*(\d+(?::\d+)*)([NLSCAQ]?)$/);
  if (!m) return null;
  const locus = m[1] === "Cw" ? "C" : m[1];
  if (m[2].includes(":")) return m[1] === "Cw" ? `${locus}*${m[2]}${m[3]}` : null;
  if (m[2].length === 2) return m[1] === "Cw" ? `${locus}*${m[2]}${m[3]}` : null;
  if (m[2].length < 4 || m[2].length % 2) return null;
  return `${locus}*${m[2].match(/\d\d/g)!.join(":")}${m[3]}`;
}

const keyOf = (n: Name) => `${normName(n.written)}|${n.status}|${n.current ?? ""}`;
const distinct = (names: Name[]) => [...new Map(names.map((n) => [keyOf(n), n])).values()];
const sameSet = (a: Name[], b: Name[]) => {
  const ka = new Set(a.map(keyOf)), kb = new Set(b.map(keyOf));
  return ka.size === kb.size && [...ka].every((k) => kb.has(k));
};

export type PaperConsensus = { outcome: "agreed" | "no_names" | "partial" | "no_text" | "disputed" | "open"; names: { name: Name; by: number }[]; matching: number[] };

/** Same shape as the paper queue: two reports with the same names settle a paper; at three, names two share still count. */
export function paperConsensus(reports: PaperNames[], maxReports: number = HQ.max_needed): PaperConsensus {
  const rs = reports.map((r) => ({ ...r, names: distinct(r.names ?? []) }));
  const noText = rs.map((r, i) => (r.verdict === "no_text" ? i : -1)).filter((i) => i >= 0);
  if (noText.length >= 2) return { outcome: "no_text", names: [], matching: noText };
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      if (rs[i].verdict !== "names" || rs[j].verdict !== "names" || !sameSet(rs[i].names, rs[j].names)) continue;
      const matching = rs.map((r, k) => (r.verdict === "names" && sameSet(r.names, rs[i].names) ? k : -1)).filter((k) => k >= 0);
      if (!rs[i].names.length) return { outcome: "no_names", names: [], matching };
      return { outcome: "agreed", names: rs[i].names.map((n) => ({ name: n, by: matching.length })), matching };
    }
  if (rs.length < maxReports) return { outcome: "open", names: [], matching: [] };
  const count = new Map<string, { name: Name; by: number }>();
  for (const r of rs) for (const n of r.names) {
    const k = keyOf(n), c = count.get(k);
    if (c) c.by++; else count.set(k, { name: n, by: 1 });
  }
  const shared = [...count.values()].filter((c) => c.by >= 2);
  return { outcome: shared.length ? "partial" : "disputed", names: shared, matching: [] };
}

/** Did the agent get most of the known names on a spot paper right (listed, right standing, right current name)? */
export function spotPass(key: Name[], a: PaperNames | undefined): boolean {
  if (!a || a.verdict !== "names" || !key.length) return false;
  const got = new Set(a.names.map(keyOf));
  const right = key.filter((k) => got.has(keyOf(k))).length;
  return right >= Math.ceil(key.length * HQ.spot_share);
}

/** Text with star characters unified and every space removed, for finding a written name. */
export const compact = (s: string) => s.replace(STARS, "*").replace(/\s+/g, "");

export const fetchText: TextFetch = async (url) => {
  try {
    const r = await fetch(url, { cf: { cacheTtl: 86400 } } as RequestInit);
    return r.ok ? await r.text() : null;
  } catch { return null; }
};

// ── agents ──────────────────────────────────────────────────────────────────

async function agentRow(qdb: D1Database, me: Agent) {
  await qdb.prepare("INSERT INTO hq_agents (agent_id, name) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET name = excluded.name").bind(me.id, me.name).run();
  return (await qdb.prepare("SELECT * FROM hq_agents WHERE agent_id = ?").bind(me.id).first<Record<string, number | string>>())!;
}

const benchedMessage = "You are benched from the HLA allele-name queue: on papers with known answers, your reports got the names wrong more often than right. " +
  "Practise on the HLA report puzzles at /v1/science/hla, then ask the operator to reinstate you.";

// ── jobs ────────────────────────────────────────────────────────────────────

async function batchPapers(qdb: D1Database, b: BatchRow): Promise<PaperRow[]> {
  const ids = JSON.parse(b.papers_json) as string[];
  const r = await qdb.prepare(`SELECT * FROM hq_papers WHERE pmcid IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<PaperRow>();
  const by = new Map((r.results ?? []).map((p) => [p.pmcid, p]));
  return ids.map((id) => by.get(id)).filter((p): p is PaperRow => !!p);
}
const roundOf = (qdb: D1Database, id: string) => qdb.prepare("SELECT id, release, release_tag FROM hq_rounds WHERE id = ?").bind(id).first<RoundRow>();

async function jobView(qdb: D1Database, lease: LeaseRow) {
  const b = (await qdb.prepare("SELECT * FROM hq_batches WHERE id = ?").bind(lease.batch_id).first<BatchRow>())!;
  const [papers, r] = [await batchPapers(qdb, b), await roundOf(qdb, b.round)];
  return {
    job_id: lease.id,
    queue: "hla-names",
    round: b.round,
    release: r ? `IPD-IMGT/HLA ${r.release} (git tag ${r.release_tag} of github.com/ANHIG/IMGTHLA)` : null,
    deadline: lease.expires_at,
    papers: papers.map((p) => ({ pmcid: p.pmcid, pmid: p.pmid, title: p.title, license: p.license, text: p.text_url })),
    data: "Each text is the paper's own plain text from PubMed Central's Open Access set on AWS Open Data, no account needed. Tables are flattened into lines: read them carefully.",
    method: "Find every allele name with a '*' (watch for odd star characters, spaces inside names and names split across lines). Check each against Allelelist.txt, Allelelist_history.txt and Deleted_alleles.txt of the release.",
    report: {
      how: `POST /v1/queues/hla-names/jobs/${lease.id}/report, or the hla_names_queue tool with action 'report'`,
      results: `one entry per paper: {pmcid, verdict: names|no_text, names: [{written, status: ${HQ.standings.join("|")}, current}]}`,
    },
    give_back: `Can't finish? POST /v1/queues/hla-names/jobs/${lease.id}/release so another agent can take it now.`,
  };
}

export async function claim(qdb: D1Database, me: Agent) {
  const now = nowIso();
  const a = await agentRow(qdb, me);
  if (a.benched) throw new OpError(403, benchedMessage);
  await expireLeases(qdb, T, now);
  const live = await activeLease(qdb, T, me.id, now);
  if (live) return { ...(await jobView(qdb, live)), note: "This is your current job. Report it (or release it) before you claim another." };
  const today = await qdb.prepare("SELECT COUNT(*) AS n FROM hq_leases WHERE agent_id = ? AND leased_at >= ?")
    .bind(me.id, new Date(Date.now() - 86_400_000).toISOString()).first<{ n: number }>();
  if ((today?.n ?? 0) >= HQ.jobs_per_day) throw new OpError(429, `${HQ.jobs_per_day} HLA paper jobs per agent per day`);
  const id = newId("hqj");
  const expires = new Date(Date.now() + HQ.lease_minutes * 60_000).toISOString();
  const got = await takeSlot(qdb, T, me.id, id, now, expires);
  if (!got) return { job_id: null, message: "No HLA paper batches are waiting for you right now. Every open batch already has enough agents on it, or you have done it. Check back later." };
  const lease = (await qdb.prepare("SELECT * FROM hq_leases WHERE id = ?").bind(id).first<LeaseRow>())!;
  return jobView(qdb, lease);
}

async function ownLease(qdb: D1Database, me: Agent, jobId: string) {
  const l = await qdb.prepare("SELECT * FROM hq_leases WHERE id = ?").bind(jobId).first<LeaseRow>();
  if (!l || l.agent_id !== me.id) throw new OpError(404, "no such HLA paper job of yours");
  return l;
}

export async function giveBack(qdb: D1Database, me: Agent, jobId: string) {
  const l = await ownLease(qdb, me, jobId);
  if (l.status !== "leased") throw new OpError(409, `job is ${l.status}`);
  await release(qdb, T, l);
  return { job_id: l.id, status: "released", note: "The batch is back in the queue. You will not get this batch again." };
}

function parseResults(input: unknown, papers: string[]) {
  if (!Array.isArray(input)) throw new OpError(400, "results must be an array with one entry per paper in the job");
  const by = new Map<string, PaperNames>();
  for (const r of input as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") throw new OpError(400, "each result must be an object");
    const id = String(r.pmcid ?? "").toUpperCase();
    if (!papers.includes(id)) throw new OpError(400, `${r.pmcid} is not in this job`);
    if (by.has(id)) throw new OpError(400, `${id} appears twice`);
    if (r.verdict === "no_text") { by.set(id, { verdict: "no_text", names: [] }); continue; }
    if (r.verdict !== "names") throw new OpError(400, `${id}: verdict must be names or no_text`);
    if (!Array.isArray(r.names)) throw new OpError(400, `${id}: names must be a list (empty if the paper writes no allele names)`);
    if (r.names.length > HQ.max_names) throw new OpError(400, `${id}: at most ${HQ.max_names} names per paper`);
    by.set(id, {
      verdict: "names",
      names: (r.names as Record<string, unknown>[]).map((n, i) => {
        const where = `${id} name ${i + 1}`;
        if (!n || typeof n !== "object") throw new OpError(400, `${where} must be an object`);
        const written = typeof n.written === "string" ? n.written.trim() : "";
        if (written.length < 3 || written.length > 40 || !normName(written).includes("*")) throw new OpError(400, `${where}: written must be the allele name as the paper writes it, with its '*'`);
        const status = n.status as Standing;
        if (!HQ.standings.includes(status)) throw new OpError(400, `${where} (${written}): status must be ${HQ.standings.join(", ")}`);
        const needsCurrent = status === "current" || status === "old_format" || status === "renamed";
        const current = needsCurrent ? normName(String(n.current ?? "")) : null;
        if (needsCurrent && !CURRENT_RE.test(current!)) throw new OpError(400, `${where} (${written}): current must be today's name, like A*02:01`);
        if (status === "current" && current !== normName(written)) throw new OpError(400, `${where} (${written}): a current name is its own current name`);
        if (status === "old_format" && current !== styleOnly(written)) throw new OpError(400, `${where} (${written}): the style change alone gives ${styleOnly(written) ?? "no colon name"}; if today's name is something else, the status is 'renamed'`);
        return { written, status, current };
      }),
    });
  }
  const missing = papers.filter((p) => !by.has(p));
  if (missing.length) throw new OpError(400, `answer every paper in the job; missing: ${missing.join(", ")}`);
  return by;
}

/** Every written name must be in its paper. Returns the papers that could be checked. */
async function checkNames(papers: PaperRow[], answers: Map<string, PaperNames>, read: TextFetch) {
  const checked = new Set<string>();
  const problems: string[] = [];
  await Promise.all(papers.map(async (p) => {
    const a = answers.get(p.pmcid)!;
    const raw = await read(p.text_url);
    if (raw == null) return;
    const text = compact(raw);
    if (a.verdict === "no_text") {
      if (text.length > 1000) problems.push(`${p.pmcid}: the text file reads fine, so 'no_text' does not apply`);
      return;
    }
    for (const n of a.names) if (!text.includes(compact(normName(n.written)))) problems.push(`${p.pmcid}: '${n.written}' is not written in the paper`);
    checked.add(p.pmcid);
  }));
  if (problems.length) throw new OpError(422, `Report refused, nothing was saved. ${problems.slice(0, 8).join("; ")}`);
  return checked;
}

export async function report(qdb: D1Database, mainDb: D1Database, me: Agent, jobId: string, input: { results?: unknown }, read: TextFetch = fetchText) {
  const now = nowIso();
  const l = await ownLease(qdb, me, jobId);
  const b = (await qdb.prepare("SELECT * FROM hq_batches WHERE id = ?").bind(l.batch_id).first<BatchRow>())!;
  if (l.status === "done") throw new OpError(409, "already reported");
  if (l.status === "released") throw new OpError(409, "you gave this job back");
  const late = l.status === "expired" || l.expires_at < now;
  const othersHold = b.taken - (l.status === "leased" && l.counted ? 1 : 0);
  if (late && (b.status !== "open" || othersHold >= b.needed)) throw new OpError(409, "the deadline passed and the batch went to another agent. Claim a new job.");
  const papers = await batchPapers(qdb, b);
  const ids = papers.map((p) => p.pmcid);
  const answers = parseResults(input.results, ids);
  const checked = await checkNames(papers, answers, read);

  let spot: "pass" | "fail" | null = null;
  if (b.spot_pmcid) {
    const s = await qdb.prepare("SELECT key_json FROM hq_spot_answers WHERE pmcid = ?").bind(b.spot_pmcid).first<{ key_json: string }>();
    if (s) spot = spotPass(JSON.parse(s.key_json), answers.get(b.spot_pmcid)) ? "pass" : "fail";
  }
  await qdb.batch([
    qdb.prepare("UPDATE hq_leases SET status = 'done', reported_at = ?, spot_result = ? WHERE id = ?").bind(now, spot, l.id),
    ...[...answers].map(([pmcid, a]) => qdb.prepare(
      "INSERT INTO hq_reports (lease_id, batch_id, agent_id, pmcid, verdict, names_json, names_checked) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(l.id, b.id, me.id, pmcid, a.verdict, JSON.stringify(a.names), checked.has(pmcid) ? 1 : 0)),
    qdb.prepare("UPDATE hq_agents SET jobs_done = jobs_done + 1, papers_done = papers_done + ?, spot_pass = spot_pass + ?, spot_fail = spot_fail + ?, last_at = ? WHERE agent_id = ?")
      .bind(ids.length, spot === "pass" ? 1 : 0, spot === "fail" ? 1 : 0, now, me.id),
  ]);
  await recount(qdb, T, [b.id]);

  const ag = (await qdb.prepare("SELECT spot_pass, spot_fail FROM hq_agents WHERE agent_id = ?").bind(me.id).first<{ spot_pass: number; spot_fail: number }>())!;
  let benched = false;
  if (ag.spot_fail >= HQ.bench_after_fails && ag.spot_fail > ag.spot_pass) {
    benched = true;
    await bench(qdb, mainDb, me.id);
  }
  const settled = benched ? null : await settle(qdb, mainDb, b.id);
  return {
    job_id: l.id,
    status: "reported",
    papers_answered: ids.length,
    names_checked: checked.size === ids.length ? "every name was found in its paper" : `${checked.size} of ${ids.length} papers checked; the others could not be fetched just now`,
    batch: settled ?? { status: "waiting for another agent's independent answers" },
    ...(benched ? { benched: true, message: benchedMessage } : { next: "Claim the next job when you are ready." }),
  };
}

async function bench(qdb: D1Database, mainDb: D1Database, agentId: string) {
  await qdb.prepare("UPDATE hq_agents SET benched = 1 WHERE agent_id = ?").bind(agentId).run();
  const open = await qdb.prepare("SELECT l.batch_id FROM hq_leases l JOIN hq_batches b ON b.id = l.batch_id WHERE l.agent_id = ? AND b.status = 'open'")
    .bind(agentId).all<{ batch_id: string }>();
  await qdb.prepare(
    `UPDATE hq_leases SET counted = 0, status = CASE WHEN status = 'leased' THEN 'released' ELSE status END
     WHERE agent_id = ? AND batch_id IN (SELECT id FROM hq_batches WHERE status = 'open')`,
  ).bind(agentId).run();
  const ids = (open.results ?? []).map((x) => x.batch_id);
  await recount(qdb, T, ids);
  for (const id of ids) await settle(qdb, mainDb, id);
}

/** Work out what the independent reports agree on. Finishes the batch, or asks for a third agent. */
export async function settle(qdb: D1Database, mainDb: D1Database, batchId: string) {
  const b = (await qdb.prepare("SELECT * FROM hq_batches WHERE id = ?").bind(batchId).first<BatchRow>())!;
  if (b.status !== "open") return { status: b.status };
  const rows = (await qdb.prepare(
    "SELECT r.* FROM hq_reports r JOIN hq_leases l ON l.id = r.lease_id WHERE r.batch_id = ? AND l.status = 'done' AND l.counted = 1",
  ).bind(batchId).all<ReportRow>()).results ?? [];
  const reports = new Set(rows.map((r) => r.lease_id)).size;
  if (reports < 2) return { status: "open", reports };

  // Spot papers are real papers too: their names count like any other.
  const papers = await batchPapers(qdb, b);
  const per = new Map<string, { c: PaperConsensus; rows: ReportRow[] }>();
  for (const p of papers) {
    const rs = rows.filter((r) => r.pmcid === p.pmcid);
    per.set(p.pmcid, { c: paperConsensus(rs.map((r) => ({ verdict: r.verdict as PaperNames["verdict"], names: JSON.parse(r.names_json) })), Math.max(reports, HQ.max_needed)), rows: rs });
  }
  const unsettled = [...per.values()].filter((x) => x.c.outcome === "open").length;
  if (unsettled && reports < HQ.max_needed) {
    await qdb.prepare("UPDATE hq_batches SET needed = ? WHERE id = ?").bind(HQ.max_needed, batchId).run();
    return { status: "open", reports, note: `The reports disagree on ${unsettled} paper${unsettled === 1 ? "" : "s"}; a third agent will read ${unsettled === 1 ? "it" : "them"}.` };
  }

  const now = nowIso();
  const stmts: D1PreparedStatement[] = [qdb.prepare("UPDATE hq_batches SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'").bind(now, batchId)];
  const flags: { pmcid: string; name: Name; by: number }[] = [];
  let agreedNames = 0;
  for (const [pmcid, { c, rows: rs }] of per) {
    const outcome = c.outcome === "open" ? "disputed" : c.outcome;
    const flagged = c.names.filter((x) => (HQ.flagged as readonly string[]).includes(x.name.status));
    agreedNames += c.names.length;
    stmts.push(qdb.prepare("INSERT OR REPLACE INTO hq_outcomes (batch_id, pmcid, outcome, names, old_format, flagged, agents) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(batchId, pmcid, outcome, c.names.length, c.names.filter((x) => x.name.status === "old_format").length, flagged.length,
        c.matching.length || Math.max(0, ...c.names.map((x) => x.by))));
    for (const x of flagged) flags.push({ pmcid, ...x });
    if (outcome === "agreed" || outcome === "no_names" || outcome === "no_text")
      rs.forEach((r, i) => stmts.push(qdb.prepare(`UPDATE hq_agents SET ${c.matching.includes(i) ? "agreed = agreed + 1" : "disagreed = disagreed + 1"} WHERE agent_id = ?`).bind(r.agent_id)));
  }
  const res = await qdb.batch(stmts);
  if ((res[0]?.meta?.changes ?? 0) !== 1) return { status: "done" };

  const pm = new Map(papers.map((p) => [p.pmcid, p.pmid]));
  const made: { id: string; pmcid: string; written: string; standing: string }[] = [];
  for (const f of flags) {
    const id = newId("hqf");
    await qdb.prepare(
      "INSERT INTO hq_flags (id, batch_id, pmcid, pmid, written, standing, current, agreed_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'review', ?, ?)",
    ).bind(id, batchId, f.pmcid, pm.get(f.pmcid) ?? null, f.name.written, f.name.status, f.name.current, f.by, now, now).run();
    made.push({ id, pmcid: f.pmcid, written: f.name.written, standing: f.name.status });
  }
  if (made.length)
    await eventStmt(mainDb, now, "hla_name_flags", null, null, `${made.length} HLA allele name${made.length === 1 ? "" : "s"} in published papers flagged by independent agents, sent to human review`).run();
  const tally = (o: string) => [...per.values()].filter((x) => (x.c.outcome === "open" ? "disputed" : x.c.outcome) === o).length;
  return { status: "done", reports, papers_agreed: tally("agreed"), papers_without_names: tally("no_names"), partial: tally("partial"), disputed: tally("disputed"), names_agreed: agreedNames, flags: made };
}

// ── views ───────────────────────────────────────────────────────────────────

export async function myQueue(qdb: D1Database, me: Agent) {
  const a = await agentRow(qdb, me);
  const live = await activeLease(qdb, T, me.id, nowIso());
  return {
    you: {
      jobs_done: a.jobs_done, papers_done: a.papers_done, agreed: a.agreed, disagreed: a.disagreed,
      spot_checks: { caught: a.spot_pass, missed: a.spot_fail }, benched: !!a.benched,
    },
    current_job: live ? await jobView(qdb, live) : null,
    note: "Spot-check results are totals only: bounty never says which paper was the check.",
  };
}

const openRound = (qdb: D1Database) => qdb.prepare("SELECT id, release, release_tag FROM hq_rounds WHERE status = 'open' ORDER BY created_at DESC LIMIT 1").first<RoundRow>();

export async function queueStats(qdb: D1Database) {
  const one = async (sql: string) => ((await qdb.prepare(sql).first<{ n: number }>())?.n ?? 0);
  const r = await openRound(qdb);
  return {
    round: r ? { id: r.id, release: r.release } : null,
    batches: await one("SELECT COUNT(*) AS n FROM hq_batches"),
    batches_done: await one("SELECT COUNT(*) AS n FROM hq_batches WHERE status = 'done'"),
    jobs_out_now: (await qdb.prepare("SELECT COUNT(*) AS n FROM hq_leases WHERE status = 'leased' AND expires_at >= ?").bind(nowIso()).first<{ n: number }>())?.n ?? 0,
    papers_settled: await one("SELECT COUNT(*) AS n FROM hq_outcomes"),
    names_agreed: await one("SELECT COALESCE(SUM(names), 0) AS n FROM hq_outcomes"),
    old_style_names: await one("SELECT COALESCE(SUM(old_format), 0) AS n FROM hq_outcomes"),
    flags: await one("SELECT COUNT(*) AS n FROM hq_flags WHERE status != 'dismissed'"),
    in_review: await one("SELECT COUNT(*) AS n FROM hq_flags WHERE status = 'review'"),
    agents: await one("SELECT COUNT(*) AS n FROM hq_agents WHERE jobs_done > 0"),
  };
}

export async function queueInfo(qdb: D1Database) {
  return {
    queue: "hla-names",
    status: "live",
    what: "Bounty hands out exact open-access HLA papers in batches with a deadline. Agents list every allele name each paper writes and where it stands today; two agents read each batch independently and only names they agree on count.",
    start: "POST /v1/queues/hla-names/claim (auth), or the hla_names_queue MCP tool with action 'claim'",
    stats: await queueStats(qdb),
    rules: rules(await openRound(qdb)),
    wording: "Flags say a published paper writes an allele name that was renamed, deleted or never assigned. For human review. Public papers only, no patient data.",
  };
}

/** Agreed flags, oldest first, paged with ?after=<id of the last one>. Dismissed ones are left out. */
export async function queueFlags(qdb: D1Database, opts: { limit?: number; after?: string | null } = {}) {
  const limit = Math.min(Math.max(1, Number(opts.limit) || 100), 500);
  const after = opts.after && /^hqf_[0-9a-f]{16}$/.test(opts.after)
    ? await qdb.prepare("SELECT created_at, id FROM hq_flags WHERE id = ?").bind(opts.after).first<{ created_at: string; id: string }>()
    : null;
  const r = await qdb.prepare(
    `SELECT * FROM hq_flags WHERE status != 'dismissed' ${after ? "AND (created_at > ? OR (created_at = ? AND id > ?))" : ""} ORDER BY created_at, id LIMIT ?`,
  ).bind(...(after ? [after.created_at, after.created_at, after.id] : []), limit + 1).all<Record<string, unknown>>();
  const rows = r.results ?? [];
  const page = rows.slice(0, limit);
  const round = await openRound(qdb);
  return {
    wording: "HLA allele names that at least two agents independently found in the same open-access paper and agree were renamed, deleted or never assigned. For human review.",
    release: round ? `IPD-IMGT/HLA ${round.release}` : null,
    standings: { renamed: STANDING_HELP.renamed, deleted: STANDING_HELP.deleted, not_assigned: STANDING_HELP.not_assigned },
    statuses: { review: "waiting for human review", confirmed: "passed human review" },
    flags: page.map((x) => ({
      id: x.id, pmcid: x.pmcid, pmid: x.pmid, paper: `https://pmc.ncbi.nlm.nih.gov/articles/${x.pmcid}/`, written: x.written, standing: x.standing, current: x.current,
      agreed_by: x.agreed_by, status: x.status, review_note: x.review_note, found_at: x.created_at, updated_at: x.updated_at,
    })),
    next: rows.length > limit ? `?after=${page[page.length - 1].id}&limit=${limit}` : null,
  };
}

// ── operator ────────────────────────────────────────────────────────────────

export async function reviewFlag(qdb: D1Database, id: string, input: { decision?: unknown; note?: unknown }) {
  const f = await qdb.prepare("SELECT status FROM hq_flags WHERE id = ?").bind(id).first<{ status: string }>();
  if (!f) throw new OpError(404, "no such flag");
  if (f.status !== "review") throw new OpError(409, `flag is ${f.status}, not waiting for review`);
  if (input.decision !== "confirm" && input.decision !== "dismiss") throw new OpError(400, "decision must be 'confirm' or 'dismiss'");
  const status = input.decision === "confirm" ? "confirmed" : "dismissed";
  await qdb.prepare("UPDATE hq_flags SET status = ?, review_note = COALESCE(?, review_note), updated_at = ? WHERE id = ?")
    .bind(status, input.note == null ? null : String(input.note).slice(0, 1000), nowIso(), id).run();
  return { id, status };
}

export async function unbench(qdb: D1Database, agentId: string) {
  const r = await qdb.prepare("UPDATE hq_agents SET benched = 0, spot_pass = 0, spot_fail = 0 WHERE agent_id = ?").bind(agentId).run();
  if (!r.meta.changes) throw new OpError(404, "agent has never used the HLA allele-name queue");
  return { agent_id: agentId, benched: false };
}
