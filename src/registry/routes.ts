import {
  listServers, serverVersions, serverVersion, publish, validate, recheck, adminStatus, RegistryError, LIMITS, PROOF_PATH, SCHEMA_URL,
} from "./registry.js";
import { registryPage, registryServerPage } from "./page.js";

/**
 * Routing for the MCP server registry. The read API sits at /registry/v0.1 and
 * /registry/v0 (and at /v0.1, /v0 for clients that only take a host), in the
 * official MCP Registry's format. Pages: /registry and /registry/servers/{name}.
 */

type RegEnv = { DB: D1Database; ADMIN_KEY?: string; SAFE_BROWSING_KEY?: string; URLHAUS_AUTH_KEY?: string };
const scanKeys = (env: RegEnv) => ({ safeBrowsing: env.SAFE_BROWSING_KEY || undefined, urlhaus: env.URLHAUS_AUTH_KEY || undefined });
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-admin-key",
};

const json = (o: unknown, status = 200, cache = false) =>
  new Response(JSON.stringify(o, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(cache ? { "cache-control": "public, max-age=60" } : { "cache-control": "no-store" }),
      ...CORS,
    },
  });

const problem = (e: RegistryError) =>
  new Response(JSON.stringify({ title: e.message, status: e.status, detail: e.message, ...(e.errors.length ? { errors: e.errors } : {}) }, null, 2), {
    status: e.status,
    headers: { "content-type": "application/problem+json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });

// In-isolate burst guard for the endpoints that fetch other sites. The real,
// shared limits for publishing are counted in D1 (see registry.ts).
const burst = new Map<string, { m: number; n: number }>();
function guard(ip: string, now = Date.now()) {
  const m = Math.floor(now / 60_000);
  const b = burst.get(ip);
  if (!b || b.m !== m) { if (burst.size > 5000) burst.clear(); burst.set(ip, { m, n: 1 }); return; }
  if (++b.n > 20) throw new RegistryError(429, "slow down: at most 20 registry writes a minute");
}

async function text(request: Request): Promise<string> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > LIMITS.body_bytes) throw new RegistryError(413, `body too large (${LIMITS.body_bytes} bytes max)`);
  const t = await request.text();
  if (t.length > LIMITS.body_bytes) throw new RegistryError(413, `body too large (${LIMITS.body_bytes} bytes max)`);
  return t;
}

/** "/servers/com.example%2Fweather/versions/1.0" or the same with a plain slash. */
export function parseServerPath(rest: string): { name: string; tail: string[] } | null {
  const segs = rest.split("/").filter((s) => s !== "");
  if (!segs.length) return null;
  let first: string, second: string;
  try { first = decodeURIComponent(segs[0]); } catch { return null; }
  if (first.includes("/")) return { name: first, tail: segs.slice(1) };
  if (segs.length < 2) return null;
  try { second = decodeURIComponent(segs[1]); } catch { return null; }
  return { name: `${first}/${second}`, tail: segs.slice(2) };
}

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export async function registryRoutes(request: Request, url: URL, env: RegEnv, fetcher: Fetcher = fetch): Promise<Response | null> {
  const p = url.pathname.replace(/\/$/, "") || "/";
  const method = request.method;

  if (p === "/registry" && method === "GET") return registryPage(env.DB, url);
  const pm = p.match(/^\/registry\/servers\/(.+)$/);
  if (pm && method === "GET") {
    const sp = parseServerPath(pm[1]);
    if (!sp || sp.tail.length) return new Response("not found", { status: 404 });
    return registryServerPage(env.DB, sp.name);
  }

  const am = p.match(/^(?:\/registry)?\/v0(?:\.1)?(\/.*)?$/);
  if (!am) return null;
  const rest = am[1] ?? "";
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  try {
    if ((rest === "" || rest === "/") && method === "GET")
      return json({
        service: "Bounty MCP server registry",
        about: "A free, open registry of MCP servers in the official MCP Registry format. Any maker can list theirs; checks are automatic.",
        browse: `${url.origin}/registry`,
        endpoints: {
          "GET  /registry/v0.1/servers": "?search= (3+ chars, name, title or description) &version=latest|<exact> &limit=1-100 &cursor=<metadata.nextCursor> &updated_since=<RFC3339> &include_deleted=true",
          "GET  /registry/v0.1/servers/{name}/versions": "all versions of one server (URL-encode the slash: com.example%2Fweather)",
          "GET  /registry/v0.1/servers/{name}/versions/{version}": "one version; 'latest' works",
          "POST /registry/v0.1/validate": "body: your server.json — schema checks only, nothing fetched or stored",
          "POST /registry/v0.1/publish": "body: your server.json — list it for free once ownership and remotes check out",
          "POST /registry/v0.1/recheck": "{name} — re-read the owner's file now (at most once every 5 minutes)",
        },
        how_to_list: [
          "Name your server after a domain you own, reversed: com.example/weather for example.com, io.github.you/tool for you.github.io.",
          `Put a plain text file at https://<that domain>${PROOF_PATH} with the line <your server name> (or <namespace>/* for all).`,
          "Every remote URL must be public https and answer an MCP initialize (an auth error such as 401 is fine).",
          "POST your server.json to /registry/v0.1/publish. New version: bump version and publish again; listed versions never change.",
          "To remove one: end its line with 'deprecated' or 'deleted', or remove the line, then POST /registry/v0.1/recheck.",
        ],
        limits: { per_sender_per_hour: LIMITS.per_ip_hour, per_sender_per_day: LIMITS.per_ip_day, per_domain_per_day: LIMITS.per_domain_day },
        schema: SCHEMA_URL,
      }, 200, true);
    if ((rest === "/health" || rest === "/ping") && method === "GET") return json({ status: "ok" });

    if (rest === "/servers" && method === "GET") {
      const s = url.searchParams;
      return json(await listServers(env.DB, {
        cursor: s.get("cursor"), limit: s.get("limit"), search: s.get("search"), version: s.get("version"),
        updated_since: s.get("updated_since"), include_deleted: s.get("include_deleted"),
      }), 200, true);
    }
    const sm = rest.match(/^\/servers\/(.+)$/);
    if (sm && method === "GET") {
      const sp = parseServerPath(sm[1]);
      if (!sp) throw new RegistryError(404, "no such server path");
      const del = url.searchParams.get("include_deleted") === "true";
      if (!sp.tail.length) return json(await serverVersion(env.DB, sp.name, "latest", del), 200, true);
      if (sp.tail.length === 1 && sp.tail[0] === "versions") return json(await serverVersions(env.DB, sp.name, del), 200, true);
      if (sp.tail.length === 2 && sp.tail[0] === "versions") return json(await serverVersion(env.DB, sp.name, decode(sp.tail[1]), del), 200, true);
      throw new RegistryError(404, "no such server path");
    }

    if (rest === "/validate" && method === "POST") { guard(ip); return json(validate(await text(request))); }
    if (rest === "/publish" && method === "POST") {
      guard(ip);
      return json(await publish(env.DB, await text(request), { ip, fetcher, keys: scanKeys(env) }), 201);
    }
    if (rest === "/recheck" && method === "POST") {
      guard(ip);
      let b: unknown;
      try { b = JSON.parse(await text(request)); } catch { throw new RegistryError(400, 'body must be {"name": "<server name>"}'); }
      const name = b && typeof b === "object" ? (b as Record<string, unknown>).name : null;
      if (typeof name !== "string" || !name) throw new RegistryError(400, 'body must be {"name": "<server name>"}');
      return json(await recheck(env.DB, name, fetcher, new Date(), false, scanKeys(env)));
    }
    if (rest === "/admin/status" && method === "POST") {
      const given = request.headers.get("x-admin-key");
      if (!env.ADMIN_KEY || !given || given !== env.ADMIN_KEY) throw new RegistryError(403, "admin key required");
      let b: unknown;
      try { b = JSON.parse(await text(request)); } catch { throw new RegistryError(400, "body must be JSON"); }
      return json(await adminStatus(env.DB, (b ?? {}) as Record<string, unknown>));
    }
    throw new RegistryError(404, `no registry route ${method} ${p} — see GET ${url.origin}/registry/v0.1`);
  } catch (e) {
    if (e instanceof RegistryError) return problem(e);
    console.error("registry", e);
    return problem(new RegistryError(500, "internal error"));
  }
}
