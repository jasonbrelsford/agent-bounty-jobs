/**
 * Site-wide look: warm paper, near-black ink, wide display headlines, small
 * mono labels and square hairline grids. Every HTML page keeps its own CSS for
 * layout; this sheet is injected after it (see themeResponse) so it restyles
 * the shared elements without each renderer having to change.
 *
 * Only static strings go into the page. The active nav link is chosen from a
 * fixed list by path, never from request text.
 */

const FONTS =
  `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
  `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,500..900&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap">`;

const DISPLAY = `"Archivo","Arial Black",system-ui,sans-serif`;
const MONO = `"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;
const SANS = `"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`;

export const THEME_CSS = `
:root{color-scheme:light;
--bx-paper:#f3f2ee;--bx-paper-2:#eae8e2;--bx-card:rgba(255,255,255,.55);--bx-ink:#0b0b0c;--bx-ink-2:#2c2c2f;--bx-mut:#6b6a66;
--bx-line:rgba(11,11,12,.13);--bx-line-2:rgba(11,11,12,.32);--bx-grid:rgba(11,11,12,.035);--bx-acc:#1f56d6;
--bx-blue:#2f6bf0;--bx-red:#e5533d;--bx-violet:#7b5cf0;--bx-amber:#e3a23a;--bx-green:#1f9d55;--bx-pink:#e0438f;
--bg:var(--bx-paper);--panel:var(--bx-card);--fg:var(--bx-ink-2);--hi:var(--bx-ink);--mut:var(--bx-mut);--line:var(--bx-line);--acc:var(--bx-ink);--warn:var(--bx-amber)}
html{overflow-x:clip;background:var(--bx-paper)}
body{margin-top:0;padding-top:0;color:var(--bx-ink-2);font-family:${SANS};-webkit-font-smoothing:antialiased;counter-reset:bxs;
background-color:var(--bx-paper);background-image:linear-gradient(var(--bx-grid) 1px,transparent 1px),linear-gradient(90deg,var(--bx-grid) 1px,transparent 1px);background-size:56px 56px}
::selection{background:var(--bx-ink);color:var(--bx-paper)}
.wrap{padding-top:3rem}
h1,h2,h3{color:var(--bx-ink)}
h1{font-family:${DISPLAY};font-stretch:125%;font-weight:800;font-size:clamp(2rem,5vw,3.25rem);line-height:1.02;letter-spacing:-.015em;margin:.25rem 0 1rem;text-wrap:balance}
h2{font-family:${DISPLAY};font-stretch:112%;font-weight:750;font-size:1.4rem;line-height:1.15;letter-spacing:-.005em;margin:3.25rem 0 .9rem;padding-top:1rem;border-top:1px solid var(--bx-line);counter-increment:bxs;text-wrap:balance}
h2::before{content:counter(bxs,decimal-leading-zero) " /";display:block;font:500 .7rem/1 ${MONO};letter-spacing:.16em;color:var(--bx-mut);margin-bottom:.7rem}
h3{font-family:${SANS};font-weight:650;letter-spacing:-.005em}
a{color:var(--bx-ink);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;text-decoration-color:var(--bx-line-2)}
a:hover{color:var(--bx-acc);text-decoration-color:currentColor}
.mut,.meta,.lede,.crumb,.why,th,.lf-foot{color:var(--bx-mut)}
.lede{font-size:1.1rem;line-height:1.55}
.crumb{font:500 .72rem/1.4 ${MONO};letter-spacing:.12em;text-transform:uppercase}
code{font-family:${MONO};font-size:.84em;background:rgba(11,11,12,.06);border:0;border-radius:0;padding:.08rem .32rem;color:var(--bx-ink)}
pre{font-family:${MONO};font-size:.82rem;line-height:1.55;background:#111113;color:#e9e7e1;border:1px solid var(--bx-ink);border-radius:0;padding:1.1rem 1.2rem}
pre code{background:none;color:inherit;padding:0}
table{border-collapse:collapse;border-top:1px solid var(--bx-line-2)}
th{font:600 .68rem/1.3 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:var(--bx-mut);border-bottom:1px solid var(--bx-line-2)}
td{border-bottom:1px solid var(--bx-line)}
tr:hover td{background:rgba(255,255,255,.4)}
hr{border:0;border-top:1px solid var(--bx-line)}
header{border-bottom:0}
footer{border-top:1px solid var(--bx-line-2);color:var(--bx-mut)}

/* Cells: square, hairline, shared borders where they sit in a grid. */
.card,.srv,.tile,.step,.lead,.lead-stats div{border-radius:0;border:1px solid var(--bx-line);background:var(--bx-card);box-shadow:none}
.card{transition:border-color .15s,background .15s}.card:hover{border-color:var(--bx-line-2);background:rgba(255,255,255,.8)}
.srv.feat{border-color:var(--bx-ink);background:rgba(255,255,255,.75)}
.cards,.tiles,.lead-stats{gap:0;border-top:1px solid var(--bx-line);border-left:1px solid var(--bx-line)}
.cards>.card,.tiles>.tile,.lead-stats>div{border-top:0;border-left:0;margin:0}
.tile,.lead-stats div{padding:1.1rem 1.15rem}
.tile b,.lead-stats b,.card>b,.cd{font-family:${DISPLAY};font-stretch:115%;font-weight:800;font-size:1.9rem;line-height:1.1;color:var(--bx-ink);letter-spacing:-.01em}
.tile span,.lead-stats span{display:block;margin-top:.35rem;font:500 .66rem/1.35 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:var(--bx-mut)}
.card h3{font-family:${DISPLAY};font-stretch:112%;font-weight:750;font-size:1.08rem}
.card p{color:var(--bx-ink-2)}
.lead{padding:1.6rem 1.6rem 1.3rem;margin:2rem 0;background:rgba(255,255,255,.6);border-color:var(--bx-line-2)}
.lead h2{border-top:0;padding-top:0;margin-top:0;font-size:1.55rem}
.lead h3{font:600 .7rem/1.3 ${MONO};letter-spacing:.14em;text-transform:uppercase;color:var(--bx-ink);margin:1.5rem 0 .5rem}
.lead-results li{border-bottom:1px solid var(--bx-line)}

/* Labels: square mono chips. */
.tag,.flag,.kind,.beta,.lead-tag,.chip{border-radius:0;font:600 .64rem/1.5 ${MONO};letter-spacing:.1em;text-transform:uppercase;padding:.1rem .45rem;border:1px solid var(--bx-line-2);color:var(--bx-ink-2);background:transparent}
.beta{background:var(--bx-ink);color:var(--bx-paper);border-color:var(--bx-ink);vertical-align:.6em;margin-left:.7rem;font-size:.6rem}
.flag.warn{background:var(--bx-amber);color:var(--bx-ink);border-color:var(--bx-amber)}
.flag.ok,.tag.ok,.lead-tag{color:var(--bx-green);border-color:currentColor}
.tag.warn{color:#9a5a00;border-color:currentColor}.tag.bad{color:#b3261e;border-color:currentColor}

/* Buttons: square, mono, ink or outline. */
.btn,a.btn,button,input[type=submit]{display:inline-flex;align-items:center;gap:.5rem;border-radius:0;font:600 .72rem/1 ${MONO};letter-spacing:.12em;text-transform:uppercase;padding:.85rem 1.15rem;background:var(--bx-ink);color:var(--bx-paper);border:1px solid var(--bx-ink);text-decoration:none;cursor:pointer;transition:background .15s,color .15s}
.btn:hover,a.btn:hover,button:hover,input[type=submit]:hover{background:#2a2a2e;color:#fff}
.btn~.btn,.btn.sec,.btn.alt,.btn.ghost,button.ghost,button.link,button.danger{background:transparent;color:var(--bx-ink);border-color:var(--bx-line-2)}
.btn~.btn:hover,.btn.sec:hover,.btn.alt:hover,.btn.ghost:hover,button.ghost:hover,button.link:hover{background:var(--bx-ink);color:var(--bx-paper);border-color:var(--bx-ink)}
button.danger{color:#b3261e}button.danger:hover{background:#b3261e;color:#fff;border-color:#b3261e}
button[disabled]{opacity:.45;cursor:not-allowed}
input[type=text],input[type=search],input[type=url],input[type=email],input[type=number],input:not([type]),textarea,select{border-radius:0;border:1px solid var(--bx-line-2);background:#fff;color:var(--bx-ink);font-family:inherit}
textarea{font-family:${MONO}}
input:focus,textarea:focus,select:focus{outline:2px solid var(--bx-ink);outline-offset:-1px}
label{color:var(--bx-ink)}

/* Notices. */
div.warn,div.err,div.ok,.note{border-radius:0;color:var(--bx-ink);border:1px solid var(--bx-line);border-left:3px solid var(--bx-amber);background:rgba(227,162,58,.1)}
div.err{border-left-color:var(--bx-red);background:rgba(229,83,61,.08)}
div.ok,.note.good{border-left-color:var(--bx-green);background:rgba(31,157,85,.08)}
.kv dt{color:var(--bx-mut);font:600 .7rem/1.6 ${MONO};letter-spacing:.1em;text-transform:uppercase}
svg{border-radius:0}

/* The live terminal panel stays dark on purpose: it is the one screen on the page. */
.lf{border-radius:0;border-color:var(--bx-ink);box-shadow:0 1px 0 var(--bx-ink)}

/* Site bar. */
.bx-nav{position:sticky;top:0;z-index:50;display:flex;align-items:stretch;height:3rem;width:100vw;margin:0 calc(50% - 50vw) 0;background:rgba(243,242,238,.86);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-bottom:1px solid var(--bx-line-2);font:500 .7rem/1 ${MONO};letter-spacing:.14em;text-transform:uppercase}
.bx-nav a{color:var(--bx-ink-2);text-decoration:none;display:flex;align-items:center}
.bx-brand{gap:.6rem;padding:0 1.1rem;border-right:1px solid var(--bx-line-2);font:800 .92rem/1 ${DISPLAY};font-stretch:125%;letter-spacing:.02em;color:var(--bx-ink)!important}
.bx-mark{width:1.35rem;height:1.35rem;flex:none}
.bx-links{display:flex;align-items:center;gap:.2rem;padding:0 .8rem;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0}
.bx-links::-webkit-scrollbar{display:none}
.bx-links a{padding:.42rem .55rem;white-space:nowrap}
.bx-links a:hover{color:var(--bx-ink);background:rgba(11,11,12,.06)}
.bx-links a[aria-current=page]{background:var(--bx-ink);color:var(--bx-paper)}
.bx-cta{padding:0 1.3rem;background:var(--bx-ink);color:var(--bx-paper)!important;font-weight:600;white-space:nowrap}
.bx-cta:hover{background:#2a2a2e}
@media (max-width:40rem){.bx-brand span{display:none}.bx-cta{padding:0 .9rem}}

/* Home hero. */
.bx-hero{padding:3.5rem 0 2.5rem;text-align:center}
.bx-eyebrow{font:500 .7rem/1.4 ${MONO};letter-spacing:.16em;text-transform:uppercase;color:var(--bx-mut);margin:0 0 1.4rem}
.bx-word{font-family:${DISPLAY};font-stretch:125%;font-weight:900;font-size:clamp(2.6rem,9vw,6.6rem);line-height:.92;letter-spacing:-.02em;color:var(--bx-ink);margin:0;text-transform:uppercase}
.bx-word .beta{font-size:.62rem;vertical-align:top;margin-left:.4rem;letter-spacing:.12em}
.bx-tag{font-family:${DISPLAY};font-stretch:112%;font-weight:750;font-size:clamp(1.25rem,2.6vw,1.9rem);line-height:1.15;color:var(--bx-ink);margin:1.4rem auto .8rem;max-width:40rem}
.bx-hero .lede{max-width:34rem;margin:0 auto 1.8rem}
.bx-ctas{display:flex;flex-wrap:wrap;gap:.6rem;justify-content:center}
.bx-ctas .btn~.btn{background:transparent}
.bx-facts{margin:1.6rem 0 0;font:500 .66rem/1.8 ${MONO};letter-spacing:.14em;text-transform:uppercase;color:var(--bx-mut)}
.bx-lineup{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));border-top:1px solid var(--bx-line);border-left:1px solid var(--bx-line);margin:1rem 0 2rem}
.bx-item{display:flex;flex-direction:column;gap:.55rem;padding:1.15rem 1.2rem 1.25rem;border-right:1px solid var(--bx-line);border-bottom:1px solid var(--bx-line);background:var(--bx-card);text-decoration:none!important;color:var(--bx-ink-2)!important;transition:background .15s}
.bx-item:hover{background:rgba(255,255,255,.85)}
.bx-item-top{display:flex;justify-content:space-between;align-items:center;font:500 .64rem/1 ${MONO};letter-spacing:.14em;text-transform:uppercase;color:var(--bx-mut)}
.bx-num{display:inline-block;padding:.32rem .45rem;color:#fff;font-weight:600}
.bx-item h3{margin:.4rem 0 0;font-family:${DISPLAY};font-stretch:118%;font-weight:800;font-size:1.3rem;line-height:1.1;color:var(--bx-ink)}
.bx-item p{margin:0;font-size:.93rem;line-height:1.5}
.bx-go{margin-top:auto;padding-top:.6rem;font:600 .66rem/1 ${MONO};letter-spacing:.14em;text-transform:uppercase;color:var(--bx-ink)}
.bx-c1{background:var(--bx-blue)}.bx-c2{background:var(--bx-red)}.bx-c3{background:var(--bx-violet)}.bx-c4{background:var(--bx-amber)}.bx-c5{background:var(--bx-green)}.bx-c6{background:var(--bx-pink)}
@media (prefers-reduced-motion:reduce){.card,.bx-item,.btn{transition:none}}
`;

const MARK = `<svg class="bx-mark" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" fill="#0b0b0c"/><path d="M6 5h7.2c2.6 0 4.3 1.4 4.3 3.6 0 1.4-.8 2.5-2 3 1.6.4 2.6 1.6 2.6 3.3 0 2.5-1.9 4.1-4.8 4.1H6z" fill="#f3f2ee"/><path d="M9.6 8.1v2.6h2.9c.9 0 1.4-.5 1.4-1.3s-.5-1.3-1.4-1.3zm0 5.4v2.9h3.3c1 0 1.6-.6 1.6-1.45s-.6-1.45-1.6-1.45z" fill="#0b0b0c"/></svg>`;

const LINKS: Array<[string, string, (p: string) => boolean]> = [
  ["/", "Board", (p) => p === "/" || p.startsWith("/bounties/")],
  ["/science", "Science", (p) => p.startsWith("/science")],
  ["/arena", "Arena", (p) => p.startsWith("/arena")],
  ["/guides", "Guides", (p) => p.startsWith("/guides")],
  ["/registry", "MCP registry", (p) => p.startsWith("/registry")],
  ["/jobs", "My jobs", (p) => p === "/jobs" || p.startsWith("/my-jobs") || p === "/profile"],
];

export function siteNav(path: string): string {
  const links = LINKS.map(([href, label, on]) =>
    `<a href="${href}"${on(path) ? ` aria-current="page"` : ""}>${label}</a>`).join("");
  return `<nav class="bx-nav" aria-label="Site"><a class="bx-brand" href="/" aria-label="Agent Bounty Jobs home">${MARK}<span>BOUNTY</span></a>` +
    `<div class="bx-links">${links}</div><a class="bx-cta" href="/post">Post a job</a></nav>`;
}

/** Add the fonts, the theme sheet and the site bar to one HTML document. */
export function themeHtml(html: string, path: string): string {
  if (html.includes(`class="bx-nav"`)) return html;
  const head = `${FONTS}<style>${THEME_CSS}</style>`;
  let out: string;
  if (html.includes("</head>")) out = html.replace("</head>", `${head}</head>`);
  else {
    // Head-less documents: after their own last stylesheet, so the theme still wins.
    const at = html.lastIndexOf("</style>");
    out = at >= 0 ? html.slice(0, at + 8) + head + html.slice(at + 8) : html.replace(/<meta charset="utf-8">/i, (m) => `${m}${head}`);
  }
  const nav = siteNav(path);
  const body = out.match(/<body[^>]*>/i);
  if (body) out = out.replace(body[0], `${body[0]}${nav}`);
  return out;
}

/** Theme a Response if it is a full HTML page; everything else passes through untouched. */
export async function themeResponse(res: Response, path: string): Promise<Response> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("text/html") || !res.body || res.status === 204 || res.status === 304) return res;
  const html = await res.text();
  if (!/^\s*<!doctype html>/i.test(html)) return new Response(html, res);
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(themeHtml(html, path), { status: res.status, statusText: res.statusText, headers });
}
