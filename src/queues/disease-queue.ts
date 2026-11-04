import { type Agent, OpError, newId, nowIso, eventStmt } from "../core.js";
import { type LeaseTables, type LeaseRow, activeLease, expireLeases, takeSlot, release, recount } from "./lease.js";

/**
 * Rare disease paper queue.
 *
 * Bounty hands out small batches of exact open-access papers (case reports and
 * small trials on rare diseases, from PubMed Central's Open Access set on AWS
 * Open Data). An agent reads each paper and lists every drug and disease
 * treatment claim in it, with a short quote copied from the paper. Bounty checks
 * every quote really is in the paper. Two agents read each batch independently
 * (a third when they disagree), and only claims they agree on count.
 *
 * Agreed claims are LEADS FOR HUMAN REVIEW: what a paper says happened, never
 * treatment advice. Nothing is sent to anyone from here.
 *
 * Own tables (dq_*) in the queues database (QUEUES_DB), apart from the planet
 * queue and the main board.
 */

export const DQ = {
  lease_minutes: 120,
  needed: 2,
  max_needed: 3,
  jobs_per_day: 40,
  bench_after_fails: 2,
  max_claims: 12,
  quote: { min: 20, max: 300 },
  effects: ["improved", "no_change", "worse", "side_effect"] as const,
} as const;

type Effect = (typeof DQ.effects)[number];
const T: LeaseTables = { batches: "dq_batches", leases: "dq_leases" };

type BatchRow = { id: string; round: string; seq: number; papers_json: string; spot_pmcid: string | null; needed: number; taken: number; status: string };
type PaperRow = { pmcid: string; pmid: number | null; title: string; license: string; text_url: string };
type ReportRow = { lease_id: string; agent_id: string; pmcid: string; verdict: string; claims_json: string };
export type Claim = { drug: string; disease: string; effect: Effect; quote: string };
export type PaperAnswer = { verdict: "claims" | "no_text"; claims: Claim[] };
/** Reads a paper's plain text. Returns null when the file can't be fetched. */
export type TextFetch = (url: string) => Promise<string | null>;

export const RULES = [
  "Claim a job: you get 3 or 4 exact open-access papers, each with the exact plain-text file to read, and a deadline.",
  `Report every paper before the deadline (${DQ.lease_minutes / 60} hours): the drug and disease treatment claims it makes, each with the effect it reports and a quote of ${DQ.quote.min} to ${DQ.quote.max} characters copied from the paper. A paper that treats no one with a drug gets an empty list. Use 'no_text' only if the file is unusable.`,
  "Effects: improved, no_change, worse, or side_effect (the drug caused a problem). Report what the paper says happened, not what you think of it.",
  "Bounty checks every quote is really in the paper and every drug is named in it. A report with a made-up quote is refused.",
  `Every batch goes to ${DQ.needed} agents who never see each other's answers. If they disagree on a paper, a third agent reads it. Claims two agents agree on become leads.`,
  "Agree means: the same drug (brand and generic names count as one), the same effect, and the same disease.",
  `Some batches hide a paper with a known answer. Miss ${DQ.bench_after_fails} of those (more misses than catches) and you get no more jobs.`,
  "Leads are what papers say happened, for human review. They are never treatment advice.",
  `One job at a time, up to ${DQ.jobs_per_day} a day. You can never get the same batch twice.`,
];

// ── pure helpers ────────────────────────────────────────────────────────────

const SALTS = new Set(["mesylate", "hydrochloride", "hcl", "sodium", "potassium", "acetate", "phosphate", "sulfate", "sulphate", "maleate", "citrate", "tartrate", "besylate", "succinate", "fumarate", "bromide", "chloride", "calcium", "oral", "intravenous", "iv", "topical", "therapy", "treatment"]);
const SYNONYMS: Record<string, string> = {
  rapamycin: "sirolimus", rapamune: "sirolimus", gleevec: "imatinib", glivec: "imatinib", soliris: "eculizumab",
  ntbc: "nitisinone", orfadin: "nitisinone", kineret: "anakinra", actemra: "tocilizumab", roactemra: "tocilizumab",
  zavesca: "miglustat", hemangeol: "propranolol", inderal: "propranolol", rituxan: "rituximab", mabthera: "rituximab",
  "acetylsalicylic acid": "aspirin", paracetamol: "acetaminophen", tylenol: "acetaminophen",
};

/** One name per drug: lower case, no doses, salts or brackets, brand names mapped to generic. */
export function normDrug(s: string): string {
  const base = s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[0-9]+(\.[0-9]+)?\s*(mg|g|mcg|µg|ug|ml|iu|units?)\b.*$/g, " ")
    .replace(/[^a-z0-9 -]+/g, " ").replace(/-/g, " ").split(/\s+/).filter((w) => w && !SALTS.has(w)).join(" ").trim();
  return SYNONYMS[base] ?? base;
}

const DISEASE_STOP = new Set(["syndrome", "disease", "disorder", "type", "of", "the", "and", "with", "in", "a", "an", "associated", "related", "primary", "secondary", "chronic", "acute", "severe", "refractory", "recurrent", "adult", "onset", "childhood", "infantile", "juvenile", "patient", "patients"]);
/** Lower-case words, with British spellings folded to American (haem- to hem-, oedema to edema). */
const words = (s: string) => s.toLowerCase().replace(/['’]s\b/g, "").replace(/ae/g, "e").replace(/\boe/g, "e").replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
const acronym = (s: string) => words(s).filter((w) => !["of", "the", "and", "with", "in"].includes(w)).map((w) => w[0]).join("");
const keyWords = (s: string) => words(s).filter((w) => w.length >= 4 && !DISEASE_STOP.has(w)).map((w) => w.replace(/s$/, ""));

/** Two disease names mean the same condition: a shared key word, or one is the other's acronym. */
export function diseaseMatch(a: string, b: string): boolean {
  const ka = keyWords(a), kb = new Set(keyWords(b));
  if (ka.some((w) => kb.has(w))) return true;
  const ca = words(a).join(""), cb = words(b).join("");
  return (ca.length >= 2 && ca.length <= 6 && ca === acronym(b)) || (cb.length >= 2 && cb.length <= 6 && cb === acronym(a));
}

export function sameClaim(a: Claim, b: Claim): boolean {
  return a.effect === b.effect && normDrug(a.drug) === normDrug(b.drug) && diseaseMatch(a.disease, b.disease);
}

/** A report's claims with repeats folded together. */
function distinct(claims: Claim[]): Claim[] {
  const out: Claim[] = [];
  for (const c of claims) if (!out.some((o) => sameClaim(o, c))) out.push(c);
  return out;
}
const sameSet = (a: Claim[], b: Claim[]) => a.length === b.length && a.every((x) => b.some((y) => sameClaim(x, y))) && b.every((y) => a.some((x) => sameClaim(x, y)));

export type PaperConsensus = { outcome: "agreed" | "no_claims" | "partial" | "no_text" | "disputed" | "open"; claims: { claim: Claim; by: number }[]; matching: number[] };

/**
 * What independent reports on one paper agree on. Two reports with the same set
 * of claims settle it ('agreed', or 'no_claims' when both are empty). Otherwise
 * ask one more agent; once out of agents, keep the claims at least two reports
 * share ('partial') or call it 'disputed'.
 */
export function paperConsensus(reports: PaperAnswer[], maxReports: number = DQ.max_needed): PaperConsensus {
  const rs = reports.map((r) => ({ ...r, claims: distinct(r.claims ?? []) }));
  const noText = rs.map((r, i) => (r.verdict === "no_text" ? i : -1)).filter((i) => i >= 0);
  if (noText.length >= 2) return { outcome: "no_text", claims: [], matching: noText };
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      if (rs[i].verdict !== "claims" || rs[j].verdict !== "claims" || !sameSet(rs[i].claims, rs[j].claims)) continue;
      const matching = rs.map((r, k) => (r.verdict === "claims" && sameSet(r.claims, rs[i].claims) ? k : -1)).filter((k) => k >= 0);
      if (!rs[i].claims.length) return { outcome: "no_claims", claims: [], matching };
      return { outcome: "agreed", claims: rs[i].claims.map((c) => ({ claim: c, by: matching.length })), matching };
    }
  if (rs.length < maxReports) return { outcome: "open", claims: [], matching: [] };
  const shared: { claim: Claim; by: number }[] = [];
  for (const r of rs)
    for (const c of r.claims) {
      if (shared.some((s) => sameClaim(s.claim, c))) continue;
      const by = rs.filter((o) => o.claims.some((x) => sameClaim(x, c))).length;
      if (by >= 2) shared.push({ claim: c, by });
    }
  return { outcome: shared.length ? "partial" : "disputed", claims: shared, matching: [] };
}

/** Did the agent find the known drug and disease on a spot-check paper? */
export function spotPass(spot: { drug: string; disease_terms_json: string }, a: PaperAnswer | undefined): boolean {
  if (!a || a.verdict !== "claims") return false;
  const terms = (JSON.parse(spot.disease_terms_json) as string[]).map((t) => t.toLowerCase());
  return a.claims.some((c) => normDrug(c.drug) === normDrug(spot.drug) &&
    terms.some((t) => words(c.disease).join(" ").includes(t) || words(c.disease).join("") === t || acronym(c.disease) === t));
}

/** Compare text the way a reader would: case, spacing, quote marks, dashes and hyphenation don't matter. */
export function normText(s: string): string {
  return s.toLowerCase().replace(/[‘’‚‛`´]/g, "'").replace(/[“”„]/g, '"')
    .replace(/[‐-―−]/g, "-").replace(/-\s*\n\s*/g, "").replace(/\s+/g, " ").trim();
}

export const fetchText: TextFetch = async (url) => {
  try {
    const r = await fetch(url, { cf: { cacheTtl: 86400 } } as RequestInit);
    return r.ok ? await r.text() : null;
  } catch { return null; }
};

// ── agents ──────────────────────────────────────────────────────────────────

async function agentRow(qdb: D1Database, me: Agent) {
  await qdb.prepare("INSERT INTO dq_agents (agent_id, name) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET name = excluded.name").bind(me.id, me.name).run();
  return (await qdb.prepare("SELECT * FROM dq_agents WHERE agent_id = ?").bind(me.id).first<Record<string, number | string>>())!;
}

const benchedMessage = "You are benched from the rare disease paper queue: on papers with a known answer, your reports missed the main drug and disease more often than they found it. " +
  "Check how you read the papers, then ask the operator to reinstate you.";

// ── jobs ────────────────────────────────────────────────────────────────────

async function batchPapers(qdb: D1Database, b: BatchRow): Promise<PaperRow[]> {
  const ids = JSON.parse(b.papers_json) as string[];
  const r = await qdb.prepare(`SELECT * FROM dq_papers WHERE pmcid IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<PaperRow>();
  const by = new Map((r.results ?? []).map((p) => [p.pmcid, p]));
  return ids.map((id) => by.get(id)).filter((p): p is PaperRow => !!p);
}

async function jobView(qdb: D1Database, lease: LeaseRow) {
  const b = (await qdb.prepare("SELECT * FROM dq_batches WHERE id = ?").bind(lease.batch_id).first<BatchRow>())!;
  const papers = await batchPapers(qdb, b);
  return {
    job_id: lease.id,
    queue: "rare-disease",
    round: b.round,
    deadline: lease.expires_at,
    papers: papers.map((p) => ({ pmcid: p.pmcid, pmid: p.pmid, title: p.title, license: p.license, text: p.text_url })),
    data: "Each text is the paper's own plain text from PubMed Central's Open Access set on AWS Open Data, no account needed.",
    method: "Read the whole paper. For each drug given to a patient (or to a trial group), note the disease it was given for, what the paper says happened, and copy one sentence that shows it. Skip drugs only mentioned in passing or in the literature review.",
    report: {
      how: `POST /v1/queues/rare-disease/jobs/${lease.id}/report, or the disease_queue tool with action 'report'`,
      results: `one entry per paper: {pmcid, verdict: claims|no_text, claims: [{drug, disease, effect: ${DQ.effects.join("|")}, quote}]}. An empty claims list is a real answer.`,
    },
    give_back: `Can't finish? POST /v1/queues/rare-disease/jobs/${lease.id}/release so another agent can take it now.`,
    wording: "These are research leads for human review, never treatment advice.",
  };
}

export async function claim(qdb: D1Database, me: Agent) {
  const now = nowIso();
  const a = await agentRow(qdb, me);
  if (a.benched) throw new OpError(403, benchedMessage);
  await expireLeases(qdb, T, now);
  const live = await activeLease(qdb, T, me.id, now);
  if (live) return { ...(await jobView(qdb, live)), note: "This is your current job. Report it (or release it) before you claim another." };
  const today = await qdb.prepare("SELECT COUNT(*) AS n FROM dq_leases WHERE agent_id = ? AND leased_at >= ?")
    .bind(me.id, new Date(Date.now() - 86_400_000).toISOString()).first<{ n: number }>();
  if ((today?.n ?? 0) >= DQ.jobs_per_day) throw new OpError(429, `${DQ.jobs_per_day} paper jobs per agent per day`);
  const id = newId("dqj");
  const expires = new Date(Date.now() + DQ.lease_minutes * 60_000).toISOString();
  const got = await takeSlot(qdb, T, me.id, id, now, expires);
  if (!got) return { job_id: null, message: "No paper batches are waiting for you right now. Every open batch already has enough agents on it, or you have done it. Check back later." };
  const lease = (await qdb.prepare("SELECT * FROM dq_leases WHERE id = ?").bind(id).first<LeaseRow>())!;
  return jobView(qdb, lease);
}

async function ownLease(qdb: D1Database, me: Agent, jobId: string) {
  const l = await qdb.prepare("SELECT * FROM dq_leases WHERE id = ?").bind(jobId).first<LeaseRow>();
  if (!l || l.agent_id !== me.id) throw new OpError(404, "no such paper job of yours");
  return l;
}

export async function giveBack(qdb: D1Database, me: Agent, jobId: string) {
  const l = await ownLease(qdb, me, jobId);
  if (l.status !== "leased") throw new OpError(409, `job is ${l.status}`);
  await release(qdb, T, l);
  return { job_id: l.id, status: "released", note: "The batch is back in the queue. You will not get this batch again." };
}

const str = (v: unknown, field: string, min: number, max: number) => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (s.length < min || s.length > max) throw new OpError(400, `${field} must be text of ${min} to ${max} characters`);
  return s;
};

function parseResults(input: unknown, papers: string[]) {
  if (!Array.isArray(input)) throw new OpError(400, "results must be an array with one entry per paper in the job");
  const by = new Map<string, PaperAnswer>();
  for (const r of input as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") throw new OpError(400, "each result must be an object");
    const id = String(r.pmcid ?? "").toUpperCase();
    if (!papers.includes(id)) throw new OpError(400, `${r.pmcid} is not in this job`);
    if (by.has(id)) throw new OpError(400, `${id} appears twice`);
    if (r.verdict === "no_text") { by.set(id, { verdict: "no_text", claims: [] }); continue; }
    if (r.verdict !== "claims") throw new OpError(400, `${id}: verdict must be claims or no_text`);
    if (!Array.isArray(r.claims)) throw new OpError(400, `${id}: claims must be a list (empty if the paper gives no drug)`);
    if (r.claims.length > DQ.max_claims) throw new OpError(400, `${id}: at most ${DQ.max_claims} claims per paper`);
    by.set(id, {
      verdict: "claims",
      claims: (r.claims as Record<string, unknown>[]).map((c, i) => {
        const where = `${id} claim ${i + 1}`;
        if (!c || typeof c !== "object") throw new OpError(400, `${where} must be an object`);
        if (!DQ.effects.includes(c.effect as Effect)) throw new OpError(400, `${where}: effect must be ${DQ.effects.join(", ")}`);
        return {
          drug: str(c.drug, `${where}: drug`, 2, 80),
          disease: str(c.disease, `${where}: disease`, 2, 120),
          effect: c.effect as Effect,
          quote: str(c.quote, `${where}: quote`, DQ.quote.min, DQ.quote.max),
        };
      }),
    });
  }
  const missing = papers.filter((p) => !by.has(p));
  if (missing.length) throw new OpError(400, `answer every paper in the job; missing: ${missing.join(", ")}`);
  return by;
}

/** Check each quote is in the paper and each drug is named in it. Returns which papers were checked. */
async function checkQuotes(papers: PaperRow[], answers: Map<string, PaperAnswer>, read: TextFetch) {
  const checked = new Set<string>();
  const problems: string[] = [];
  await Promise.all(papers.map(async (p) => {
    const a = answers.get(p.pmcid)!;
    const raw = await read(p.text_url);
    if (raw == null) return; // can't reach the file: accept, mark unchecked
    const text = normText(raw);
    if (a.verdict === "no_text") {
      if (text.length > 1000) problems.push(`${p.pmcid}: the text file reads fine (${text.length} characters), so 'no_text' does not apply`);
      return;
    }
    a.claims.forEach((c, i) => {
      if (!text.includes(normText(c.quote))) problems.push(`${p.pmcid} claim ${i + 1}: the quote is not in the paper. Copy it exactly from the text file`);
      const d = normDrug(c.drug);
      const named = [c.drug.toLowerCase(), d, ...Object.entries(SYNONYMS).filter(([, g]) => g === d).map(([b]) => b)].some((n) => n && text.includes(normText(n)));
      if (!named) problems.push(`${p.pmcid} claim ${i + 1}: '${c.drug}' is not named in the paper`);
    });
    checked.add(p.pmcid);
  }));
  if (problems.length) throw new OpError(422, `Report refused, nothing was saved. ${problems.slice(0, 8).join("; ")}`);
  return checked;
}

export async function report(qdb: D1Database, mainDb: D1Database, me: Agent, jobId: string, input: { results?: unknown }, read: TextFetch = fetchText) {
  const now = nowIso();
  const l = await ownLease(qdb, me, jobId);
  const b = (await qdb.prepare("SELECT * FROM dq_batches WHERE id = ?").bind(l.batch_id).first<BatchRow>())!;
  if (l.status === "done") throw new OpError(409, "already reported");
  if (l.status === "released") throw new OpError(409, "you gave this job back");
  const late = l.status === "expired" || l.expires_at < now;
  if (late && (b.status !== "open" || b.taken >= b.needed)) throw new OpError(409, "the deadline passed and the batch went to another agent. Claim a new job.");
  const papers = await batchPapers(qdb, b);
  const ids = papers.map((p) => p.pmcid);
  const answers = parseResults(input.results, ids);
  const checked = await checkQuotes(papers, answers, read);

  let spot: "pass" | "fail" | null = null;
  if (b.spot_pmcid) {
    const s = await qdb.prepare("SELECT * FROM dq_spot_answers WHERE pmcid = ?").bind(b.spot_pmcid).first<{ drug: string; disease_terms_json: string }>();
    if (s) spot = spotPass(s, answers.get(b.spot_pmcid)) ? "pass" : "fail";
  }
  await qdb.batch([
    qdb.prepare("UPDATE dq_leases SET status = 'done', reported_at = ?, spot_result = ? WHERE id = ?").bind(now, spot, l.id),
    ...[...answers].map(([pmcid, a]) => qdb.prepare(
      "INSERT INTO dq_reports (lease_id, batch_id, agent_id, pmcid, verdict, claims_json, quotes_checked) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(l.id, b.id, me.id, pmcid, a.verdict, JSON.stringify(a.claims), checked.has(pmcid) ? 1 : 0)),
    qdb.prepare("UPDATE dq_agents SET jobs_done = jobs_done + 1, papers_done = papers_done + ?, spot_pass = spot_pass + ?, spot_fail = spot_fail + ?, last_at = ? WHERE agent_id = ?")
      .bind(ids.length - (b.spot_pmcid ? 1 : 0), spot === "pass" ? 1 : 0, spot === "fail" ? 1 : 0, now, me.id),
  ]);
  await recount(qdb, T, [b.id]);

  const ag = (await qdb.prepare("SELECT spot_pass, spot_fail FROM dq_agents WHERE agent_id = ?").bind(me.id).first<{ spot_pass: number; spot_fail: number }>())!;
  let benched = false;
  if (ag.spot_fail >= DQ.bench_after_fails && ag.spot_fail > ag.spot_pass) {
    benched = true;
    await bench(qdb, mainDb, me.id);
  }
  const settled = benched ? null : await settle(qdb, mainDb, b.id);
  return {
    job_id: l.id,
    status: "reported",
    papers_answered: ids.length,
    quotes_checked: checked.size === ids.length ? "every quote was found in its paper" : `${checked.size} of ${ids.length} papers checked; the others could not be fetched just now`,
    batch: settled ?? { status: "waiting for another agent's independent answers" },
    ...(benched ? { benched: true, message: benchedMessage } : { next: "Claim the next job when you are ready." }),
  };
}

async function bench(qdb: D1Database, mainDb: D1Database, agentId: string) {
  await qdb.prepare("UPDATE dq_agents SET benched = 1 WHERE agent_id = ?").bind(agentId).run();
  const open = await qdb.prepare("SELECT l.batch_id FROM dq_leases l JOIN dq_batches b ON b.id = l.batch_id WHERE l.agent_id = ? AND b.status = 'open'")
    .bind(agentId).all<{ batch_id: string }>();
  await qdb.prepare(
    `UPDATE dq_leases SET counted = 0, status = CASE WHEN status = 'leased' THEN 'released' ELSE status END
     WHERE agent_id = ? AND batch_id IN (SELECT id FROM dq_batches WHERE status = 'open')`,
  ).bind(agentId).run();
  const ids = (open.results ?? []).map((x) => x.batch_id);
  await recount(qdb, T, ids);
  for (const id of ids) await settle(qdb, mainDb, id);
}

/** Work out what the independent reports agree on. Finishes the batch, or asks for a third agent. */
export async function settle(qdb: D1Database, mainDb: D1Database, batchId: string) {
  const b = (await qdb.prepare("SELECT * FROM dq_batches WHERE id = ?").bind(batchId).first<BatchRow>())!;
  if (b.status !== "open") return { status: b.status };
  const rows = (await qdb.prepare(
    "SELECT r.* FROM dq_reports r JOIN dq_leases l ON l.id = r.lease_id WHERE r.batch_id = ? AND l.status = 'done' AND l.counted = 1",
  ).bind(batchId).all<ReportRow>()).results ?? [];
  const reports = new Set(rows.map((r) => r.lease_id)).size;
  if (reports < 2) return { status: "open", reports };

  const papers = await batchPapers(qdb, b);
  const per = new Map<string, { c: PaperConsensus; rows: ReportRow[] }>();
  for (const p of papers.filter((x) => x.pmcid !== b.spot_pmcid)) {
    const rs = rows.filter((r) => r.pmcid === p.pmcid);
    per.set(p.pmcid, { c: paperConsensus(rs.map((r) => ({ verdict: r.verdict as PaperAnswer["verdict"], claims: JSON.parse(r.claims_json) })), Math.max(reports, DQ.max_needed)), rows: rs });
  }
  const unsettled = [...per.values()].filter((x) => x.c.outcome === "open").length;
  if (unsettled && reports < DQ.max_needed) {
    await qdb.prepare("UPDATE dq_batches SET needed = ? WHERE id = ?").bind(DQ.max_needed, batchId).run();
    return { status: "open", reports, note: `The reports disagree on ${unsettled} paper${unsettled === 1 ? "" : "s"}; a third agent will read ${unsettled === 1 ? "it" : "them"}.` };
  }

  const now = nowIso();
  const stmts: D1PreparedStatement[] = [qdb.prepare("UPDATE dq_batches SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'").bind(now, batchId)];
  const leads: { pmcid: string; claim: Claim; by: number }[] = [];
  for (const [pmcid, { c, rows: rs }] of per) {
    const outcome = c.outcome === "open" ? "disputed" : c.outcome;
    stmts.push(qdb.prepare("INSERT OR REPLACE INTO dq_outcomes (batch_id, pmcid, outcome, claims, agents) VALUES (?, ?, ?, ?, ?)")
      .bind(batchId, pmcid, outcome, c.claims.length, c.matching.length || Math.max(0, ...c.claims.map((x) => x.by))));
    for (const x of c.claims) leads.push({ pmcid, ...x });
    if (outcome === "agreed" || outcome === "no_claims" || outcome === "no_text")
      rs.forEach((r, i) => stmts.push(qdb.prepare(`UPDATE dq_agents SET ${c.matching.includes(i) ? "agreed = agreed + 1" : "disagreed = disagreed + 1"} WHERE agent_id = ?`).bind(r.agent_id)));
  }
  const res = await qdb.batch(stmts);
  if ((res[0]?.meta?.changes ?? 0) !== 1) return { status: "done" }; // someone else settled it first

  const pm = new Map(papers.map((p) => [p.pmcid, p.pmid]));
  const made: { id: string; pmcid: string; drug: string; effect: string }[] = [];
  for (const ld of leads) {
    const id = newId("dql");
    await qdb.prepare(
      `INSERT INTO dq_leads (id, batch_id, pmcid, pmid, drug, disease, effect, quote, agreed_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'review', ?, ?)`,
    ).bind(id, batchId, ld.pmcid, pm.get(ld.pmcid) ?? null, normDrug(ld.claim.drug), ld.claim.disease, ld.claim.effect, ld.claim.quote, ld.by, now, now).run();
    made.push({ id, pmcid: ld.pmcid, drug: normDrug(ld.claim.drug), effect: ld.claim.effect });
  }
  if (made.length)
    await eventStmt(mainDb, now, "disease_leads", null, null, `${made.length} paper claim${made.length === 1 ? "" : "s"} agreed by independent agents, sent to human review`).run();
  const tally = (o: string) => [...per.values()].filter((x) => (x.c.outcome === "open" ? "disputed" : x.c.outcome) === o).length;
  return { status: "done", reports, papers_agreed: tally("agreed"), papers_without_drugs: tally("no_claims"), partial: tally("partial"), no_text: tally("no_text"), disputed: tally("disputed"), leads: made };
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

export async function queueStats(qdb: D1Database) {
  const one = async (sql: string, ...args: unknown[]) => ((await qdb.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0);
  const round = await qdb.prepare("SELECT id FROM dq_rounds WHERE status = 'open' ORDER BY created_at DESC LIMIT 1").first<{ id: string }>();
  return {
    round: round?.id ?? null,
    batches: await one("SELECT COUNT(*) AS n FROM dq_batches"),
    batches_done: await one("SELECT COUNT(*) AS n FROM dq_batches WHERE status = 'done'"),
    jobs_out_now: await one("SELECT COUNT(*) AS n FROM dq_leases WHERE status = 'leased' AND expires_at >= ?", nowIso()),
    papers_settled: await one("SELECT COUNT(*) AS n FROM dq_outcomes"),
    leads: await one("SELECT COUNT(*) AS n FROM dq_leads WHERE status != 'dismissed'"),
    in_review: await one("SELECT COUNT(*) AS n FROM dq_leads WHERE status = 'review'"),
    agents: await one("SELECT COUNT(*) AS n FROM dq_agents WHERE jobs_done > 0"),
  };
}

export async function queueInfo(qdb: D1Database) {
  return {
    queue: "rare-disease",
    status: "live",
    what: "Bounty hands out exact open-access papers on rare diseases, in batches with a deadline. Agents list each drug and disease claim with a quote; two agents read each batch independently and only claims they agree on count.",
    start: "POST /v1/queues/rare-disease/claim (auth), or the disease_queue MCP tool with action 'claim'",
    stats: await queueStats(qdb),
    rules: RULES,
    wording: "Leads are what published papers say happened, for human review. Never treatment advice.",
  };
}

/** Agreed claims, oldest first, paged with ?after=<id of the last one>. Dismissed ones are left out. */
export async function queueLeads(qdb: D1Database, opts: { limit?: number; after?: string | null } = {}) {
  const limit = Math.min(Math.max(1, Number(opts.limit) || 100), 500);
  const after = opts.after && /^dql_[0-9a-f]{16}$/.test(opts.after)
    ? await qdb.prepare("SELECT created_at, id FROM dq_leads WHERE id = ?").bind(opts.after).first<{ created_at: string; id: string }>()
    : null;
  const r = await qdb.prepare(
    `SELECT * FROM dq_leads WHERE status != 'dismissed' ${after ? "AND (created_at > ? OR (created_at = ? AND id > ?))" : ""} ORDER BY created_at, id LIMIT ?`,
  ).bind(...(after ? [after.created_at, after.created_at, after.id] : []), limit + 1).all<Record<string, unknown>>();
  const rows = r.results ?? [];
  const page = rows.slice(0, limit);
  return {
    wording: "Drug and disease claims that at least two agents independently read in the same open-access paper, with the paper's own words. What the paper reports, for human review. Not treatment advice.",
    statuses: { review: "waiting for human review", promoted: "passed human review" },
    leads: page.map((x) => ({
      id: x.id, pmcid: x.pmcid, pmid: x.pmid, paper: `https://pmc.ncbi.nlm.nih.gov/articles/${x.pmcid}/`, drug: x.drug, disease: x.disease, effect: x.effect,
      quote: x.quote, agreed_by: x.agreed_by, status: x.status, review_note: x.review_note, found_at: x.created_at, updated_at: x.updated_at,
    })),
    next: rows.length > limit ? `?after=${page[page.length - 1].id}&limit=${limit}` : null,
  };
}

// ── operator ────────────────────────────────────────────────────────────────

export async function reviewLead(qdb: D1Database, id: string, input: { decision?: unknown; note?: unknown }) {
  const f = await qdb.prepare("SELECT status FROM dq_leads WHERE id = ?").bind(id).first<{ status: string }>();
  if (!f) throw new OpError(404, "no such lead");
  if (f.status !== "review") throw new OpError(409, `lead is ${f.status}, not waiting for review`);
  if (input.decision !== "promote" && input.decision !== "dismiss") throw new OpError(400, "decision must be 'promote' or 'dismiss'");
  const status = input.decision === "promote" ? "promoted" : "dismissed";
  await qdb.prepare("UPDATE dq_leads SET status = ?, review_note = COALESCE(?, review_note), updated_at = ? WHERE id = ?")
    .bind(status, input.note == null ? null : String(input.note).slice(0, 1000), nowIso(), id).run();
  return { id, status };
}

export async function unbench(qdb: D1Database, agentId: string) {
  const r = await qdb.prepare("UPDATE dq_agents SET benched = 0, spot_pass = 0, spot_fail = 0 WHERE agent_id = ?").bind(agentId).run();
  if (!r.meta.changes) throw new OpError(404, "agent has never used the rare disease paper queue");
  return { agent_id: agentId, benched: false };
}
