/**
 * Open MCP server registry: a free list of MCP servers that any maker can add
 * their own server to, served in the official MCP Registry's read format
 * (GET /v0.1/servers, /v0.1/servers/{name}/versions[/{version}]) so existing
 * registry clients can point at it unchanged.
 *
 * Listing is automatic, with no manual review:
 *   1. server.json is checked against the official schema's rules;
 *   2. ownership is proven by a file on the maker's own domain, the one the
 *      reverse-DNS name points at (com.example/weather -> example.com,
 *      io.github.alice/x -> alice.github.io), at
 *      https://<domain>/.well-known/bounty-mcp-registry.txt, listing the name;
 *   3. every remote URL must be public https and answer an MCP initialize.
 * Submissions are rate-limited per caller, per domain and in total.
 *
 * Its tables (registry_*) and this code are kept apart from the bounty board,
 * the arena and the science queues; nothing here reads or writes theirs.
 */

export const PROOF_PATH = "/.well-known/bounty-mcp-registry.txt";
export const SCHEMA_URL = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
export const OFFICIAL = "io.modelcontextprotocol.registry/official";
export const CHECKS = "com.brelsfordsoftware.registry/checks";

export const LIMITS = {
  per_ip_hour: 10,
  per_ip_day: 30,
  per_domain_day: 30,
  global_day: 500,
  body_bytes: 16_384,
  proof_bytes: 65_536,
  timeout_ms: 8_000,
  sweep_batch: 10,
} as const;

/** The board's own entry, the same as server.json. Listed first on the browse page; seeded by migration
 * 0021 and updated by 0024 (a new version needs a new migration; tests check they agree). */
export const BOUNTY_SERVER = {
  $schema: SCHEMA_URL,
  name: SERVER_NAME,
  title: SERVER_TITLE,
  description: SERVER_DESCRIPTION,
  version: SERVER_VERSION,
  websiteUrl: SITE_URL,
  icons: SERVER_ICONS,
  repository: { url: REPO_URL, source: "github" },
  remotes: [{ type: "streamable-http", url: `${SITE_URL}/mcp` }],
};

export class RegistryError extends Error {
  constructor(public status: number, message: string, public errors: string[] = []) {
    super(message);
  }
}

import { scanServer, type Scan, type ScanKeys } from "./scan.js";
import { SERVER_NAME, SERVER_TITLE, SERVER_DESCRIPTION, SERVER_VERSION, SITE_URL, REPO_URL, SERVER_ICONS } from "../listing.js";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

// ── validation ──────────────────────────────────────────────────────────────

const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const TOP_KEYS = new Set(["$schema", "_meta", "name", "title", "description", "version", "websiteUrl", "repository", "remotes", "packages", "icons"]);
const REMOTE_TYPES = new Set(["streamable-http", "sse"]);
const PACKAGE_TYPES = new Set(["npm", "pypi", "oci", "nuget", "mcpb"]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, min: number, max: number) => typeof v === "string" && v.trim().length >= min && v.length <= max;

/** A hostname that resolves on the public internet: no IPs, no local names. */
export function publicHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h.includes(".") || h.includes(":") || h.startsWith("[")) return false;
  if (/^[0-9.]+$/.test(h)) return false;
  if (/(^|\.)(localhost|local|internal|lan|home|arpa|test|invalid|example|onion)$/.test(h)) return false;
  const labels = h.split(".");
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  return /^[a-z]{2,63}$/.test(labels[labels.length - 1]);
}

/** A public https URL, default port, no credentials. Template braces allowed in the path only. */
export function publicHttpsUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  const hostPart = raw.replace(/^https:\/\//, "").split(/[/?#]/)[0];
  if (hostPart.includes("{")) return null;
  let u: URL;
  try { u = new URL(raw.replace(/\{[A-Za-z0-9_]+\}/g, "x")); } catch { return null; }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
  return publicHost(u.hostname) ? u : null;
}

/** The domain a reverse-DNS server name points at: com.example/x -> example.com. */
export function domainOf(name: string): string | null {
  const ns = name.split("/")[0]?.toLowerCase() ?? "";
  const labels = ns.split(".");
  if (labels.length < 2) return null;
  const domain = labels.reverse().join(".");
  return publicHost(domain) ? domain : null;
}

/** Checks a server.json against the official schema's rules. Returns every problem found. */
export function validateServer(s: unknown): string[] {
  const e: string[] = [];
  if (!isObj(s)) return ["server.json must be a JSON object"];
  for (const k of Object.keys(s)) if (!TOP_KEYS.has(k)) e.push(`unknown field "${k}"`);
  if (!str(s.$schema, 1, 500) || !/^https:\/\//.test(String(s.$schema))) e.push(`$schema is required (use ${SCHEMA_URL})`);
  if (!str(s.name, 3, 200) || !NAME_RE.test(String(s.name)))
    e.push('name must be reverse-DNS with one slash, e.g. "com.example/weather" (letters, digits, . - _)');
  else if (!domainOf(String(s.name))) e.push(`name "${s.name}" does not point at a public domain (com.example/x means example.com)`);
  if (!str(s.description, 1, 100)) e.push("description is required, 1 to 100 characters");
  if (!str(s.version, 1, 255) || !VERSION_RE.test(String(s.version)) || String(s.version) === "latest")
    e.push('version is required, e.g. "1.0.0" (no spaces, ranges or "latest")');
  if (s.title !== undefined && !str(s.title, 1, 100)) e.push("title must be 1 to 100 characters");
  if (s.websiteUrl !== undefined && !publicHttpsUrl(s.websiteUrl)) e.push("websiteUrl must be a public https URL");
  if (s.repository !== undefined) {
    const r = s.repository;
    if (!isObj(r)) e.push("repository must be an object");
    else {
      for (const k of Object.keys(r)) if (!["url", "source", "id", "subfolder"].includes(k)) e.push(`unknown repository field "${k}"`);
      if (r.url !== undefined && !publicHttpsUrl(r.url)) e.push("repository.url must be a public https URL");
      if (r.source !== undefined && !str(r.source, 1, 50)) e.push("repository.source must be a short string, e.g. github");
      if (r.subfolder !== undefined && (!str(r.subfolder, 1, 300) || /(^\/|\.\.)/.test(String(r.subfolder)))) e.push("repository.subfolder must be a clean relative path");
    }
  }
  const remotes = s.remotes ?? [];
  const packages = s.packages ?? [];
  if (!Array.isArray(remotes)) e.push("remotes must be an array");
  if (!Array.isArray(packages)) e.push("packages must be an array");
  if (Array.isArray(remotes)) {
    if (remotes.length > 5) e.push("at most 5 remotes");
    remotes.slice(0, 5).forEach((r, i) => {
      if (!isObj(r)) return void e.push(`remotes[${i}] must be an object`);
      for (const k of Object.keys(r)) if (!["type", "url", "headers", "variables"].includes(k)) e.push(`unknown remotes[${i}] field "${k}"`);
      if (!REMOTE_TYPES.has(String(r.type))) e.push(`remotes[${i}].type must be "streamable-http" or "sse"`);
      if (!publicHttpsUrl(r.url)) e.push(`remotes[${i}].url must be a public https URL on the default port`);
      if (r.headers !== undefined && !Array.isArray(r.headers)) e.push(`remotes[${i}].headers must be an array`);
      if (r.variables !== undefined && !isObj(r.variables)) e.push(`remotes[${i}].variables must be an object`);
    });
  }
  if (Array.isArray(packages)) {
    if (packages.length > 10) e.push("at most 10 packages");
    packages.slice(0, 10).forEach((p, i) => {
      if (!isObj(p)) return void e.push(`packages[${i}] must be an object`);
      if (!PACKAGE_TYPES.has(String(p.registryType))) e.push(`packages[${i}].registryType must be one of ${[...PACKAGE_TYPES].join(", ")}`);
      if (!str(p.identifier, 1, 300)) e.push(`packages[${i}].identifier is required`);
      if (!isObj(p.transport) || !["stdio", "streamable-http", "sse"].includes(String(p.transport.type)))
        e.push(`packages[${i}].transport.type must be stdio, streamable-http or sse`);
    });
  }
  if (Array.isArray(remotes) && Array.isArray(packages) && !remotes.length && !packages.length)
    e.push("list at least one remote (a URL agents connect to) or one package");
  if (s.icons !== undefined) {
    if (!Array.isArray(s.icons) || s.icons.length > 8) e.push("icons must be an array of at most 8");
    else s.icons.forEach((ic, i) => { if (!isObj(ic) || !publicHttpsUrl(ic.src)) e.push(`icons[${i}].src must be a public https URL`); });
  }
  if (s._meta !== undefined) {
    if (!isObj(s._meta) || Object.keys(s._meta).some((k) => k !== "io.modelcontextprotocol.registry/publisher-provided"))
      e.push('_meta may only hold "io.modelcontextprotocol.registry/publisher-provided"');
  }
  return e;
}

// ── versions ────────────────────────────────────────────────────────────────

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver order, or null when either side is not semver. */
export function compareVersions(a: string, b: string): number | null {
  const x = a.match(SEMVER), y = b.match(SEMVER);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1; // a release outranks its prerelease
  if (!y[4]) return -1;
  return x[4] < y[4] ? -1 : 1;
}

// ── storage and read API ────────────────────────────────────────────────────

type Row = {
  name: string; version: string; server_json: string; status: string; status_message: string | null;
  status_changed_at: string; published_at: string; updated_at: string; is_latest: number;
  featured: number; source: string; domain: string; checks_json: string | null; last_checked_at: string | null;
  scan_verdict?: string | null; scan_json?: string | null; scanned_at?: string | null; tools_hash?: string | null; tools_changed_at?: string | null;
};

/** Rows a reader sees: not deleted and not flagged by the safety scan. */
const VISIBLE = "status != 'deleted' AND COALESCE(scan_verdict, '') != 'flagged'";

export function entry(r: Row) {
  const official: Record<string, unknown> = {
    status: r.status, statusChangedAt: r.status_changed_at, publishedAt: r.published_at,
    updatedAt: r.updated_at, isLatest: !!r.is_latest,
  };
  if (r.status_message) official.statusMessage = r.status_message;
  const checks = r.checks_json ? JSON.parse(r.checks_json) : {};
  const scan: Partial<Scan> = r.scan_json ? JSON.parse(r.scan_json) : {};
  return {
    server: JSON.parse(r.server_json),
    _meta: {
      [OFFICIAL]: official,
      [CHECKS]: {
        listedBy: r.source === "operator" ? "registry operator" : "owner",
        ownership: r.source === "operator" ? "operator" : "verified",
        domain: r.domain,
        ...checks,
        lastCheckedAt: r.last_checked_at,
        safety: {
          verdict: r.scan_verdict ?? "not_scanned",
          scannedAt: r.scanned_at ?? null,
          toolCount: scan.toolCount ?? null,
          toolsChangedAt: r.tools_changed_at ?? null,
          checked: scan.checked ?? [],
          notChecked: scan.notChecked ?? [],
          findings: scan.findings ?? [],
        },
      },
    },
  };
}

export type ListOpts = {
  cursor?: string | null; limit?: string | number | null; search?: string | null; version?: string | null;
  updated_since?: string | null; include_deleted?: string | boolean | null;
};

const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);
const truthy = (v: unknown) => v === true || v === "true" || v === "1";

/** GET /v0.1/servers: one record per server version, ordered by name then version, cursor "name:version". */
export async function listServers(db: D1Database, o: ListOpts = {}) {
  const limit = o.limit == null || o.limit === "" ? 30 : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RegistryError(400, "limit must be 1 to 100");
  const where: string[] = [];
  const args: unknown[] = [];
  const since = o.updated_since?.trim();
  if (since) {
    if (Number.isNaN(Date.parse(since))) throw new RegistryError(400, "updated_since must be an RFC3339 timestamp");
    where.push("updated_at >= ?"); args.push(new Date(since).toISOString());
  }
  if (!truthy(o.include_deleted) && !since) where.push(VISIBLE);
  const q = o.search?.trim();
  if (q) {
    if (q.length < 3) throw new RegistryError(400, "search needs at least 3 characters");
    const p = `%${likeEsc(q.slice(0, 100))}%`;
    where.push("(name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    args.push(p, p, p);
  }
  const v = o.version?.trim();
  if (v === "latest") where.push("is_latest = 1");
  else if (v) { where.push("version = ?"); args.push(v); }
  if (o.cursor) {
    const i = o.cursor.indexOf(":");
    if (i < 1) throw new RegistryError(400, "cursor is not valid; use metadata.nextCursor as given");
    where.push("(name > ? OR (name = ? AND version > ?))");
    args.push(o.cursor.slice(0, i), o.cursor.slice(0, i), o.cursor.slice(i + 1));
  }
  const sql = `SELECT * FROM registry_servers ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY name, version LIMIT ?`;
  const rows = (await db.prepare(sql).bind(...args, limit + 1).all<Row>()).results ?? [];
  const page = rows.slice(0, limit);
  const metadata: { count: number; nextCursor?: string } = { count: page.length };
  if (rows.length > limit) { const last = page[page.length - 1]; metadata.nextCursor = `${last.name}:${last.version}`; }
  return { servers: page.map(entry), metadata };
}

/** GET /v0.1/servers/{name}/versions */
export async function serverVersions(db: D1Database, name: string, includeDeleted = false) {
  const rows = (await db
    .prepare(`SELECT * FROM registry_servers WHERE name = ? ${includeDeleted ? "" : `AND ${VISIBLE}`} ORDER BY published_at`)
    .bind(name).all<Row>()).results ?? [];
  if (!rows.length) throw new RegistryError(404, `server ${name} not found`);
  return { servers: rows.map(entry), metadata: { count: rows.length } };
}

/** GET /v0.1/servers/{name}/versions/{version} ('latest' allowed) */
export async function serverVersion(db: D1Database, name: string, version: string, includeDeleted = false) {
  const r = await db
    .prepare(`SELECT * FROM registry_servers WHERE name = ? AND ${version === "latest" ? "is_latest = 1" : "version = ?"} ${includeDeleted ? "" : `AND ${VISIBLE}`}`)
    .bind(...(version === "latest" ? [name] : [name, version])).first<Row>();
  if (!r) throw new RegistryError(404, `server ${name} version ${version} not found`);
  return entry(r);
}

/** For the browse page: latest version of each listed server, featured first. */
export async function browse(db: D1Database, q?: string | null, page = 0, size = 50) {
  const args: unknown[] = [];
  let filter = "";
  const s = q?.trim();
  if (s) {
    const p = `%${likeEsc(s.slice(0, 100))}%`;
    filter = "AND (name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')";
    args.push(p, p, p);
  }
  const rows = (await db
    .prepare(`SELECT * FROM registry_servers WHERE is_latest = 1 AND ${VISIBLE} ${filter}
              ORDER BY featured DESC, updated_at DESC, name LIMIT ? OFFSET ?`)
    .bind(...args, size + 1, page * size).all<Row>()).results ?? [];
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM registry_servers WHERE is_latest = 1 AND ${VISIBLE}`).first<{ n: number }>();
  return { rows: rows.slice(0, size).map(entry), more: rows.length > size, total: total?.n ?? 0 };
}

// ── submissions ─────────────────────────────────────────────────────────────

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** The caller's address is never stored, only a hash that changes every day. */
export const callerHash = (ip: string, now: Date) => sha(`registry:${now.toISOString().slice(0, 10)}:${ip}`);

async function rateLimit(db: D1Database, ipHash: string, domain: string | null, now: Date) {
  const hour = new Date(now.getTime() - 3_600_000).toISOString();
  const day = new Date(now.getTime() - 86_400_000).toISOString();
  const r = await db
    .prepare(`SELECT
        SUM(CASE WHEN ip_hash = ? AND created_at >= ? THEN 1 ELSE 0 END) AS ip_hour,
        SUM(CASE WHEN ip_hash = ? THEN 1 ELSE 0 END) AS ip_day,
        SUM(CASE WHEN domain = ? THEN 1 ELSE 0 END) AS dom_day,
        COUNT(*) AS all_day
      FROM registry_publish_log WHERE created_at >= ?`)
    .bind(ipHash, hour, ipHash, domain ?? "", day)
    .first<{ ip_hour: number | null; ip_day: number | null; dom_day: number | null; all_day: number }>();
  const msg = (what: string) => new RegistryError(429, `too many submissions ${what}; try again later`);
  if ((r?.ip_hour ?? 0) >= LIMITS.per_ip_hour) throw msg(`from you this hour (limit ${LIMITS.per_ip_hour})`);
  if ((r?.ip_day ?? 0) >= LIMITS.per_ip_day) throw msg(`from you today (limit ${LIMITS.per_ip_day})`);
  if (domain && (r?.dom_day ?? 0) >= LIMITS.per_domain_day) throw msg(`for ${domain} today (limit ${LIMITS.per_domain_day})`);
  if ((r?.all_day ?? 0) >= LIMITS.global_day) throw msg("to the registry today");
}

type Proof = { ok: boolean; listed: boolean; status?: "active" | "deprecated" | "deleted"; message?: string; error?: string; http?: number };

/** Reads the owner's file. Lines: "<name>" or "<namespace>/*", optionally followed by active|deprecated|deleted. */
export async function readProof(fetcher: Fetcher, domain: string, name: string): Promise<Proof> {
  const url = `https://${domain}${PROOF_PATH}`;
  let res: Response;
  try {
    res = await fetcher(url, { redirect: "manual", headers: { "user-agent": "bounty-mcp-registry/1 (+https://bounty.brelsfordsoftware.com/registry)" }, signal: AbortSignal.timeout(LIMITS.timeout_ms) });
  } catch (e) {
    return { ok: false, listed: false, error: `could not fetch ${url} (${(e as Error).message || "network error"})` };
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    return { ok: false, listed: false, http: res.status, error: `${url} answered HTTP ${res.status}; it must answer 200 directly, without a redirect` };
  }
  const text = (await res.text()).slice(0, LIMITS.proof_bytes);
  const ns = name.split("/")[0];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [who, st] = line.split(/\s+/);
    if (who === name || who === `${ns}/*`) {
      const status = st === "deprecated" || st === "deleted" ? st : "active";
      return { ok: true, listed: true, status };
    }
  }
  return { ok: true, listed: false, http: 200, error: `${url} does not list ${name}` };
}

type RemoteCheck = { url: string; ok: boolean; http?: number; note?: string; checkedAt: string };

/** Sends an MCP initialize to the remote. Any answer below 500 counts as reachable (401 means it wants a key). */
export async function checkRemote(fetcher: Fetcher, remote: { type?: unknown; url?: unknown }, now: Date): Promise<RemoteCheck> {
  const url = String(remote.url);
  const at = now.toISOString();
  if (url.includes("{")) return { url, ok: true, note: "templated URL, filled in by the client; not called", checkedAt: at };
  try {
    const res = await fetcher(url, {
      method: remote.type === "sse" ? "GET" : "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "bounty-mcp-registry/1 (+https://bounty.brelsfordsoftware.com/registry)",
      },
      body: remote.type === "sse" ? undefined : JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bounty-mcp-registry", version: "1" } },
      }),
      signal: AbortSignal.timeout(LIMITS.timeout_ms),
    });
    await res.body?.cancel();
    if (res.status >= 300 && res.status < 400) return { url, ok: false, http: res.status, note: "redirects; list the final URL", checkedAt: at };
    return { url, ok: res.status < 500, http: res.status, checkedAt: at };
  } catch (e) {
    return { url, ok: false, note: `no answer (${(e as Error).message || "network error"})`, checkedAt: at };
  }
}

export type PublishCtx = { ip: string; fetcher: Fetcher; now?: Date; keys?: ScanKeys };

/** POST /v0.1/publish: list a server or a new version of it, free, after the automatic checks. */
export async function publish(db: D1Database, raw: string, ctx: PublishCtx) {
  const now = ctx.now ?? new Date();
  if (raw.length > LIMITS.body_bytes) throw new RegistryError(413, `server.json is too large (${LIMITS.body_bytes} bytes max)`);
  let s: unknown;
  try { s = JSON.parse(raw); } catch { throw new RegistryError(400, "body must be your server.json, as JSON"); }
  // Accept the server.json itself, or {server: {...}} as the list API returns it.
  if (isObj(s) && isObj(s.server) && !("name" in s)) s = s.server;
  const name = isObj(s) && typeof s.name === "string" ? s.name : "";
  const domain = name ? domainOf(name) : null;
  const ipHash = await callerHash(ctx.ip || "unknown", now);
  await rateLimit(db, ipHash, domain, now);
  const log = (ok: boolean) =>
    db.prepare("INSERT INTO registry_publish_log (ip_hash, domain, name, ok, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(ipHash, domain, name.slice(0, 200) || null, ok ? 1 : 0, now.toISOString()).run();
  await log(false);

  const problems = validateServer(s);
  if (problems.length) throw new RegistryError(422, "server.json did not pass the checks", problems);
  const server = s as Record<string, unknown> & { name: string; version: string; remotes?: { type?: unknown; url?: unknown }[] };
  const existing = await db.prepare("SELECT source FROM registry_servers WHERE name = ? LIMIT 1").bind(server.name).first<{ source: string }>();
  if (existing?.source === "operator") throw new RegistryError(403, `${server.name} is kept by the registry operator`);
  const dup = await db.prepare("SELECT 1 FROM registry_servers WHERE name = ? AND version = ?").bind(server.name, server.version).first();
  if (dup) throw new RegistryError(409, `${server.name} version ${server.version} is already listed; versions cannot change, publish a new version`);

  const proof = await readProof(ctx.fetcher, domain!, server.name);
  if (!proof.listed)
    throw new RegistryError(403, "ownership was not proven", [
      proof.error ?? "not listed",
      `put a plain text file at https://${domain}${PROOF_PATH} with the line: ${server.name}`,
    ]);
  if (proof.status === "deleted") throw new RegistryError(403, `your file marks ${server.name} as deleted`);

  const remotes = await Promise.all((server.remotes ?? []).map((r) => checkRemote(ctx.fetcher, r, now)));
  const down = remotes.filter((r) => !r.ok);
  if (down.length)
    throw new RegistryError(422, "a remote URL is not reachable", down.map((r) => `${r.url}: ${r.http ? `HTTP ${r.http}` : ""}${r.note ? ` ${r.note}` : ""}`.trim()));

  const cur = await db.prepare("SELECT version, tools_hash FROM registry_servers WHERE name = ? AND is_latest = 1").bind(server.name).first<{ version: string; tools_hash: string | null }>();
  const scan = await scanServer(ctx.fetcher, server as never, domain!, cur?.tools_hash ?? null, now, ctx.keys);
  if (scan.verdict === "flagged")
    throw new RegistryError(422, "the server did not pass the safety scan", scan.findings.filter((f) => f.severity === "high").map((f) => `${f.where}: ${f.what}${f.snippet ? ` (near: ${f.snippet})` : ""}`));
  const cmp = cur ? compareVersions(server.version, cur.version) : 1;
  const latest = !cur || cmp === null || cmp >= 0;
  const at = now.toISOString();
  const status = proof.status ?? "active";
  const checks = JSON.stringify({ remotes });
  const stmts = [];
  if (latest) stmts.push(db.prepare("UPDATE registry_servers SET is_latest = 0 WHERE name = ?").bind(server.name));
  stmts.push(
    db.prepare(`INSERT INTO registry_servers
        (name, version, server_json, title, description, status, status_message, status_changed_at, published_at, updated_at,
         is_latest, featured, source, domain, checks_json, last_checked_at, scan_verdict, scan_json, scanned_at, tools_hash, tools_changed_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, 'owner', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(server.name, server.version, JSON.stringify(server), String(server.title ?? ""), String(server.description),
        status, at, at, at, latest ? 1 : 0, domain, checks, at,
        scan.verdict, JSON.stringify(scan), scan.scannedAt, scan.toolsHash, scan.toolsChanged ? at : null),
  );
  await db.batch(stmts);
  await db.prepare("UPDATE registry_publish_log SET ok = 1 WHERE id = (SELECT MAX(id) FROM registry_publish_log WHERE ip_hash = ?)").bind(ipHash).run();
  return serverVersion(db, server.name, server.version);
}

/** POST /v0.1/validate: the schema checks only. Nothing is fetched or stored. */
export function validate(raw: string) {
  let s: unknown;
  try { s = JSON.parse(raw); } catch { return { valid: false, errors: ["body must be your server.json, as JSON"] }; }
  if (isObj(s) && isObj(s.server) && !("name" in s)) s = s.server;
  const errors = validateServer(s);
  const name = isObj(s) && typeof s.name === "string" ? s.name : "";
  const domain = name ? domainOf(name) : null;
  return {
    valid: !errors.length, errors,
    ...(domain ? { ownership_file: `https://${domain}${PROOF_PATH}`, ownership_line: name } : {}),
  };
}

/**
 * Re-reads one server's ownership file and applies the owner's word: a line ending in
 * "deprecated" or "deleted" sets that status on every version, and a file that no longer
 * lists the server (a clean 200 without the name, or 404/410) takes it off the list.
 * Network trouble changes nothing. Anyone may ask for a recheck; only the owner's file decides.
 */
export async function recheck(db: D1Database, name: string, fetcher: Fetcher, now = new Date(), force = false, keys: ScanKeys = {}) {
  const row = await db.prepare(`SELECT version, source, domain, status, last_checked_at, server_json, scan_verdict, tools_hash
      FROM registry_servers WHERE name = ? AND is_latest = 1`).bind(name)
    .first<{ version: string; source: string; domain: string; status: string; last_checked_at: string | null; server_json: string; scan_verdict: string | null; tools_hash: string | null }>();
  if (!row) throw new RegistryError(404, `server ${name} not found`);
  if (!force && row.last_checked_at && now.getTime() - Date.parse(row.last_checked_at) < 300_000)
    return { name, status: row.status, safety: row.scan_verdict, changed: false, note: "checked in the last 5 minutes; try again shortly" };
  const at = now.toISOString();
  let next: string | null = null;
  let message: string | null = null;
  let note: string | undefined;
  if (row.source === "operator") note = "ownership kept by the registry operator";
  else {
    const proof = await readProof(fetcher, row.domain, name);
    if (proof.listed) next = proof.status ?? "active";
    else if (proof.ok || proof.http === 404 || proof.http === 410) { next = "deleted"; message = "the owner's file no longer lists this server"; }
    if (proof.error && !proof.listed) note = proof.error;
  }
  const changed = next !== null && next !== row.status;
  const statusNow = changed ? next! : row.status;

  // Safety scan of the latest version. A scan that could not read the tools never clears a flag.
  let safety = row.scan_verdict;
  if (statusNow !== "deleted") {
    const scan = await scanServer(fetcher, JSON.parse(row.server_json), row.domain, row.tools_hash, now, keys);
    if (row.scan_verdict === "flagged" && scan.verdict === "partial") {
      await db.prepare("UPDATE registry_servers SET scanned_at = ? WHERE name = ? AND version = ?").bind(at, name, row.version).run();
    } else {
      safety = scan.verdict;
      await db.prepare(`UPDATE registry_servers SET scan_verdict = ?, scan_json = ?, scanned_at = ?, tools_hash = COALESCE(?, tools_hash),
          tools_changed_at = CASE WHEN ? = 1 THEN ? ELSE tools_changed_at END WHERE name = ? AND version = ?`)
        .bind(scan.verdict, JSON.stringify(scan), at, scan.toolsHash, scan.toolsChanged ? 1 : 0, at, name, row.version).run();
    }
  }
  if (changed)
    await db.prepare("UPDATE registry_servers SET status = ?, status_message = ?, status_changed_at = ?, updated_at = ?, last_checked_at = ? WHERE name = ?")
      .bind(next, message, at, at, at, name).run();
  else await db.prepare("UPDATE registry_servers SET last_checked_at = ? WHERE name = ?").bind(at, name).run();
  return { name, status: statusNow, safety, changed, ...(note ? { note } : {}) };
}

/** Admin takedown or restore (x-admin-key). */
export async function adminStatus(db: D1Database, b: Record<string, unknown>, now = new Date()) {
  const name = String(b.name ?? "");
  const status = String(b.status ?? "");
  if (!["active", "deprecated", "deleted"].includes(status)) throw new RegistryError(400, "status must be active, deprecated or deleted");
  const at = now.toISOString();
  const r = await db.prepare("UPDATE registry_servers SET status = ?, status_message = ?, status_changed_at = ?, updated_at = ? WHERE name = ?")
    .bind(status, b.statusMessage ? String(b.statusMessage).slice(0, 300) : null, at, at, name).run();
  if (!r.meta.changes) throw new RegistryError(404, `server ${name} not found`);
  return { name, status, versions: r.meta.changes };
}

/** Cron: recheck ownership and rescan the servers checked longest ago (the operator's own included), and drop submission logs older than two days. */
export async function registrySweep(db: D1Database, fetcher: Fetcher, now = new Date(), keys: ScanKeys = {}) {
  const due = (await db
    .prepare(`SELECT name FROM registry_servers WHERE is_latest = 1 AND status != 'deleted'
              ORDER BY COALESCE(last_checked_at, '') LIMIT ?`)
    .bind(LIMITS.sweep_batch).all<{ name: string }>()).results ?? [];
  for (const d of due) await recheck(db, d.name, fetcher, now, true, keys).catch((e) => console.error("registry recheck", d.name, e));
  await db.prepare("DELETE FROM registry_publish_log WHERE created_at < ?").bind(new Date(now.getTime() - 2 * 86_400_000).toISOString()).run();
  return { rechecked: due.length };
}

/** Names of listed servers, for the sitemap. */
export async function listedNames(db: D1Database, max = 5000) {
  return (await db
    .prepare(`SELECT name, updated_at FROM registry_servers WHERE is_latest = 1 AND ${VISIBLE} ORDER BY featured DESC, name LIMIT ?`)
    .bind(max).all<{ name: string; updated_at: string }>()).results ?? [];
}
