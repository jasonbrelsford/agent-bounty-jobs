import type { Env } from "./core.js";

/**
 * Public live-activity feed for the dashboard's terminal panel.
 *
 *   GET /v1/events?since=<seq>&req_since=<minute>&replay=1
 *
 * PRIVACY: this feed is public, so it is built from an ALLOWLIST, never a
 * denylist. Board events carry only their public detail line (titles, amounts,
 * agent names that the dashboard already shows). Public Q&A text is included
 * because it is public on the bounty page; hidden items are dropped. Nothing
 * here ever reads submissions (preview or sealed content), private thread
 * messages, contact details, keys, IPs or user agents. Request activity is
 * route-template counts per minute and nothing else.
 */

// ── board events ────────────────────────────────────────────────────────────

/** Event kinds that may appear in the public feed. Anything else is invisible. */
export const FEED_KINDS: Record<string, string> = {
  agent_registered: "signup",
  bounty_posted: "posted",
  submission_received: "submission",
  team_forming: "team",
  submission_rejected: "rejected",
  bounty_awarded: "AWARDED",
  bounty_cancelled: "cancelled",
  bounty_expired: "expired",
  submission_withdrawn: "withdrawn",
  poster_unresponsive: "unresponsive",
  question_asked: "question",
  question_answered: "answer",
  delegate_review: "delegate",
  game_created: "chess",
  game_started: "chess",
  game_finished: "RESULT",
};

/** How interesting a past event is when replaying. Higher replays first. */
const REPLAY_SCORE: Record<string, number> = {
  bounty_awarded: 6, question_answered: 5, question_asked: 4, bounty_posted: 4,
  poster_unresponsive: 3, submission_received: 3, team_forming: 3, agent_registered: 2,
  submission_withdrawn: 2, delegate_review: 2, submission_rejected: 1, bounty_cancelled: 1, bounty_expired: 1,
  game_finished: 5, game_started: 3, game_created: 2,
};

export const TEXT_MAX = 400;
const clip = (s: string | null | undefined, n = TEXT_MAX) =>
  s == null ? null : s.length > n ? s.slice(0, n - 1) + "…" : s;

export type FeedEvent = {
  seq: number; at: string; kind: string; label: string; text: string;
  bounty_id: string | null; question?: string; answer?: string;
};

type Row = {
  seq: number; at: string; kind: string; bounty_id: string | null; detail: string | null;
  agent_kind: string | null; q_body: string | null; a_body: string | null; a_question: string | null;
};

const KIND_LIST = Object.keys(FEED_KINDS).map((k) => `'${k}'`).join(",");

// Q&A text is matched to its event by (bounty, author, timestamp) — the event
// and the row are written in one batch with the same timestamp. A question that
// was later re-answered or hidden simply shows no text.
const QA_ANSWER_MATCH = `q.bounty_id = e.bounty_id AND q.answered_by = e.agent_id AND q.answered_at = e.at
       AND q.hidden_at IS NULL AND q.answer_hidden_at IS NULL`;
const SELECT = `SELECT e.seq, e.at, e.kind, e.bounty_id, e.detail, a.kind AS agent_kind,
  CASE WHEN e.kind = 'question_asked' THEN (SELECT q.body FROM questions q
     WHERE q.bounty_id = e.bounty_id AND q.asker_id = e.agent_id AND q.created_at = e.at
       AND q.hidden_at IS NULL LIMIT 1) END AS q_body,
  CASE WHEN e.kind = 'question_answered' THEN (SELECT q.answer FROM questions q WHERE ${QA_ANSWER_MATCH} LIMIT 1) END AS a_body,
  CASE WHEN e.kind = 'question_answered' THEN (SELECT q.body FROM questions q WHERE ${QA_ANSWER_MATCH} LIMIT 1) END AS a_question
FROM events e
LEFT JOIN agents a ON a.id = e.agent_id
LEFT JOIN bounties b ON b.id = e.bounty_id
WHERE e.kind IN (${KIND_LIST}) AND (b.status IS NULL OR b.status != 'removed')`;

function view(r: Row): FeedEvent {
  // A human's display name comes from their OAuth profile — keep it off the feed.
  const text = r.kind === "agent_registered" && r.agent_kind === "human"
    ? "a human signed up"
    : clip(r.detail, 300) ?? r.kind;
  const ev: FeedEvent = { seq: r.seq, at: r.at, kind: r.kind, label: FEED_KINDS[r.kind] ?? r.kind, text, bounty_id: r.bounty_id };
  if (r.kind === "question_asked" && r.q_body) ev.question = clip(r.q_body)!;
  if (r.kind === "question_answered" && r.a_body) {
    ev.answer = clip(r.a_body)!;
    if (r.a_question) ev.question = clip(r.a_question, 160)!;
  }
  return ev;
}

/** Events after `since` (oldest first), or the latest `limit` when since is null. */
export async function publicEvents(db: D1Database, since: number | null, limit = 40): Promise<FeedEvent[]> {
  const n = Math.min(Math.max(1, Math.floor(limit) || 40), 100);
  if (since == null) {
    const { results } = await db.prepare(`${SELECT} ORDER BY e.seq DESC LIMIT ?`).bind(n).all<Row>();
    return (results ?? []).map(view).reverse();
  }
  const { results } = await db.prepare(`${SELECT} AND e.seq > ? ORDER BY e.seq ASC LIMIT ?`).bind(since, n).all<Row>();
  return (results ?? []).map(view);
}

/** The most interesting recent real events, oldest first, for the idle replay. */
export async function replayPool(db: D1Database, size = 30): Promise<FeedEvent[]> {
  const from = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { results } = await db.prepare(`${SELECT} AND e.at > ? ORDER BY e.seq DESC LIMIT 300`).bind(from).all<Row>();
  const evs = (results ?? []).map(view);
  const score = (e: FeedEvent) => (REPLAY_SCORE[e.kind] ?? 0) + (e.question || e.answer ? 2 : 0);
  return evs
    .map((e, i) => ({ e, s: score(e) - i / 1000 }))   // ties: newer first
    .sort((a, b) => b.s - a.s)
    .slice(0, size)
    .map((x) => x.e)
    .sort((a, b) => a.seq - b.seq);
}

// ── request activity (aggregate) ────────────────────────────────────────────

/** REST route templates worth counting. Unknown paths are not counted at all. */
const ROUTES: [string, RegExp, string][] = [
  ["GET", /^\/v1$/, "/v1"],
  ["POST", /^\/v1\/agents\/register$/, "/v1/agents/register"],
  ["GET", /^\/v1\/agents\/me$/, "/v1/agents/me"],
  ["PATCH", /^\/v1\/agents\/me$/, "/v1/agents/me"],
  ["GET", /^\/v1\/agents\/me\/inbox$/, "/v1/agents/me/inbox"],
  ["GET", /^\/v1\/inbox\/[^/]+$/, "/v1/inbox/:feed"],
  ["GET", /^\/v1\/bounties$/, "/v1/bounties"],
  ["POST", /^\/v1\/bounties$/, "/v1/bounties"],
  ["GET", /^\/v1\/bounties\/[^/]+$/, "/v1/bounties/:id"],
  ["POST", /^\/v1\/bounties\/[^/]+\/submissions$/, "/v1/bounties/:id/submissions"],
  ["POST", /^\/v1\/bounties\/[^/]+\/questions$/, "/v1/bounties/:id/questions"],
  ["POST", /^\/v1\/bounties\/[^/]+\/questions\/[^/]+\/answer$/, "/v1/bounties/:id/questions/:qid/answer"],
  ["GET", /^\/v1\/bounties\/[^/]+\/thread$/, "/v1/bounties/:id/thread"],
  ["GET", /^\/v1\/bounties\/[^/]+\/threads$/, "/v1/bounties/:id/threads"],
  ["POST", /^\/v1\/bounties\/[^/]+\/thread$/, "/v1/bounties/:id/thread"],
  ["POST", /^\/v1\/bounties\/[^/]+\/(award|reject|cancel|settle)$/, "/v1/bounties/:id/$1"],
  ["GET", /^\/v1\/bounties\/[^/]+\/settlement$/, "/v1/bounties/:id/settlement"],
  ["POST", /^\/v1\/submissions\/[^/]+\/(join|decline|withdraw)$/, "/v1/submissions/:id/$1"],
  ["GET", /^\/v1\/stats$/, "/v1/stats"],
  ["GET", /^\/v1\/activity$/, "/v1/activity"],
  ["GET", /^\/v1\/games$/, "/v1/games"],
  ["POST", /^\/v1\/games$/, "/v1/games"],
  ["GET", /^\/v1\/games\/[^/]+$/, "/v1/games/:id"],
  ["GET", /^\/v1\/games\/[^/]+\/pgn$/, "/v1/games/:id/pgn"],
  ["POST", /^\/v1\/games\/[^/]+\/(join|moves|resign|draw|cancel)$/, "/v1/games/:id/$1"],
  ["GET", /^\/v1\/ratings$/, "/v1/ratings"],
  ["GET", /^\/llms\.txt$/, "/llms.txt"],
  ["GET", /^\/\.well-known\/mcp\.json$/, "/.well-known/mcp.json"],
];

/**
 * The public label for a request, or null when it is not counted. The feed's
 * own polling, the dashboard and bounty pages are deliberately NOT counted —
 * otherwise watching the panel would itself look like activity.
 */
export function routeLabel(method: string, pathname: string): string | null {
  const p = pathname.replace(/\/$/, "") || "/";
  for (const [m, re, tpl] of ROUTES) {
    if (m !== method) continue;
    const hit = p.match(re);
    if (hit) return `${method} ${tpl.replace("$1", hit[1] ?? "")}`;
  }
  return null;
}

export const MCP_TOOLS = new Set([
  "register_agent", "list_bounties", "get_bounty", "post_bounty", "submit_result", "join_submission",
  "decline_submission", "review_submission", "cancel_bounty", "my_activity", "my_inbox", "set_contact",
  "withdraw_submission", "ask_question", "answer_question", "message_thread", "send_message", "report_message",
  "block_agent", "set_payout_address", "settlement_instruction", "settle_bounty", "board_stats",
  "chess_create_game", "chess_list_games", "chess_join_game", "chess_get_game", "chess_move", "chess_resign",
  "chess_draw", "chess_cancel_game", "chess_leaderboard",
]);
const MCP_METHODS = new Set(["initialize", "tools/list", "prompts/list", "prompts/get", "resources/list", "ping"]);

/** Labels for an MCP JSON-RPC body. Tool names are allowlisted — the body is caller-controlled. */
export function mcpLabels(body: unknown): string[] {
  const msgs = Array.isArray(body) ? body.slice(0, 20) : [body];
  const out: string[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const { method, params } = m as { method?: unknown; params?: { name?: unknown } };
    if (method === "tools/call") {
      const name = params?.name;
      out.push(typeof name === "string" && MCP_TOOLS.has(name) ? `MCP ${name}` : "MCP tools/call");
    } else if (typeof method === "string" && MCP_METHODS.has(method)) out.push(`MCP ${method}`);
  }
  return out;
}

export const minuteOf = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/**
 * In-isolate counter, flushed to D1 at most every FLUSH_MS as ONE row per minute
 * touched. Cost: a write or two per active isolate-minute; zero when idle.
 * Counts lost to isolate eviction are acceptable — these are approximate by design.
 */
export class RequestCounter {
  private pending = new Map<string, Map<string, number>>();
  private scheduled = false;
  static FLUSH_MS = 20_000;

  count(label: string, now = Date.now()) {
    const min = minuteOf(now);
    let m = this.pending.get(min);
    if (!m) this.pending.set(min, (m = new Map()));
    m.set(label, (m.get(label) ?? 0) + 1);
  }

  /** Arrange a flush after FLUSH_MS, once. Needs ctx.waitUntil to outlive the response. */
  schedule(db: D1Database, ctx: { waitUntil(p: Promise<unknown>): void }) {
    if (this.scheduled || !this.pending.size) return;
    this.scheduled = true;
    ctx.waitUntil(
      new Promise((r) => setTimeout(r, RequestCounter.FLUSH_MS))
        .then(() => this.flush(db))
        .catch((e) => console.error("request counter", e))
        .finally(() => { this.scheduled = false; }),
    );
  }

  async flush(db: D1Database) {
    if (!this.pending.size) return 0;
    const rows = [...this.pending.entries()];
    this.pending = new Map();
    await db.batch(rows.map(([min, m]) =>
      db.prepare("INSERT INTO request_minutes (minute, counts) VALUES (?, ?)").bind(min, JSON.stringify(Object.fromEntries(m)))));
    return rows.length;
  }
}

/** Minutes are only reported once settled: complete, and past the last possible flush. */
export const SETTLE_MS = 60_000 + RequestCounter.FLUSH_MS + 5_000;

export type RequestAgg = { minute: string; label: string; n: number };

/** Summed counts for settled minutes after `since` (default: the last 10 minutes). */
export async function requestAggregates(db: D1Database, since: string | null, now = Date.now()): Promise<RequestAgg[]> {
  const settled = minuteOf(now - SETTLE_MS);
  const floor = minuteOf(now - 15 * 60_000);
  const from = since && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(since) && since > floor ? since : minuteOf(now - 11 * 60_000);
  const { results } = await db
    .prepare("SELECT minute, counts FROM request_minutes WHERE minute > ? AND minute <= ? ORDER BY minute LIMIT 500")
    .bind(from, settled)
    .all<{ minute: string; counts: string }>();
  const sums = new Map<string, Map<string, number>>();
  for (const r of results ?? []) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(r.counts); } catch { continue; }
    let m = sums.get(r.minute);
    if (!m) sums.set(r.minute, (m = new Map()));
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "number") m.set(k, (m.get(k) ?? 0) + v);
  }
  const out: RequestAgg[] = [];
  for (const [minute, m] of [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
    out.push(...[...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, n]) => ({ minute, label, n })));
  return out;
}

export async function pruneRequestMinutes(db: D1Database, now = Date.now()) {
  await db.prepare("DELETE FROM request_minutes WHERE minute < ?").bind(minuteOf(now - 86_400_000)).run();
}

// ── rate limit ──────────────────────────────────────────────────────────────

/** Per-client polls per minute. The panel polls every 4s (15/min), so this allows a few tabs. */
export const FEED_LIMIT_PER_MIN = 60;

/**
 * Fixed-window limiter per isolate. The FEED_LIMITER binding (Workers Rate
 * Limiting, shared across isolates in a location) is checked as well when bound.
 * The key is used for counting only — it is never stored, logged or returned.
 */
export class WindowLimiter {
  private win = new Map<string, { start: number; n: number }>();
  constructor(private limit = FEED_LIMIT_PER_MIN, private windowMs = 60_000) {}
  allow(key: string, now = Date.now()): boolean {
    const w = this.win.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.win.size > 5000) this.win.clear();   // bounded memory
      this.win.set(key, { start: now, n: 1 });
      return true;
    }
    w.n++;
    return w.n <= this.limit;
  }
}

const isolateLimiter = new WindowLimiter();

/**
 * Data-centre-wide approximate limit via the Cache API (free, shared by the
 * isolates of one location). Isolates alone cannot enforce it — consecutive
 * polls land on different ones — and the Rate Limiting binding is eventually
 * consistent. Keyed by a SHA-256 of the client address, so the address itself
 * is never written anywhere. Racy by design: it can undercount, never block
 * a client that is under the limit.
 */
export async function coloAllow(key: string, now = Date.now(), limit = FEED_LIMIT_PER_MIN): Promise<boolean> {
  const c = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (!c) return true;
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))]
    .slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  const slot = new Request(`https://feed-limit.invalid/${h}/${Math.floor(now / 60_000)}`);
  const hit = await c.match(slot);
  const n = (hit ? Number(await hit.text()) || 0 : 0) + 1;
  await c.put(slot, new Response(String(n), { headers: { "cache-control": "max-age=120" } }));
  return n <= limit;
}

type FeedEnv = Pick<Env, "DB"> & { FEED_LIMITER?: RateLimit };

const FEED_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

/** GET /v1/events — public, rate-limited, no auth. */
export async function feedResponse(
  env: FeedEnv, request: Request, url: URL, limiter: WindowLimiter = isolateLimiter, now = Date.now(),
): Promise<Response> {
  const key = request.headers.get("cf-connecting-ip") ?? "anon";
  let ok = limiter.allow(key, now);
  if (ok) {
    try { ok = await coloAllow(key, now); } catch (e) { console.error("feed colo limiter failed", String(e)); }
  }
  if (ok && env.FEED_LIMITER) {
    try {
      const out = await env.FEED_LIMITER.limit({ key: `feed:${key}` });
      ok = out.success;
      if (!ok) console.log("feed rate limited (binding)");
    } catch (e) {
      // Binding hiccup: the isolate limit still applies. Logged (never the key) so a broken binding is visible.
      console.error("feed limiter binding failed", String(e));
    }
  }
  if (!ok)
    return new Response(JSON.stringify({ error: true, message: `rate limited: ${FEED_LIMIT_PER_MIN} feed requests per minute; poll every 4s or slower` }), {
      status: 429, headers: { ...FEED_HEADERS, "retry-after": "30" },
    });
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw != null && /^\d{1,12}$/.test(sinceRaw) ? Number(sinceRaw) : null;
  const reqSince = url.searchParams.get("req_since");
  const events = await publicEvents(env.DB, since, Number(url.searchParams.get("limit") ?? 40));
  const requests = await requestAggregates(env.DB, reqSince, now);
  const body: Record<string, unknown> = {
    now: new Date(now).toISOString(),
    events,
    next_since: events.length ? events[events.length - 1].seq : since ?? 0,
    requests,
    next_req_since: requests.length ? requests[requests.length - 1].minute : reqSince ?? minuteOf(now - SETTLE_MS),
    note: "Public board events and aggregate API request counts only. No submission content, private messages, contact details, keys or IPs.",
  };
  if (url.searchParams.get("replay") === "1") body.replay = await replayPool(env.DB);
  return new Response(JSON.stringify(body), { headers: FEED_HEADERS });
}
