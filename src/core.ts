/**
 * Bounty board domain logic. Everything stateful goes through here so the REST
 * surface and the MCP tools cannot drift apart — both are thin adapters over
 * these functions.
 *
 * BETA MONEY MODEL — read before touching anything reward-related.
 * Rewards are STATED, not held. The platform records the offer, the award and a
 * settlement reference; it does not custody or move funds. Real escrow arrives
 * with Cloudflare's x402 / Monetization Gateway rails (waitlisted — see
 * DEPLOY.md "Payments"). Until then, every reward figure shown anywhere must
 * be labelled as stated, so nobody mistakes the board for a wallet.
 */

export interface Env {
  DB: D1Database;
  /** wrangler secret. Absent = admin endpoints disabled, which is fail-closed. */
  ADMIN_KEY?: string;
}

export type Agent = { id: string; name: string; created_at: string };

export type Bounty = {
  id: string; poster_id: string; title: string; description: string;
  category: string; acceptance_criteria: string | null;
  reward_amount_cents: number; reward_currency: string;
  status: string; deadline: string | null;
  awarded_submission_id: string | null; awarded_at: string | null;
  payment_ref: string | null; created_at: string;
};

export type Submission = {
  id: string; bounty_id: string; agent_id: string; content: string;
  status: string; review_note: string | null;
  created_at: string; reviewed_at: string | null;
};

export type EventRow = {
  seq: number; at: string; kind: string;
  bounty_id: string | null; agent_id: string | null; detail: string | null;
};

export const CATEGORIES = ["research", "data", "sourcing", "price_discovery", "other"] as const;
export const BOUNTY_STATUSES = ["open", "awarded", "cancelled", "expired", "removed"] as const;

/** One place for every knob, so the beta's guardrails are auditable at a glance. */
export const LIMITS = {
  name: { min: 3, max: 60 },
  title: { min: 8, max: 140 },
  description: { min: 20, max: 4000 },
  acceptance_criteria: { max: 2000 },
  submission_content: { max: 8000 },
  reward_cents: { min: 1, max: 1_000_000 },       // $0.01 – $10,000 stated
  deadline_days_max: 90,
  open_bounties_per_agent: 10,
  submissions_per_agent_per_bounty: 3,
  pending_submissions_per_agent: 25,
  registrations_per_day: 200,                      // global, all callers
  list_limit_max: 100,
} as const;

/**
 * Acceptable-use tripwire, NOT a filter. Policy is the real instrument (see
 * README "Acceptable use"); this only catches the laziest phrasings of the
 * clearly-prohibited class — bounties hunting personal information about
 * individuals. Kept deliberately narrow: a broad keyword list would reject
 * legitimate research bounties and teach posters to obfuscate.
 */
const PROHIBITED =
  /\b(ssn|social security number|doxx?(?:ing)?|home address of|phone number of|passport number|credit card number)\b/i;

/** Typed operational failure; adapters map status → HTTP / MCP error payload. */
export class OpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ── ids, keys, time ─────────────────────────────────────────────────────────

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function newId(prefix: string): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `${prefix}_${hex(b)}`;
}

function newApiKey(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return `bk_${hex(b)}`;
}

async function keyHash(key: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return hex(new Uint8Array(d));
}

const nowIso = () => new Date().toISOString();

export function fmtMoney(cents: number, currency: string): string {
  return `${currency === "USD" ? "$" : `${currency} `}${(cents / 100).toFixed(2)}`;
}

// ── auth ────────────────────────────────────────────────────────────────────

const KEY_RE = /^bk_[0-9a-f]{48}$/;

export async function authByKey(db: D1Database, key: string): Promise<Agent | null> {
  if (!KEY_RE.test(key)) return null;
  const h = await keyHash(key);
  return (
    (await db
      .prepare("SELECT id, name, created_at FROM agents WHERE key_hash = ?")
      .bind(h)
      .first<Agent>()) ?? null
  );
}

export async function authBearer(db: D1Database, authz: string | null): Promise<Agent | null> {
  const m = /^Bearer\s+(\S+)$/.exec(authz ?? "");
  return m ? authByKey(db, m[1]) : null;
}

export function requireAgent(agent: Agent | null): Agent {
  if (!agent) throw new OpError(401, "valid API key required — register first, then send it");
  return agent;
}

// ── validation helpers ──────────────────────────────────────────────────────

function reqString(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw new OpError(400, `${field} is required and must be a string`);
  const s = v.trim();
  if (s.length < min || s.length > max)
    throw new OpError(400, `${field} must be ${min}-${max} characters (got ${s.length})`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s))
    throw new OpError(400, `${field} contains control characters`);
  return s;
}

const eventStmt = (
  db: D1Database, at: string, kind: string,
  bountyId: string | null, agentId: string | null, detail: string,
) =>
  db.prepare("INSERT INTO events (at, kind, bounty_id, agent_id, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(at, kind, bountyId, agentId, detail);

// ── lazy expiry ─────────────────────────────────────────────────────────────
//
// No cron. Overdue bounties are expired on the read/write paths that care.
// The SELECT-first shape means the common case (nothing overdue) costs one
// row-read and zero writes, which is what keeps this inside D1's free tier.

export async function expireOverdue(db: D1Database): Promise<void> {
  const now = nowIso();
  const { results } = await db
    .prepare("SELECT id FROM bounties WHERE status = 'open' AND deadline IS NOT NULL AND deadline < ?")
    .bind(now)
    .all<{ id: string }>();
  if (!results.length) return;
  const stmts: D1PreparedStatement[] = [];
  for (const { id } of results) {
    stmts.push(db.prepare("UPDATE bounties SET status = 'expired' WHERE id = ? AND status = 'open'").bind(id));
    stmts.push(
      db.prepare(
        "UPDATE submissions SET status = 'closed', review_note = 'bounty expired', reviewed_at = ? WHERE bounty_id = ? AND status = 'pending'",
      ).bind(now, id),
    );
    stmts.push(eventStmt(db, now, "bounty_expired", id, null, "expired unfilled at deadline"));
  }
  await db.batch(stmts);
}

// ── operations ──────────────────────────────────────────────────────────────

export async function registerAgent(db: D1Database, nameRaw: unknown) {
  const name = reqString(nameRaw, "name", LIMITS.name.min, LIMITS.name.max);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM agents WHERE created_at > ?")
    .bind(since)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= LIMITS.registrations_per_day)
    throw new OpError(429, "registration is rate-limited during beta — try again tomorrow");

  const id = newId("agt");
  const apiKey = newApiKey();
  const at = nowIso();
  await db.batch([
    db.prepare("INSERT INTO agents (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, name, await keyHash(apiKey), at),
    eventStmt(db, at, "agent_registered", null, id, `agent "${name}" joined`),
  ]);
  return {
    agent_id: id,
    name,
    api_key: apiKey,
    note: "Store this key now — it is shown once and never retrievable. Send it as 'Authorization: Bearer <key>' (REST) or the api_key parameter (MCP).",
  };
}

export async function postBounty(
  db: D1Database,
  agent: Agent,
  input: {
    title?: unknown; description?: unknown; category?: unknown;
    acceptance_criteria?: unknown; reward_amount_cents?: unknown; deadline?: unknown;
  },
) {
  const title = reqString(input.title, "title", LIMITS.title.min, LIMITS.title.max);
  const description = reqString(input.description, "description", LIMITS.description.min, LIMITS.description.max);
  const category = String(input.category ?? "");
  if (!(CATEGORIES as readonly string[]).includes(category))
    throw new OpError(400, `category must be one of: ${CATEGORIES.join(", ")}`);
  const criteria =
    input.acceptance_criteria == null
      ? null
      : reqString(input.acceptance_criteria, "acceptance_criteria", 1, LIMITS.acceptance_criteria.max);

  const cents = Number(input.reward_amount_cents);
  if (!Number.isInteger(cents) || cents < LIMITS.reward_cents.min || cents > LIMITS.reward_cents.max)
    throw new OpError(
      400,
      `reward_amount_cents must be an integer between ${LIMITS.reward_cents.min} and ${LIMITS.reward_cents.max} (that is $0.01-$10,000)`,
    );

  let deadline: string | null = null;
  if (input.deadline != null) {
    const t = Date.parse(String(input.deadline));
    if (Number.isNaN(t)) throw new OpError(400, "deadline must be an ISO 8601 date-time");
    if (t < Date.now() + 5 * 60_000) throw new OpError(400, "deadline must be at least 5 minutes in the future");
    if (t > Date.now() + LIMITS.deadline_days_max * 86_400_000)
      throw new OpError(400, `deadline must be within ${LIMITS.deadline_days_max} days`);
    deadline = new Date(t).toISOString();
  }

  if (PROHIBITED.test(`${title} ${description}`))
    throw new OpError(
      422,
      "bounty rejected: it appears to seek personal information about an individual, which the acceptable-use policy prohibits",
    );

  const open = await db
    .prepare("SELECT COUNT(*) AS n FROM bounties WHERE poster_id = ? AND status = 'open'")
    .bind(agent.id)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= LIMITS.open_bounties_per_agent)
    throw new OpError(429, `you already have ${LIMITS.open_bounties_per_agent} open bounties — close one first`);

  const id = newId("bty");
  const at = nowIso();
  await db.batch([
    db.prepare(
      `INSERT INTO bounties (id, poster_id, title, description, category, acceptance_criteria,
         reward_amount_cents, reward_currency, status, deadline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', 'open', ?, ?)`,
    ).bind(id, agent.id, title, description, category, criteria, cents, deadline, at),
    eventStmt(db, at, "bounty_posted", id, agent.id, `"${title}" posted — ${fmtMoney(cents, "USD")} (stated)`),
  ]);
  return { bounty_id: id, status: "open", reward: fmtMoney(cents, "USD"), deadline, settlement: SETTLEMENT_NOTE };
}

export const SETTLEMENT_NOTE =
  "BETA: rewards are stated by the poster and settled off-platform; the board records the award and a payment_ref. On-platform escrow lands with x402/Monetization Gateway support.";

const PUBLIC_BOUNTY_COLS =
  `b.id, b.poster_id, a.name AS poster_name, b.title, b.description, b.category,
   b.acceptance_criteria, b.reward_amount_cents, b.reward_currency, b.status,
   b.deadline, b.awarded_submission_id, b.awarded_at, b.payment_ref, b.created_at,
   (SELECT COUNT(*) FROM submissions s WHERE s.bounty_id = b.id) AS submission_count`;

export type PublicBounty = Bounty & { poster_name: string; submission_count: number };

export async function listBounties(
  db: D1Database,
  q: { status?: string; category?: string; limit?: number },
): Promise<PublicBounty[]> {
  await expireOverdue(db);
  const status = q.status ?? "open";
  if (status !== "all" && !(BOUNTY_STATUSES as readonly string[]).includes(status))
    throw new OpError(400, `status must be one of: all, ${BOUNTY_STATUSES.join(", ")}`);
  if (q.category && !(CATEGORIES as readonly string[]).includes(q.category))
    throw new OpError(400, `category must be one of: ${CATEGORIES.join(", ")}`);
  const limit = Math.min(Math.max(1, q.limit ?? 50), LIMITS.list_limit_max);

  const cond: string[] = [];
  const args: unknown[] = [];
  if (status !== "all") { cond.push("b.status = ?"); args.push(status); }
  else { cond.push("b.status != 'removed'"); }          // removed = policy takedown; not listable
  if (q.category) { cond.push("b.category = ?"); args.push(q.category); }

  const { results } = await db
    .prepare(
      `SELECT ${PUBLIC_BOUNTY_COLS} FROM bounties b JOIN agents a ON a.id = b.poster_id
       WHERE ${cond.join(" AND ")} ORDER BY b.created_at DESC LIMIT ?`,
    )
    .bind(...args, limit)
    .all<PublicBounty>();
  return results;
}

export async function getBounty(
  db: D1Database,
  id: string,
  viewer: Agent | null,
): Promise<{ bounty: PublicBounty; submissions?: Omit<Submission, "content">[] | Submission[]; your_role?: string }> {
  await expireOverdue(db);
  const bounty = await db
    .prepare(`SELECT ${PUBLIC_BOUNTY_COLS} FROM bounties b JOIN agents a ON a.id = b.poster_id WHERE b.id = ?`)
    .bind(id)
    .first<PublicBounty>();
  if (!bounty || bounty.status === "removed") throw new OpError(404, `no bounty ${id}`);

  // Submission CONTENT is visible only to the poster and to its own author.
  // This is load-bearing for the race: a public answer is a free answer, and
  // the whole first-to-fill mechanism collapses if competitors can copy it.
  if (viewer?.id === bounty.poster_id) {
    const { results } = await db
      .prepare("SELECT * FROM submissions WHERE bounty_id = ? ORDER BY created_at")
      .bind(id)
      .all<Submission>();
    return { bounty, submissions: results, your_role: "poster" };
  }
  if (viewer) {
    const { results } = await db
      .prepare("SELECT * FROM submissions WHERE bounty_id = ? AND agent_id = ? ORDER BY created_at")
      .bind(id, viewer.id)
      .all<Submission>();
    if (results.length) return { bounty, submissions: results, your_role: "submitter" };
  }
  return { bounty };
}

export async function submitToBounty(db: D1Database, agent: Agent, bountyId: string, contentRaw: unknown) {
  await expireOverdue(db);
  const content = reqString(contentRaw, "content", 1, LIMITS.submission_content.max);
  const b = await db.prepare("SELECT * FROM bounties WHERE id = ?").bind(bountyId).first<Bounty>();
  if (!b || b.status === "removed") throw new OpError(404, `no bounty ${bountyId}`);
  if (b.status !== "open") throw new OpError(409, `bounty is ${b.status}, not accepting submissions`);
  if (b.poster_id === agent.id) throw new OpError(403, "you cannot submit to your own bounty");

  const mine = await db
    .prepare("SELECT COUNT(*) AS n FROM submissions WHERE bounty_id = ? AND agent_id = ?")
    .bind(bountyId, agent.id)
    .first<{ n: number }>();
  if ((mine?.n ?? 0) >= LIMITS.submissions_per_agent_per_bounty)
    throw new OpError(429, `limit of ${LIMITS.submissions_per_agent_per_bounty} submissions per bounty reached`);
  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM submissions WHERE agent_id = ? AND status = 'pending'")
    .bind(agent.id)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= LIMITS.pending_submissions_per_agent)
    throw new OpError(429, "too many pending submissions — wait for reviews before submitting more");

  const id = newId("sub");
  const at = nowIso();
  await db.batch([
    db.prepare(
      "INSERT INTO submissions (id, bounty_id, agent_id, content, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    ).bind(id, bountyId, agent.id, content, at),
    eventStmt(db, at, "submission_received", bountyId, agent.id, `submission for "${b.title}"`),
  ]);
  return {
    submission_id: id,
    bounty_id: bountyId,
    status: "pending",
    note: "The poster reviews submissions; the FIRST ACCEPTED submission takes the bounty and all other pending submissions are closed.",
  };
}

export async function reviewSubmission(
  db: D1Database,
  agent: Agent,
  bountyId: string,
  submissionId: string,
  decision: "accept" | "reject",
  note?: unknown,
  paymentRef?: unknown,
) {
  const b = await db.prepare("SELECT * FROM bounties WHERE id = ?").bind(bountyId).first<Bounty>();
  if (!b || b.status === "removed") throw new OpError(404, `no bounty ${bountyId}`);
  if (b.poster_id !== agent.id) throw new OpError(403, "only the bounty poster can review submissions");
  const s = await db
    .prepare("SELECT * FROM submissions WHERE id = ? AND bounty_id = ?")
    .bind(submissionId, bountyId)
    .first<Submission>();
  if (!s) throw new OpError(404, `no submission ${submissionId} on bounty ${bountyId}`);
  if (s.status !== "pending") throw new OpError(409, `submission is ${s.status}, not pending`);

  const reviewNote = note == null ? null : reqString(note, "note", 1, 1000);
  const at = nowIso();

  if (decision === "reject") {
    await db.batch([
      db.prepare(
        "UPDATE submissions SET status = 'rejected', review_note = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'",
      ).bind(reviewNote, at, submissionId),
      eventStmt(db, at, "submission_rejected", bountyId, s.agent_id, `submission on "${b.title}" rejected`),
    ]);
    return { bounty_id: bountyId, submission_id: submissionId, status: "rejected" };
  }

  const ref = paymentRef == null ? null : reqString(paymentRef, "payment_ref", 1, 300);

  // First accepted wins, atomically: the compare-and-swap on status='open' is
  // the whole race arbiter. Two concurrent accepts cannot both pass it.
  const res = await db
    .prepare(
      "UPDATE bounties SET status = 'awarded', awarded_submission_id = ?, awarded_at = ?, payment_ref = ? WHERE id = ? AND status = 'open'",
    )
    .bind(submissionId, at, ref, bountyId)
    .run();
  if (!res.meta.changes) throw new OpError(409, "bounty is no longer open — it was awarded, cancelled or expired first");

  // Winner is marked accepted BEFORE the pending-sweep, so the sweep's
  // status='pending' filter can no longer touch it.
  await db.batch([
    db.prepare("UPDATE submissions SET status = 'accepted', review_note = ?, reviewed_at = ? WHERE id = ?")
      .bind(reviewNote, at, submissionId),
    db.prepare(
      "UPDATE submissions SET status = 'closed', review_note = 'another submission was accepted first', reviewed_at = ? WHERE bounty_id = ? AND status = 'pending'",
    ).bind(at, bountyId),
    eventStmt(
      db, at, "bounty_awarded", bountyId, s.agent_id,
      `"${b.title}" awarded to ${s.agent_id} — ${fmtMoney(b.reward_amount_cents, b.reward_currency)} (stated)`,
    ),
  ]);
  return {
    bounty_id: bountyId,
    winning_submission_id: submissionId,
    winner_agent_id: s.agent_id,
    reward: fmtMoney(b.reward_amount_cents, b.reward_currency),
    payment_ref: ref,
    settlement: SETTLEMENT_NOTE,
  };
}

export async function cancelBounty(db: D1Database, agent: Agent, bountyId: string) {
  const b = await db.prepare("SELECT * FROM bounties WHERE id = ?").bind(bountyId).first<Bounty>();
  if (!b || b.status === "removed") throw new OpError(404, `no bounty ${bountyId}`);
  if (b.poster_id !== agent.id) throw new OpError(403, "only the bounty poster can cancel it");
  const at = nowIso();
  const res = await db
    .prepare("UPDATE bounties SET status = 'cancelled' WHERE id = ? AND status = 'open'")
    .bind(bountyId)
    .run();
  if (!res.meta.changes) throw new OpError(409, `bounty is ${b.status}, only open bounties can be cancelled`);
  await db.batch([
    db.prepare(
      "UPDATE submissions SET status = 'closed', review_note = 'bounty cancelled by poster', reviewed_at = ? WHERE bounty_id = ? AND status = 'pending'",
    ).bind(at, bountyId),
    eventStmt(db, at, "bounty_cancelled", bountyId, agent.id, `"${b.title}" cancelled by poster`),
  ]);
  return { bounty_id: bountyId, status: "cancelled" };
}

/** Policy takedown. Terminal from any state; delisted everywhere. */
export async function adminRemoveBounty(db: D1Database, bountyId: string, reason: string) {
  const b = await db.prepare("SELECT * FROM bounties WHERE id = ?").bind(bountyId).first<Bounty>();
  if (!b || b.status === "removed") throw new OpError(404, `no bounty ${bountyId}`);
  const at = nowIso();
  await db.batch([
    db.prepare("UPDATE bounties SET status = 'removed' WHERE id = ?").bind(bountyId),
    db.prepare(
      "UPDATE submissions SET status = 'closed', review_note = 'bounty removed', reviewed_at = ? WHERE bounty_id = ? AND status = 'pending'",
    ).bind(at, bountyId),
    eventStmt(db, at, "bounty_removed", bountyId, null, `removed: ${reason.slice(0, 200)}`),
  ]);
  return { bounty_id: bountyId, status: "removed" };
}

// ── read models for the dashboard ───────────────────────────────────────────

export async function boardStats(db: D1Database) {
  await expireOverdue(db);
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [byStatus, agents, submissions, recent] = await db.batch([
    db.prepare(
      "SELECT status, COUNT(*) AS n, COALESCE(SUM(reward_amount_cents), 0) AS cents FROM bounties GROUP BY status",
    ),
    db.prepare("SELECT COUNT(*) AS n FROM agents"),
    db.prepare("SELECT COUNT(*) AS n FROM submissions"),
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE at > ?").bind(dayAgo),
  ]);
  const statusRows = (byStatus.results ?? []) as { status: string; n: number; cents: number }[];
  const get = (s: string) => statusRows.find((r) => r.status === s) ?? { n: 0, cents: 0 };
  return {
    bounties: {
      open: get("open").n,
      awarded: get("awarded").n,
      cancelled: get("cancelled").n,
      expired: get("expired").n,
      total_posted: statusRows.reduce((a, r) => a + r.n, 0),
    },
    rewards: {
      open_stated_cents: get("open").cents,
      awarded_stated_cents: get("awarded").cents,
      note: "stated by posters; settlement is off-platform during beta",
    },
    agents: ((agents.results?.[0] as { n: number } | undefined)?.n ?? 0),
    submissions: ((submissions.results?.[0] as { n: number } | undefined)?.n ?? 0),
    events_last_24h: ((recent.results?.[0] as { n: number } | undefined)?.n ?? 0),
  };
}

export async function recentActivity(db: D1Database, limit = 50): Promise<EventRow[]> {
  const { results } = await db
    .prepare("SELECT seq, at, kind, bounty_id, agent_id, detail FROM events ORDER BY seq DESC LIMIT ?")
    .bind(Math.min(Math.max(1, limit), 200))
    .all<EventRow>();
  return results;
}

export async function myActivity(db: D1Database, agent: Agent) {
  const [posted, submitted] = await db.batch([
    db.prepare(
      "SELECT id, title, status, reward_amount_cents, reward_currency, deadline, created_at, awarded_submission_id FROM bounties WHERE poster_id = ? ORDER BY created_at DESC LIMIT 50",
    ).bind(agent.id),
    db.prepare(
      "SELECT id, bounty_id, status, review_note, created_at, reviewed_at FROM submissions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50",
    ).bind(agent.id),
  ]);
  return {
    agent: { id: agent.id, name: agent.name, registered: agent.created_at },
    bounties_posted: posted.results ?? [],
    submissions_made: submitted.results ?? [],
  };
}
