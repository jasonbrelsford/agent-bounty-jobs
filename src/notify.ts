/**
 * Notifications: the inbox every agent has, the signed webhook an agent may add,
 * and the hourly sweep that emits stale and review-window notices.
 *
 * Inbox rows are the source of truth; webhooks are a best-effort push of the
 * same rows. A receiver that misses a push loses nothing — the row is still in
 * the inbox, and the push is retried with backoff.
 *
 * PRIVACY: inbox payloads carry ids, titles and amounts only. Never sealed
 * submission content, never evidence values, never another agent's contact.
 *
 * SSRF: the board makes outbound requests to URLs that callers chose. Those
 * URLs are checked syntactically when set (https, public host, default port, no
 * credentials) and the host is resolved over DNS-over-HTTPS before EVERY
 * delivery, refusing any private, loopback, link-local or otherwise reserved
 * address. Redirects are never followed and every request has a hard timeout.
 */

// ── addresses ───────────────────────────────────────────────────────────────

function v4parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((x) => x <= 255) ? p : null;
}

function v4Public(p: number[]): boolean {
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return false;            // this-net, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false;              // CGNAT 100.64/10
  if (a === 169 && b === 254) return false;                        // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;               // private
  if (a === 192 && b === 168) return false;                        // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;  // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false;             // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false;           // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;            // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;             // TEST-NET-3
  if (a >= 224) return false;                                      // multicast, reserved, broadcast
  return true;
}

/** Expand an IPv6 literal to 8 hextets, or null if it is not one. */
function v6hextets(raw: string): number[] | null {
  let ip = raw.toLowerCase();
  if (ip.includes("%")) return null;                               // zone ids: never public
  // trailing dotted-quad (::ffff:1.2.3.4)
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (tail) {
    const p = v4parts(tail[1]);
    if (!p) return null;
    ip = ip.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":") : []);
  const head = parse(halves[0]), rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...rest];
  if (all.length !== 8 || !all.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => parseInt(h, 16));
}

/**
 * Only global unicast (2000::/3) is public, minus documentation, Teredo and
 * 6to4 — the last two embed IPv4 addresses that could be anything. Everything
 * else (::, ::1, fc00::/7, fe80::/10, ff00::/8, ::ffff:…, 64:ff9b::…) is outside
 * 2000::/3 and therefore refused without enumerating it.
 */
function v6Public(h: number[]): boolean {
  if ((h[0] & 0xe000) !== 0x2000) return false;
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false;
  if (h[0] === 0x2001 && h[1] === 0x0000) return false;
  if (h[0] === 0x2002) return false;
  return true;
}

/** True only for an address it is safe for the board to connect to. */
export function isPublicIp(ip: string): boolean {
  const s = ip.replace(/^\[|\]$/g, "");
  const p4 = v4parts(s);
  if (p4) return v4Public(p4);
  const h = v6hextets(s);
  return h ? v6Public(h) : false;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".arpa", ".invalid", ".test", ".example"];

/**
 * Validate a webhook URL at the moment it is set. Returns the normalised URL.
 * This is the cheap, synchronous half of the SSRF defence; the DNS check at
 * delivery time is the other half.
 */
export function validateWebhookUrl(raw: unknown, field = "notify_webhook"): string {
  if (typeof raw !== "string" || !raw.trim()) throw new WebhookError(`${field} must be an https URL`);
  const s = raw.trim();
  if (s.length > 500) throw new WebhookError(`${field} must be at most 500 characters`);
  let u: URL;
  try { u = new URL(s); } catch { throw new WebhookError(`${field} is not a valid URL`); }
  if (u.protocol !== "https:") throw new WebhookError(`${field} must use https`);
  if (u.username || u.password) throw new WebhookError(`${field} must not contain credentials`);
  if (u.port && u.port !== "443") throw new WebhookError(`${field} must use the default https port`);
  const host = u.hostname.toLowerCase();
  // The WHATWG parser already canonicalises odd IPv4 spellings (0x7f.1, 2130706433)
  // into dotted quads, so checking the canonical host catches them.
  if (v4parts(host) || host.startsWith("[")) {
    if (!isPublicIp(host)) throw new WebhookError(`${field} points at a private or reserved address`);
  } else {
    if (host === "localhost" || !host.includes(".") || BLOCKED_SUFFIXES.some((x) => host.endsWith(x)))
      throw new WebhookError(`${field} must be a public internet hostname`);
  }
  u.hash = "";
  return u.toString();
}

export class WebhookError extends Error {}

export type Resolver = (host: string) => Promise<string[]>;

/** DNS-over-HTTPS A + AAAA lookup. Cloudflare's resolver, JSON API. */
export const dohResolve: Resolver = async (host) => {
  const out: string[] = [];
  for (const type of ["A", "AAAA"]) {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`DNS lookup failed (${r.status})`);
    const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
    for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data);
  }
  return out;
};

/** Refuse delivery unless EVERY address the host resolves to is public. */
export async function assertDeliverable(url: string, resolve: Resolver): Promise<void> {
  validateWebhookUrl(url);
  const host = new URL(url).hostname;
  if (v4parts(host) || host.startsWith("[")) return;   // literal already checked above
  const ips = await resolve(host);
  if (!ips.length) throw new WebhookError("webhook host does not resolve");
  const bad = ips.find((ip) => !isPublicIp(ip));
  if (bad) throw new WebhookError(`webhook host resolves to a non-public address (${bad})`);
}

// ── signing ─────────────────────────────────────────────────────────────────

const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export function newWebhookSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `whsec_${hex(b)}`;
}

/**
 * Signature header value: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 * The timestamp is inside the MAC so a captured delivery cannot be replayed
 * later with a fresh time; receivers should reject t older than ~5 minutes.
 */
export async function signPayload(secret: string, body: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  return `t=${t},v1=${hex(mac)}`;
}

// ── inbox ───────────────────────────────────────────────────────────────────

export type InboxRow = {
  seq: number; agent_id: string; at: string; type: string;
  bounty_id: string | null; submission_id: string | null; data: string;
};

/** Public shape of an inbox event — identical in the inbox and in a webhook body. */
export function eventView(r: InboxRow) {
  return {
    id: `evt_${r.seq}`,
    seq: r.seq,
    type: r.type,
    at: r.at,
    agent_id: r.agent_id,
    bounty_id: r.bounty_id,
    submission_id: r.submission_id,
    data: JSON.parse(r.data),
  };
}

/**
 * SQL that decides whether an inbox row has a push target. A poster's events
 * about their own bounty prefer that bounty's webhook; everything else uses the
 * agent's own. Shared by insert-time and delivery-time so they cannot disagree.
 */
export const TARGET_SQL = (agentCol: string, bountyCol: string) =>
  `COALESCE((SELECT notify_webhook FROM bounties WHERE id = ${bountyCol} AND poster_id = ${agentCol}),
            (SELECT notify_webhook FROM agents WHERE id = ${agentCol}))`;

/** One inbox event for one agent, as a statement that can join any batch. */
export function inboxStmt(
  db: D1Database, at: string, agentId: string, type: string,
  bountyId: string | null, submissionId: string | null, data: Record<string, unknown>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO inbox (agent_id, at, type, bounty_id, submission_id, data, webhook_pending)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ${TARGET_SQL("?1", "?4")} IS NULL THEN 0 ELSE 1 END)`,
    )
    .bind(agentId, at, type, bountyId, submissionId, JSON.stringify(data));
}

const BACKOFF_MIN = [1, 5, 30, 120, 720];
export const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Push undelivered inbox rows to their webhooks. Safe to call concurrently: each
 * row is claimed with a compare-and-swap on `attempts`, so two flushes cannot
 * both deliver the same attempt. Receivers should still dedupe on the event id.
 */
export async function flushWebhooks(
  db: D1Database,
  opts: { fetcher?: Fetcher; resolve?: Resolver; limit?: number; now?: number } = {},
): Promise<{ delivered: number; failed: number }> {
  const fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
  const resolve = opts.resolve ?? dohResolve;
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const { results } = await db
    .prepare(
      `SELECT i.*, a.webhook_secret AS secret, ${TARGET_SQL("i.agent_id", "i.bounty_id")} AS target
         FROM inbox i JOIN agents a ON a.id = i.agent_id
        WHERE i.webhook_pending = 1 AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= ?)
        ORDER BY i.seq LIMIT ?`,
    )
    .bind(nowIso, opts.limit ?? 25)
    .all<InboxRow & { attempts: number; secret: string | null; target: string | null }>();
  let delivered = 0, failed = 0;
  for (const r of results ?? []) {
    // The target or secret was removed since the row was queued: stop pushing.
    if (!r.target || !r.secret) {
      await db.prepare("UPDATE inbox SET webhook_pending = 0, last_error = 'no webhook configured' WHERE seq = ?").bind(r.seq).run();
      continue;
    }
    const attempt = r.attempts + 1;
    const next = attempt >= MAX_ATTEMPTS ? null : new Date(now + BACKOFF_MIN[attempt - 1] * 60_000).toISOString();
    const claim = await db
      .prepare("UPDATE inbox SET attempts = ?, next_attempt_at = ? WHERE seq = ? AND attempts = ? AND webhook_pending = 1")
      .bind(attempt, next, r.seq, r.attempts)
      .run();
    if (!claim.meta.changes) continue;
    let err: string | null = null;
    try {
      await assertDeliverable(r.target, resolve);
      const body = JSON.stringify(eventView(r));
      const t = Math.floor(now / 1000);
      const res = await fetcher(r.target, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: {
          "content-type": "application/json",
          "user-agent": "agent-bounty-jobs-webhook/1",
          "x-bounty-event": r.type,
          "x-bounty-delivery": `evt_${r.seq}`,
          "x-bounty-signature": await signPayload(r.secret, body, t),
        },
        body,
      });
      if (res.status < 200 || res.status >= 300) err = `HTTP ${res.status}${res.status >= 300 && res.status < 400 ? " (redirects are not followed)" : ""}`;
    } catch (e) {
      err = e instanceof Error ? e.message.slice(0, 200) : "delivery failed";
    }
    if (err === null) {
      delivered++;
      await db.prepare("UPDATE inbox SET webhook_pending = 0, delivered_at = ?, last_error = NULL WHERE seq = ?").bind(nowIso, r.seq).run();
    } else {
      failed++;
      await db
        .prepare("UPDATE inbox SET last_error = ?, webhook_pending = CASE WHEN ? THEN 0 ELSE 1 END WHERE seq = ?")
        .bind(err, attempt >= MAX_ATTEMPTS ? 1 : 0, r.seq)
        .run();
    }
  }
  return { delivered, failed };
}
