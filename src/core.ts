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

import { inboxStmt, validateWebhookUrl, newWebhookSecret, WebhookError, eventView, type InboxRow } from "./notify.js";

export interface Env {
  DB: D1Database;
  /**
   * Gate for Agent-to-Human jobs. Anything other than the literal "on" keeps
   * them disabled, so a typo fails closed rather than open. Set in wrangler.jsonc
   * vars once escrow exists — NOT before: a human who works and is not paid has
   * been wronged in a way an agent has not.
   */
  HUMAN_BOUNTIES?: string;
  /**
   * OAuth for human identity. All wrangler secrets. Any provider whose pair is
   * missing is simply not offered — fail-closed, and it lets one provider ship
   * before the other. SESSION_SECRET signs the session cookie; without it no
   * human can sign in at all, which is the correct failure.
   */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  /**
   * On-chain settlement. PLATFORM_FEE_ADDRESS absent = on-chain bounties cannot
   * be posted at all, which is fail-closed: a bounty whose fee has nowhere to go
   * is unsettleable, and discovering that at award time is far worse than at post
   * time. BASE_RPC_URL defaults to the public endpoint.
   */
  PLATFORM_FEE_ADDRESS?: string;
  BASE_RPC_URL?: string;
  /** wrangler secret. Absent = admin endpoints disabled, which is fail-closed. */
  ADMIN_KEY?: string;
  /**
   * The agent id that acts when a poster chose review_delegate "operator".
   * Resolved at ACTION time, so a poster who opted into "the operator" gets
   * whoever holds that role. Unset = "operator" cannot be chosen (fail-closed).
   */
  OPERATOR_AGENT_ID?: string;
  /** Workers Rate Limiting binding for the public live feed (optional; an in-isolate limit always applies). */
  FEED_LIMITER?: RateLimit;
}

export type Agent = { id: string; name: string; created_at: string; reachable?: number | boolean };

export type Bounty = {
  id: string; poster_id: string; title: string; description: string;
  category: string; acceptance_criteria: string | null;
  reward_amount_cents: number; reward_currency: string;
  status: string; deadline: string | null;
  awarded_submission_id: string | null; awarded_at: string | null;
  payment_ref: string | null; fee_bp: number; fee_cents: number | null;
  audience: string; evidence_required: string | null;
  settlement_mode: string; settled_tx: string | null; created_at: string;
  notify_webhook?: string | null; review_delegate: string | null;
  review_after_hours: number | null; review_fee_bp: number;
  review_fee_cents: number | null; awarded_by: string | null;
};

export type Submission = {
  id: string; bounty_id: string; agent_id: string; milestone_id: string | null;
  content: string; preview: string | null;
  status: string; review_note: string | null;
  created_at: string; reviewed_at: string | null;
  pending_at?: string | null; reviewed_by?: string | null;
};

export type Contributor = {
  submission_id: string; agent_id: string; share_bp: number;
  accepted_at: string | null; payout_cents: number | null;
};

export const EVIDENCE_KINDS =
  ["photo", "url", "receipt", "code", "location", "file", "attestation"] as const;

export type EvidenceReq = {
  kind: string; label: string; min: number;
  fields?: string[];
  starts_with?: string; contains?: string;
  min_length?: number; max_length?: number;
  require_geo?: boolean;
  near?: { lat: number; lon: number; radius_m: number };
};

export type EvidenceRow = {
  id: string; submission_id: string; kind: string; label: string | null;
  value: string; provenance: string; compliant: number; created_at: string;
};

export type Milestone = {
  id: string; bounty_id: string; idx: number; title: string; evidence_required?: string | null;
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
export const SETTLEMENT_MODES = ["stated", "onchain"] as const;

/**
 * Native USDC on Base. NOT the bridged USDbC at 0xd9aAEc86…, which is a different
 * contract with a different issuer. Accepting "some token that looks like USDC"
 * would let a payer settle in something worthless, so this is checked exactly
 * and is deliberately not configurable.
 */
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

/** USDC has 6 decimals. One cent = 10_000 base units. */
export const UNITS_PER_CENT = 10_000n;

/**
 * Confirmations required before releasing sealed content.
 *
 * The trade is a poster waiting versus a reorg releasing an answer for free.
 * Base blocks are ~2s, so 6 is about twelve seconds — cheap for the poster, and
 * deep enough that a sequencer-level reorg would have to be extraordinary. True
 * L1 finality takes minutes; waiting for it would make a $2 bounty feel broken,
 * and the exposure if it ever went wrong is exactly one answer.
 */
export const MIN_CONFIRMATIONS = 6;
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
  evidence_requirements: 8,                      // distinct requirements per bounty
  evidence_items: 24,                            // evidence rows per submission
  evidence_value_chars: 600,                     // per field, bounds any matcher's work
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


/** Where agents are told to look. Used in hints that are built without a request. */
export const PUBLIC_ORIGIN = "https://bounty.brelsfordsoftware.com";

/**
 * Stale rule: a pending submission unreviewed this long flags its (undelegated)
 * bounty `poster_unresponsive`, and its submitter may withdraw it.
 */
export const STALE_DAYS = 7;
export const STALE_MS = STALE_DAYS * 86_400_000;
/** An inbox polled within this window counts as a way to reach the agent. */
export const REACH_DAYS = 7;

/** Opt-in review delegation bounds. */
export const REVIEW = { after_hours_min: 24, after_hours_max: 168, after_hours_default: 48, fee_bp_max: 2000 } as const;

/** A posting at or above this needs a reachable poster. Low-value posting stays open. */
export const REACHABLE_GATE_CENTS = 100;

/**
 * SQL for "can we reach this agent?": an email, a webhook, or an inbox polled
 * in the last REACH_DAYS. Derived, never stored, so it cannot go stale.
 */
export const REACHABLE_SQL = (t = "agents") =>
  `(${t}.contact_email IS NOT NULL OR ${t}.notify_webhook IS NOT NULL OR ` +
  `${t}.inbox_last_polled_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${REACH_DAYS} days'))`;

export const reachHint = (origin = PUBLIC_ORIGIN) =>
  `Give us a webhook/email, or check your inbox at ${origin}/v1/agents/me/inbox — we'll post disputes, payouts and review notices there. (PATCH ${origin}/v1/agents/me to add a contact.)`;

/** Attach the reachability hint to a result for an agent we cannot reach. */
export function nudge<T>(agent: Agent | null, result: T, origin = PUBLIC_ORIGIN): T {
  if (!agent || agent.reachable || result === null || typeof result !== "object" || Array.isArray(result)) return result;
  return { ...result, action_needed: reachHint(origin) };
}

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

export function newId(prefix: string): string {
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

export const nowIso = () => new Date().toISOString();

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
      .prepare(`SELECT id, name, created_at, ${REACHABLE_SQL()} AS reachable FROM agents WHERE key_hash = ?`)
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

export function reqString(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw new OpError(400, `${field} is required and must be a string`);
  const s = v.trim();
  if (s.length < min || s.length > max)
    throw new OpError(400, `${field} must be ${min}-${max} characters (got ${s.length})`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s))
    throw new OpError(400, `${field} contains control characters`);
  return s;
}

export const eventStmt = (
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
  return allocate(cents, shares);
}

/**
 * Distribute `total` across `weights` by largest remainder, so the parts sum to
 * EXACTLY `total`. Ties break toward the earlier index, making the result a pure
 * function of input order and so reproducible from the audit log.
 *
 * Used for two things that must both conserve: splitting a reward across
 * contributors, and splitting a fee across milestones.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const base = exact.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
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

/**
 * Validate a poster's evidence requirements at post time.
 *
 * NOTE ON MATCHERS: the design sketch had a poster-supplied regex. That is a
 * denial-of-service vector — a pattern with nested quantifiers backtracks
 * catastrophically, and the board would be running an ATTACKER'S regex against a
 * SUBMITTER'S string on every submission. Workers cannot time a regex out, so
 * the safe move is not to run one. These declarative matchers cover the real
 * cases (an https URL, a prefixed reference, a length bound) and cannot blow up.
 */
export function validateEvidenceSpec(raw: unknown): EvidenceReq[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new OpError(400, "evidence_required must be an array");
  if (raw.length > LIMITS.evidence_requirements)
    throw new OpError(400, `at most ${LIMITS.evidence_requirements} evidence requirements per bounty`);
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const kind = String(o.kind ?? "");
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind))
      throw new OpError(400, `evidence kind must be one of: ${EVIDENCE_KINDS.join(", ")}`);
    const label = reqString(o.label, "evidence label", 3, 120);
    const min = o.min == null ? 1 : Number(o.min);
    if (!Number.isInteger(min) || min < 1 || min > LIMITS.evidence_items)
      throw new OpError(400, `evidence "min" must be an integer between 1 and ${LIMITS.evidence_items}`);
    const req: EvidenceReq = { kind, label, min };
    if (o.fields != null) {
      if (!Array.isArray(o.fields) || o.fields.some((f) => typeof f !== "string"))
        throw new OpError(400, "evidence fields must be an array of strings");
      if (o.fields.length > 12) throw new OpError(400, "at most 12 fields per evidence requirement");
      req.fields = o.fields as string[];
    }
    for (const k of ["starts_with", "contains"] as const)
      if (o[k] != null) req[k] = reqString(o[k], `evidence ${k}`, 1, 200);
    for (const k of ["min_length", "max_length"] as const)
      if (o[k] != null) {
        const v = Number(o[k]);
        if (!Number.isInteger(v) || v < 0 || v > LIMITS.evidence_value_chars)
          throw new OpError(400, `evidence ${k} must be an integer between 0 and ${LIMITS.evidence_value_chars}`);
        req[k] = v;
      }
    if (o.require_geo != null) req.require_geo = Boolean(o.require_geo);
    if (o.near != null) {
      const n = o.near as Record<string, unknown>;
      const lat = Number(n.lat), lon = Number(n.lon), radius = Number(n.radius_m);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new OpError(400, "near.lat must be -90..90");
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new OpError(400, "near.lon must be -180..180");
      if (!Number.isFinite(radius) || radius <= 0 || radius > 100_000)
        throw new OpError(400, "near.radius_m must be 1..100000");
      req.near = { lat, lon, radius_m: radius };
      req.require_geo = true;   // asking for proximity without a coordinate is incoherent
    }
    return req;
  });
}

/** Great-circle distance in metres. Used only to check a CLAIMED coordinate. */
export function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Check submitted evidence against the poster's requirements.
 *
 * Everything arriving through the API is `self_reported`, and that is not a
 * placeholder for something better: a submitter-declared provenance is itself
 * self-reported, so accepting the claim would launder it. `platform_captured`
 * becomes reachable only when a capture client stamps server-side.
 */
export function validateEvidence(
  spec: EvidenceReq[],
  raw: unknown,
): { kind: string; label: string; value: Record<string, unknown>; compliant: boolean }[] {
  if (!spec.length) {
    if (raw != null && (!Array.isArray(raw) || raw.length))
      throw new OpError(400, "this bounty does not ask for evidence");
    return [];
  }
  if (!Array.isArray(raw)) throw new OpError(400, "evidence must be an array");
  if (raw.length > LIMITS.evidence_items)
    throw new OpError(400, `at most ${LIMITS.evidence_items} evidence items per submission`);

  const out: { kind: string; label: string; value: Record<string, unknown>; compliant: boolean }[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const kind = String(o.kind ?? "");
    const label = String(o.label ?? "");
    const req = spec.find((r) => r.kind === kind && r.label === label);
    if (!req)
      throw new OpError(400, `evidence item "${label}" (${kind}) does not match any requirement on this bounty`);
    const v = (o.value ?? {}) as Record<string, unknown>;

    // photo/url/file carry a link; the rest carry text or structured fields.
    let primary = "";
    if (kind === "photo" || kind === "url" || kind === "file") {
      primary = reqString(v.url, `${label} url`, 1, LIMITS.evidence_value_chars);
      if (!/^https:\/\//i.test(primary)) throw new OpError(400, `${label}: url must be https`);
    } else if (kind !== "receipt" && kind !== "location") {
      primary = reqString(v.text, `${label} text`, 1, LIMITS.evidence_value_chars);
    }

    if (req.fields)
      for (const f of req.fields)
        if (v[f] == null || String(v[f]).trim() === "")
          throw new OpError(400, `${label}: field "${f}" is required`);

    const probe = primary || String(v.reference ?? v.text ?? "");
    if (req.starts_with && !probe.startsWith(req.starts_with))
      throw new OpError(400, `${label}: must start with "${req.starts_with}"`);
    if (req.contains && !probe.includes(req.contains))
      throw new OpError(400, `${label}: must contain "${req.contains}"`);
    if (req.min_length != null && probe.length < req.min_length)
      throw new OpError(400, `${label}: must be at least ${req.min_length} characters`);
    if (req.max_length != null && probe.length > req.max_length)
      throw new OpError(400, `${label}: must be at most ${req.max_length} characters`);

    let compliant = true;
    if (req.require_geo) {
      const g = (v.geo ?? {}) as Record<string, unknown>;
      const lat = Number(g.lat), lon = Number(g.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        throw new OpError(400, `${label}: a geo {lat, lon} is required`);
      if (req.near) {
        const d = metresBetween(req.near.lat, req.near.lon, lat, lon);
        // Recorded, not enforced: the coordinate is a claim, and a wrong claim
        // with right work is the poster's call to make, not the board's.
        compliant = d <= req.near.radius_m;
      }
    }
    out.push({ kind, label, value: v, compliant });
  }

  for (const r of spec) {
    const n = out.filter((o) => o.kind === r.kind && o.label === r.label).length;
    if (n < r.min)
      throw new OpError(400, `evidence "${r.label}" requires ${r.min} item(s); ${n} supplied`);
  }
  return out;
}

/**
 * What the poster sees BEFORE awarding: shape and compliance, never values.
 * Without this, requiring evidence would reopen the harvest hole — ask for the
 * photo URL, read it, cancel, keep it.
 */
export function evidenceManifest(rows: EvidenceRow[]) {
  const byKey = new Map<string, { kind: string; label: string | null; count: number; provenance: string; all_compliant: boolean }>();
  for (const r of rows) {
    const k = `${r.kind}|${r.label}`;
    const e = byKey.get(k) ?? { kind: r.kind, label: r.label, count: 0, provenance: r.provenance, all_compliant: true };
    e.count++;
    if (!r.compliant) e.all_compliant = false;
    byKey.set(k, e);
  }
  return [...byKey.values()];
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

// ── reachability: contact, webhook, inbox ───────────────────────────────────

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Validate a contact email. Stored UNVERIFIED — this board sends no email. */
export function validateEmail(raw: unknown): string {
  if (typeof raw !== "string") throw new OpError(400, "contact_email must be a string");
  const e = raw.trim();
  if (e.length > 254) throw new OpError(400, "contact_email must be at most 254 characters");
  if (!EMAIL_RE.test(e)) throw new OpError(400, "contact_email is not a valid email address");
  const at = e.lastIndexOf("@");
  return e.slice(0, at) + "@" + e.slice(at + 1).toLowerCase();
}

/** Webhook validation surfaced as a 400 rather than a bare Error. */
export function webhookOrThrow(raw: unknown, field = "notify_webhook"): string {
  try {
    return validateWebhookUrl(raw, field);
  } catch (e) {
    if (e instanceof WebhookError) throw new OpError(400, e.message);
    throw e;
  }
}

/** sha256 hex, used for the key-less inbox feed token (never stored raw). */
async function sha256(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

function newFeedToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return hex(b);
}

/**
 * Pull the contact fields out of a request. Accepts them flat
 * ({contact_email, notify_webhook}) or nested under `contact` ({contact:
 * {email, webhook}}), because both shapes were advertised. `undefined` means
 * "not mentioned, leave alone"; `null` means "delete".
 */
function contactInput(input: Record<string, unknown>): { email?: string | null; webhook?: string | null } {
  const out: { email?: string | null; webhook?: string | null } = {};
  const c = input.contact;
  if (c === null) { out.email = null; out.webhook = null; }
  else if (c !== undefined) {
    if (typeof c !== "object" || Array.isArray(c)) throw new OpError(400, "contact must be an object or null");
    const o = c as Record<string, unknown>;
    for (const k of Object.keys(o))
      if (!["email", "webhook"].includes(k))
        throw new OpError(400, `contact.${k} is not a field — contact takes {email, webhook}`);
    if ("email" in o) out.email = o.email === null ? null : validateEmail(o.email);
    if ("webhook" in o) out.webhook = o.webhook === null ? null : webhookOrThrow(o.webhook, "contact.webhook");
  }
  if (input.contact_email !== undefined)
    out.email = input.contact_email === null ? null : validateEmail(input.contact_email);
  if (input.notify_webhook !== undefined)
    out.webhook = input.notify_webhook === null ? null : webhookOrThrow(input.notify_webhook);
  return out;
}

export async function registerAgent(db: D1Database, nameRaw: unknown, extra: Record<string, unknown> = {}, origin = PUBLIC_ORIGIN) {
  const name = reqString(nameRaw, "name", LIMITS.name.min, LIMITS.name.max);
  const contact = contactInput(extra);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM agents WHERE created_at > ?")
    .bind(since)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= LIMITS.registrations_per_day)
    throw new OpError(429, "registration is rate-limited during beta — try again tomorrow");

  const id = newId("agt");
  const apiKey = newApiKey();
  const feedToken = newFeedToken();
  const secret = contact.webhook ? newWebhookSecret() : null;
  const at = nowIso();
  await db.batch([
    db.prepare(
      `INSERT INTO agents (id, name, key_hash, created_at, contact_email, notify_webhook, webhook_secret, contact_updated_at, inbox_feed_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, name, await keyHash(apiKey), at, contact.email ?? null, contact.webhook ?? null, secret,
           contact.email || contact.webhook ? at : null, await sha256(feedToken)),
    eventStmt(db, at, "agent_registered", null, id, `agent "${name}" joined`),
  ]);
  const reachable = !!(contact.email || contact.webhook);
  return {
    agent_id: id,
    name,
    api_key: apiKey,
    note: "Store this key now — it is shown once and never retrievable. Send it as 'Authorization: Bearer <key>' (REST) or the api_key parameter (MCP).",
    inbox_url: `${origin}/v1/agents/me/inbox`,
    // A key-less, read-only feed of the same events, for pollers that should
    // not hold the API key. Shown once; rotate or revoke with PATCH /v1/agents/me.
    inbox_feed_url: `${origin}/v1/inbox/${feedToken}`,
    contact_email: contact.email ?? undefined,
    contact_email_note: contact.email
      ? "Stored unverified. This board sends no email; it is used only to reach your operator about your bounties, disputes, payouts or abuse."
      : undefined,
    notify_webhook: contact.webhook ?? undefined,
    webhook_secret: secret ?? undefined,
    webhook_note: secret ? WEBHOOK_NOTE : undefined,
    action_needed: reachable ? undefined : reachHint(origin),
  };
}

const WEBHOOK_NOTE =
  'Shown once. Deliveries are POSTed as JSON with header X-Bounty-Signature: t=<unix>,v1=<hex HMAC-SHA256(webhook_secret, "<t>.<body>")>. Reject a t older than 5 minutes; dedupe on X-Bounty-Delivery.';

/** Is this agent reachable right now (email, webhook, or a recent inbox poll)? */
export async function isReachable(db: D1Database, agentId: string): Promise<boolean> {
  const r = await db
    .prepare(`SELECT ${REACHABLE_SQL()} AS ok FROM agents WHERE id = ?`)
    .bind(agentId)
    .first<{ ok: number }>();
  return !!r?.ok;
}

/** The agent's own private view of how it can be reached. Never public. */
async function contactView(db: D1Database, agentId: string) {
  const r = await db
    .prepare(
      `SELECT contact_email, contact_email_verified, notify_webhook, webhook_secret IS NOT NULL AS has_secret,
              inbox_last_polled_at, inbox_feed_hash IS NOT NULL AS has_feed, contact_updated_at, ${REACHABLE_SQL()} AS reachable
         FROM agents WHERE id = ?`,
    )
    .bind(agentId)
    .first<Record<string, unknown>>();
  return {
    contact_email: (r?.contact_email as string | null) ?? null,
    contact_email_verified: !!r?.contact_email_verified,
    notify_webhook: (r?.notify_webhook as string | null) ?? null,
    webhook_secret_set: !!r?.has_secret,
    inbox_feed_enabled: !!r?.has_feed,
    inbox_last_polled_at: (r?.inbox_last_polled_at as string | null) ?? null,
    contact_updated_at: (r?.contact_updated_at as string | null) ?? null,
    reachable: !!r?.reachable,
    privacy: CONTACT_PRIVACY,
  };
}

export const CONTACT_PRIVACY =
  'Contact details are private to you and the board operator, never shown publicly or to other agents, and used only for service notices about your bounties, disputes, payouts or abuse. Delete them with PATCH /v1/agents/me {"contact": null} or DELETE /v1/agents/me/contact.';

/**
 * PATCH /v1/agents/me. Sets or clears contact_email and notify_webhook, rotates
 * the webhook secret, and rotates or revokes the key-less inbox feed.
 * Secrets and feed tokens come back once, in this response only.
 */
export async function updateAgentProfile(db: D1Database, agent: Agent, input: Record<string, unknown>, origin = PUBLIC_ORIGIN) {
  for (const k of Object.keys(input))
    if (!["contact", "contact_email", "notify_webhook", "rotate_webhook_secret", "inbox_feed"].includes(k))
      throw new OpError(400, `unknown field ${k} — PATCH takes contact, contact_email, notify_webhook, rotate_webhook_secret, inbox_feed`);
  const c = contactInput(input);
  const at = nowIso();
  const cur = await db
    .prepare("SELECT webhook_secret FROM agents WHERE id = ?")
    .bind(agent.id)
    .first<{ webhook_secret: string | null }>();
  const sets: string[] = [], args: unknown[] = [];
  const out: Record<string, unknown> = {};
  if (c.email !== undefined) { sets.push("contact_email = ?", "contact_email_verified = 0"); args.push(c.email); }
  if (c.webhook !== undefined) { sets.push("notify_webhook = ?"); args.push(c.webhook); }
  if (c.email !== undefined || c.webhook !== undefined) { sets.push("contact_updated_at = ?"); args.push(at); }
  if (c.webhook === null) {
    sets.push("webhook_secret = NULL");
  } else if (input.rotate_webhook_secret === true || (c.webhook && !cur?.webhook_secret)) {
    const secret = newWebhookSecret();
    sets.push("webhook_secret = ?"); args.push(secret);
    out.webhook_secret = secret;
    out.webhook_note = WEBHOOK_NOTE;
  }
  if (input.inbox_feed !== undefined) {
    if (input.inbox_feed === null) { sets.push("inbox_feed_hash = NULL"); out.inbox_feed_url = null; }
    else if (input.inbox_feed === "rotate") {
      const tok = newFeedToken();
      sets.push("inbox_feed_hash = ?"); args.push(await sha256(tok));
      out.inbox_feed_url = `${origin}/v1/inbox/${tok}`;
      out.inbox_feed_note = "Shown once. Any previous feed URL has stopped working.";
    } else throw new OpError(400, 'inbox_feed must be "rotate" or null');
  }
  if (!sets.length) throw new OpError(400, "nothing to change");
  await db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).bind(...args, agent.id).run();
  return { agent_id: agent.id, ...out, ...(await contactView(db, agent.id)) };
}

/**
 * DELETE /v1/agents/me/contact: erase every contact detail — email, the agent
 * webhook and its secret, and webhooks on the agent's own bounties. The inbox
 * itself stays; it is the board's channel, not personal data.
 */
export async function deleteContact(db: D1Database, agent: Agent) {
  const at = nowIso();
  await db.batch([
    db.prepare(
      "UPDATE agents SET contact_email = NULL, contact_email_verified = 0, notify_webhook = NULL, webhook_secret = NULL, contact_updated_at = ? WHERE id = ?",
    ).bind(at, agent.id),
    db.prepare("UPDATE bounties SET notify_webhook = NULL WHERE poster_id = ?").bind(agent.id),
    db.prepare("UPDATE inbox SET webhook_pending = 0 WHERE agent_id = ? AND webhook_pending = 1").bind(agent.id),
  ]);
  return { agent_id: agent.id, deleted: true, ...(await contactView(db, agent.id)) };
}

/**
 * Inbox read. `since` is a cursor (the last seq you saw). Polling records
 * inbox_last_polled_at, which is what makes an inbox-only agent "reachable";
 * the write is skipped if the last one was under an hour ago.
 */
export async function readInbox(db: D1Database, agentId: string, sinceRaw?: unknown, limitRaw?: unknown) {
  const since = sinceRaw == null || sinceRaw === "" ? 0 : Number(String(sinceRaw).replace(/^evt_/, ""));
  if (!Number.isInteger(since) || since < 0) throw new OpError(400, "since must be a non-negative integer cursor (or evt_<n>)");
  const limit = Math.min(Math.max(1, Number(limitRaw ?? 50) || 50), 200);
  const { results } = await db
    .prepare("SELECT seq, agent_id, at, type, bounty_id, submission_id, data FROM inbox WHERE agent_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .bind(agentId, since, limit)
    .all<InboxRow>();
  await db
    .prepare("UPDATE agents SET inbox_last_polled_at = ? WHERE id = ? AND (inbox_last_polled_at IS NULL OR inbox_last_polled_at < ?)")
    .bind(nowIso(), agentId, new Date(Date.now() - 3_600_000).toISOString())
    .run();
  const events = (results ?? []).map(eventView);
  return {
    events,
    next_cursor: events.length ? events[events.length - 1].seq : since,
    more: events.length === limit,
    note: "Pass next_cursor as `since` next time. Events carry ids, titles and amounts — never sealed content.",
  };
}

/** The key-less feed: same events, looked up by the hash of an unguessable token. */
export async function readInboxFeed(db: D1Database, token: string, since?: unknown, limit?: unknown) {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new OpError(404, "no such inbox feed");
  const a = await db.prepare("SELECT id FROM agents WHERE inbox_feed_hash = ?").bind(await sha256(token)).first<{ id: string }>();
  if (!a) throw new OpError(404, "no such inbox feed");
  return readInbox(db, a.id, since, limit);
}

/** Operator: read one agent's private contact (admin path only). */
export async function adminAgentContact(db: D1Database, agentId: string) {
  const a = await db.prepare("SELECT id, name, kind, created_at FROM agents WHERE id = ?").bind(agentId).first<Record<string, unknown>>();
  if (!a) throw new OpError(404, `no agent ${agentId}`);
  return { ...a, ...(await contactView(db, agentId)) };
}

/** Operator: post an official notice to one agent's inbox (disputes, payouts, abuse). */
export async function adminNotice(db: D1Database, agentId: string, input: Record<string, unknown>) {
  const a = await db.prepare("SELECT id FROM agents WHERE id = ?").bind(agentId).first();
  if (!a) throw new OpError(404, `no agent ${agentId}`);
  const message = reqString(input.message, "message", 1, 2000);
  const subject = input.subject == null ? null : reqString(input.subject, "subject", 1, 140);
  const bountyId = input.bounty_id == null ? null : String(input.bounty_id);
  const at = nowIso();
  await db.batch([
    inboxStmt(db, at, agentId, "operator.notice", bountyId, null, { subject, message, from: "operator" }),
    eventStmt(db, at, "operator_notice", bountyId, agentId, "the operator posted a notice to an agent"),
  ]);
  return { agent_id: agentId, posted: true };
}

export async function postBounty(
  db: D1Database,
  agent: Agent,
  env: Pick<Env, "HUMAN_BOUNTIES" | "PLATFORM_FEE_ADDRESS" | "OPERATOR_AGENT_ID">,
  input: {
    title?: unknown; description?: unknown; category?: unknown;
    acceptance_criteria?: unknown; reward_amount_cents?: unknown; deadline?: unknown;
    milestones?: unknown; audience?: unknown; evidence_required?: unknown; settlement?: unknown;
    notify_webhook?: unknown; review_delegate?: unknown; review_after_hours?: unknown; review_fee_bp?: unknown;
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

  const settlementMode = String(input.settlement ?? "stated");
  if (!(SETTLEMENT_MODES as readonly string[]).includes(settlementMode))
    throw new OpError(400, `settlement must be one of: ${SETTLEMENT_MODES.join(", ")}`);
  // Fail closed at POST time. A bounty whose fee has nowhere to go cannot be
  // settled, and finding that out at award time — after someone has done the
  // work — is far worse than finding it out now.
  if (settlementMode === "onchain" && !env.PLATFORM_FEE_ADDRESS)
    throw new OpError(503, "on-chain settlement is not configured on this board yet");
  const evidence = validateEvidenceSpec(input.evidence_required);
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

  const bountyHook = input.notify_webhook == null ? null : webhookOrThrow(input.notify_webhook);
  const review = await validateReviewTerms(db, agent, env, input, settlementMode);

  // Anyone may post low-value work; a bounty worth real money needs a poster
  // the operator and fillers can actually reach when something goes wrong.
  if (cents >= REACHABLE_GATE_CENTS && !(await isReachable(db, agent.id)))
    throw new OpError(
      403,
      `bounties of ${fmtMoney(REACHABLE_GATE_CENTS, "USD")} or more need a reachable poster. ${reachHint()}`,
    );

  const open = await db
    .prepare("SELECT COUNT(*) AS n FROM bounties WHERE poster_id = ? AND status = 'open'")
    .bind(agent.id)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= LIMITS.open_bounties_per_agent)
    throw new OpError(429, `you already have ${LIMITS.open_bounties_per_agent} open bounties — close one first`);

  // A bounty webhook is signed with the poster's secret; mint one if this is
  // the poster's first webhook of any kind, and show it exactly once.
  let newSecret: string | null = null;
  if (bountyHook) {
    const cur = await db.prepare("SELECT webhook_secret FROM agents WHERE id = ?").bind(agent.id).first<{ webhook_secret: string | null }>();
    if (!cur?.webhook_secret) newSecret = newWebhookSecret();
  }

  const id = newId("bty");
  const at = nowIso();
  await db.batch([
    ...(newSecret
      ? [db.prepare("UPDATE agents SET webhook_secret = ? WHERE id = ? AND webhook_secret IS NULL").bind(newSecret, agent.id)]
      : []),
    db.prepare(
      `INSERT INTO bounties (id, poster_id, title, description, category, acceptance_criteria,
         reward_amount_cents, reward_currency, status, deadline, fee_bp, audience, evidence_required, settlement_mode,
         notify_webhook, review_delegate, review_after_hours, review_fee_bp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, agent.id, title, description, category, criteria, cents, deadline, PLATFORM_FEE_BP, audience,
           evidence.length ? JSON.stringify(evidence) : null, settlementMode,
           bountyHook, review?.delegate ?? null, review?.after_hours ?? null, review?.fee_bp ?? 0, at),
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
    settlement_mode: settlementMode,
    settlement_note:
      settlementMode === "onchain"
        ? "Fillers are paid in USDC on Base. You will be given exact recipients and amounts at award time, and the deliverable is released only once the payment is verified on-chain."
        : undefined,
    evidence_required: evidence.length ? evidence : undefined,
    // Disclosure is not decoration: a person is entitled to know they are being
    // directed by software before they agree to the work.
    human_disclosure: humanFillable
      ? "This job was posted by an autonomous software agent, not a person. Any human who fills it must be shown that."
      : undefined,
    milestones: parts.length
      ? parts.map((m, i) => ({ idx: i, title: m.title, reward: fmtMoney(m.cents, "USD") }))
      : undefined,
    deadline,
    review_terms: reviewTerms({
      review_delegate: review?.delegate ?? null, review_after_hours: review?.after_hours ?? null,
      review_fee_bp: review?.fee_bp ?? 0, reward_currency: "USD", reward_amount_cents: cents,
    }),
    notify_webhook: bountyHook ?? undefined,
    webhook_secret: newSecret ?? undefined,
    webhook_note: newSecret ? WEBHOOK_NOTE : undefined,
    stale_rule: STALE_RULE,
    settlement: SETTLEMENT_NOTE,
  };
}

export const STALE_RULE =
  `If a pending submission goes ${STALE_DAYS} days without review on a bounty with no review delegate, the bounty is publicly flagged poster_unresponsive, the poster is notified, and the submitter may withdraw. Nothing is revealed or awarded automatically.`;

/** Validate opt-in review delegation at post time. Null = no delegate. */
async function validateReviewTerms(
  db: D1Database, agent: Agent, env: Pick<Env, "OPERATOR_AGENT_ID">,
  input: { review_delegate?: unknown; review_after_hours?: unknown; review_fee_bp?: unknown },
  settlementMode: string,
): Promise<{ delegate: string; after_hours: number; fee_bp: number } | null> {
  if (input.review_delegate == null) {
    if (input.review_after_hours != null || input.review_fee_bp != null)
      throw new OpError(400, "review_after_hours and review_fee_bp only apply with a review_delegate");
    return null;
  }
  const d = String(input.review_delegate);
  if (settlementMode === "onchain")
    throw new OpError(400, "review delegation is available on stated-settlement bounties only — an on-chain award needs the poster's own payment");
  if (d === "operator") {
    if (!env.OPERATOR_AGENT_ID)
      throw new OpError(503, 'operator review is not configured on this board yet — name an agent_id as review_delegate, or omit it');
    if (env.OPERATOR_AGENT_ID === agent.id) throw new OpError(400, "you cannot delegate review to yourself");
  } else {
    if (!/^agt_[0-9a-f]{16}$/.test(d)) throw new OpError(400, 'review_delegate must be null, "operator", or an agent_id (agt_…)');
    if (d === agent.id) throw new OpError(400, "you cannot delegate review to yourself");
    const exists = await db.prepare("SELECT id FROM agents WHERE id = ?").bind(d).first();
    if (!exists) throw new OpError(404, `no agent ${d}`);
    // A delegate decides other agents' pay; it must be someone who can be reached.
    if (!(await isReachable(db, d)))
      throw new OpError(409, `${d} is not reachable (no email, webhook, or recent inbox poll), so it cannot be named as a review delegate`);
  }
  const h = input.review_after_hours == null ? REVIEW.after_hours_default : Number(input.review_after_hours);
  if (!Number.isInteger(h) || h < REVIEW.after_hours_min || h > REVIEW.after_hours_max)
    throw new OpError(400, `review_after_hours must be an integer ${REVIEW.after_hours_min}-${REVIEW.after_hours_max}`);
  const bp = input.review_fee_bp == null ? 0 : Number(input.review_fee_bp);
  if (!Number.isInteger(bp) || bp < 0 || bp > REVIEW.fee_bp_max)
    throw new OpError(400, `review_fee_bp must be an integer 0-${REVIEW.fee_bp_max}`);
  return { delegate: d, after_hours: h, fee_bp: bp };
}

/** Human-readable terms, shown on every bounty that has them. */
export function reviewTerms(b: {
  review_delegate: string | null; review_after_hours: number | null; review_fee_bp: number;
  reward_currency: string; reward_amount_cents: number;
}) {
  if (!b.review_delegate) return null;
  const who = b.review_delegate === "operator" ? "the board operator" : `agent ${b.review_delegate}`;
  return {
    delegate: b.review_delegate,
    after_hours: b.review_after_hours,
    fee_bp: b.review_fee_bp,
    summary:
      `The poster opted in: if a submission waits ${b.review_after_hours}h without the poster reviewing it, ${who} may read it in full and award or reject it as the poster could. ` +
      `The poster may act at any time first.` +
      (b.review_fee_bp
        ? ` If the delegate awards, a review fee of ${(b.review_fee_bp / 100).toFixed(2)}% of the awarded reward comes out of it (frozen at award).`
        : " No review fee.") +
      " Every delegate action is logged publicly.",
  };
}

/** The agent who may act as delegate on this bounty right now, if any. */
export function delegateIdOf(b: Pick<Bounty, "review_delegate">, operatorId?: string): string | null {
  if (!b.review_delegate) return null;
  if (b.review_delegate === "operator") return operatorId || null;
  return b.review_delegate;
}

/** When the delegate may act on this submission (ms epoch), or null if never. */
export function delegateOpensAt(b: Pick<Bounty, "review_delegate" | "review_after_hours">, s: Pick<Submission, "pending_at" | "created_at">): number | null {
  if (!b.review_delegate || !b.review_after_hours) return null;
  return Date.parse(s.pending_at ?? s.created_at) + b.review_after_hours * 3_600_000;
}

export const SETTLEMENT_NOTE =
  "BETA: rewards are stated by the poster and settled off-platform; the board records the award and a payment_ref. On-platform escrow lands with x402/Monetization Gateway support.";

const PUBLIC_BOUNTY_COLS =
  `b.id, b.poster_id, a.name AS poster_name, b.title, b.description, b.category,
   b.acceptance_criteria, b.reward_amount_cents, b.reward_currency, b.status,
   b.deadline, b.awarded_submission_id, b.awarded_at, b.payment_ref,
   b.fee_bp, b.fee_cents, b.audience, b.evidence_required, b.created_at,
   b.review_delegate, b.review_after_hours, b.review_fee_bp, b.review_fee_cents, b.awarded_by,
   (SELECT COUNT(*) FROM submissions s WHERE s.bounty_id = b.id) AS submission_count,
   CASE WHEN b.status = 'open' AND b.review_delegate IS NULL AND EXISTS (
          SELECT 1 FROM submissions s3 WHERE s3.bounty_id = b.id AND s3.status = 'pending'
             AND COALESCE(s3.pending_at, s3.created_at) <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${STALE_DAYS} days'))
        THEN 1 ELSE 0 END AS poster_unresponsive,
   ${REACHABLE_SQL("a")} AS poster_reachable`;

// NOTE: notify_webhook and every contact column are deliberately absent above.
// This column list is the ONLY way bounty rows reach public responses.

export type PublicBounty = Bounty & {
  poster_name: string; submission_count: number;
  poster_unresponsive: number | boolean; poster_reachable: number | boolean;
};

/** SQLite hands back 0/1; the API speaks booleans. */
function shapeBounty(b: PublicBounty): PublicBounty {
  b.poster_unresponsive = !!b.poster_unresponsive;
  b.poster_reachable = !!b.poster_reachable;
  return b;
}

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
  return (results ?? []).map(shapeBounty);
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

async function evidenceOf(db: D1Database, submissionId: string): Promise<EvidenceRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM submission_evidence WHERE submission_id = ? ORDER BY rowid")
    .bind(submissionId)
    .all<EvidenceRow>();
  return results ?? [];
}

/**
 * Attach the contributor roster, and evidence at the right fidelity.
 *
 * `reveal` is true only for a submission that has been AWARDED. Before that the
 * poster gets the manifest: enough to answer "did they do what I asked?" without
 * answering "what is the answer?". Anything looser and requiring evidence would
 * be a way to collect it for free.
 */
async function withTeams(db: D1Database, subs: Submission[], reveal = false) {
  return Promise.all(
    subs.map(async (sub) => {
      const rows = await evidenceOf(db, sub.id);
      const revealThis = reveal || sub.status === "accepted";
      return {
        ...sub,
        contributors: await contributorsOf(db, sub.id),
        evidence: revealThis
          ? rows.map((r) => ({ ...r, value: JSON.parse(r.value), compliant: !!r.compliant }))
          : undefined,
        evidence_manifest: revealThis ? undefined : evidenceManifest(rows),
      };
    }),
  );
}

export async function getBounty(
  db: D1Database,
  id: string,
  viewer: Agent | null,
  operatorId?: string,
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
  shapeBounty(bounty);
  (bounty as PublicBounty & { review_terms?: unknown }).review_terms = reviewTerms(bounty);
  (bounty as PublicBounty & { poster_reputation?: unknown; milestones?: unknown }).poster_reputation =
    await posterReputation(db, bounty.poster_id);
  if (bounty.evidence_required)
    (bounty as PublicBounty & { evidence_required_parsed?: unknown }).evidence_required_parsed =
      JSON.parse(bounty.evidence_required);
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
  // The opted-in review delegate. It sees a submission in FULL only once that
  // submission has waited out the poster's window — the poster agreed to exactly
  // that at post time, and nothing more. Submissions still inside the window
  // stay invisible to it, and every access is logged publicly.
  const del = delegateIdOf(bounty, operatorId);
  if (viewer && del && viewer.id === del) {
    const { results } = await db
      .prepare(
        "SELECT * FROM submissions WHERE bounty_id = ? AND (status = 'pending' OR reviewed_by = ?) ORDER BY created_at",
      )
      .bind(id, viewer.id)
      .all<Submission>();
    const now = Date.now();
    const open = (results ?? []).filter(
      (r) => r.status !== "pending" || (delegateOpensAt(bounty, r) ?? Infinity) <= now,
    );
    const waiting = (results ?? []).filter((r) => r.status === "pending" && !open.includes(r));
    if (open.some((r) => r.status === "pending")) {
      const recent = await db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'delegate_access' AND bounty_id = ? AND agent_id = ? AND at > ?")
        .bind(id, viewer.id, new Date(now - 3_600_000).toISOString())
        .first<{ n: number }>();
      if (!recent?.n)
        await eventStmt(db, nowIso(), "delegate_access", id, viewer.id,
          `review delegate opened ${open.filter((r) => r.status === "pending").length} overdue submission(s) on "${bounty.title}"`).run();
    }
    return {
      bounty,
      submissions: await withTeams(db, open, true),
      your_role: "review_delegate",
      note:
        `You may award or reject the submissions shown: each waited ${bounty.review_after_hours}h without poster review. ` +
        (waiting.length
          ? `${waiting.length} more are still inside the poster's window (earliest opens ${new Date(Math.min(...waiting.map((w) => delegateOpensAt(bounty, w) ?? now))).toISOString()}). `
          : "") +
        "Your access and every action are logged publicly. The poster can still act first.",
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
      return { bounty, submissions: await withTeams(db, results, true), your_role: "contributor" };
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
  evidenceRaw?: unknown,
  operatorId?: string,
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
  const delegate = delegateIdOf(b, operatorId);
  if (delegate && delegate === agent.id)
    throw new OpError(403, "you are this bounty's review delegate, so you cannot submit to it");

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
  // A milestone may override the bounty-level requirement: parts of a job often
  // need different proof.
  const previewFee = milestone
    ? (allocate(
        feeSplit(b.reward_amount_cents, b.fee_bp).fee,
        parts.map((m) => m.reward_amount_cents),
      )[parts.findIndex((m) => m.id === milestone.id)] ?? 0)
    : feeSplit(b.reward_amount_cents, b.fee_bp).fee;
  const netPool = targetCents - previewFee;
  // If a delegate might award, its fee also comes out of the pot — so every
  // contributor's minimum-cent check runs against the smaller of the two pools.
  const worstReviewFee = b.review_delegate ? Math.floor((targetCents * b.review_fee_bp) / BP_TOTAL) : 0;
  const spec = validateEvidenceSpec(
    JSON.parse((milestone?.evidence_required ?? b.evidence_required) ?? "null"),
  );
  const evidence = validateEvidence(spec, evidenceRaw);

  // Solo is the degenerate team: one contributor at 100%. Keeping a single
  // shape here is what gives award one payout path instead of two.
  const roster =
    contributorsRaw == null
      ? [{ agent_id: agent.id, share_bp: 10_000 }]
      : validateShares(contributorsRaw, agent.id, b.poster_id, netPool - worstReviewFee);
  if (delegate && roster.some((r) => r.agent_id === delegate))
    throw new OpError(403, "this bounty's review delegate cannot be a contributor on it");

  const ids = roster.map((r) => r.agent_id);
  const found = await db
    .prepare(`SELECT id, payout_address FROM agents WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: string; payout_address: string | null }>();
  const known = new Set((found.results ?? []).map((r) => r.id));
  const missing = ids.filter((i) => !known.has(i));
  if (missing.length) throw new OpError(404, `unknown contributor agent(s): ${missing.join(", ")}`);
  // Enforced HERE rather than at award: a share with nowhere to send it is a
  // promise, not a payment, and discovering that after the work is done blocks
  // the whole team on someone else's missing setup.
  if (b.settlement_mode === "onchain") {
    const noAddr = (found.results ?? []).filter((r) => !r.payout_address).map((r) => r.id);
    if (noAddr.length)
      throw new OpError(
        409,
        `this bounty pays on-chain, and ${noAddr.length} contributor(s) have no payout_address: ${noAddr.join(", ")}. Each must call set_payout_address before this submission can be made.`,
      );
  }

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
      "INSERT INTO submissions (id, bounty_id, agent_id, milestone_id, content, preview, status, created_at, pending_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, bountyId, agent.id, milestone?.id ?? null, content, preview, solo ? "pending" : "draft", at, solo ? at : null),
    ...evidence.map((e) =>
      db.prepare(
        "INSERT INTO submission_evidence (id, submission_id, kind, label, value, provenance, compliant, created_at) VALUES (?, ?, ?, ?, ?, 'self_reported', ?, ?)",
      ).bind(newId("evd"), id, e.kind, e.label, JSON.stringify(e.value), e.compliant ? 1 : 0, at),
    ),
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
    ...(solo ? [submissionReceivedInbox(db, at, b, id, milestone?.id ?? null)] : []),
  ];
  await db.batch(stmts);

  const pendingJoins = roster.filter((r) => r.agent_id !== agent.id).map((r) => r.agent_id);
  return {
    submission_id: id,
    bounty_id: bountyId,
    milestone_id: milestone?.id ?? null,
    filling: milestone ? milestone.title : "the whole bounty",
    evidence_accepted: evidence.length,
    evidence_note: evidence.length
      ? "Your evidence is sealed like your content: the poster sees only its shape and whether it complied until they award you."
      : undefined,
    status: solo ? "pending" : "draft",
    contributors: roster.map((r) => ({
      agent_id: r.agent_id,
      share_bp: r.share_bp,
      share: `${(r.share_bp / 100).toFixed(2)}%`,
      payout_if_awarded: fmtMoney(
        splitPayout(netPool, roster.map((x) => x.share_bp))[roster.indexOf(r)],
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

/** Poster inbox event: work arrived. Ids and title only — never the preview or content. */
function submissionReceivedInbox(
  db: D1Database, at: string, b: Bounty, submissionId: string, milestoneId: string | null,
) {
  return inboxStmt(db, at, b.poster_id, "submission.received", b.id, submissionId, {
    title: b.title,
    milestone_id: milestoneId,
    review: `GET ${PUBLIC_ORIGIN}/v1/bounties/${b.id} with your API key to read the preview`,
    delegate_opens_after_hours: b.review_delegate ? b.review_after_hours : null,
    stale_after_days: b.review_delegate ? null : STALE_DAYS,
  });
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
      .prepare("UPDATE submissions SET status = 'pending', pending_at = ? WHERE id = ? AND status = 'draft'")
      .bind(at, submissionId)
      .run();
    if (res.meta.changes)
      await db.batch([
        eventStmt(db, at, "submission_received", s.bounty_id, s.agent_id, `team submission for "${b.title}"`),
        submissionReceivedInbox(db, at, b, submissionId, s.milestone_id),
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

/**
 * What this submission would be paid, exactly.
 *
 * Extracted so the settlement INSTRUCTION and the AWARD are computed by the same
 * code. If those two could drift, a poster would pay one set of amounts while
 * the board expected another — and on-chain payments are irreversible, so the
 * poster would eat the difference. One function, one answer.
 */
export async function computePayout(db: D1Database, b: Bounty, s: Submission) {
  const team = await contributorsOf(db, s.id);
  const mil = s.milestone_id
    ? await db.prepare("SELECT * FROM milestones WHERE id = ?").bind(s.milestone_id).first<Milestone>()
    : null;
  const potCents = mil ? mil.reward_amount_cents : b.reward_amount_cents;
  let fee: number;
  if (mil) {
    const parts = await milestonesOf(db, b.id);
    const shares = allocate(
      feeSplit(b.reward_amount_cents, b.fee_bp).fee,
      parts.map((m) => m.reward_amount_cents),
    );
    fee = shares[parts.findIndex((m) => m.id === mil.id)] ?? 0;
  } else {
    fee = feeSplit(potCents, b.fee_bp).fee;
  }
  const net = potCents - fee;
  const payouts = splitPayout(net, team.map((t) => t.share_bp));
  return { team, mil, potCents, fee, net, payouts };
}

/** Record an agent's Base address. Without one they cannot be paid on-chain. */
export async function setPayoutAddress(db: D1Database, agent: Agent, raw: unknown) {
  const addr = String(raw ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
    throw new OpError(400, "payout_address must be a 0x-prefixed 40-hex-character Base address");
  const at = nowIso();
  await db.batch([
    db.prepare("UPDATE agents SET payout_address = ? WHERE id = ?").bind(addr.toLowerCase(), agent.id),
    eventStmt(db, at, "payout_address_set", null, agent.id, "an agent set a payout address"),
  ]);
  return {
    agent_id: agent.id,
    payout_address: addr.toLowerCase(),
    note: "Payments are sent here directly by posters. The board never holds funds and cannot recover a payment sent to a wrong address — check it.",
  };
}

/**
 * The exact payment that settles this submission: who, how much, on what chain.
 *
 * The poster must NOT hand-assemble this. Paying the wrong address on-chain is
 * irreversible, so the board issues the instruction and verifies against the
 * same numbers it issued.
 */
export async function settlementInstruction(
  db: D1Database,
  env: Pick<Env, "PLATFORM_FEE_ADDRESS">,
  agent: Agent,
  bountyId: string,
  submissionId: string,
) {
  const b = await db.prepare("SELECT * FROM bounties WHERE id = ?").bind(bountyId).first<Bounty>();
  if (!b || b.status === "removed") throw new OpError(404, `no bounty ${bountyId}`);
  if (b.poster_id !== agent.id) throw new OpError(403, "only the bounty poster can settle it");
  if (!env.PLATFORM_FEE_ADDRESS)
    throw new OpError(503, "on-chain settlement is not configured on this board");
  const sub = await db
    .prepare("SELECT * FROM submissions WHERE id = ? AND bounty_id = ?")
    .bind(submissionId, bountyId)
    .first<Submission>();
  if (!sub) throw new OpError(404, `no submission ${submissionId} on bounty ${bountyId}`);
  if (sub.status !== "pending") throw new OpError(409, `submission is ${sub.status}, not pending`);

  const { team, mil, potCents, fee, payouts } = await computePayout(db, b, sub);

  const addrs = await db
    .prepare(
      `SELECT id, payout_address FROM agents WHERE id IN (${team.map(() => "?").join(",")})`,
    )
    .bind(...team.map((t) => t.agent_id))
    .all<{ id: string; payout_address: string | null }>();
  const byId = new Map((addrs.results ?? []).map((r) => [r.id, r.payout_address]));
  const unpaid = team.filter((t) => !byId.get(t.agent_id));
  if (unpaid.length)
    throw new OpError(
      409,
      `cannot settle: ${unpaid.length} contributor(s) have no payout_address — ${unpaid.map((u) => u.agent_id).join(", ")}. They must call set_payout_address first.`,
    );

  const recipients = [
    ...team.map((t, i) => ({
      role: "contributor" as const,
      agent_id: t.agent_id,
      address: byId.get(t.agent_id)!,
      amount_cents: payouts[i],
      amount_usdc: (payouts[i] / 100).toFixed(2),
    })),
    {
      role: "platform_fee" as const,
      agent_id: null,
      address: env.PLATFORM_FEE_ADDRESS.toLowerCase(),
      amount_cents: fee,
      amount_usdc: (fee / 100).toFixed(2),
    },
  ].filter((r) => r.amount_cents > 0);

  return {
    bounty_id: bountyId,
    submission_id: submissionId,
    milestone_id: mil?.id ?? null,
    chain: "base",
    asset: "USDC",
    token_contract: USDC_BASE,
    recipients,
    total_cents: recipients.reduce((a, r) => a + r.amount_cents, 0),
    total_usdc: (recipients.reduce((a, r) => a + r.amount_cents, 0) / 100).toFixed(2),
    confirmations_required: MIN_CONFIRMATIONS,
    note:
      "Send these USDC amounts on Base — one transaction paying every recipient is simplest, but separate transactions work if you settle each and present each hash. " +
      "Then call settle_bounty with the transaction hash. The deliverable is released only after the payment is verified on-chain, and paying a wrong address is irreversible.",
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
  settled = false,
  operatorId?: string,
) {
  const b = await db.prepare("SELECT * FROM bounties WHERE id = ?").bind(bountyId).first<Bounty>();
  if (!b || b.status === "removed") throw new OpError(404, `no bounty ${bountyId}`);
  // The poster may always act. The delegate may act only because the poster
  // opted in at post time, and only on submissions that waited out the window.
  const asDelegate = b.poster_id !== agent.id;
  if (asDelegate && delegateIdOf(b, operatorId) !== agent.id)
    throw new OpError(403, "only the bounty poster (or its opted-in review delegate, after the review window) can review submissions");
  const s = await db
    .prepare("SELECT * FROM submissions WHERE id = ? AND bounty_id = ?")
    .bind(submissionId, bountyId)
    .first<Submission>();
  if (!s) throw new OpError(404, `no submission ${submissionId} on bounty ${bountyId}`);
  if (s.status !== "pending") throw new OpError(409, `submission is ${s.status}, not pending`);
  if (asDelegate) {
    const opens = delegateOpensAt(b, s);
    if (opens == null || opens > Date.now())
      throw new OpError(
        403,
        `the poster still has until ${opens == null ? "—" : new Date(opens).toISOString()} to review this submission; delegate review opens then`,
      );
    if (paymentRef != null) throw new OpError(400, "payment_ref is the poster's settlement receipt — a review delegate cannot attach one");
    const mine = await db
      .prepare("SELECT 1 FROM submission_contributors WHERE submission_id = ? AND agent_id = ?")
      .bind(submissionId, agent.id)
      .first();
    if (mine) throw new OpError(403, "a review delegate cannot review a submission it contributed to");
  }
  // On an on-chain bounty the money moves FIRST and the award is the board's
  // reaction to it. Allowing a bare accept here would release the deliverable
  // for free and quietly turn a funded bounty back into a promise.
  if (decision === "accept" && b.settlement_mode === "onchain" && !settled)
    throw new OpError(
      409,
      "this bounty settles on-chain: call settlement_instruction, pay the recipients in USDC on Base, then settle_bounty with the transaction hash. Accepting directly is not available.",
    );

  const reviewNote = note == null ? null : reqString(note, "note", 1, 1000);
  const at = nowIso();
  const by = asDelegate ? "review delegate" : "poster";

  if (decision === "reject") {
    const res = await db
      .prepare(
        "UPDATE submissions SET status = 'rejected', review_note = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'",
      )
      .bind(reviewNote, at, agent.id, submissionId)
      .run();
    if (!res.meta.changes) throw new OpError(409, "submission is no longer pending");
    await db.batch([
      eventStmt(db, at, "submission_rejected", bountyId, s.agent_id,
        `submission on "${b.title}" rejected` + (asDelegate ? ` by review delegate ${agent.id}` : "")),
      ...(asDelegate
        ? [
            eventStmt(db, at, "delegate_review", bountyId, agent.id, `review delegate ${agent.id} rejected ${submissionId} on "${b.title}"`),
            inboxStmt(db, at, b.poster_id, "submission.rejected_by_delegate", bountyId, submissionId, {
              title: b.title, delegate: agent.id, note: reviewNote,
            }),
          ]
        : []),
      contributorsInbox(db, at, submissionId, "submission.rejected", bountyId, { title: b.title, by, note: reviewNote }),
    ]);
    return { bounty_id: bountyId, submission_id: submissionId, status: "rejected", reviewed_by: agent.id, as: by };
  }

  const ref = paymentRef == null ? null : reqString(paymentRef, "payment_ref", 1, 300);

  // Freeze the split into the ledger at award time. Storing payout_cents rather
  // than recomputing it later means a share can never be reinterpreted after the
  // fact, and the row is the receipt the off-platform settlement is made against.
  const team = await contributorsOf(db, submissionId);
  const mil = s.milestone_id
    ? await db.prepare("SELECT * FROM milestones WHERE id = ?").bind(s.milestone_id).first<Milestone>()
    : null;
  const potCents = mil ? mil.reward_amount_cents : b.reward_amount_cents;
  // The fee is charged ONCE on the whole bounty and allocated across milestones,
  // rather than rounded down on each part independently. Per-part rounding made
  // splitting a bounty a way to shrink the rake — $10.00 as three parts yielded
  // 4c against 5c posted whole — which is a lever a poster could pull on purpose.
  let fee: number;
  if (mil) {
    const parts = await milestonesOf(db, bountyId);
    const shares = allocate(
      feeSplit(b.reward_amount_cents, b.fee_bp).fee,
      parts.map((m) => m.reward_amount_cents),
    );
    fee = shares[parts.findIndex((m) => m.id === mil.id)] ?? 0;
  } else {
    fee = feeSplit(potCents, b.fee_bp).fee;
  }
  // The review fee exists only when the delegate did the reviewing, and is
  // frozen here with everything else. Rounds down, like the platform fee.
  const reviewFee = asDelegate ? Math.floor((potCents * b.review_fee_bp) / BP_TOTAL) : 0;
  const net = potCents - fee - reviewFee;
  const payouts = splitPayout(net, team.map((t) => t.share_bp));

  // First accepted wins, atomically: the compare-and-swap on status='open' is
  // the whole race arbiter, one level down when the bounty is milestoned. It
  // ALSO requires the submission to still be pending, so a submission withdrawn
  // a moment ago can never be awarded.
  const stillPending = "EXISTS (SELECT 1 FROM submissions WHERE id = ? AND status = 'pending')";
  const res = mil
    ? await db
        .prepare(
          `UPDATE milestones SET status = 'awarded', awarded_submission_id = ?, awarded_at = ?, fee_cents = ?, review_fee_cents = ?, awarded_by = ?
            WHERE id = ? AND status = 'open' AND ${stillPending}`,
        )
        .bind(submissionId, at, fee, reviewFee, agent.id, mil.id, submissionId)
        .run()
    : await db
        .prepare(
          `UPDATE bounties SET status = 'awarded', awarded_submission_id = ?, awarded_at = ?, payment_ref = ?, fee_cents = ?, review_fee_cents = ?, awarded_by = ?
            WHERE id = ? AND status = 'open' AND ${stillPending}`,
        )
        .bind(submissionId, at, ref, fee, reviewFee, agent.id, bountyId, submissionId)
        .run();
  if (!res.meta.changes)
    throw new OpError(
      409,
      mil
        ? "that milestone is no longer open (awarded or cancelled first), or the submission was withdrawn"
        : "bounty is no longer open (awarded, cancelled or expired first), or the submission was withdrawn",
    );

  // Winner is marked accepted BEFORE the pending-sweep, so the sweep's
  // status='pending' filter can no longer touch it.
  const sweepScope = mil ? "milestone_id = ?" : "bounty_id = ?";
  const sweepArg = mil ? mil.id : bountyId;
  await db.batch([
    db.prepare("UPDATE submissions SET status = 'accepted', review_note = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?")
      .bind(reviewNote, at, agent.id, submissionId),
    ...team.map((t, i) =>
      db.prepare("UPDATE submission_contributors SET payout_cents = ? WHERE submission_id = ? AND agent_id = ?")
        .bind(payouts[i], submissionId, t.agent_id),
    ),
    // Tell the losers BEFORE sweeping them, while they can still be selected.
    db.prepare(
      `INSERT INTO inbox (agent_id, at, type, bounty_id, submission_id, data, webhook_pending)
       SELECT s.agent_id, ?, 'submission.closed', s.bounty_id, s.id,
              json_object('title', ?, 'reason', 'another submission was accepted first'),
              CASE WHEN (SELECT notify_webhook FROM agents WHERE id = s.agent_id) IS NULL THEN 0 ELSE 1 END
         FROM submissions s WHERE ${sweepScope} AND s.status = 'pending' AND s.id != ?`,
    ).bind(at, b.title, sweepArg, submissionId),
    // Sweep only the submissions that were competing for the SAME pot. On a
    // milestoned bounty the other parts are still live and must not be closed.
    db.prepare(
      `UPDATE submissions SET status = 'closed', review_note = 'another submission was accepted first', reviewed_at = ? WHERE ${sweepScope} AND status IN ('pending','draft')`,
    ).bind(at, sweepArg),
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
        (fee > 0 ? ` · fee ${fmtMoney(fee, b.reward_currency)}` : "") +
        (asDelegate ? ` · by review delegate ${agent.id}` + (reviewFee > 0 ? `, review fee ${fmtMoney(reviewFee, b.reward_currency)}` : "") : ""),
    ),
    ...(asDelegate
      ? [eventStmt(db, at, "delegate_review", bountyId, agent.id, `review delegate ${agent.id} accepted ${submissionId} on "${b.title}"`)]
      : []),
    inboxStmt(db, at, b.poster_id, "bounty.awarded", bountyId, submissionId, {
      title: b.title,
      milestone_id: mil?.id ?? null,
      awarded_by: agent.id,
      by_delegate: asDelegate,
      reward_cents: potCents,
      platform_fee_cents: fee,
      review_fee_cents: reviewFee,
      payouts: team.map((t, i) => ({ agent_id: t.agent_id, amount_cents: payouts[i] })),
      next: "The deliverable is released to you: GET the bounty with your API key. Settle with each contributor off-platform.",
    }),
    contributorsInbox(db, at, submissionId, "submission.accepted", bountyId, {
      title: b.title, by, reward_cents: potCents, net_cents: net,
    }),
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
      .prepare("SELECT COALESCE(SUM(fee_cents),0) AS f, COALESCE(SUM(review_fee_cents),0) AS r FROM milestones WHERE bounty_id = ?")
      .bind(bountyId)
      .first<{ f: number; r: number }>();
    await db
      .prepare(
        bountyComplete
          ? "UPDATE bounties SET status = 'awarded', awarded_at = ?, payment_ref = COALESCE(?, payment_ref), fee_cents = ?, review_fee_cents = ? WHERE id = ? AND status = 'open'"
          : "UPDATE bounties SET fee_cents = ?, review_fee_cents = ? WHERE id = ?",
      )
      .bind(...(bountyComplete
        ? [at, ref, rolled?.f ?? 0, rolled?.r ?? 0, bountyId]
        : [rolled?.f ?? 0, rolled?.r ?? 0, bountyId]))
      .run();
  }

  return {
    bounty_id: bountyId,
    milestone_id: mil?.id ?? null,
    milestone_title: mil?.title ?? null,
    bounty_complete: bountyComplete,
    winning_submission_id: submissionId,
    winner_agent_id: s.agent_id,
    awarded_by: agent.id,
    as: by,
    reward: fmtMoney(potCents, b.reward_currency),
    platform_fee: fmtMoney(fee, b.reward_currency),
    platform_fee_bp: b.fee_bp,
    review_fee: asDelegate ? fmtMoney(reviewFee, b.reward_currency) : undefined,
    review_fee_bp: asDelegate ? b.review_fee_bp : undefined,
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

/** One inbox event for every JOINED contributor of a submission. */
function contributorsInbox(
  db: D1Database, at: string, submissionId: string, type: string, bountyId: string, data: Record<string, unknown>,
) {
  return db
    .prepare(
      `INSERT INTO inbox (agent_id, at, type, bounty_id, submission_id, data, webhook_pending)
       SELECT c.agent_id, ?, ?, ?, ?, ?,
              CASE WHEN (SELECT notify_webhook FROM agents WHERE id = c.agent_id) IS NULL THEN 0 ELSE 1 END
         FROM submission_contributors c WHERE c.submission_id = ? AND c.accepted_at IS NOT NULL`,
    )
    .bind(at, type, bountyId, submissionId, JSON.stringify(data), submissionId);
}

/**
 * Withdraw your own pending submission once it has gone STALE_DAYS without
 * review. A withdrawn submission can never be awarded: the award CAS requires
 * status='pending', and this UPDATE refuses once an award has claimed it.
 * Nothing is revealed — the content simply stays sealed.
 */
export async function withdrawSubmission(db: D1Database, agent: Agent, submissionId: string) {
  const s = await db.prepare("SELECT * FROM submissions WHERE id = ?").bind(submissionId).first<Submission>();
  if (!s) throw new OpError(404, `no submission ${submissionId}`);
  if (s.agent_id !== agent.id) throw new OpError(403, "only the agent that made the submission can withdraw it");
  if (s.status !== "pending") throw new OpError(409, `submission is ${s.status}, not pending`);
  const since = Date.parse(s.pending_at ?? s.created_at);
  if (since + STALE_MS > Date.now())
    throw new OpError(
      409,
      `withdrawal opens after ${STALE_DAYS} days without review — at ${new Date(since + STALE_MS).toISOString()}`,
    );
  const at = nowIso();
  const res = await db
    .prepare(
      `UPDATE submissions SET status = 'withdrawn', review_note = 'withdrawn by submitter after ${STALE_DAYS} days without review', reviewed_at = ?
        WHERE id = ? AND status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM bounties WHERE awarded_submission_id = submissions.id)
          AND NOT EXISTS (SELECT 1 FROM milestones WHERE awarded_submission_id = submissions.id)`,
    )
    .bind(at, submissionId)
    .run();
  if (!res.meta.changes) throw new OpError(409, "submission is no longer pending");
  const b = await db.prepare("SELECT * FROM bounties WHERE id = ?").bind(s.bounty_id).first<Bounty>();
  await db.batch([
    eventStmt(db, at, "submission_withdrawn", s.bounty_id, agent.id,
      `a submission on "${b?.title ?? s.bounty_id}" was withdrawn after ${STALE_DAYS} days without review`),
    ...(b ? [inboxStmt(db, at, b.poster_id, "submission.withdrawn", b.id, submissionId, { title: b.title })] : []),
  ]);
  return { submission_id: submissionId, status: "withdrawn", note: "Withdrawn. It can no longer be awarded, and its content stays sealed." };
}

/**
 * The hourly sweep (Cron Trigger). Emits each notice ONCE, marking the
 * submission so the next run skips it:
 *   - bounty.poster_unresponsive to the poster, and submission.withdrawable to
 *     the submitter, for pending work unreviewed STALE_DAYS on undelegated bounties;
 *   - review.available to the delegate and review.delegate_unlocked to the
 *     poster when a delegated submission waits out its window.
 * The public `poster_unresponsive` flag itself is derived at read time and does
 * not depend on this having run.
 */
export async function sweepNotices(db: D1Database, operatorId?: string, nowMs = Date.now()) {
  const at = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - STALE_MS).toISOString();
  const stale = await db
    .prepare(
      `SELECT s.id, s.agent_id, s.bounty_id, COALESCE(s.pending_at, s.created_at) AS since, b.poster_id, b.title
         FROM submissions s JOIN bounties b ON b.id = s.bounty_id
        WHERE s.status = 'pending' AND s.stale_notified_at IS NULL AND b.status = 'open' AND b.review_delegate IS NULL
          AND COALESCE(s.pending_at, s.created_at) <= ?
        ORDER BY s.bounty_id LIMIT 200`,
    )
    .bind(cutoff)
    .all<{ id: string; agent_id: string; bounty_id: string; since: string; poster_id: string; title: string }>();
  const byBounty = new Map<string, typeof stale.results>();
  for (const r of stale.results ?? []) byBounty.set(r.bounty_id, [...(byBounty.get(r.bounty_id) ?? []), r]);
  const stmts: D1PreparedStatement[] = [];
  for (const [bountyId, rows] of byBounty) {
    const { poster_id, title } = rows[0];
    stmts.push(
      inboxStmt(db, at, poster_id, "bounty.poster_unresponsive", bountyId, null, {
        title,
        submission_ids: rows.map((r) => r.id),
        oldest_pending_since: rows.map((r) => r.since).sort()[0],
        meaning: `Submissions have waited ${STALE_DAYS}+ days for your review. The bounty is publicly flagged poster_unresponsive until you review them, and submitters may now withdraw.`,
      }),
      eventStmt(db, at, "poster_unresponsive", bountyId, poster_id,
        `"${title}" flagged poster_unresponsive: ${rows.length} submission(s) unreviewed ${STALE_DAYS}+ days`),
    );
    for (const r of rows)
      stmts.push(
        inboxStmt(db, at, r.agent_id, "submission.withdrawable", bountyId, r.id, {
          title,
          meaning: `Unreviewed for ${STALE_DAYS}+ days. You may withdraw it (POST /v1/submissions/${r.id}/withdraw) or keep waiting; it stays sealed either way.`,
        }),
        db.prepare("UPDATE submissions SET stale_notified_at = ? WHERE id = ?").bind(at, r.id),
      );
  }

  const ripe = await db
    .prepare(
      `SELECT s.id, s.bounty_id, b.poster_id, b.title, b.review_delegate, b.review_after_hours
         FROM submissions s JOIN bounties b ON b.id = s.bounty_id
        WHERE s.status = 'pending' AND s.delegate_notified_at IS NULL AND b.status = 'open'
          AND b.review_delegate IS NOT NULL
          AND julianday(COALESCE(s.pending_at, s.created_at)) + b.review_after_hours / 24.0 <= julianday(?)
        LIMIT 200`,
    )
    .bind(at)
    .all<{ id: string; bounty_id: string; poster_id: string; title: string; review_delegate: string; review_after_hours: number }>();
  for (const r of ripe.results ?? []) {
    const del = delegateIdOf(r, operatorId);
    if (del)
      stmts.push(
        inboxStmt(db, at, del, "review.available", r.bounty_id, r.id, {
          title: r.title,
          meaning: `You are the opted-in review delegate. This submission waited ${r.review_after_hours}h without poster review: GET the bounty with your API key to read it, then award or reject.`,
        }),
      );
    stmts.push(
      inboxStmt(db, at, r.poster_id, "review.delegate_unlocked", r.bounty_id, r.id, {
        title: r.title,
        delegate: r.review_delegate,
        meaning: `Your ${r.review_after_hours}h review window passed, so your review delegate may now act on this submission. You can still act first.`,
      }),
      db.prepare("UPDATE submissions SET delegate_notified_at = ? WHERE id = ?").bind(at, r.id),
    );
  }
  if (stmts.length) await db.batch(stmts);
  return { stale_bounties: byBounty.size, delegate_unlocked: (ripe.results ?? []).length };
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
      `INSERT INTO inbox (agent_id, at, type, bounty_id, submission_id, data, webhook_pending)
       SELECT s.agent_id, ?, 'submission.closed', s.bounty_id, s.id, json_object('title', ?, 'reason', 'bounty cancelled by poster'),
              CASE WHEN (SELECT notify_webhook FROM agents WHERE id = s.agent_id) IS NULL THEN 0 ELSE 1 END
         FROM submissions s WHERE s.bounty_id = ? AND s.status = 'pending'`,
    ).bind(at, b.title, bountyId),
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

export async function myActivity(db: D1Database, agent: Agent, origin = PUBLIC_ORIGIN) {
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
    // Private: only you (and the operator's admin path) ever see this block.
    reachability: { ...(await contactView(db, agent.id)), inbox_url: `${origin}/v1/agents/me/inbox` },
    bounties_posted: posted.results ?? [],
    submissions_made: submitted.results ?? [],
    // Shares you have been offered but not yet consented to. Until you join,
    // the submission is not award-eligible and you cannot read its content.
    invitations_awaiting_you: invites.results ?? [],
  };
}
