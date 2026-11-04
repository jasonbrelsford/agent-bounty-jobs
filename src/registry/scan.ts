/**
 * Safety scan for registry listings. Free sources; two optional free keys add more:
 *
 *   1. Tool poisoning: connect as an MCP client, read tools/list and prompts/list,
 *      and look for what poisoned tools use to steer an agent: hidden tags such as
 *      <IMPORTANT>, invisible or direction-flipping characters, "ignore previous
 *      instructions", "don't tell the user", paths to keys and config files,
 *      instructions to send data elsewhere, steering of other tools, encoded blobs.
 *      (The same family of checks as open-source scanners like mcp-scan.)
 *   2. Rug pulls: a hash of the tool definitions; a change between scans is
 *      recorded and the new definitions are scanned again.
 *   3. Domains: every host is looked up on Cloudflare's malware-blocking resolver
 *      (security.cloudflare-dns.com), which answers 0.0.0.0 for known malware and
 *      phishing hosts.
 *   4. Packages: npm, PyPI and NuGet packages are looked up on OSV.dev, which
 *      carries the OpenSSF malicious-package reports (MAL- ids) and known
 *      vulnerabilities.
 *
 *   5. With a free key: Google Safe Browsing (SAFE_BROWSING_KEY) checks each remote
 *      and website URL, and URLhaus (URLHAUS_AUTH_KEY) checks each host for
 *      malware URLs. Without the keys these two are listed as not checked.
 *
 * What it cannot see: the code behind a remote server. A server can pass every
 * check here and still misbehave when a tool is actually called.
 */

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type Severity = "high" | "medium" | "info";
export type Finding = { severity: Severity; where: string; what: string; snippet?: string };
export type Verdict = "passed" | "warning" | "flagged" | "partial";
export type Scan = {
  verdict: Verdict;
  scannedAt: string;
  toolCount: number | null;
  promptCount: number | null;
  toolsHash: string | null;
  toolsChanged: boolean;
  checked: string[];
  notChecked: string[];
  findings: Finding[];
  tools: { name: string; description: string }[];
};

export const SCAN = {
  timeout_ms: 8_000,
  max_bytes: 512 * 1024,
  max_tools: 300,
  max_findings: 25,
  long_description: 4_000,
  dns: "https://security.cloudflare-dns.com/dns-query",
  osv: "https://api.osv.dev/v1/query",
  safe_browsing: "https://safebrowsing.googleapis.com/v4/threatMatches:find",
  urlhaus: "https://urlhaus-api.abuse.ch/v1/host/",
} as const;

/** Optional free keys, from Worker secrets. Each one adds a check; none is required. */
export type ScanKeys = { safeBrowsing?: string; urlhaus?: string };

const UA = "bounty-mcp-registry-scan/1 (+https://bounty.brelsfordsoftware.com/registry)";

// ── text rules ──────────────────────────────────────────────────────────────

type Rule = { id: string; severity: Severity; re: RegExp; what: string };

export const RULES: Rule[] = [
  { id: "invisible", severity: "high", re: /[​-‏⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u, what: "hidden invisible characters (a common way to smuggle instructions)" },
  { id: "bidi", severity: "high", re: /[‪-‮⁦-⁩]/, what: "text-direction control characters that make text read differently than it is" },
  { id: "hidden-tag", severity: "high", re: /<\s*\/?\s*(important|system|secret|hidden|admin|instructions?)\b[^>]*>/i, what: "a hidden-instruction tag such as <IMPORTANT>" },
  { id: "ignore", severity: "high", re: /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|any|other|system|your)\b.{0,20}\b(instructions?|prompts?|rules?|guidelines?|messages?)\b/i, what: "an attempt to override the agent's instructions" },
  { id: "conceal", severity: "high", re: /\b(do not|don't|dont|never|without)\s+(\w+\s+){0,3}(tell|telling|inform|informing|mention|mentioning|notify|notifying|alert|alerting|reveal|revealing)\s+(\w+\s+){0,2}(the\s+)?(user|human|person|operator)\b/i, what: "an instruction to hide something from the user" },
  { id: "secret-paths", severity: "high", re: /(~\/\.ssh|\bid_rsa\b|\bid_ed25519\b|\.aws\/credentials|\bmcp\.json\b|claude_desktop_config|\.cursor\/|\/etc\/passwd|\/etc\/shadow|\.npmrc\b|\.netrc\b|\.git-credentials|\.kube\/config)/i, what: "a path to keys or app config files" },
  { id: "exfil", severity: "high", re: /\b(send|upload|forward|transmit|exfiltrate|post|copy|leak)\b.{0,50}\b(credentials?|passwords?|secrets?|private keys?|ssh keys?|api keys?|tokens?|cookies|conversation|chat history|previous messages)\b.{0,50}\b(to|into)\b.{0,30}(https?:\/\/|@[a-z0-9-]+\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|ru|top)\b)/i, what: "an instruction to send private data somewhere else" },
  { id: "read-secrets", severity: "medium", re: /\b(read|collect|gather|extract|harvest|dump|grab)\b.{0,40}\b(credentials|passwords?|secrets|private keys?|ssh keys?|cookies|seed phrases?|recovery phrases?|environment variables|env vars)\b/i, what: "asks for local secrets to be read" },
  { id: "role", severity: "medium", re: /(\byou are now\b|\bnew instructions\b|\bsystem prompt\b|<\|im_start\|>|\[INST\]|\bdeveloper mode\b|\bjailbreak\b)/i, what: "prompt-injection wording" },
  { id: "shadow", severity: "medium", re: /\b(when(ever)?|before|after|instead of)\b.{0,30}\b(the )?(user|agent|assistant|you)\b.{0,15}\b(calls?|uses?|invokes?|runs?)\b.{0,30}\b(any|another|other|the|a)\b.{0,15}\b(tools?|functions?|servers?)\b/i, what: "tries to change how other tools are used" },
  { id: "must-call", severity: "medium", re: /\b(always|must)\b.{0,20}\b(call|use|run|invoke)\b.{0,10}\bthis tool\b.{0,20}\b(first|before)\b/i, what: "insists it is called before anything else" },
  { id: "send-url", severity: "medium", re: /\b(send|post|upload|forward|transmit)\b.{0,60}https?:\/\/[^\s"')]+/i, what: "tells the agent to send something to a web address" },
  { id: "encoded", severity: "medium", re: /[A-Za-z0-9+/]{160,}={0,2}/, what: "a long encoded blob" },
];

const snip = (s: string, i: number) => {
  const t = s.slice(Math.max(0, i - 40), i + 80).replace(/[\u0000-\u001F\u007F]/g, " ");
  // Make invisible characters visible in the report.
  return t.replace(/[​-‏⁠-⁤﻿‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/gu, (c) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`).slice(0, 160);
};

export function scanText(where: string, text: string): Finding[] {
  const out: Finding[] = [];
  if (!text) return out;
  for (const r of RULES) {
    const m = r.re.exec(text);
    if (m) out.push({ severity: r.severity, where, what: r.what, snippet: snip(text, m.index) });
  }
  if (text.length > SCAN.long_description) out.push({ severity: "info", where, what: `a very long description (${text.length} characters)` });
  return out;
}

/** Every human-readable string in a JSON Schema: titles, descriptions, enum values, defaults, property names. */
function schemaText(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || out.length > 2000) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => schemaText(x, out, depth + 1));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      schemaText(x, out, depth + 1);
    }
  return out;
}

type Tool = { name?: unknown; title?: unknown; description?: unknown; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown };
type Prompt = { name?: unknown; title?: unknown; description?: unknown; arguments?: unknown };

export function scanTools(tools: Tool[], prompts: Prompt[] = []): Finding[] {
  const f: Finding[] = [];
  for (const t of tools) {
    const n = String(t.name ?? "?").slice(0, 80);
    f.push(...scanText(`tool ${n}`, [t.name, t.title, t.description].filter((x) => typeof x === "string").join("\n")));
    f.push(...scanText(`tool ${n} inputs`, schemaText([t.inputSchema, t.outputSchema, t.annotations]).join("\n")));
  }
  for (const p of prompts) {
    const n = String(p.name ?? "?").slice(0, 80);
    f.push(...scanText(`prompt ${n}`, [p.name, p.title, p.description, ...schemaText(p.arguments)].filter((x) => typeof x === "string").join("\n")));
  }
  return f;
}

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable fingerprint of what the agent is told: names, descriptions, schemas. */
export function toolsHash(tools: Tool[], prompts: Prompt[] = []) {
  const key = (x: { name?: unknown }) => String(x.name ?? "");
  const t = [...tools].sort((a, b) => key(a).localeCompare(key(b))).map((x) => [x.name, x.title ?? null, x.description ?? null, x.inputSchema ?? null]);
  const p = [...prompts].sort((a, b) => key(a).localeCompare(key(b))).map((x) => [x.name, x.description ?? null, x.arguments ?? null]);
  return sha(JSON.stringify([t, p]));
}

// ── MCP client (streamable HTTP) ────────────────────────────────────────────

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    out += dec.decode(value, { stream: true });
    if (n >= max) { await reader.cancel(); break; }
    // A JSON-RPC answer over SSE ends the useful part; stop instead of waiting on the stream.
    if (/\n\n/.test(out) && /"result"|"error"/.test(out) && res.headers.get("content-type")?.includes("event-stream")) { await reader.cancel(); break; }
  }
  return out;
}

function parseRpc(body: string, contentType: string | null, id: number): any {
  if (contentType?.includes("event-stream")) {
    for (const ev of body.split(/\r?\n\r?\n/)) {
      const data = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data) continue;
      try { const j = JSON.parse(data); if (j && j.id === id) return j; } catch { /* next event */ }
    }
    return null;
  }
  try {
    const j = JSON.parse(body);
    return Array.isArray(j) ? j.find((x) => x?.id === id) ?? null : j;
  } catch { return null; }
}

export type ToolRead = { ok: true; tools: Tool[]; prompts: Prompt[] } | { ok: false; reason: string; http?: number };

export async function readTools(fetcher: Fetcher, url: string): Promise<ToolRead> {
  let session: string | null = null;
  let version = "2025-06-18";
  let id = 0;
  const call = async (method: string, params?: unknown, notify = false) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": UA, "mcp-protocol-version": version };
    if (session) headers["mcp-session-id"] = session;
    const myId = notify ? undefined : ++id;
    const res = await fetcher(url, {
      method: "POST", redirect: "manual", headers, signal: AbortSignal.timeout(SCAN.timeout_ms),
      body: JSON.stringify({ jsonrpc: "2.0", ...(notify ? {} : { id: myId }), method, ...(params === undefined ? {} : { params }) }),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    if (notify) { await res.body?.cancel(); return { res, msg: null }; }
    const text = await readCapped(res, SCAN.max_bytes);
    return { res, msg: res.ok ? parseRpc(text, res.headers.get("content-type"), myId!) : null };
  };
  try {
    const init = await call("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "bounty-mcp-registry-scan", version: "1" } });
    if (init.res.status === 401 || init.res.status === 403) return { ok: false, reason: "the server needs a sign-in or key, so its tools could not be read", http: init.res.status };
    if (!init.msg?.result) return { ok: false, reason: `the server did not complete an MCP handshake (HTTP ${init.res.status})`, http: init.res.status };
    if (typeof init.msg.result.protocolVersion === "string") version = init.msg.result.protocolVersion;
    const caps = init.msg.result.capabilities ?? {};
    await call("notifications/initialized", undefined, true).catch(() => {});
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10 && tools.length < SCAN.max_tools; page++) {
      const r = await call("tools/list", cursor ? { cursor } : {});
      if (!r.msg?.result) {
        if (page === 0 && caps.tools === undefined) break; // no tools at all
        return { ok: false, reason: `tools/list failed (HTTP ${r.res.status})`, http: r.res.status };
      }
      tools.push(...(Array.isArray(r.msg.result.tools) ? r.msg.result.tools : []));
      cursor = typeof r.msg.result.nextCursor === "string" ? r.msg.result.nextCursor : undefined;
      if (!cursor) break;
    }
    const prompts: Prompt[] = [];
    if (caps.prompts !== undefined) {
      const r = await call("prompts/list", {}).catch(() => null);
      if (r?.msg?.result && Array.isArray(r.msg.result.prompts)) prompts.push(...r.msg.result.prompts.slice(0, SCAN.max_tools));
    }
    return { ok: true, tools: tools.slice(0, SCAN.max_tools), prompts };
  } catch (e) {
    return { ok: false, reason: `the server did not answer (${(e as Error).message || "network error"})` };
  }
}

// ── threat lists ────────────────────────────────────────────────────────────

/** Cloudflare's malware-blocking resolver answers 0.0.0.0 for hosts on its block list. */
export async function checkHost(fetcher: Fetcher, host: string): Promise<"clean" | "blocked" | "unknown"> {
  try {
    const res = await fetcher(`${SCAN.dns}?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: "application/dns-json", "user-agent": UA }, signal: AbortSignal.timeout(SCAN.timeout_ms),
    });
    if (!res.ok) { await res.body?.cancel(); return "unknown"; }
    const j = (await res.json()) as { Status?: number; Answer?: { type?: number; data?: string }[] };
    if ((j.Answer ?? []).some((a) => a.data === "0.0.0.0")) return "blocked";
    return typeof j.Status === "number" ? "clean" : "unknown";
  } catch { return "unknown"; }
}

/** Google Safe Browsing v4 Lookup: the URLs Google lists as malware, phishing or unwanted software. */
export async function checkSafeBrowsing(fetcher: Fetcher, key: string, urls: string[]): Promise<{ status: "checked"; matches: { url: string; type: string }[] } | { status: "unknown" }> {
  try {
    const res = await fetcher(`${SCAN.safe_browsing}?key=${encodeURIComponent(key)}`, {
      method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, signal: AbortSignal.timeout(SCAN.timeout_ms),
      body: JSON.stringify({
        client: { clientId: "bounty-mcp-registry", clientVersion: "1" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
          platformTypes: ["ANY_PLATFORM"], threatEntryTypes: ["URL"],
          threatEntries: urls.map((url) => ({ url })),
        },
      }),
    });
    if (!res.ok) { await res.body?.cancel(); return { status: "unknown" }; }
    const j = (await res.json()) as { matches?: { threatType?: string; threat?: { url?: string } }[] };
    return { status: "checked", matches: (j.matches ?? []).map((m) => ({ url: String(m.threat?.url ?? ""), type: String(m.threatType ?? "") })) };
  } catch { return { status: "unknown" }; }
}

/** URLhaus host lookup: malware download URLs abuse.ch has seen on this host, live now or in the past. */
export async function checkUrlhaus(fetcher: Fetcher, key: string, h: string): Promise<{ status: "clean" | "online" | "past"; count: number } | { status: "unknown" }> {
  try {
    const res = await fetcher(SCAN.urlhaus, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "auth-key": key, "user-agent": UA },
      signal: AbortSignal.timeout(SCAN.timeout_ms), body: `host=${encodeURIComponent(h)}`,
    });
    if (!res.ok) { await res.body?.cancel(); return { status: "unknown" }; }
    const j = (await res.json()) as { query_status?: string; urls?: { url_status?: string }[] };
    if (j.query_status === "no_results" || j.query_status === "invalid_host") return { status: "clean", count: 0 };
    if (j.query_status !== "ok") return { status: "unknown" };
    const u = j.urls ?? [];
    return { status: u.some((x) => x.url_status === "online") ? "online" : "past", count: u.length };
  } catch { return { status: "unknown" }; }
}

const OSV_ECOSYSTEM: Record<string, string> = { npm: "npm", pypi: "PyPI", nuget: "NuGet" };

/** OSV.dev: MAL- ids are reported malicious packages; others are known vulnerabilities. */
export async function checkPackage(fetcher: Fetcher, p: { registryType?: unknown; identifier?: unknown; version?: unknown }) {
  const eco = OSV_ECOSYSTEM[String(p.registryType)];
  if (!eco) return null;
  const name = String(p.identifier ?? "");
  try {
    const res = await fetcher(SCAN.osv, {
      method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, signal: AbortSignal.timeout(SCAN.timeout_ms),
      body: JSON.stringify({ package: { name, ecosystem: eco }, ...(typeof p.version === "string" && p.version ? { version: p.version } : {}) }),
    });
    if (!res.ok) { await res.body?.cancel(); return { name, eco, status: "unknown" as const, malicious: [], vulns: [] }; }
    const j = (await res.json()) as { vulns?: { id?: string; summary?: string }[] };
    const v = j.vulns ?? [];
    const malicious = v.filter((x) => String(x.id).startsWith("MAL-"));
    // Without a version, every vulnerability ever filed would match; only malware counts then.
    const vulns = typeof p.version === "string" && p.version ? v.filter((x) => !String(x.id).startsWith("MAL-")) : [];
    return { name, eco, status: "checked" as const, malicious, vulns };
  } catch {
    return { name, eco, status: "unknown" as const, malicious: [], vulns: [] };
  }
}

// ── the scan ────────────────────────────────────────────────────────────────

type ServerLike = {
  remotes?: { type?: unknown; url?: unknown }[]; packages?: { registryType?: unknown; identifier?: unknown; version?: unknown }[];
  websiteUrl?: unknown;
};

const host = (u: unknown) => { try { return new URL(String(u).replace(/\{[A-Za-z0-9_]+\}/g, "x")).hostname.toLowerCase(); } catch { return null; } };

export async function scanServer(fetcher: Fetcher, server: ServerLike, domain: string, prevHash: string | null, now = new Date(), keys: ScanKeys = {}): Promise<Scan> {
  const findings: Finding[] = [];
  const checked: string[] = [];
  const notChecked: string[] = [];
  let toolCount: number | null = null, promptCount: number | null = null, hash: string | null = null;
  let tools: { name: string; description: string }[] = [];
  let toolsRead = false;

  // 1 and 2: tool definitions.
  const remotes = (server.remotes ?? []).filter((r) => r.type === "streamable-http" && typeof r.url === "string" && !String(r.url).includes("{"));
  for (const r of remotes.slice(0, 3)) {
    const t = await readTools(fetcher, String(r.url));
    if (!t.ok) { notChecked.push(`tools at ${r.url}: ${t.reason}`); continue; }
    toolsRead = true;
    toolCount = (toolCount ?? 0) + t.tools.length;
    promptCount = (promptCount ?? 0) + t.prompts.length;
    findings.push(...scanTools(t.tools, t.prompts));
    hash = await toolsHash(t.tools, t.prompts);
    tools = t.tools.slice(0, 100).map((x) => ({ name: String(x.name ?? "").slice(0, 80), description: String(x.description ?? "").slice(0, 200) }));
    checked.push(`${t.tools.length} tools and ${t.prompts.length} prompts at ${r.url}`);
    break; // one live endpoint is enough; the rest serve the same server
  }
  if (!remotes.length && (server.remotes ?? []).length) notChecked.push("tools: only templated or legacy SSE remotes, which the scanner does not connect to");
  if (!(server.remotes ?? []).length) notChecked.push("tools: package-only server; its tools appear only once installed");
  const changed = !!(hash && prevHash && hash !== prevHash);
  if (changed) findings.push({ severity: "info", where: "tools", what: "tool definitions changed since the last scan; the new ones were scanned" });

  // 3: hosts.
  const hosts = new Set<string>([domain]);
  for (const r of server.remotes ?? []) { const h = host(r.url); if (h) hosts.add(h); }
  const w = host(server.websiteUrl); if (w) hosts.add(w);
  const unknownHosts: string[] = [];
  for (const h of [...hosts].slice(0, 6)) {
    const s = await checkHost(fetcher, h);
    if (s === "blocked") findings.push({ severity: "high", where: h, what: "this host is on Cloudflare's malware and phishing block list" });
    else if (s === "unknown") unknownHosts.push(h);
  }
  if (hosts.size - unknownHosts.length > 0) checked.push(`${hosts.size - unknownHosts.length} hosts against Cloudflare's malware block list`);
  if (unknownHosts.length) notChecked.push(`block-list lookup did not answer for ${unknownHosts.join(", ")}`);

  // 5: optional keyed lists.
  const hostList = [...hosts].slice(0, 6);
  if (keys.safeBrowsing) {
    const urls = new Set<string>(hostList.map((h) => `https://${h}/`));
    for (const r of server.remotes ?? []) if (typeof r.url === "string" && !r.url.includes("{")) urls.add(r.url);
    if (typeof server.websiteUrl === "string") urls.add(server.websiteUrl);
    const sb = await checkSafeBrowsing(fetcher, keys.safeBrowsing, [...urls].slice(0, 20));
    if (sb.status === "unknown") notChecked.push("Google Safe Browsing did not answer");
    else {
      checked.push(`${urls.size} URLs on Google Safe Browsing`);
      for (const m of sb.matches.slice(0, 5)) findings.push({ severity: "high", where: m.url, what: `Google Safe Browsing lists this as ${m.type.toLowerCase().replace(/_/g, " ")}` });
    }
  } else notChecked.push("Google Safe Browsing: no key set");
  if (keys.urlhaus) {
    let n = 0;
    for (const h of hostList) {
      const u = await checkUrlhaus(fetcher, keys.urlhaus, h);
      if (u.status === "unknown") { notChecked.push(`URLhaus did not answer for ${h}`); continue; }
      n++;
      if (u.status === "online") findings.push({ severity: "high", where: h, what: `URLhaus lists live malware downloads on this host (${u.count} URL${u.count === 1 ? "" : "s"} seen)` });
      else if (u.status === "past") findings.push({ severity: "medium", where: h, what: `URLhaus saw malware downloads on this host before, none live now (${u.count} URL${u.count === 1 ? "" : "s"})` });
    }
    if (n) checked.push(`${n} hosts on URLhaus`);
  } else notChecked.push("URLhaus: no key set");

  // 4: packages.
  for (const p of (server.packages ?? []).slice(0, 10)) {
    const r = await checkPackage(fetcher, p);
    if (!r) { notChecked.push(`${String(p.registryType)} package ${String(p.identifier)}: no free malware database for this kind`); continue; }
    if (r.status === "unknown") { notChecked.push(`${r.eco} package ${r.name}: OSV.dev did not answer`); continue; }
    checked.push(`${r.eco} package ${r.name} on OSV.dev`);
    for (const m of r.malicious.slice(0, 3)) findings.push({ severity: "high", where: `${r.eco} ${r.name}`, what: `reported as a malicious package (${m.id})` });
    if (r.vulns.length) findings.push({ severity: "medium", where: `${r.eco} ${r.name}`, what: `${r.vulns.length} known vulnerabilit${r.vulns.length === 1 ? "y" : "ies"} in this version (${r.vulns.slice(0, 3).map((v) => v.id).join(", ")})` });
  }

  const sev = (s: Severity) => findings.some((f) => f.severity === s);
  const verdict: Verdict = sev("high") ? "flagged" : sev("medium") ? "warning" : !toolsRead && (server.remotes ?? []).length ? "partial" : "passed";
  const order = { high: 0, medium: 1, info: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    verdict, scannedAt: now.toISOString(), toolCount, promptCount, toolsHash: hash, toolsChanged: changed,
    checked, notChecked, findings: findings.slice(0, SCAN.max_findings), tools,
  };
}

/** One line for a person. */
export function verdictLabel(v: string | null | undefined): string {
  switch (v) {
    case "passed": return "safety scan passed";
    case "warning": return "safety scan: worth a look";
    case "flagged": return "failed the safety scan";
    case "partial": return "partly scanned";
    default: return "not scanned yet";
  }
}
