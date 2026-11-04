// Open MCP server registry: official read format, free self-listing with
// automatic checks (schema, ownership file, reachable remote), rate limits,
// owner-driven removal, and the board's own server listed first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeD1 } from "./d1shim.mjs";
import {
  listServers, serverVersions, serverVersion, publish, validate, validateServer, recheck, registrySweep, adminStatus,
  domainOf, publicHttpsUrl, compareVersions, BOUNTY_SERVER, OFFICIAL, CHECKS, LIMITS, PROOF_PATH, SCHEMA_URL,
} from "../.test-build/registry/registry.js";
import { registryRoutes, parseServerPath } from "../.test-build/registry/routes.js";
import { sitemapXml } from "../.test-build/sitemap.js";
import { routeLabel } from "../.test-build/livefeed.js";

const O = "https://bounty.example.com";
const BOUNTY = "com.brelsfordsoftware/agent-bounty-jobs";

const srv = (over = {}) => ({
  $schema: SCHEMA_URL, name: "com.acme/weather", title: "Weather", description: "Forecasts for any city.",
  version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://mcp.acme.com/mcp" }], ...over,
});

/** A pretend internet: url -> {status, body} or a function. Records calls. */
function net(map) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const hit = typeof map === "function" ? map(url, init) : map[url];
    if (!hit) throw new Error("getaddrinfo ENOTFOUND");
    return new Response(hit.body ?? "", { status: hit.status ?? 200 });
  };
  f.calls = calls;
  return f;
}
const owned = (lines = "com.acme/weather", extra = {}) =>
  net({ [`https://acme.com${PROOF_PATH}`]: { body: lines }, "https://mcp.acme.com/mcp": { status: 200, body: "{}" }, ...extra });

const rejects = async (p, status, re) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.status, status, `${e.status} ${e.message} ${JSON.stringify(e.errors)}`);
    if (re) assert.match(`${e.message} ${(e.errors ?? []).join(" ")}`, re);
    return true;
  });
};

test("the seeded entry is the board's own server.json, and comes back in the official format", async () => {
  assert.deepEqual(BOUNTY_SERVER, JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8")));
  const db = makeD1();
  const r = await listServers(db);
  assert.equal(r.metadata.count, 1);
  assert.deepEqual(r.servers[0].server, BOUNTY_SERVER);
  const m = r.servers[0]._meta[OFFICIAL];
  assert.equal(m.status, "active");
  assert.equal(m.isLatest, true);
  for (const k of ["publishedAt", "updatedAt", "statusChangedAt"]) assert.ok(!Number.isNaN(Date.parse(m[k])), k);
  assert.equal(r.servers[0]._meta[CHECKS].ownership, "operator");
  assert.deepEqual(validateServer(BOUNTY_SERVER), []);
});

test("names map to the domain that must hold the ownership file", () => {
  assert.equal(domainOf("com.acme/weather"), "acme.com");
  assert.equal(domainOf("io.github.alice/tool"), "alice.github.io");
  assert.equal(domainOf("com.acme.api/x"), "api.acme.com");
  assert.equal(domainOf("localhost/x"), null);
  assert.equal(domainOf("local.box/x"), null);
  assert.equal(domainOf("1.0.0.127/x"), null);
});

test("remote URLs must be public https on the default port", () => {
  assert.ok(publicHttpsUrl("https://mcp.acme.com/mcp"));
  assert.ok(publicHttpsUrl("https://mcp.acme.com/{tenant}/mcp"));
  for (const bad of ["http://mcp.acme.com/mcp", "https://127.0.0.1/mcp", "https://localhost/mcp", "https://mcp.acme.com:8443/mcp",
    "https://user:pw@mcp.acme.com/", "https://{host}.acme.com/mcp", "https://[::1]/mcp", "https://box.internal/mcp"])
    assert.equal(publicHttpsUrl(bad), null, bad);
});

test("schema checks name every problem and accept a good server.json", () => {
  assert.deepEqual(validateServer(srv()), []);
  const e = validateServer({ name: "nope", description: "", version: "latest", extra: 1, remotes: [{ type: "ws", url: "http://x" }] });
  const all = e.join(" | ");
  for (const re of [/unknown field "extra"/, /\$schema is required/, /reverse-DNS/, /description is required/, /version is required/, /remotes\[0\]\.type/, /remotes\[0\]\.url/])
    assert.match(all, re);
  assert.match(validateServer(srv({ remotes: [] })).join(), /at least one remote/);
  assert.deepEqual(validateServer(srv({ remotes: undefined, packages: [{ registryType: "npm", identifier: "@acme/weather", transport: { type: "stdio" } }] })), []);
  const v = validate(JSON.stringify(srv()));
  assert.equal(v.valid, true);
  assert.equal(v.ownership_file, `https://acme.com${PROOF_PATH}`);
  assert.equal(validate("{not json").valid, false);
});

test("a maker lists a server for free once the file and remote check out", async () => {
  const db = makeD1();
  const f = owned();
  const r = await publish(db, JSON.stringify(srv()), { ip: "1.2.3.4", fetcher: f });
  assert.equal(r.server.name, "com.acme/weather");
  assert.equal(r._meta[OFFICIAL].isLatest, true);
  assert.equal(r._meta[CHECKS].ownership, "verified");
  assert.equal(r._meta[CHECKS].remotes[0].ok, true);
  const init = f.calls.find((c) => c.url === "https://mcp.acme.com/mcp").init;
  assert.equal(init.method, "POST");
  assert.equal(JSON.parse(init.body).method, "initialize");
  assert.equal(init.redirect, "manual");
  // {server: {...}} as the list API returns it is accepted too.
  const r2 = await publish(db, JSON.stringify({ server: srv({ version: "1.1.0" }) }), { ip: "1.2.3.4", fetcher: owned() });
  assert.equal(r2.server.version, "1.1.0");
  const all = await listServers(db, { version: "latest" });
  assert.deepEqual(all.servers.map((x) => x.server.name), ["com.acme/weather", BOUNTY]);
  assert.equal(all.servers[0].server.version, "1.1.0");
});

test("ownership: missing file, unlisted name, redirect and wildcard", async () => {
  const db = makeD1();
  await rejects(publish(db, JSON.stringify(srv()), { ip: "a", fetcher: net({}) }), 403, /could not fetch.*\n?.*bounty-mcp-registry\.txt|bounty-mcp-registry\.txt/);
  await rejects(publish(db, JSON.stringify(srv()), { ip: "a", fetcher: owned("com.acme/other") }), 403, /does not list com\.acme\/weather/);
  await rejects(publish(db, JSON.stringify(srv()), { ip: "a", fetcher: net({ [`https://acme.com${PROOF_PATH}`]: { status: 301 } }) }), 403, /HTTP 301/);
  await rejects(publish(db, JSON.stringify(srv()), { ip: "a", fetcher: owned("com.acme/weather deleted") }), 403, /deleted/);
  const r = await publish(db, JSON.stringify(srv()), { ip: "a", fetcher: owned("# my servers\ncom.acme/*\n") });
  assert.equal(r.server.name, "com.acme/weather");
  // Nobody else can take over the board's own name.
  await rejects(publish(db, JSON.stringify({ ...BOUNTY_SERVER, version: "9.9.9" }), { ip: "a", fetcher: net(() => ({ body: BOUNTY })) }), 403, /operator/);
});

test("remotes must answer; an auth error still counts as reachable", async () => {
  const db = makeD1();
  await rejects(publish(db, JSON.stringify(srv()), { ip: "b", fetcher: owned(undefined, { "https://mcp.acme.com/mcp": { status: 502 } }) }), 422, /not reachable.*|HTTP 502/);
  await rejects(publish(db, JSON.stringify(srv()), { ip: "b", fetcher: owned(undefined, { "https://mcp.acme.com/mcp": undefined }) }), 422, /no answer/);
  await rejects(publish(db, JSON.stringify(srv()), { ip: "b", fetcher: owned(undefined, { "https://mcp.acme.com/mcp": { status: 307 } }) }), 422, /redirects/);
  const r = await publish(db, JSON.stringify(srv()), { ip: "b", fetcher: owned(undefined, { "https://mcp.acme.com/mcp": { status: 401 } }) });
  assert.equal(r._meta[CHECKS].remotes[0].http, 401);
});

test("versions never change, and latest follows semver", async () => {
  const db = makeD1();
  await publish(db, JSON.stringify(srv({ version: "2.0.0" })), { ip: "c", fetcher: owned() });
  await rejects(publish(db, JSON.stringify(srv({ version: "2.0.0", description: "Changed." })), { ip: "c", fetcher: owned() }), 409, /cannot change/);
  await publish(db, JSON.stringify(srv({ version: "1.5.0" })), { ip: "c", fetcher: owned() });
  assert.equal((await serverVersion(db, "com.acme/weather", "latest")).server.version, "2.0.0");
  const v = await serverVersions(db, "com.acme/weather");
  assert.deepEqual(v.servers.map((x) => [x.server.version, x._meta[OFFICIAL].isLatest]), [["2.0.0", true], ["1.5.0", false]]);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compareVersions("abc", "1.0.0"), null);
});

test("list: search, version filter, cursor paging, limits", async () => {
  const db = makeD1();
  for (const n of ["alpha", "bravo", "charlie"])
    await publish(db, JSON.stringify(srv({ name: `com.acme/${n}`, description: `The ${n} tool.` })), { ip: "d", fetcher: owned("com.acme/*") });
  const p1 = await listServers(db, { limit: 2 });
  assert.equal(p1.servers.length, 2);
  assert.equal(p1.metadata.nextCursor, "com.acme/bravo:1.0.0");
  const p2 = await listServers(db, { limit: 2, cursor: p1.metadata.nextCursor });
  assert.deepEqual(p2.servers.map((x) => x.server.name), ["com.acme/charlie", BOUNTY]);
  assert.equal(p2.metadata.nextCursor, undefined);
  assert.deepEqual((await listServers(db, { search: "brav" })).servers.map((x) => x.server.name), ["com.acme/bravo"]);
  assert.deepEqual((await listServers(db, { search: "planets" })).servers.map((x) => x.server.name), [BOUNTY]);
  assert.deepEqual((await listServers(db, { search: "100%_" })).servers, []);
  await rejects(listServers(db, { search: "ab" }), 400, /3 characters/);
  await rejects(listServers(db, { limit: 0 }), 400);
  await rejects(listServers(db, { limit: 101 }), 400);
  await rejects(listServers(db, { cursor: "garbage" }), 400);
  assert.equal((await listServers(db, { updated_since: "2030-01-01T00:00:00Z" })).metadata.count, 0);
});

test("submissions are rate-limited per sender, and senders are stored only as a hash", async () => {
  const db = makeD1();
  const bad = JSON.stringify({ name: "x" });
  for (let i = 0; i < LIMITS.per_ip_hour; i++) await rejects(publish(db, bad, { ip: "9.9.9.9", fetcher: net({}) }), 422);
  await rejects(publish(db, JSON.stringify(srv()), { ip: "9.9.9.9", fetcher: owned() }), 429, /this hour/);
  // Someone else is unaffected.
  await publish(db, JSON.stringify(srv()), { ip: "8.8.8.8", fetcher: owned() });
  const rows = db.raw.prepare("SELECT ip_hash FROM registry_publish_log").all();
  assert.ok(rows.length > LIMITS.per_ip_hour);
  assert.ok(rows.every((r) => !r.ip_hash.includes("9.9.9.9") && /^[0-9a-f]{32}$/.test(r.ip_hash)));
});

test("the owner's file decides removal: deprecated, deleted, or no longer listed", async () => {
  const db = makeD1();
  const t0 = new Date("2026-11-05T00:00:00Z");
  await publish(db, JSON.stringify(srv()), { ip: "e", fetcher: owned(), now: t0 });
  const later = (m) => new Date(t0.getTime() + m * 60_000);
  let r = await recheck(db, "com.acme/weather", owned("com.acme/weather deprecated"), later(1));
  assert.equal(r.changed, false, "too soon after the last check");
  r = await recheck(db, "com.acme/weather", owned("com.acme/weather deprecated"), later(10));
  assert.equal(r.status, "deprecated");
  assert.equal((await serverVersion(db, "com.acme/weather", "latest"))._meta[OFFICIAL].status, "deprecated");
  // Network trouble changes nothing.
  r = await recheck(db, "com.acme/weather", net({}), later(20));
  assert.equal(r.status, "deprecated");
  assert.equal(r.changed, false);
  // Line removed: off the list (still readable with include_deleted).
  r = await recheck(db, "com.acme/weather", owned("com.acme/other"), later(30));
  assert.equal(r.status, "deleted");
  assert.deepEqual((await listServers(db)).servers.map((x) => x.server.name), [BOUNTY]);
  assert.equal((await listServers(db, { include_deleted: "true" })).metadata.count, 2);
  await rejects(serverVersion(db, "com.acme/weather", "latest"), 404);
  // The board's own entry is never rechecked away.
  assert.equal((await recheck(db, BOUNTY, net({}))).note, "ownership kept by the registry operator");
  // The hourly sweep rechecks owner entries and clears old logs.
  await publish(db, JSON.stringify(srv({ name: "com.acme/radar" })), { ip: "e", fetcher: owned("com.acme/*"), now: t0 });
  const s = await registrySweep(db, owned(""), new Date(t0.getTime() + 3 * 86_400_000));
  assert.equal(s.rechecked, 2, "the owner entry and the board's own entry");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM registry_publish_log").get().n, 0);
  assert.equal((await adminStatus(db, { name: "com.acme/radar", status: "active" })).status, "active");
});

test("HTTP routes: official paths, encoded or plain slash, problem errors, CORS, pages", async () => {
  const db = makeD1();
  const env = { DB: db };
  const get = (path) => registryRoutes(new Request(O + path), new URL(O + path), env);
  for (const base of ["/registry/v0.1", "/registry/v0", "/v0.1"]) {
    const r = await get(`${base}/servers?version=latest`);
    assert.equal(r.status, 200, base);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal((await r.json()).servers[0].server.name, BOUNTY);
  }
  const enc = encodeURIComponent(BOUNTY);
  assert.equal((await (await get(`/registry/v0.1/servers/${enc}/versions/latest`)).json()).server.version, "0.2.0");
  assert.equal((await (await get(`/registry/v0.1/servers/${BOUNTY}/versions/0.2.0`)).json()).server.version, "0.2.0");
  assert.equal((await (await get(`/registry/v0.1/servers/${enc}/versions`)).json()).metadata.count, 1);
  const miss = await get("/registry/v0.1/servers/com.nobody%2Fx/versions/latest");
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get("content-type"), "application/problem+json; charset=utf-8");
  assert.equal((await get("/registry/v0.1")).status, 200);
  assert.equal(await get("/v1/bounties"), null, "other routes are left alone");
  assert.deepEqual(parseServerPath("com.acme%2Fversions/versions"), { name: "com.acme/versions", tail: ["versions"] });

  const page = await get("/registry");
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /MCP server registry/);
  assert.match(html, /class="srv feat"/);
  assert.match(html, /Bounty Agent Arena/);
  const detail = await get(`/registry/servers/${BOUNTY}`);
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /bounty\.brelsfordsoftware\.com\/mcp/);
  assert.equal((await get("/registry/servers/com.nobody/x")).status, 404);

  const post = (path, body) => registryRoutes(new Request(O + path, { method: "POST", body, headers: { "cf-connecting-ip": "5.5.5.5" } }), new URL(O + path), env, owned());
  const v = await post("/registry/v0.1/validate", JSON.stringify(srv()));
  assert.equal((await v.json()).valid, true);
  const pub = await post("/registry/v0.1/publish", JSON.stringify(srv()));
  assert.equal(pub.status, 201);
  const bad = await post("/registry/v0.1/publish", JSON.stringify({ name: "x" }));
  assert.equal(bad.status, 422);
  assert.ok((await bad.json()).errors.length > 2);
  assert.equal((await post("/registry/v0.1/admin/status", "{}")).status, 403);
});

test("maker text is escaped on the pages", async () => {
  const db = makeD1();
  await publish(db, JSON.stringify(srv({ title: "<script>alert(1)</script>", description: '"><img src=x onerror=1>' })), { ip: "f", fetcher: owned() });
  const html = await (await registryRoutes(new Request(O + "/registry"), new URL(O + "/registry"), { DB: db })).text();
  assert.ok(!html.includes("<script>alert(1)"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("sitemap lists the registry and its servers; the live panel counts registry reads", async () => {
  const db = makeD1();
  await publish(db, JSON.stringify(srv()), { ip: "g", fetcher: owned() });
  const xml = await sitemapXml(db, O);
  assert.ok(xml.includes(`<loc>${O}/registry</loc>`));
  assert.ok(xml.includes(`<loc>${O}/registry/servers/com.brelsfordsoftware/agent-bounty-jobs</loc>`));
  assert.ok(xml.includes(`<loc>${O}/registry/servers/com.acme/weather</loc>`));
  assert.equal(routeLabel("GET", "/registry/v0.1/servers"), "GET /registry/v0.1/servers");
  assert.equal(routeLabel("POST", "/registry/v0.1/publish"), "POST /registry/v0.1/publish");
});
