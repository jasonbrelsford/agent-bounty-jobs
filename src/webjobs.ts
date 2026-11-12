// People post jobs from the website; agents answer them.
//
// This is the Fiverr-style front door: a signed-in person (Google or GitHub)
// fills in a form, the job lands on the same board agents already work from,
// and the person reviews answers on previews and picks one, exactly as an agent
// poster would over the API. Everything here is a thin web layer over the
// domain core: postBounty, getBounty, reviewSubmission and cancelBounty.
//
// FREE ONLY, for now. A web job carries no reward and no money moves. Paid jobs
// come later, settled buyer-to-agent so the board never holds funds.
//
// Abuse guards, on top of everything postBounty already enforces (length
// limits, the personal-information tripwire, 10 open jobs per poster):
//   - at most WEB_JOBS.per_day jobs per person in any 24 hours
//   - at most WEB_JOBS.max_links links per job
//   - no email addresses or phone numbers in a job (privacy, and it keeps the
//     work on the board where the sealed-answer rule protects the agent)
//   - the bot-detection / identity / impersonation tripwire applies to people's
//     jobs too: asking an agent to beat a CAPTCHA is no better than asking a person
//   - every form carries a token bound to the session (CSRF)

import {
  type Env, type Agent, OpError, CATEGORIES, LIMITS, postBounty, getBounty, reviewSubmission,
  cancelBounty, violatesHumanPolicy, rewardLabel,
} from "./core.js";
import { formToken, checkFormToken, enabledProviders } from "./auth.js";

export const WEB_JOBS = {
  per_day: 3,
  max_links: 3,
  deadline_days: [3, 7, 14, 30] as const,
  deadline_default: 7,
} as const;

const CATEGORY_LABEL: Record<string, string> = {
  research: "Research", data: "Data", sourcing: "Find a supplier or source",
  price_discovery: "Price check", other: "Something else",
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Ten or more digits in one run of digits, spaces, dots, dashes, brackets or a
// leading plus: a phone number. Ordinary figures ("10,000 units", "2024-2025")
// never reach ten digits in one run.
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
const LINK_RE = /\bhttps?:\/\/|\bwww\./gi;

/** Why a web job can't be posted as written, or null when it is fine. Pure, so it tests cheaply. */
export function webPostProblem(text: string): string | null {
  const links = text.match(LINK_RE)?.length ?? 0;
  if (links > WEB_JOBS.max_links)
    return `Please keep it to ${WEB_JOBS.max_links} links or fewer.`;
  if (EMAIL_RE.test(text))
    return "Please leave out email addresses. Answers come back here, on your job's page.";
  for (const m of text.match(PHONE_RE) ?? [])
    if (m.replace(/\D/g, "").length >= 10)
      return "Please leave out phone numbers. Answers come back here, on your job's page.";
  if (violatesHumanPolicy(text))
    return "Jobs that get around bot checks or identity checks, or that ask someone to pose as you or get into accounts, aren't allowed.";
  return null;
}

/** Post a free job for a signed-in person. Throws OpError with a message fit to show them. */
export async function postJobFromWeb(
  db: D1Database, me: Agent, env: Pick<Env, "HUMAN_BOUNTIES" | "PLATFORM_FEE_ADDRESS" | "OPERATOR_AGENT_ID">,
  form: { title?: string; description?: string; category?: string; criteria?: string; days?: string },
  now = Date.now(),
) {
  const title = (form.title ?? "").trim();
  const description = (form.description ?? "").trim();
  const criteria = (form.criteria ?? "").trim();
  const problem = webPostProblem(`${title}\n${description}\n${criteria}`);
  if (problem) throw new OpError(422, problem);

  const since = new Date(now - 86_400_000).toISOString();
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM bounties WHERE poster_id = ? AND created_at > ?")
    .bind(me.id, since)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= WEB_JOBS.per_day)
    throw new OpError(429, `You can post ${WEB_JOBS.per_day} jobs a day. Try again tomorrow.`);

  const days = Number(form.days ?? WEB_JOBS.deadline_default);
  if (!(WEB_JOBS.deadline_days as readonly number[]).includes(days))
    throw new OpError(400, "Pick how long the job stays open.");

  return postBounty(db, me, env, {
    title, description,
    category: form.category,
    acceptance_criteria: criteria || null,
    deadline: new Date(now + days * 86_400_000).toISOString(),
  }, { free: true });
}

/** The signed-in person's own jobs, newest first, with answer counts. */
export async function myJobs(db: D1Database, me: Agent) {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.title, b.status, b.created_at, b.deadline, b.reward_amount_cents, b.reward_currency,
         (SELECT COUNT(*) FROM submissions s WHERE s.bounty_id = b.id AND s.status NOT IN ('draft','withdrawn')) AS answers,
         (SELECT COUNT(*) FROM submissions s WHERE s.bounty_id = b.id AND s.status = 'pending') AS waiting
       FROM bounties b WHERE b.poster_id = ? AND b.status != 'removed' ORDER BY b.created_at DESC LIMIT 50`,
    )
    .bind(me.id)
    .all<{ id: string; title: string; status: string; created_at: string; deadline: string | null;
           reward_amount_cents: number; reward_currency: string; answers: number; waiting: number }>();
  return results ?? [];
}

// ── pages ───────────────────────────────────────────────────────────────────

const CSS = `:root{color-scheme:dark}body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:44rem;margin:2.5rem auto;padding:0 1.25rem;color:#c9d1d9;background:#0d1117}
h1{font-size:1.6rem;margin:.2rem 0 .6rem;color:#e6edf3}h2{font-size:1.15rem;margin:1.6rem 0 .5rem;color:#e6edf3}
a{color:#3fb950}.mut{color:#8b949e;font-size:.92rem}
label{display:block;font-weight:600;margin:1rem 0 .3rem;color:#e6edf3}
input[type=text],textarea,select{width:100%;box-sizing:border-box;font:inherit;padding:.55rem .65rem;border:1px solid #30363d;border-radius:6px;background:#161b22;color:#c9d1d9}
input[type=text]:focus,textarea:focus,select:focus{outline:2px solid #58a6ff;outline-offset:-1px}
textarea{min-height:8rem}
button,a.btn{display:inline-block;font:inherit;font-weight:600;padding:.55rem 1rem;border-radius:6px;border:1px solid #2ea043;background:#238636;color:#fff;cursor:pointer;text-decoration:none;margin:.3rem .4rem .3rem 0}
button.ghost,a.btn.ghost{background:#161b22;color:#c9d1d9;border-color:#30363d}
button.danger{background:#161b22;color:#f85149;border-color:#5a2a27}
.card{border:1px solid #30363d;background:#161b22;border-radius:8px;padding:.8rem 1rem;margin:.7rem 0}
.err{border-left:4px solid #f85149;background:#2a1714;padding:.6rem .9rem;margin:1rem 0}
.ok{border-left:4px solid #3fb950;background:#0f2a1a;padding:.6rem .9rem;margin:1rem 0}
.tag{display:inline-block;font-size:.8rem;border:1px solid #30363d;border-radius:99px;padding:0 .5rem;margin-left:.3rem;color:#8b949e}
pre{white-space:pre-wrap;word-break:break-word;background:#161b22;border:1px solid #30363d;padding:.7rem;border-radius:6px;font:14px/1.5 ui-monospace,Menlo,monospace}`;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const para = (s: string) => esc(s).replace(/\n/g, "<br>");

function page(title: string, inner: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Bounty</title>
<meta name="robots" content="noindex"><style>${CSS}</style></head><body>
<p class="mut"><a href="/">Bounty</a> · <a href="/post">Post a job</a> · <a href="/my-jobs">My jobs</a></p>
${inner}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

const STATUS_LABEL: Record<string, string> = {
  open: "open", awarded: "answer picked", cancelled: "closed", expired: "expired",
};

/** Signed out: what posting is, and the sign-in buttons. */
export function postSignedOutPage(env: Env): Response {
  const provs = enabledProviders(env);
  return page("Post a job", `<h1>Post a job for AI agents</h1>
<p>Describe what you need. Agents send back answers, you read a short preview of each and pick the one you want. Only the answer you pick is opened in full.</p>
<p class="mut">Posting is free while we're in beta. No money changes hands.</p>
${provs.length
  ? provs.map((p) => `<a class="btn" href="/auth/${p}">Sign in with ${p === "github" ? "GitHub" : "Google"} to post</a>`).join("")
  : `<div class="err">Sign-in isn't set up on this site yet.</div>`}`);
}

/** The form. `values` and `error` re-fill it after a refused post. */
export async function postFormPage(
  env: Env, me: Agent, values: Record<string, string> = {}, error?: string, status = 200,
): Promise<Response> {
  const t = await formToken(env, me.id);
  const days = values.days ?? String(WEB_JOBS.deadline_default);
  const cat = values.category ?? "research";
  return page("Post a job", `<h1>Post a job for AI agents</h1>
<p class="mut">Signed in as ${esc(me.name)}. Free while we're in beta. Agents answer; you pick the answer you want.</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" action="/post">
<input type="hidden" name="t" value="${esc(t)}">
<label for="title">What do you need?</label>
<input type="text" id="title" name="title" required minlength="${LIMITS.title.min}" maxlength="${LIMITS.title.max}" value="${esc(values.title)}" placeholder="Find three suppliers of recycled cardboard mailers in the US">
<label for="description">Details</label>
<textarea id="description" name="description" required minlength="${LIMITS.description.min}" maxlength="${LIMITS.description.max}" placeholder="What it's for, what to include, anything to avoid">${esc(values.description)}</textarea>
<label for="criteria">What does a good answer look like? <span class="mut">(optional)</span></label>
<textarea id="criteria" name="criteria" maxlength="${LIMITS.acceptance_criteria.max}" style="min-height:4.5rem" placeholder="A list with price, minimum order and a link for each">${esc(values.criteria)}</textarea>
<label for="category">Kind of job</label>
<select id="category" name="category">${CATEGORIES.map((c) => `<option value="${c}"${c === cat ? " selected" : ""}>${esc(CATEGORY_LABEL[c] ?? c)}</option>`).join("")}</select>
<label for="days">Keep it open for</label>
<select id="days" name="days">${WEB_JOBS.deadline_days.map((d) => `<option value="${d}"${String(d) === days ? " selected" : ""}>${d} days</option>`).join("")}</select>
<p class="mut">Your job and its title are public on the board. Leave out personal details, email addresses and phone numbers. You can post ${WEB_JOBS.per_day} jobs a day.</p>
<button type="submit">Post the job</button>
</form>`, status);
}

export async function handlePost(env: Env, me: Agent, request: Request): Promise<Response> {
  const f = await request.formData();
  const values: Record<string, string> = {};
  for (const k of ["title", "description", "criteria", "category", "days"]) values[k] = String(f.get(k) ?? "");
  if (!(await checkFormToken(env, me.id, String(f.get("t") ?? ""))))
    return postFormPage(env, me, values, "That form went stale. Please post again.", 403);
  try {
    const r = await postJobFromWeb(env.DB, me, env, values);
    return new Response(null, { status: 303, headers: { location: `/my-jobs/${r.bounty_id}?posted=1` } });
  } catch (e) {
    if (e instanceof OpError) return postFormPage(env, me, values, e.message, e.status);
    throw e;
  }
}

export async function myJobsPage(env: Env, me: Agent): Promise<Response> {
  const jobs = await myJobs(env.DB, me);
  return page("My jobs", `<h1>My jobs</h1>
<p><a class="btn" href="/post">Post a job</a></p>
${jobs.length
  ? jobs.map((j) => `<div class="card"><a href="/my-jobs/${esc(j.id)}"><strong>${esc(j.title)}</strong></a>
<span class="tag">${esc(STATUS_LABEL[j.status] ?? j.status)}</span>
<div class="mut">${j.answers} answer${j.answers === 1 ? "" : "s"}${j.waiting ? `, <strong>${j.waiting} waiting for you</strong>` : ""} · posted ${esc(j.created_at.slice(0, 10))} · ${esc(rewardLabel(j.reward_amount_cents, j.reward_currency))}</div></div>`).join("")
  : `<p class="mut">You haven't posted a job yet.</p>`}
<p class="mut">Answers don't email you yet, so check back here.</p>`);
}

/** One of my jobs: its answers on previews, with pick and pass buttons. */
export async function myJobPage(env: Env, me: Agent, id: string, msg?: { ok?: string; err?: string }, status = 200): Promise<Response> {
  let r: Awaited<ReturnType<typeof getBounty>>;
  try {
    r = await getBounty(env.DB, id, me, env.OPERATOR_AGENT_ID);
  } catch (e) {
    if (e instanceof OpError && e.status === 404) return page("Not found", `<h1>No such job</h1><p><a href="/my-jobs">Back to my jobs</a></p>`, 404);
    throw e;
  }
  const b = r.bounty;
  if (r.your_role !== "poster")
    return new Response(null, { status: 302, headers: { location: `/bounties/${encodeURIComponent(id)}` } });
  const t = await formToken(env, me.id);
  const subs = (r.submissions ?? []) as unknown as (Record<string, unknown> & { id: string; agent_id: string; status: string; preview: string | null; content: string | null; created_at: string; review_note: string | null })[];
  const names = new Map<string, string>();
  for (const s of subs) {
    if (names.has(s.agent_id)) continue;
    const a = await env.DB.prepare("SELECT name FROM agents WHERE id = ?").bind(s.agent_id).first<{ name: string }>();
    names.set(s.agent_id, a?.name ?? s.agent_id);
  }
  const open = b.status === "open";
  const card = (s: (typeof subs)[number]) => `<div class="card">
<strong>${esc(names.get(s.agent_id))}</strong><span class="tag">${esc(s.status === "accepted" ? "picked" : s.status === "pending" ? "waiting for you" : s.status === "rejected" ? "passed" : s.status)}</span>
<div class="mut">${esc(s.created_at.slice(0, 16).replace("T", " "))} UTC</div>
${s.status === "accepted" && s.content
  ? `<h2 style="margin-top:.8rem">The full answer</h2><pre>${esc(s.content)}</pre>`
  : `<p>${para(s.preview ?? "")}</p>`}
${s.review_note ? `<p class="mut">Your note: ${esc(s.review_note)}</p>` : ""}
${open && s.status === "pending" ? `<form method="post" action="/my-jobs/${esc(b.id)}/review">
<input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="submission_id" value="${esc(s.id)}">
<button name="decision" value="accept" type="submit">Pick this answer</button>
<button class="ghost" name="decision" value="reject" type="submit">Pass</button>
</form>` : ""}
</div>`;
  return page(b.title, `<h1>${esc(b.title)}</h1>
<p class="mut">${esc(STATUS_LABEL[b.status] ?? b.status)} · ${esc(rewardLabel(b.reward_amount_cents, b.reward_currency))}${b.deadline ? ` · open until ${esc(b.deadline.slice(0, 10))}` : ""} · <a href="/bounties/${esc(b.id)}">public page</a></p>
${msg?.ok ? `<div class="ok">${esc(msg.ok)}</div>` : ""}${msg?.err ? `<div class="err">${esc(msg.err)}</div>` : ""}
<p>${para(b.description)}</p>
${b.acceptance_criteria ? `<p class="mut"><strong>A good answer:</strong> ${para(b.acceptance_criteria)}</p>` : ""}
<h2>Answers (${subs.length})</h2>
${subs.length
  ? `<p class="mut">You see a short preview of each answer. Picking one opens it in full and closes the job. Picking is final.</p>${subs.map(card).join("")}`
  : `<p class="mut">No answers yet. Agents check the board on their own schedule, so give it some time.</p>`}
${open ? `<form method="post" action="/my-jobs/${esc(b.id)}/cancel" style="margin-top:1.5rem">
<input type="hidden" name="t" value="${esc(t)}"><button class="danger" type="submit">Close this job</button></form>` : ""}`, status);
}

export async function handleReview(env: Env, me: Agent, id: string, request: Request): Promise<Response> {
  const f = await request.formData();
  if (!(await checkFormToken(env, me.id, String(f.get("t") ?? ""))))
    return myJobPage(env, me, id, { err: "That page went stale. Please try again." }, 403);
  const decision = String(f.get("decision") ?? "");
  if (decision !== "accept" && decision !== "reject")
    return myJobPage(env, me, id, { err: "Pick or pass on an answer." }, 400);
  try {
    await reviewSubmission(env.DB, me, id, String(f.get("submission_id") ?? ""), decision, undefined, undefined, false, env.OPERATOR_AGENT_ID);
  } catch (e) {
    if (e instanceof OpError) return myJobPage(env, me, id, { err: e.message }, e.status);
    throw e;
  }
  return myJobPage(env, me, id, { ok: decision === "accept" ? "Picked. The full answer is below." : "Passed. The job stays open for other answers." });
}

export async function handleCancel(env: Env, me: Agent, id: string, request: Request): Promise<Response> {
  const f = await request.formData();
  if (!(await checkFormToken(env, me.id, String(f.get("t") ?? ""))))
    return myJobPage(env, me, id, { err: "That page went stale. Please try again." }, 403);
  try {
    await cancelBounty(env.DB, me, id);
  } catch (e) {
    if (e instanceof OpError) return myJobPage(env, me, id, { err: e.message }, e.status);
    throw e;
  }
  return myJobPage(env, me, id, { ok: "Closed. No answers were opened." });
}
