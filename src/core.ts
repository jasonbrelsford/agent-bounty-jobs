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
  /**
   * Gate for Agent-to-Human jobs. Anything other than the literal "on" keeps
   * them disabled, so a typo fails closed rather than open. Set in wrangler.jsonc
   * vars once escrow exists — NOT before: a human who works and is not paid has
   * been wronged in a way an agent has not.
   */
  HUMAN_BOUNTIES?: string;
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
  payment_ref: string | null; fee_bp: number; fee_cents: number | null;
  audience: string; created_at: string;
};

export type Submission = {
  id: string; bounty_id: string; agent_id: string; milestone_id: string | null;
  content: string; preview: string | null;
  status: string; review_note: string | null;
  created_at: string; reviewed_at: string | null;
};

export type Contributor = {
  submission_id: string; agent_id: string; share_bp: number;
  accepted_at: string | null; payout_cents: number | null;
};

export type Milestone = {
  id: string; bounty_id: string; idx: number; title: string;
  reward_amount_cents: number; status: string;
  awarded_submission_id: string | null; awarded_at: string | null;
  fee_cents: number | null; created_at: string;
};

export type EventRow = {
  seq: number; at: string; kind: string;
  bounty_id: string | null; agent_id: string | null; detail: string | null;
};

export const CATEGORIES = ["research", "data", "sourcing", "price_discovery", "other"] as const;
export const AUDIENCES = ["agents", "humans", "either"] as const;
export const BOUNTY_STATUSES = ["open", "awarded", "cancelled", "expired", "removed"] as const;

/** One place for every knob, so the beta's guardrails are auditable at a glance. */
export const LIMITS = {
  name: { min: 3, max: 60 },
  title: { min: 8, max: 140 },
  description: { min: 20, max: 4000 },
  acceptance_criteria: { max: 2000 },
  submission_content: { max: 8000 },
  submission_preview: { min: 40, max: 600 },      // what the poster judges on

  reward_cents: { min: 1, max: 1_000_000 },       // $0.01 – $10,000 stated
  deadline_days_max: 90,
  open_bounties_per_agent: 10,
  submissions_per_agent_per_bounty: 3,
  pending_submissions_per_agent: 25,
  registrations_per_day: 200,                      // global, all callers
  list_limit_max: 100,
  contributors_per_submission: 16,               // incl. the lead; see splitPayout
  milestones_per_bounty: 10,
  milestone_title: { min: 4, max: 100 },
} as const;

/**
 * Platform rake, in basis points of the stated reward, charged ONLY when a
 * bounty is awarded. Submitting is free by design: on a board where most
 * submissions lose a race, a per-submission fee would bill agents mainly for
 * losing and choke the supply side while liquidity is still thin.
 *
 * The fee comes OUT of the reward, so "stated reward" keeps meaning what the
 * poster owes in total; contributors split the remainder.
 *
 * Change this freely — it is snapshot onto each bounty at post time, so edits
 * never alter a deal already struck.
 */
export const PLATFORM_FEE_BP = 50; // 0.50%

/**
 * Acceptable-use tripwire, NOT a filter. Policy is the real instrument (see
 * README "Acceptable use"); this only catches the laziest phrasings of the
 * clearly-prohibited class — bounties hunting personal information about
 * individuals. Kept deliberately narrow: a broad keyword list would reject
 * legitimate research bounties and teach posters to obfuscate.
 */
const PROHIBITED =
  /\b(ssn|social security number|doxx?(?:ing)?|home address of|phone number of|passport number|credit card number)\b/i;

/** Exported so the tripwire can be tested directly; the env gate fires first in postBounty. */
export function violatesHumanPolicy(text: string): boolean {
  return PROHIBITED_HUMAN.test(text);
}

/**
 * Second tripwire, applied only when a bounty may be filled by a HUMAN.
 *
 * The rationale is specific rather than general squeamishness. An agent-to-human
 * board is, structurally, a mechanism for routing around the things agents are
 * prevented from doing — by hiring a person as the effector. The tasks an agent
 * most wants a human for are disproportionately the ones it is blocked from:
 * defeating a CAPTCHA, passing identity verification, phoning someone while
 * presenting as a real party, opening an account, reaching a paywalled system.
 *
 * Those are prohibited for the agent; hiring them out does not launder them.
 *
 * Kept narrow like PROHIBITED — policy is the real instrument and a broad list
 * would reject honest work and teach posters to paraphrase. It catches the
 * unobfuscated phrasings, which is what a tripwire is for.
 */
export const PROHIBITED_HUMAN =
  /\b(?:(?:re|h)?captchas?|bot[- ]?detection|anti[- ]?bot|(?:bypass|solve|complete|pass|defeat) (?:the |their )?(?:verification|2fa|mfa|kyc|challenge)|identity verification|verify (?:my|the|their) identity|pose as|pretend to be|impersonat\w*|sign (?:up|in) (?:as|for) (?:me|an account)|open an account|log\s?in(?:\s?to)? (?:my|the|their|his|her) account|proof of (?:life|address|identity))\b/i;

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

/** Basis points per whole share. Shares are integers; money never touches a float. */
const BP_TOTAL = 10_000;

/**
 * Split `cents` by basis-point shares using the largest-remainder method, so
 * the payouts sum to EXACTLY `cents` — no rounding dust appears or vanishes.
 * Ties break toward the earlier contributor, which makes the result a pure
 * function of the input order and therefore reproducible from the audit log.
 */
export function splitPayout(cents: number, shares: number[]): number[] {
  const exact = shares.map((bp) => (cents * bp) / BP_TOTAL);
  const base = exact.map(Math.floor);
  let left = cents - base.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && left > 0; k++, left--) base[order[k].i]++;
  return base;
}

/**
 * Validate a team roster against a reward. Returns rows ready to insert.
 *
 * The floor rule is arithmetic, not policy: a contributor whose share rounds to
 * zero cents is owed nothing, which is a silent bug rather than a small payment.
 * Rejecting it at submission time is why `reward_cents` caps the real team size
 * far below `contributors_per_submission` for small bounties.
 */
export function validateShares(
  raw: unknown,
  leadId: string,
  posterId: string,
  netCents: number,
): { agent_id: string; share_bp: number }[] {
  if (!Array.isArray(raw)) throw new OpError(400, "contributors must be an array");
  const rows: { agent_id: string; share_bp: number }[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (typeof c !== "object" || c === null) throw new OpError(400, "each contributor must be an object");
    const id = String((c as Record<string, unknown>).agent_id ?? "");
    const bp = Number((c as Record<string, unknown>).share_bp);
    if (!/^agt_[0-9a-f]{16}$/.test(id)) throw new OpError(400, `invalid contributor agent_id "${id}"`);
    if (!Number.isInteger(bp) || bp <= 0) throw new OpError(400, "share_bp must be a positive integer");
    if (id === posterId) throw new OpError(403, "the bounty poster cannot be a contributor on their own bounty");
    if (seen.has(id)) throw new OpError(400, `duplicate contributor ${id}`);
    seen.add(id);
    rows.push({ agent_id: id, share_bp: bp });
  }
  if (!seen.has(leadId)) throw new OpError(400, "the submitting agent must be listed among the contributors");
  if (rows.length > LIMITS.contributors_per_submission)
    throw new OpError(400, `at most ${LIMITS.contributors_per_submission} contributors per submission`);
  const total = rows.reduce((a, r) => a + r.share_bp, 0);
  if (total !== BP_TOTAL)
    throw new OpError(400, `contributor shares must sum to ${BP_TOTAL} basis points (got ${total})`);
  // Tested against the post-fee pool, because that is what actually gets paid.
  for (const r of rows)
    if (Math.floor((netCents * r.share_bp) / BP_TOTAL) < 1)
      throw new OpError(
        400,
        `share ${r.share_bp}bp of ${fmtMoney(netCents, "USD")} (reward after platform fee) ` +
          "rounds to $0.00 — every contributor must receive at least 1 cent",
      );
  return rows;
}

/**
 * The rake, and what is actually left to split. Both integer cents.
 * The fee rounds DOWN, so rounding error always favours the contributors
 * rather than the house — the one direction that needs no explaining.
 */
export function feeSplit(rewardCents: number, feeBp: number): { fee: number; net: number } {
  const fee = Math.floor((rewardCents * feeBp) / BP_TOTAL);
  return { fee, net: rewardCents - fee };
}

/** Milestones of a bounty in display order; empty when the bounty is whole. */
export async function milestonesOf(db: D1Database, bountyId: string): Promise<Milestone[]> {
  const { results } = await db
    .prepare("SELECT * FROM milestones WHERE bounty_id = ? ORDER BY idx")
    .bind(bountyId)
    .all<Milestone>();
  return results ?? [];
}

/** Accepted contributors on a submission, in insert order. */
async function contributorsOf(db: D1Database, submissionId: string): Promise<Contributor[]> {
  const { results } = await db
    .prepare("SELECT * FROM submission_contributors WHERE submission_id = ? ORDER BY rowid")
    .bind(submissionId)
    .all<Contributor>();
  return results ?? [];
}

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
  env: Pick<Env, "HUMAN_BOUNTIES">,
  input: {
    title?: unknown; description?: unknown; category?: unknown;
    acceptance_criteria?: unknown; reward_amount_cents?: unknown; deadline?: unknown;
    milestones?: unknown; audience?: unknown;
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

  // Milestones, if any. The bounty reward is DERIVED from their sum rather than
  // stated alongside: two numbers that must agree are two numbers that will
  // eventually disagree.
  let parts: { title: string; cents: number }[] = [];
  if (input.milestones != null) {
    if (!Array.isArray(input.milestones)) throw new OpError(400, "milestones must be an array");
    if (input.milestones.length < 2)
      throw new OpError(400, "a milestoned bounty needs at least 2 milestones — otherwise just post it whole");
    if (input.milestones.length > LIMITS.milestones_per_bounty)
      throw new OpError(400, `at most ${LIMITS.milestones_per_bounty} milestones per bounty`);
    parts = input.milestones.map((m: unknown) => {
      const o = (m ?? {}) as Record<string, unknown>;
      const c = Number(o.reward_amount_cents);
      if (!Number.isInteger(c) || c < LIMITS.reward_cents.min)
        throw new OpError(400, "each milestone needs an integer reward_amount_cents of at least 1");
      return {
        title: reqString(o.title, "milestone title", LIMITS.milestone_title.min, LIMITS.milestone_title.max),
        cents: c,
      };
    });
  }

  const cents = parts.length ? parts.reduce((a, m) => a + m.cents, 0) : Number(input.reward_amount_cents);
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

  const audience = String(input.audience ?? "agents");
  if (!(AUDIENCES as readonly string[]).includes(audience))
    throw new OpError(400, `audience must be one of: ${AUDIENCES.join(", ")}`);
  const humanFillable = audience !== "agents";
  // Fail closed: anything but the literal "on" leaves human jobs shut.
  if (humanFillable && env.HUMAN_BOUNTIES !== "on")
    throw new OpError(
      503,
      "Agent-to-Human jobs are not enabled on this board yet. They stay disabled until rewards can be held in escrow — a person who does the work and is not paid has been wronged in a way an agent has not.",
    );

  const blob = `${title} ${description} ${criteria ?? ""}`;
  if (PROHIBITED.test(blob))
    throw new OpError(
      422,
      "bounty rejected: it appears to seek personal information about an individual, which the acceptable-use policy prohibits",
    );
  // Applied only to human-fillable work. Hiring a person to do what an agent is
  // barred from doing does not launder the request.
  if (humanFillable && violatesHumanPolicy(blob))
    throw new OpError(
      422,
      "bounty rejected: tasks that defeat bot-detection or identity verification, or that ask a person to impersonate someone or open/access accounts on your behalf, cannot be posted to humans. Hiring out an action an agent may not take does not make it permitted.",
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
         reward_amount_cents, reward_currency, status, deadline, fee_bp, audience, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', 'open', ?, ?, ?, ?)`,
    ).bind(id, agent.id, title, description, category, criteria, cents, deadline, PLATFORM_FEE_BP, audience, at),
    ...parts.map((m, i) =>
      db.prepare(
        "INSERT INTO milestones (id, bounty_id, idx, title, reward_amount_cents, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
      ).bind(newId("mil"), id, i, m.title, m.cents, at),
    ),
    eventStmt(
      db, at, "bounty_posted", id, agent.id,
      `"${title}" posted — ${fmtMoney(cents, "USD")} (stated)` +
        (parts.length ? ` across ${parts.length} milestones` : ""),
    ),
  ]);
  const fs = feeSplit(cents, PLATFORM_FEE_BP);
  return {
    bounty_id: id,
    status: "open",
    reward: fmtMoney(cents, "USD"),
    // Disclosed at post time, not discovered at award time. The poster owes the
    // full stated reward; the rake comes out of what the filler receives.
    platform_fee: fmtMoney(fs.fee, "USD"),
    platform_fee_bp: PLATFORM_FEE_BP,
    net_to_filler: fmtMoney(fs.net, "USD"),
    audience,
    // Disclosure is not decoration: a person is entitled to know they are being
    // directed by software before they agree to the work.
    human_disclosure: humanFillable
      ? "This job was posted by an autonomous software agent, not a person. Any human who fills it must be shown that."
      : undefined,
    milestones: parts.length
      ? parts.map((m, i) => ({ idx: i, title: m.title, reward: fmtMoney(m.cents, "USD") }))
      : undefined,
    deadline,
    settlement: SETTLEMENT_NOTE,
  };
}

export const SETTLEMENT_NOTE =
  "BETA: rewards are stated by the poster and settled off-platform; the board records the award and a payment_ref. On-platform escrow lands with x402/Monetization Gateway support.";

const PUBLIC_BOUNTY_COLS =
  `b.id, b.poster_id, a.name AS poster_name, b.title, b.description, b.category,
   b.acceptance_criteria, b.reward_amount_cents, b.reward_currency, b.status,
   b.deadline, b.awarded_submission_id, b.awarded_at, b.payment_ref,
   b.fee_bp, b.fee_cents, b.audience, b.created_at,
   (SELECT COUNT(*) FROM submissions s WHERE s.bounty_id = b.id) AS submission_count`;

export type PublicBounty = Bounty & { poster_name: string; submission_count: number };

export async function listBounties(
  db: D1Database,
  q: { status?: string; category?: string; limit?: number; audience?: string },
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
  // "humans" means work a person may take, which includes 'either'. Asking for
  // human-fillable jobs and being shown agent-only ones would waste their time.
  if (q.audience) {
    if (!(AUDIENCES as readonly string[]).includes(q.audience))
      throw new OpError(400, `audience must be one of: ${AUDIENCES.join(", ")}`);
    if (q.audience === "either") { cond.push("b.audience = 'either'"); }
    else { cond.push("(b.audience = ? OR b.audience = 'either')"); args.push(q.audience); }
  }

  const { results } = await db
    .prepare(
      `SELECT ${PUBLIC_BOUNTY_COLS} FROM bounties b JOIN agents a ON a.id = b.poster_id
       WHERE ${cond.join(" AND ")} ORDER BY b.created_at DESC LIMIT ?`,
    )
    .bind(...args, limit)
    .all<PublicBounty>();
  return results;
}

/**
 * A poster's public track record. Computed live from the bounty table rather
 * than denormalised, so it cannot drift from what actually happened.
 *
 * This is the residual defence against harvesting: sealing the deliverable stops
 * the free copy, and this stops a poster who repeatedly collects previews and
 * walks from doing it unnoticed. Fillers should read it before spending work.
 */
export async function posterReputation(db: D1Database, posterId: string) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS posted,
              SUM(CASE WHEN status = 'awarded'   THEN 1 ELSE 0 END) AS awarded,
              SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN status = 'expired'   THEN 1 ELSE 0 END) AS expired
         FROM bounties WHERE poster_id = ? AND status != 'removed'`,
    )
    .bind(posterId)
    .first<{ posted: number; awarded: number; cancelled: number; expired: number }>();
  const posted = r?.posted ?? 0;
  const awarded = r?.awarded ?? 0;
  const cancelled = r?.cancelled ?? 0;
  const expired = r?.expired ?? 0;
  // Only count bounties that actually drew work: cancelling an ignored bounty
  // costs nobody anything and should not stain the record.
  const withWork = await db
    .prepare(
      `SELECT COUNT(DISTINCT b.id) AS n FROM bounties b JOIN submissions s ON s.bounty_id = b.id
        WHERE b.poster_id = ? AND b.status IN ('cancelled','expired') AND s.status != 'draft'`,
    )
    .bind(posterId)
    .first<{ n: number }>();
  return {
    bounties_posted: posted,
    awarded,
    cancelled,
    expired,
    abandoned_after_submissions: withWork?.n ?? 0,
    award_rate: posted ? Math.round((awarded / posted) * 100) / 100 : null,
  };
}

/** Attach the contributor roster to each submission, so a reviewer can see who is owed what. */
async function withTeams(db: D1Database, subs: Submission[]) {
  return Promise.all(
    subs.map(async (sub) => ({ ...sub, contributors: await contributorsOf(db, sub.id) })),
  );
}

export async function getBounty(
  db: D1Database,
  id: string,
  viewer: Agent | null,
): Promise<{
  bounty: PublicBounty;
  submissions?: Omit<Submission, "content">[] | Submission[];
  your_role?: string;
  note?: string;
  invitations?: string[];
}> {
  await expireOverdue(db);
  const bounty = await db
    .prepare(`SELECT ${PUBLIC_BOUNTY_COLS} FROM bounties b JOIN agents a ON a.id = b.poster_id WHERE b.id = ?`)
    .bind(id)
    .first<PublicBounty>();
  if (!bounty || bounty.status === "removed") throw new OpError(404, `no bounty ${id}`);
  (bounty as PublicBounty & { poster_reputation?: unknown; milestones?: unknown }).poster_reputation =
    await posterReputation(db, bounty.poster_id);
  const parts = await milestonesOf(db, id);
  if (parts.length)
    (bounty as PublicBounty & { milestones?: unknown }).milestones = parts.map((m) => ({
      id: m.id, idx: m.idx, title: m.title,
      reward: fmtMoney(m.reward_amount_cents, bounty.reward_currency),
      reward_amount_cents: m.reward_amount_cents,
      status: m.status, awarded_at: m.awarded_at,
    }));

  // Submission CONTENT is visible only to the poster and to its own author.
  // This is load-bearing for the race: a public answer is a free answer, and
  // the whole first-to-fill mechanism collapses if competitors can copy it.
  // Drafts are invisible to the poster: a team that is still forming has not
  // offered anything yet, and showing it would leak a half-built answer.
  if (viewer?.id === bounty.poster_id) {
    const { results } = await db
      .prepare("SELECT * FROM submissions WHERE bounty_id = ? AND status NOT IN ('draft','withdrawn') ORDER BY created_at")
      .bind(id)
      .all<Submission>();
    // Content is released ONLY for the submission you awarded. Everything else
    // shows its preview. This is what makes "read everything then cancel"
    // stop being a way to get work for free.
    const shown = (results ?? []).map((r) =>
      r.status === "accepted" ? r : { ...r, content: null, sealed: true },
    );
    return {
      bounty,
      submissions: await withTeams(db, shown as Submission[]),
      your_role: "poster",
      note: "You review on previews. Awarding releases the winning submission's full content; it is final and cannot be undone.",
    };
  }
  // A contributor sees their own team's submission only once they have JOINED.
  // Invited-but-not-joined deliberately returns nothing: that gap is what stops
  // an invite from being used to read a rival team's answer.
  if (viewer) {
    const { results } = await db
      .prepare(
        "SELECT s.* FROM submissions s JOIN submission_contributors c ON c.submission_id = s.id " +
          "WHERE s.bounty_id = ? AND c.agent_id = ? AND c.accepted_at IS NOT NULL ORDER BY s.created_at",
      )
      .bind(id, viewer.id)
      .all<Submission>();
    if (results.length)
      return { bounty, submissions: await withTeams(db, results), your_role: "contributor" };
    const invited = await db
      .prepare(
        "SELECT s.id FROM submissions s JOIN submission_contributors c ON c.submission_id = s.id " +
          "WHERE s.bounty_id = ? AND c.agent_id = ? AND c.accepted_at IS NULL AND s.status = 'draft'",
      )
      .bind(id, viewer.id)
      .all<{ id: string }>();
    if ((invited.results ?? []).length)
      return {
        bounty,
        your_role: "invited",
        invitations: (invited.results ?? []).map((r) => r.id),
      };
  }
  return { bounty };
}

export async function submitToBounty(
  db: D1Database,
  agent: Agent,
  bountyId: string,
  contentRaw: unknown,
  contributorsRaw?: unknown,
  previewRaw?: unknown,
  milestoneIdRaw?: unknown,
) {
  await expireOverdue(db);
  const content = reqString(contentRaw, "content", 1, LIMITS.submission_content.max);
  // The preview is what the poster judges on. It is mandatory: without it the
  // poster has nothing to evaluate and would need the sealed content back.
  const preview = reqString(
    previewRaw, "preview", LIMITS.submission_preview.min, LIMITS.submission_preview.max,
  );
  const b = await db.prepare("SELECT * FROM bounties WHERE id = ?").bind(bountyId).first<Bounty>();
  if (!b || b.status === "removed") throw new OpError(404, `no bounty ${bountyId}`);
  if (b.status !== "open") throw new OpError(409, `bounty is ${b.status}, not accepting submissions`);
  if (b.poster_id === agent.id) throw new OpError(403, "you cannot submit to your own bounty");

  // On a milestoned bounty you fill ONE part, and that part's reward is what
  // gets split. Requiring the target explicitly beats inferring it: a wrong
  // guess would silently compete for the wrong money.
  const parts = await milestonesOf(db, bountyId);
  let milestone: Milestone | null = null;
  if (parts.length) {
    const mid = String(milestoneIdRaw ?? "");
    if (!mid)
      throw new OpError(
        400,
        `this bounty has ${parts.length} milestones — pass milestone_id to say which one you are filling: ` +
          parts.map((m) => `${m.id} (${m.title}, ${fmtMoney(m.reward_amount_cents, b.reward_currency)}, ${m.status})`).join("; "),
      );
    milestone = parts.find((m) => m.id === mid) ?? null;
    if (!milestone) throw new OpError(404, `no milestone ${mid} on bounty ${bountyId}`);
    if (milestone.status !== "open") throw new OpError(409, `milestone is ${milestone.status}, not accepting submissions`);
  } else if (milestoneIdRaw != null) {
    throw new OpError(400, "this bounty has no milestones — omit milestone_id");
  }
  const targetCents = milestone ? milestone.reward_amount_cents : b.reward_amount_cents;

  // Solo is the degenerate team: one contributor at 100%. Keeping a single
  // shape here is what gives award one payout path instead of two.
  const roster =
    contributorsRaw == null
      ? [{ agent_id: agent.id, share_bp: 10_000 }]
      : validateShares(contributorsRaw, agent.id, b.poster_id, feeSplit(targetCents, b.fee_bp).net);

  const ids = roster.map((r) => r.agent_id);
  const found = await db
    .prepare(`SELECT id FROM agents WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: string }>();
  const known = new Set((found.results ?? []).map((r) => r.id));
  const missing = ids.filter((i) => !known.has(i));
  if (missing.length) throw new OpError(404, `unknown contributor agent(s): ${missing.join(", ")}`);

  // Per-bounty and pending caps count every submission the agent is ON, not
  // just ones they authored — otherwise joining teams is an unmetered way
  // around both limits.
  const mine = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM submissions s JOIN submission_contributors c ON c.submission_id = s.id " +
        "WHERE s.bounty_id = ? AND c.agent_id = ? AND (? IS NULL OR s.milestone_id = ?)",
    )
    .bind(bountyId, agent.id, milestone?.id ?? null, milestone?.id ?? null)
    .first<{ n: number }>();
  if ((mine?.n ?? 0) >= LIMITS.submissions_per_agent_per_bounty)
    throw new OpError(429, `limit of ${LIMITS.submissions_per_agent_per_bounty} submissions per bounty reached`);
  const pending = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM submissions s JOIN submission_contributors c ON c.submission_id = s.id " +
        "WHERE c.agent_id = ? AND s.status IN ('pending','draft')",
    )
    .bind(agent.id)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= LIMITS.pending_submissions_per_agent)
    throw new OpError(429, "too many pending submissions — wait for reviews before submitting more");

  // A team submission is NOT award-eligible until everyone has consented, so it
  // starts as 'draft'. Solo submissions skip straight to 'pending' — the lead
  // consents by the act of submitting.
  const solo = roster.length === 1;
  const id = newId("sub");
  const at = nowIso();
  const stmts = [
    db.prepare(
      "INSERT INTO submissions (id, bounty_id, agent_id, milestone_id, content, preview, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, bountyId, agent.id, milestone?.id ?? null, content, preview, solo ? "pending" : "draft", at),
    ...roster.map((r) =>
      db.prepare(
        "INSERT INTO submission_contributors (submission_id, agent_id, share_bp, accepted_at) VALUES (?, ?, ?, ?)",
      ).bind(id, r.agent_id, r.share_bp, r.agent_id === agent.id ? at : null),
    ),
    eventStmt(
      db, at, solo ? "submission_received" : "team_forming", bountyId, agent.id,
      solo
        ? `submission for "${b.title}"`
        : `${roster.length}-agent team forming on "${b.title}"`,
    ),
  ];
  await db.batch(stmts);

  const pendingJoins = roster.filter((r) => r.agent_id !== agent.id).map((r) => r.agent_id);
  return {
    submission_id: id,
    bounty_id: bountyId,
    milestone_id: milestone?.id ?? null,
    filling: milestone ? milestone.title : "the whole bounty",
    status: solo ? "pending" : "draft",
    contributors: roster.map((r) => ({
      agent_id: r.agent_id,
      share_bp: r.share_bp,
      share: `${(r.share_bp / 100).toFixed(2)}%`,
      payout_if_awarded: fmtMoney(
        splitPayout(feeSplit(targetCents, b.fee_bp).net, roster.map((x) => x.share_bp))[
          roster.indexOf(r)
        ],
        b.reward_currency,
      ),
      accepted: r.agent_id === agent.id,
    })),
    awaiting_consent: pendingJoins,
    sealed: "Your content is sealed. The poster sees only your preview until they award the bounty.",
    note: solo
      ? "The poster reviews on your PREVIEW; the FIRST ACCEPTED submission takes the bounty and all other pending submissions are closed."
      : `Draft: not visible to the poster and not award-eligible until all ${pendingJoins.length} invited contributor(s) call join_submission. They cannot read the content until they join.`,
  };
}

/**
 * Consent to a share on a team submission. This is the gate that makes naming a
 * contributor safe: until it is called the invitee cannot read the content, so
 * an invite cannot be used to leak a rival's answer.
 */
export async function joinSubmission(db: D1Database, agent: Agent, submissionId: string) {
  const s = await db.prepare("SELECT * FROM submissions WHERE id = ?").bind(submissionId).first<Submission>();
  if (!s) throw new OpError(404, `no submission ${submissionId}`);
  const me = await db
    .prepare("SELECT * FROM submission_contributors WHERE submission_id = ? AND agent_id = ?")
    .bind(submissionId, agent.id)
    .first<Contributor>();
  if (!me) throw new OpError(403, "you are not an invited contributor on that submission");
  if (s.status !== "draft") throw new OpError(409, `submission is ${s.status}, no longer forming`);
  if (me.accepted_at) throw new OpError(409, "you have already joined this submission");

  const b = await db.prepare("SELECT * FROM bounties WHERE id = ?").bind(s.bounty_id).first<Bounty>();
  if (!b || b.status !== "open") throw new OpError(409, `bounty is ${b?.status ?? "gone"}, not accepting submissions`);

  const at = nowIso();
  await db
    .prepare("UPDATE submission_contributors SET accepted_at = ? WHERE submission_id = ? AND agent_id = ? AND accepted_at IS NULL")
    .bind(at, submissionId, agent.id)
    .run();

  // Last consent flips the draft to pending. The compare-and-swap on
  // status='draft' means concurrent final joins cannot double-promote it.
  const left = await db
    .prepare("SELECT COUNT(*) AS n FROM submission_contributors WHERE submission_id = ? AND accepted_at IS NULL")
    .bind(submissionId)
    .first<{ n: number }>();
  const complete = (left?.n ?? 0) === 0;
  if (complete) {
    const res = await db
      .prepare("UPDATE submissions SET status = 'pending' WHERE id = ? AND status = 'draft'")
      .bind(submissionId)
      .run();
    if (res.meta.changes)
      await db.batch([
        eventStmt(db, at, "submission_received", s.bounty_id, s.agent_id, `team submission for "${b.title}"`),
      ]);
  }
  return {
    submission_id: submissionId,
    joined: true,
    your_share_bp: me.share_bp,
    status: complete ? "pending" : "draft",
    still_awaiting: left?.n ?? 0,
  };
}

/**
 * Decline an invited share. This voids the whole draft rather than reallocating
 * the share: silently redistributing would change what the other contributors
 * already consented to.
 */
export async function declineSubmission(db: D1Database, agent: Agent, submissionId: string) {
  const s = await db.prepare("SELECT * FROM submissions WHERE id = ?").bind(submissionId).first<Submission>();
  if (!s) throw new OpError(404, `no submission ${submissionId}`);
  const me = await db
    .prepare("SELECT * FROM submission_contributors WHERE submission_id = ? AND agent_id = ?")
    .bind(submissionId, agent.id)
    .first<Contributor>();
  if (!me) throw new OpError(403, "you are not a contributor on that submission");
  if (s.status !== "draft") throw new OpError(409, `submission is ${s.status}, no longer forming`);
  const at = nowIso();
  await db.batch([
    db.prepare("UPDATE submissions SET status = 'withdrawn', review_note = ?, reviewed_at = ? WHERE id = ? AND status = 'draft'")
      .bind(`contributor ${agent.id} declined their share`, at, submissionId),
    eventStmt(db, at, "team_dissolved", s.bounty_id, agent.id, "a contributor declined; team submission withdrawn"),
  ]);
  return { submission_id: submissionId, status: "withdrawn", reason: "a contributor declined their share" };
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
  // Freeze the split into the ledger at award time. Storing payout_cents rather
  // than recomputing it later means a share can never be reinterpreted after the
  // fact, and the row is the receipt the off-platform settlement is made against.
  const team = await contributorsOf(db, submissionId);
  const mil = s.milestone_id
    ? await db.prepare("SELECT * FROM milestones WHERE id = ?").bind(s.milestone_id).first<Milestone>()
    : null;
  const potCents = mil ? mil.reward_amount_cents : b.reward_amount_cents;
  const { fee, net } = feeSplit(potCents, b.fee_bp);
  const payouts = splitPayout(net, team.map((t) => t.share_bp));

  // The arbiter is the SAME compare-and-swap, one level down when the bounty is
  // milestoned: awarding a part swaps that milestone from 'open', awarding a
  // whole bounty swaps the bounty. Either way two concurrent accepts cannot both
  // pass, and the loser gets a clean 409.
  const res = mil
    ? await db
        .prepare(
          "UPDATE milestones SET status = 'awarded', awarded_submission_id = ?, awarded_at = ?, fee_cents = ? WHERE id = ? AND status = 'open'",
        )
        .bind(submissionId, at, fee, mil.id)
        .run()
    : await db
        .prepare(
          "UPDATE bounties SET status = 'awarded', awarded_submission_id = ?, awarded_at = ?, payment_ref = ?, fee_cents = ? WHERE id = ? AND status = 'open'",
        )
        .bind(submissionId, at, ref, fee, bountyId)
        .run();
  if (!res.meta.changes)
    throw new OpError(
      409,
      mil
        ? "that milestone is no longer open — it was awarded or cancelled first"
        : "bounty is no longer open — it was awarded, cancelled or expired first",
    );

  // Winner is marked accepted BEFORE the pending-sweep, so the sweep's
  // status='pending' filter can no longer touch it.
  await db.batch([
    db.prepare("UPDATE submissions SET status = 'accepted', review_note = ?, reviewed_at = ? WHERE id = ?")
      .bind(reviewNote, at, submissionId),
    ...team.map((t, i) =>
      db.prepare("UPDATE submission_contributors SET payout_cents = ? WHERE submission_id = ? AND agent_id = ?")
        .bind(payouts[i], submissionId, t.agent_id),
    ),
    // Sweep only the submissions that were competing for the SAME pot. On a
    // milestoned bounty the other parts are still live and must not be closed.
    mil
      ? db.prepare(
          "UPDATE submissions SET status = 'closed', review_note = 'another submission was accepted first', reviewed_at = ? WHERE milestone_id = ? AND status IN ('pending','draft')",
        ).bind(at, mil.id)
      : db.prepare(
          "UPDATE submissions SET status = 'closed', review_note = 'another submission was accepted first', reviewed_at = ? WHERE bounty_id = ? AND status IN ('pending','draft')",
        ).bind(at, bountyId),
    // The feed is the board's public record, so it must not imply one agent took
    // a pot that several people split, nor that a milestone award closed the
    // whole bounty. Amount shown is the pot actually awarded.
    eventStmt(
      db, at, "bounty_awarded", bountyId, s.agent_id,
      (mil ? `milestone "${mil.title}" of "${b.title}"` : `"${b.title}"`) +
        (team.length > 1
          ? ` awarded to a team of ${team.length} (${team.map((t) => t.agent_id).join(", ")})`
          : ` awarded to ${s.agent_id}`) +
        ` — ${fmtMoney(potCents, b.reward_currency)} (stated)` +
        (team.length > 1
          ? `, split ${team.map((t, i) => fmtMoney(payouts[i], b.reward_currency)).join(" / ")}`
          : "") +
        (fee > 0 ? ` · fee ${fmtMoney(fee, b.reward_currency)}` : ""),
    ),
  ]);
  // A milestoned bounty is done only when every part is awarded. Rolling the fee
  // up as we go keeps bounties.fee_cents meaningful at any point, not just at the end.
  let bountyComplete = !mil;
  if (mil) {
    const left = await db
      .prepare("SELECT COUNT(*) AS n FROM milestones WHERE bounty_id = ? AND status = 'open'")
      .bind(bountyId)
      .first<{ n: number }>();
    bountyComplete = (left?.n ?? 0) === 0;
    const rolled = await db
      .prepare("SELECT COALESCE(SUM(fee_cents),0) AS f FROM milestones WHERE bounty_id = ?")
      .bind(bountyId)
      .first<{ f: number }>();
    await db
      .prepare(
        bountyComplete
          ? "UPDATE bounties SET status = 'awarded', awarded_at = ?, payment_ref = COALESCE(?, payment_ref), fee_cents = ? WHERE id = ? AND status = 'open'"
          : "UPDATE bounties SET fee_cents = ? WHERE id = ?",
      )
      .bind(...(bountyComplete ? [at, ref, rolled?.f ?? 0, bountyId] : [rolled?.f ?? 0, bountyId]))
      .run();
  }

  return {
    bounty_id: bountyId,
    milestone_id: mil?.id ?? null,
    milestone_title: mil?.title ?? null,
    bounty_complete: bountyComplete,
    winning_submission_id: submissionId,
    winner_agent_id: s.agent_id,
    reward: fmtMoney(potCents, b.reward_currency),
    platform_fee: fmtMoney(fee, b.reward_currency),
    platform_fee_bp: b.fee_bp,
    net_to_contributors: fmtMoney(net, b.reward_currency),
    payouts: team.map((t, i) => ({
      agent_id: t.agent_id,
      share_bp: t.share_bp,
      amount: fmtMoney(payouts[i], b.reward_currency),
      amount_cents: payouts[i],
    })),
    payment_ref: ref,
    settlement:
      team.length > 1
        ? `${SETTLEMENT_NOTE} This bounty was filled by a team of ${team.length}: settle with EACH contributor for the amount listed in payouts.`
        : SETTLEMENT_NOTE,
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
    db.prepare("UPDATE milestones SET status = 'cancelled' WHERE bounty_id = ? AND status = 'open'").bind(bountyId),
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
  const [posted, submitted, invites] = await db.batch([
    db.prepare(
      "SELECT id, title, status, reward_amount_cents, reward_currency, deadline, created_at, awarded_submission_id FROM bounties WHERE poster_id = ? ORDER BY created_at DESC LIMIT 50",
    ).bind(agent.id),
    db.prepare(
      "SELECT s.id, s.bounty_id, s.status, s.review_note, s.created_at, s.reviewed_at, c.share_bp, c.payout_cents " +
        "FROM submissions s JOIN submission_contributors c ON c.submission_id = s.id " +
        "WHERE c.agent_id = ? AND c.accepted_at IS NOT NULL ORDER BY s.created_at DESC LIMIT 50",
    ).bind(agent.id),
    db.prepare(
      "SELECT s.id AS submission_id, s.bounty_id, b.title, c.share_bp, s.created_at " +
        "FROM submissions s JOIN submission_contributors c ON c.submission_id = s.id " +
        "JOIN bounties b ON b.id = s.bounty_id " +
        "WHERE c.agent_id = ? AND c.accepted_at IS NULL AND s.status = 'draft' ORDER BY s.created_at DESC LIMIT 50",
    ).bind(agent.id),
  ]);
  return {
    agent: { id: agent.id, name: agent.name, registered: agent.created_at },
    bounties_posted: posted.results ?? [],
    submissions_made: submitted.results ?? [],
    // Shares you have been offered but not yet consented to. Until you join,
    // the submission is not award-eligible and you cannot read its content.
    invitations_awaiting_you: invites.results ?? [],
  };
}
