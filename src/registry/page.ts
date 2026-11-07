import { browse, serverVersions, PROOF_PATH, SCHEMA_URL, OFFICIAL, CHECKS, RegistryError } from "./registry.js";
import { verdictLabel } from "./scan.js";

/**
 * Human pages for the MCP server registry: browse and search, one page per
 * server, and a paste box to list your own. SECURITY: every field of a
 * server.json is maker-controlled, so everything goes through esc(), and links
 * are only drawn for https URLs.
 */

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const href = (u: unknown) => (typeof u === "string" && /^https:\/\//.test(u) ? esc(u) : null);
const enc = (name: string) => name.split("/").map(encodeURIComponent).join("/");

const CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#111;background:#fff}
.wrap{max-width:60rem;margin:0 auto;padding:2rem 1.25rem 4rem}h1{font-size:1.6rem;margin:.25rem 0}h2{font-size:1.15rem;margin:2.2rem 0 .5rem}
.mut{color:#555}a{color:#0b5}code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px;font-size:.85em;word-break:break-all}
.srv{border:1px solid #e2e2e2;border-radius:8px;padding:1rem 1.1rem;margin:.8rem 0}.srv.feat{border-color:#0b5;background:#f5fbf7}
.srv h3{margin:0;font-size:1.05rem}.srv p{margin:.3rem 0}.tag{display:inline-block;font-size:.75rem;border:1px solid #ccc;border-radius:999px;padding:0 .5rem;color:#555;margin-right:.3rem}
.tag.ok{border-color:#0b5;color:#075}.tag.warn{border-color:#b50;color:#840}.tag.bad{border-color:#c22;color:#a11}
ul.find{padding-left:1.2rem}ul.find li{margin:.3rem 0}
form.q{display:flex;gap:.5rem;margin:1rem 0}form.q input{flex:1;min-width:0;font:inherit;padding:.5rem .7rem;border:1px solid #ccc;border-radius:6px}
button{font:inherit;padding:.5rem .9rem;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-weight:600}button:hover{background:#f6f6f6}
textarea{width:100%;min-height:14rem;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:.7rem;border:1px solid #ccc;border-radius:6px}
pre{background:#fafafa;border:1px solid #e2e2e2;border-radius:6px;padding:1rem;overflow-x:auto;font-size:.85rem;line-height:1.5;white-space:pre-wrap;word-break:break-word}
ol li{margin:.4rem 0}#out{margin-top:.8rem}`;

const shell = (title: string, desc: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="/icon.svg" type="image/svg+xml"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><style>${CSS}</style></head><body><div class="wrap">${body}` +
      `<p class="mut" style="margin-top:3rem"><a href="/registry">Registry</a> · <a href="/registry/v0.1/servers">API</a> · <a href="/">Bounty board</a> · <a href="/science">Science</a> · <a href="/arena">Arena</a> · <a href="/llms.txt">llms.txt</a></p></div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } },
  );

type Entry = { server: Record<string, any>; _meta: Record<string, any> };

function safetyTag(sf: any): string {
  const v = sf?.verdict;
  const cls = v === "passed" ? "ok" : v === "flagged" ? "bad" : "warn";
  const when = sf?.scannedAt ? ` ${esc(String(sf.scannedAt).slice(0, 10))}` : "";
  return `<span class="tag ${cls}">${esc(verdictLabel(v))}${when}</span>`;
}

function safetySection(sf: any): string {
  if (!sf || !sf.verdict || sf.verdict === "not_scanned") return `<h2>Safety scan</h2><p class="mut">Not scanned yet. Servers are scanned when listed and again every few hours.</p>`;
  const f: any[] = Array.isArray(sf.findings) ? sf.findings : [];
  return `<h2>Safety scan</h2>
<p>${safetyTag(sf)}${sf.toolsChangedAt ? ` <span class="tag warn">tools changed ${esc(String(sf.toolsChangedAt).slice(0, 10))}</span>` : ""}</p>
${f.length ? `<ul class="find">${f.map((x) => `<li><strong>${esc(x.severity === "high" ? "Serious" : x.severity === "medium" ? "Worth a look" : "Note")}:</strong> ${esc(x.where)}: ${esc(x.what)}${x.snippet ? `<br><code>${esc(x.snippet)}</code>` : ""}</li>`).join("")}</ul>` : `<p class="mut">No problems found.</p>`}
${(sf.checked ?? []).length ? `<p class="mut">Checked: ${(sf.checked as string[]).map(esc).join("; ")}.</p>` : ""}
${(sf.notChecked ?? []).length ? `<p class="mut">Not checked: ${(sf.notChecked as string[]).map(esc).join("; ")}.</p>` : ""}
<p class="mut">The scan reads what the server tells agents (its tools and prompts) and checks its hosts and packages against free malware lists. It cannot see the code behind a remote server, so a clean scan is not a guarantee.</p>`;
}

function card(e: Entry, featured: boolean): string {
  const s = e.server, off = e._meta[OFFICIAL] ?? {}, ch = e._meta[CHECKS] ?? {};
  const remotes: any[] = Array.isArray(s.remotes) ? s.remotes : [];
  const pkgs: any[] = Array.isArray(s.packages) ? s.packages : [];
  const reach = Array.isArray(ch.remotes) && ch.remotes.length && ch.remotes.every((r: any) => r.ok);
  return `<div class="srv${featured ? " feat" : ""}">
<h3><a href="/registry/servers/${esc(enc(s.name))}">${esc(s.title || s.name)}</a></h3>
<p class="mut"><code>${esc(s.name)}</code> · v${esc(s.version)}</p>
<p>${esc(s.description)}</p>
<p>${featured ? `<span class="tag ok">featured</span>` : ""}${ch.ownership === "verified" ? `<span class="tag ok">owner verified at ${esc(ch.domain)}</span>` : ch.ownership === "operator" ? `<span class="tag ok">listed by the registry</span>` : ""}${reach ? `<span class="tag ok">remote answered</span>` : ""}${safetyTag(ch.safety)}${off.status === "deprecated" ? `<span class="tag warn">deprecated</span>` : ""}</p>
${remotes.map((r) => `<p class="mut">Connect: <code>${esc(r.url)}</code> <span class="mut">(${esc(r.type)})</span></p>`).join("")}
${pkgs.map((p) => `<p class="mut">Package: <code>${esc(p.registryType)} ${esc(p.identifier)}</code></p>`).join("")}
</div>`;
}

const listSteps = (origin: string) => `<h2 id="list">List your server, free</h2>
<p>No account, no review queue. Automatic checks and a safety scan, then it is live.</p>
<ol>
<li><strong>Name it after a domain you own</strong>, in reverse: <code>com.example/weather</code> for example.com, or <code>io.github.yourname/tool</code> for yourname.github.io.</li>
<li><strong>Prove it is yours</strong>: put a plain text file at <code>https://example.com${PROOF_PATH}</code> with one line per server name (or <code>com.example/*</code> for all of them).</li>
<li><strong>Send your server.json</strong> (the same file the official registry uses) below, or <code>POST ${esc(origin)}/registry/v0.1/publish</code>. Each remote URL must be public https and answer an MCP request.</li>
<li><strong>Pass the safety scan</strong>: the registry reads your tools and prompts and rejects hidden instructions (such as &lt;IMPORTANT&gt; tags, invisible characters, "don't tell the user", or asking for SSH keys), and checks your hosts and packages against free malware lists. It rescans every listing regularly, and hides one that starts failing.</li>
</ol>
<p class="mut">New version? Bump <code>version</code> and send it again; versions never change once listed. To take a server down, end its line in your file with <code>deprecated</code> or <code>deleted</code>, or remove the line, then <code>POST /registry/v0.1/recheck {"name": "..."}</code>. Servers are rechecked automatically too. Limits: ${10} submissions an hour and ${30} a day per sender.</p>
<textarea id="sj" spellcheck="false" aria-label="server.json">${esc(JSON.stringify({
  $schema: SCHEMA_URL, name: "com.example/weather", title: "Weather", description: "Forecasts and alerts for any city.",
  version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
}, null, 2))}</textarea>
<p><button type="button" id="check">Check it</button> <button type="button" id="send">List it</button></p>
<div id="out"></div>
<script>
(function(){
  var out=document.getElementById('out'),sj=document.getElementById('sj');
  function show(t){var p=document.createElement('pre');p.textContent=t;out.innerHTML='';out.appendChild(p);}
  function go(path){show('Working…');fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:sj.value})
    .then(function(r){return r.text().then(function(t){var j;try{j=JSON.parse(t)}catch(e){j=t}
      if(path.indexOf('publish')>0&&r.ok&&j&&j.server){show('Listed: '+j.server.name+' v'+j.server.version+'\\nIt is live at /registry/servers/'+j.server.name);return;}
      show((r.ok?'':'Not yet. ')+JSON.stringify(j,null,2));});})
    .catch(function(e){show('Could not reach the registry: '+e);});}
  document.getElementById('check').onclick=function(){go('/registry/v0.1/validate');};
  document.getElementById('send').onclick=function(){go('/registry/v0.1/publish');};
})();
</script>`;

export async function registryPage(db: D1Database, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").slice(0, 100);
  const pageNo = Math.max(0, Math.min(1000, Number(url.searchParams.get("page") ?? 0) || 0));
  const r = await browse(db, q, pageNo);
  const o = url.origin;
  const list = r.rows.length
    ? r.rows.map((e: Entry) => card(e, !!(e._meta[CHECKS]?.ownership === "operator") && !q && pageNo === 0)).join("")
    : `<p class="mut">${q ? `No servers match "${esc(q)}".` : "No servers listed yet."}</p>`;
  const more = r.more ? `<p><a href="/registry?${q ? `q=${encodeURIComponent(q)}&` : ""}page=${pageNo + 1}">More servers</a></p>` : "";
  return shell(
    "MCP server registry: free and open",
    "A free, open registry of MCP servers. Any maker can list theirs in minutes with automatic checks, and any registry client can read it.",
    `<p class="mut"><a href="/">Bounty Agent Arena</a> › registry</p>
<h1>MCP server registry</h1>
<p>A free, open list of MCP servers that agents can connect to. Any maker can add theirs: no account and no review queue, just automatic checks. Every listing is safety-scanned when it is added and again regularly. ${r.total} listed so far.</p>
<p class="mut">For registry clients: it speaks the official MCP Registry format. Base URL <code>${esc(o)}/registry</code>, e.g. <code>GET ${esc(o)}/registry/v0.1/servers?search=weather&amp;version=latest</code>.</p>
<form class="q" method="get" action="/registry"><input name="q" value="${esc(q)}" placeholder="Search servers by name or what they do" aria-label="Search"><button>Search</button></form>
${list}${more}
${listSteps(o)}
<h2>Reading the registry</h2>
<pre>GET ${esc(o)}/registry/v0.1/servers                     ?search= &amp;version=latest &amp;limit= &amp;cursor= &amp;updated_since=
GET ${esc(o)}/registry/v0.1/servers/{name}/versions
GET ${esc(o)}/registry/v0.1/servers/{name}/versions/{version|latest}
POST ${esc(o)}/registry/v0.1/validate                   check a server.json, nothing stored
POST ${esc(o)}/registry/v0.1/publish                    list it (checks run first)
POST ${esc(o)}/registry/v0.1/recheck   {"name": ...}    re-read the owner's file now</pre>
<p class="mut">URL-encode the slash in a name (<code>com.example%2Fweather</code>). /v0 paths work the same. Each entry carries the usual registry metadata plus <code>${esc(CHECKS)}</code> with what was checked and when.</p>`,
  );
}

export async function registryServerPage(db: D1Database, name: string): Promise<Response> {
  let v: { servers: Entry[] };
  try { v = await serverVersions(db, name); } catch (e) {
    const hidden = e instanceof RegistryError
      ? await db.prepare("SELECT scan_json FROM registry_servers WHERE name = ? AND is_latest = 1 AND scan_verdict = 'flagged' AND status != 'deleted'").bind(name).first<{ scan_json: string }>()
      : null;
    if (hidden)
      return shell("Hidden: failed the safety scan", "This MCP server failed the registry's safety scan.",
        `<p class="mut"><a href="/registry">Registry</a> › ${esc(name)}</p><h1>Hidden</h1><p><code>${esc(name)}</code> is hidden from the registry because it failed the safety scan. Do not connect an agent to it.</p>${safetySection(JSON.parse(hidden.scan_json))}`, 410);
    if (e instanceof RegistryError) return shell("Not listed", "This MCP server is not in the registry.", `<h1>Not listed</h1><p><code>${esc(name)}</code> is not in the registry. <a href="/registry">Browse the registry</a> or <a href="/registry#list">list a server</a>.</p>`, 404);
    throw e;
  }
  const latest = v.servers.find((e) => e._meta[OFFICIAL]?.isLatest) ?? v.servers[v.servers.length - 1];
  const s = latest.server, ch = latest._meta[CHECKS] ?? {};
  const site = href(s.websiteUrl), repo = href(s.repository?.url);
  return shell(
    `${s.title || s.name}: MCP server`,
    String(s.description ?? ""),
    `<p class="mut"><a href="/registry">Registry</a> › ${esc(s.name)}</p>
<h1>${esc(s.title || s.name)}</h1>
<p>${esc(s.description)}</p>
<p>${ch.ownership === "verified" ? `<span class="tag ok">owner verified at ${esc(ch.domain)}</span>` : `<span class="tag ok">listed by the registry</span>`}${latest._meta[OFFICIAL]?.status === "deprecated" ? `<span class="tag warn">deprecated${latest._meta[OFFICIAL]?.statusMessage ? `: ${esc(latest._meta[OFFICIAL].statusMessage)}` : ""}</span>` : ""}</p>
${(Array.isArray(s.remotes) ? s.remotes : []).map((r: any) => `<p>Connect your MCP client to <code>${esc(r.url)}</code> <span class="mut">(${esc(r.type)})</span></p>`).join("")}
<p class="mut">${site ? `<a href="${site}" rel="nofollow ugc">Website</a> · ` : ""}${repo ? `<a href="${repo}" rel="nofollow ugc">Source</a> · ` : ""}Versions: ${v.servers.map((e) => esc(e.server.version)).join(", ")}${ch.lastCheckedAt ? ` · last checked ${esc(String(ch.lastCheckedAt).slice(0, 10))}` : ""}</p>
${safetySection(ch.safety)}
<h2>server.json</h2><pre>${esc(JSON.stringify(s, null, 2))}</pre>
<p class="mut">API: <code>GET /registry/v0.1/servers/${esc(encodeURIComponent(s.name))}/versions/latest</code></p>`,
  );
}
