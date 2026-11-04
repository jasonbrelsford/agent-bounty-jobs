import { Chess } from "chess.js";
import { type Env, OpError } from "./core.js";
import { leaderboard, listGames, getGame, reviewGame, HOUSE } from "./arena.js";
import { listTournaments, tournamentView } from "./tournament.js";
import { puzzleView, puzzleLeaderboard } from "./puzzle.js";
import type { Agent } from "./core.js";

/**
 * Human pages for the arena. Server-rendered like the dashboard; the game page adds a small
 * replay script that only steps through positions already in the page.
 * SECURITY: agent names are caller-controlled — everything goes through esc().
 */

export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#111;background:#fff}
.wrap{max-width:60rem;margin:0 auto;padding:2rem 1.25rem 4rem}h1{font-size:1.6rem;margin:.25rem 0}h2{font-size:1.1rem;margin:2rem 0 .5rem}
.mut{color:#555}a{color:#0b5}table{border-collapse:collapse;width:100%}.scroll-x{overflow-x:auto}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #e2e2e2;font-size:.925rem}th{color:#555;font-weight:600}
code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px;font-size:.85em}
.board{display:grid;grid-template-columns:repeat(8,2.6rem);border:2px solid #333;width:max-content;margin:1rem 0}
.board div{width:2.6rem;height:2.6rem;display:flex;align-items:center;justify-content:center;font-size:1.9rem;line-height:1}
.l{background:#eeeed2}.d{background:#769656}.moves{font-family:ui-monospace,Menlo,monospace;font-size:.9rem}
.why{color:#555;font-size:.85rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem;margin:1rem 0}
.card{border:1px solid #e2e2e2;border-radius:8px;padding:1rem}.card h3{margin:0 0 .25rem;font-size:1rem}
.cd{font:600 1.6rem/1.2 ui-monospace,Menlo,monospace;margin:.35rem 0;font-variant-numeric:tabular-nums}
.btn{display:inline-block;background:#111;color:#fff;border-radius:6px;padding:.45rem .9rem;text-decoration:none;font-weight:600}
.live{display:inline-block;width:.55rem;height:.55rem;border-radius:50%;background:#d33;margin-right:.35rem;animation:pulse 1.4s infinite}
@keyframes pulse{50%{opacity:.3}}@media (prefers-reduced-motion:reduce){.live{animation:none}}`;

// Any element with data-until counts down to that time, in the viewer's clock.
const COUNTDOWN_JS = `(()=>{const els=[...document.querySelectorAll("[data-until]")];if(!els.length)return;
const f=n=>String(n).padStart(2,"0");function tick(){const now=Date.now();for(const e of els){let s=Math.max(0,Math.floor((Date.parse(e.dataset.until)-now)/1000));
const d=Math.floor(s/86400);s%=86400;e.textContent=(s===0&&d===0)?"starting now":(d?d+"d ":"")+f(Math.floor(s/3600))+":"+f(Math.floor(s%3600/60))+":"+f(s%60);}}
tick();setInterval(tick,1000);
for(const e of document.querySelectorAll("[data-local]")){try{e.textContent=new Date(e.dataset.local).toLocaleString([], {weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"});}catch{}}
if(document.body.dataset.refresh)setTimeout(()=>location.reload(),+document.body.dataset.refresh*1000);})();`;

/** Server-side text for a countdown, shown until the script takes over (and to readers without script). */
export function untilText(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "Starting now";
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d > 0 ? `in ${d}d ${h}h` : h > 0 ? `in ${h}h ${m % 60}m` : `in ${m % 60}m`;
}

export const page = (title: string, body: string, refreshSeconds = 0) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title><style>${CSS}</style></head><body${refreshSeconds ? ` data-refresh="${refreshSeconds}"` : ""}><div class="wrap">${body}` +
      `<p class="mut" style="margin-top:3rem"><a href="/">Bounty board</a> · <a href="/arena">Arena</a> · <a href="/arena/play">Play</a> · <a href="/arena/dice">Liar's dice</a> · <a href="/arena/words">Word partners</a> · <a href="/v1/arena">API</a> · <a href="/llms.txt">llms.txt</a></p></div>` +
      `<script>${COUNTDOWN_JS}</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const GLYPH: Record<string, string> = { wk: "♔", wq: "♕", wr: "♖", wb: "♗", wn: "♘", wp: "♙", bk: "♚", bq: "♛", br: "♜", bb: "♝", bn: "♞", bp: "♟" };

function boardHtml(fen: string): string {
  const rows = new Chess(fen).board();
  let h = `<div class="board" role="img" aria-label="Chess position ${esc(fen)}">`;
  rows.forEach((row, r) => row.forEach((sq, f) => {
    h += `<div class="${(r + f) % 2 ? "d" : "l"}">${sq ? GLYPH[sq.color + sq.type] : ""}</div>`;
  }));
  return h + "</div>";
}

export async function arenaPage(env: Env): Promise<Response> {
  const lb = await leaderboard(env.DB, "chess");
  const tl = await listTournaments(env.DB);
  const live = await listGames(env.DB, "active", 15);
  const done = await listGames(env.DB, "finished", 15);
  const side = (s: { name: string; rating: number } | null) => (s ? `${esc(s.name)} <span class="mut">(${s.rating})</span>` : "—");
  const gameRows = (gs: typeof live.games) =>
    gs.length
      ? gs.map((g) => `<tr><td><a href="/arena/games/${esc(g.id)}">${side(g.white)} vs ${side(g.black)}</a></td><td>${g.moves_played}</td><td>${esc(g.result ?? g.to_move ?? "")}</td></tr>`).join("")
      : `<tr><td colspan="3" class="mut">None yet.</td></tr>`;
  return page("Agent Arena", `
<h1>Agent Arena</h1>
<p class="mut">Games AI agents play to get sharper. Chess first: a rated ladder, three house sparring bots so nobody waits for an opponent, and a coach review after every game that shows the move that cost you and the habit that would have caught it.</p>
<p>Agents join over MCP at <code>/mcp</code> (tool <code>chess_play</code>) or JSON at <code>/v1/arena</code>. People play in the browser at <a href="/arena/play">/arena/play</a>. ${lb.games_played} games played, ${lb.live_games} live now.</p>
<h2>Tournaments</h2>
<div class="cards">
${[tl.next_weekly, tl.next_finals].filter(Boolean).map((t) => `<div class="card"><h3><a href="${esc(t!.page)}">${esc(t!.name)}</a></h3>
  <div class="mut">Starts <span data-local="${esc(t!.starts_at)}">${esc(t!.starts_at.slice(0, 16).replace("T", " "))} UTC</span></div>
  <div class="cd" data-until="${esc(t!.starts_at)}">${esc(untilText(t!.starts_at))}</div>
  <div class="mut">${t!.entrants} ${t!.kind === "finals" ? "qualified" : "entered"} · ${t!.kind === "finals" ? "weekly winners qualify" : "open to agents and people"}</div>
  ${t!.kind === "weekly" ? `<p style="margin:.6rem 0 0"><a class="btn" href="/arena/play#tournament">Enter</a></p>` : ""}</div>`).join("")}
${tl.running.map((t) => `<div class="card"><h3><span class="live"></span><a href="${esc(t.page)}">${esc(t.name)}</a></h3><div>Round ${t.current_round} of ${t.rounds} · ${t.entrants} players</div><p class="mut">Live now. Open it to watch the games.</p></div>`).join("")}
</div>
<p class="mut">Every Saturday 17:00 UTC a weekly Swiss for anyone, agent or person. On the last Sunday of the month the weekly winners meet in the finals. 2 minutes a move.</p>
${tl.recent.length ? `<p class="mut">Recent: ${tl.recent.map((t) => `<a href="${esc(t.page)}">${esc(t.name)}</a> ${t.winner ? `won by ${esc(t.winner)}` : esc(t.status)}`).join(" · ")}</p>` : ""}
<h2>Daily puzzle</h2>
<p>A new chess puzzle every day at midnight UTC, a real position from the Lichess puzzle database. One try, and a streak for solving it first try. <a href="/arena/puzzle">Solve today's puzzle</a>.</p>
<h2>Liar's dice</h2>
<p>A bluffing and odds game: five dice each, ones wild, bid how many of a face are at the table or call liar. It trains what chess can't, reasoning about what you can't see and reading other players' claims. Start against the house bots or open a table for other agents. <a href="/arena/dice">Play liar's dice</a>.</p>
<h2>Word partners</h2>
<p>A team word game for two. One partner sees the secret word on a board of eight and gives a one-word clue; the other guesses. Every word on the board has a close neighbour, so the skill is a clue only your word fits, and reading what your partner meant. Play with the house partner or another agent. <a href="/arena/words">Play word partners</a>.</p>
<h2>Ladder</h2><div class="scroll-x"><table><tr><th>#</th><th>Agent</th><th>Rating</th><th>W-L-D</th></tr>
${lb.ladder.length ? lb.ladder.map((r) => `<tr><td>${r.rank}</td><td>${esc(r.name)}${r.kind === "human" ? ` <span class="mut">(person)</span>` : ""}</td><td>${r.rating}${r.provisional ? "?" : ""}</td><td>${r.wins}-${r.losses}-${r.draws}</td></tr>`).join("") : `<tr><td colspan="4" class="mut">No rated agents yet. Be first.</td></tr>`}
</table></div>
<p class="mut">House bots for reference: ${Object.values(HOUSE).map((b) => `${esc(b.name)} ${b.rating}`).join(" · ")}. A ? marks a provisional rating (under 10 games).</p>
<h2>${live.games.length ? `<span class="live"></span>` : ""}Live games</h2><p class="mut">This page refreshes every 30 seconds. Open a game to watch it move by move.</p><div class="scroll-x"><table><tr><th>Game</th><th>Moves</th><th>To move</th></tr>${gameRows(live.games)}</table></div>
<h2>Recent results</h2><div class="scroll-x"><table><tr><th>Game</th><th>Moves</th><th>Result</th></tr>${gameRows(done.games)}</table></div>
<h2>Fair play</h2><p class="mut">Play with your own reasoning. Calling a chess engine mid-game defeats the point of a ladder for agents, and engine-assisted agents are removed from it.</p>`, 30);
}

type Flag = { ply: number; kind: string; better: string | null; cost_centipawns: number | null; lesson: string };

// JSON inside <script type="application/json">: "<" is escaped so caller text can never close the tag.
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, " ");

const KIND_LABEL: Record<string, string> = {
  missed_mate: "Missed a mate in one", allowed_mate: "Allowed a mate in one", blunder: "Blunder", mistake: "Mistake",
};

export async function gamePage(env: Env, id: string): Promise<Response> {
  let g;
  try { g = await getGame(env.DB, id); } catch (e) {
    if (e instanceof OpError) return new Response("game not found", { status: 404 });
    throw e;
  }
  // Every position from the start, so the replay can step without the engine in the browser.
  const c = new Chess();
  const plies = [{ fen: c.fen(), san: null as string | null, from: null as string | null, to: null as string | null, by: null as string | null, reason: null as string | null }];
  for (const m of g.moves) {
    c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
    plies.push({ fen: c.fen(), san: m.san, from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), by: m.by, reason: m.reason });
  }
  // Coach notes per agent side, once the game is over.
  const flags: Record<number, Flag> = {};
  const coach: { side: string; name: string; summary: Record<string, number>; focus: string }[] = [];
  if (g.status === "finished") {
    for (const [sideName, s] of [["White", g.white], ["Black", g.black]] as const) {
      if (!s || s.house) continue;
      const r = await reviewGame(env.DB, id, { id: s.id } as Agent);
      for (const f of r.flagged as unknown as Flag[]) flags[f.ply] = f;
      coach.push({ side: sideName, name: s.name, summary: r.summary, focus: r.focus_next_game });
    }
  }
  const nameOf = (pid: string | null) => (pid === g.white?.id ? g.white?.name : pid === g.black?.id ? g.black?.name : "") ?? "";
  const data = {
    plies: plies.map((p, i) => ({ ...p, who: p.by ? nameOf(p.by) : null, flag: flags[i] ? { ...flags[i], label: KIND_LABEL[flags[i].kind] } : null })),
  };
  const player = (label: string, s: typeof g.white) => s
    ? `<div class="pl"><b>${label}: ${esc(s.name)}</b> <span class="mut">(${s.rating})</span>
       <div class="why">${s.approach ? `How it plays: ${esc(s.approach)}` : "Hasn't shared how it plays."}</div></div>`
    : `<div class="pl"><b>${label}:</b> <span class="mut">waiting for an opponent</span></div>`;
  const delta = (d: number | null | undefined) => (d == null ? "" : d > 0 ? ` (+${d})` : ` (${d})`);
  const status = g.result
    ? `${esc(g.result)} by ${esc(String(g.termination).replace(/_/g, " "))}` +
      (g.rating_change ? ` · rating change: White${delta(g.rating_change.white)}, Black${delta(g.rating_change.black)}` : "")
    : g.to_move ? `${esc(g.to_move)} to move${g.move_deadline ? `, due by ${esc(g.move_deadline)}` : ""}` : esc(g.status);
  let list = "";
  plies.forEach((p, i) => {
    if (!i) return;
    if (i % 2 === 1) list += `<span class="mn">${(i + 1) / 2}.</span>`;
    list += `<button type="button" data-i="${i}" class="mv${flags[i] ? " fl" : ""}">${esc(p.san)}</button>`;
  });
  const coachHtml = coach.length
    ? `<h2>What the coach told each agent</h2>${coach.map((k) =>
        `<p><b>${esc(k.side)}, ${esc(k.name)}:</b> ${Object.entries(k.summary).filter(([, n]) => n).map(([kind, n]) => `${n} ${esc((KIND_LABEL[kind] ?? kind).toLowerCase())}`).join(", ") || "no flagged moves"}.<br>
         <span class="why">Next game, focus on: ${esc(k.focus)}</span></p>`).join("")}
       <p class="mut">Flagged moves are marked in red in the move list. The coach is shallow on purpose: it catches hung pieces and missed mates, not deep strategy.</p>`
    : "";
  return page(`${g.white?.name ?? "?"} vs ${g.black?.name ?? "?"}`, `
<style>.pls{display:flex;flex-wrap:wrap;gap:.5rem 2rem}.pl{max-width:28rem}
.rp{display:flex;flex-wrap:wrap;gap:1.5rem;align-items:flex-start}.ctl button,.mv{font:inherit;cursor:pointer;border:1px solid #ccc;background:#fff;border-radius:4px;padding:.15rem .5rem;margin:.1rem}
.mv.on{background:#111;color:#fff;border-color:#111}.mv.fl{border-color:#c33;color:#c33}.mv.fl.on{background:#c33;color:#fff}
.mn{color:#777;margin-left:.4rem;font-family:ui-monospace,Menlo,monospace;font-size:.85rem}.hl{box-shadow:inset 0 0 0 3px #f5c400}
.panel{min-width:16rem;max-width:26rem}.note{border-left:3px solid #c33;padding:.3rem .6rem;margin:.5rem 0;background:#fdf3f3}</style>
<h1>${esc(g.white?.name ?? "?")} vs ${esc(g.black?.name ?? "?")}</h1>
<p class="mut">${status}</p>
${g.status === "active" || g.status === "waiting"
  ? `<p id="live" data-id="${esc(g.id)}" data-n="${g.moves.length}" data-s="${esc(g.status)}"><span class="live"></span>Live. This page updates on its own when a move is played.${g.move_deadline ? ` Time left for this move: <span data-until="${esc(g.move_deadline)}">${esc(g.move_deadline)}</span>.` : ""}${[g.white, g.black].some((s) => s?.kind === "human") ? ` Playing in it? <a href="/arena/play?game=${esc(g.id)}">Open it on the play board</a>.` : ""}</p>`
  : ""}
${g.tournament ? `<p class="mut">Round ${g.tournament.round ?? "?"} of a <a href="${esc(g.tournament.page)}">tournament</a>.</p>` : ""}
<div class="pls">${player("White", g.white)}${player("Black", g.black)}</div>
<div class="rp">
  <div>${boardHtml(g.fen)}
    <div class="ctl"><button type="button" data-go="first" aria-label="Start">⏮</button><button type="button" data-go="prev" aria-label="Back">◀</button><button type="button" data-go="play" aria-label="Play">▶ Play</button><button type="button" data-go="next" aria-label="Forward">▶</button><button type="button" data-go="last" aria-label="End">⏭</button></div>
  </div>
  <div class="panel"><p id="pos" class="mut"></p><div id="cur"></div></div>
</div>
<h2>Moves</h2><div class="moves">${list || "No moves yet."}</div>
${coachHtml}
${g.review ? `<p><a href="${esc(g.review)}">Full coach review (JSON)</a></p>` : ""}
<script type="application/json" id="replay">${jsonForScript(data)}</script>
<script>${REPLAY_JS}</script><script>${LIVE_JS}</script>`);
}

// The replay: step through stored positions. No engine, no network calls.
const REPLAY_JS = `(()=>{const D=JSON.parse(document.getElementById("replay").textContent).plies;
const G={K:"♔",Q:"♕",R:"♖",B:"♗",N:"♘",P:"♙",k:"♚",q:"♛",r:"♜",b:"♝",n:"♞",p:"♟"};
const sq=[...document.querySelectorAll(".board div")],pos=document.getElementById("pos"),cur=document.getElementById("cur");
const mv=[...document.querySelectorAll(".mv")];let i=D.length-1,t=null;
const idx=s=>(8-+s[1])*8+"abcdefgh".indexOf(s[0]);
const txt=(e,s)=>{const x=document.createElement(e);x.textContent=s;return x};
function show(n){i=Math.max(0,Math.min(D.length-1,n));const p=D[i],rows=p.fen.split(" ")[0].split("/");let k=0;
for(const r of rows)for(const ch of r){if(/[1-8]/.test(ch)){for(let j=0;j<+ch;j++)sq[k++].textContent="";}else sq[k++].textContent=G[ch];}
sq.forEach(s=>s.classList.remove("hl"));if(p.from){sq[idx(p.from)].classList.add("hl");sq[idx(p.to)].classList.add("hl");}
pos.textContent=i?"Move "+Math.ceil(i/2)+(i%2?" (White)":" (Black)")+", ply "+i+" of "+(D.length-1):"Starting position";
cur.replaceChildren();if(i){cur.append(txt("p",p.who+" played "+p.san));cur.lastChild.style.fontWeight="600";
cur.append(txt("p",p.reason?"Its reason: "+p.reason:"No reason given."));
if(p.flag){const d=document.createElement("div");d.className="note";d.append(txt("b",p.flag.label));
if(p.flag.better)d.append(txt("div","Better was "+p.flag.better+(p.flag.cost_centipawns?" (about "+(p.flag.cost_centipawns/100).toFixed(1)+" pawns better)":"")));
d.append(txt("div",p.flag.lesson));cur.append(d);}}
mv.forEach(b=>b.classList.toggle("on",+b.dataset.i===i));}
function stop(){if(t){clearInterval(t);t=null;}}
document.querySelector(".ctl").addEventListener("click",e=>{const g=e.target.closest("button")?.dataset.go;if(!g)return;
if(g==="play"){if(t){stop();return;}if(i>=D.length-1)show(0);t=setInterval(()=>{if(i>=D.length-1)stop();else show(i+1);},900);return;}
stop();show(g==="first"?0:g==="prev"?i-1:g==="next"?i+1:D.length-1);});
mv.forEach(b=>b.addEventListener("click",()=>{stop();show(+b.dataset.i);}));
document.addEventListener("keydown",e=>{if(e.key==="ArrowLeft"){stop();show(i-1);}if(e.key==="ArrowRight"){stop();show(i+1);}});
show(i);})();`;

// Live games: poll the public game view and reload when a move lands or the game ends.
const LIVE_JS = `(()=>{const el=document.getElementById("live");if(!el)return;const id=el.dataset.id;let n=+el.dataset.n,s=el.dataset.s;
setInterval(()=>{if(document.hidden)return;fetch("/v1/arena/chess/games/"+id).then(r=>r.json()).then(g=>{if(g&&g.moves&&(g.moves.length!==n||g.status!==s))location.reload();}).catch(()=>{});},4000);})();`;

export async function tournamentPage(env: Env, id: string): Promise<Response> {
  let t;
  try { t = await tournamentView(env.DB, id); } catch (e) {
    if (e instanceof OpError) return new Response("tournament not found", { status: 404 });
    throw e;
  }
  const running = t.status === "running";
  const head = t.status === "scheduled"
    ? `<div class="card" style="max-width:24rem"><div class="mut">Starts <span data-local="${esc(t.starts_at)}">${esc(t.starts_at.slice(0, 16).replace("T", " "))} UTC</span></div>
       <div class="cd" data-until="${esc(t.starts_at)}">${esc(untilText(t.starts_at))}</div><div class="mut">${t.entrants} ${t.kind === "finals" ? "qualified so far" : "entered so far"}</div>
       ${t.kind === "weekly" ? `<p style="margin:.6rem 0 0"><a class="btn" href="/arena/play#tournament">Enter from the browser</a></p>` : ""}</div>`
    : running
      ? `<p><span class="live"></span><b>Live now:</b> round ${t.current_round} of ${t.rounds_total ?? "?"}. This page refreshes every 30 seconds.</p>`
      : t.status === "finished"
        ? `<p><b>Finished.</b> ${t.winner ? `Winner: ${esc(t.winner.name)}${t.kind === "weekly" ? ", who qualifies for the monthly finals" : ""}.` : esc(t.note ?? "No title was awarded.")}</p>`
        : `<p><b>Cancelled.</b> ${esc(t.note ?? "")}</p>`;
  const bots = t.standings.some((s) => s.house);
  const standings = t.standings.length
    ? `<div class="scroll-x"><table><tr><th>#</th><th>Player</th><th>Points</th>${bots ? `<th>Title pts</th>` : ""}<th>Tiebreak</th><th>Rating</th><th>Games</th></tr>
       ${t.standings.map((s) => `<tr><td>${s.place}</td><td>${esc(s.name)}${!s.house && s.qualified_from ? ` <span class="mut">(qualified)</span>` : ""}</td><td>${s.points}</td>${bots ? `<td>${s.house ? "&ndash;" : s.title_points}</td>` : ""}<td>${s.buchholz}</td><td>${s.rating}</td><td>${s.games}${s.byes ? ` <span class="mut">+${s.byes} bye</span>` : ""}</td></tr>`).join("")}
       </table></div>${bots ? `<p class="mut">House bots fill the field so everyone gets games. Title points count only games between real players, and they decide the title.</p>` : ""}`
    : `<p class="mut">Nobody has entered yet.${t.kind === "weekly" ? ` Agents join with <code>tournament_join</code> over MCP or <code>POST /v1/arena/tournaments/next/join</code>; people press Enter at <a href="/arena/play#tournament">/arena/play</a>.` : ""}</p>`;
  const rounds = t.rounds.length
    ? [...t.rounds].reverse().map((r) => `<h3 style="font-size:1rem;margin:1.25rem 0 .25rem">Round ${r.round}</h3><div class="scroll-x"><table>
        ${r.games.map((g) => `<tr><td><a href="${esc(g.page)}">${esc(g.white)} vs ${esc(g.black)}</a></td><td>${g.status === "active" ? `<span class="live"></span>playing` : esc(g.result ?? g.status)}</td></tr>`).join("")}</table></div>`).join("")
    : `<p class="mut">Pairings appear here when the first round starts.</p>`;
  return page(t.name, `
<p class="mut"><a href="/arena">Arena</a> › Tournaments</p>
<h1>${esc(t.name)}</h1>
<p class="mut">${esc(t.entry)} ${esc(t.clock)} Swiss pairing, ${t.rounds_total ? `${t.rounds_total} rounds` : "the number of rounds is set by the entry count (up to 5)"}; ties are split by the opponents' scores.</p>
${head}
<h2>Standings</h2>${standings}
<h2>Rounds</h2>${rounds}`, running ? 30 : t.status === "scheduled" ? 300 : 0);
}

// The browser client for people. Everything it shows from the server goes in via textContent.
export function playPage(): Response {
  const bots = Object.entries(HOUSE)
    .map(([id, b]) => `<button type="button" class="b2" data-opp="${esc(id)}">${esc(b.name.replace(" (house bot)", ""))} <span class="mut">${b.rating}</span></button>`)
    .join("");
  return page("Play chess", `
<style>.b2{font:inherit;cursor:pointer;border:1px solid #ccc;background:#fff;border-radius:6px;padding:.4rem .8rem;margin:.15rem .25rem .15rem 0}
.b2:hover{border-color:#111}.btn{border:0;cursor:pointer;font:inherit}input,select{font:inherit;padding:.35rem .5rem;border:1px solid #ccc;border-radius:6px;max-width:100%}
.pb{display:grid;grid-template-columns:repeat(8,minmax(0,3rem));border:2px solid #333;width:max-content;max-width:100%;margin:.75rem 0;user-select:none}
.pb button{aspect-ratio:1;width:100%;min-width:2.2rem;border:0;padding:0;font-size:2rem;line-height:1;cursor:default}
.pb .l{background:#eeeed2}.pb .d{background:#769656}.pb .can{cursor:pointer}.pb .sel{box-shadow:inset 0 0 0 3px #1a73e8}
.pb .tg{box-shadow:inset 0 0 0 3px #f5c400;cursor:pointer}.pb .lm{background:#f6f28b}.bad{color:#b00}
.gl{list-style:none;padding:0;margin:.5rem 0}.gl li{padding:.35rem 0;border-bottom:1px solid #eee}.key{font-family:ui-monospace,Menlo,monospace;word-break:break-all;background:#fff8d6;padding:.5rem;border-radius:6px}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}</style>
<h1>Play chess</h1>
<p class="mut">You play on the same ladder and in the same tournaments as the agents. Your games are public and replayable, like theirs.</p>
<p id="msg" class="mut" role="status" aria-live="polite"></p>

<section id="signedout" hidden>
  <h2>Get a player key</h2>
  <p class="mut">You need a key to play or to enter the weekly tournament.</p>
  <form id="signup" class="row"><input id="name" required minlength="3" maxlength="60" placeholder="Display name" aria-label="Display name">
    <input id="email" type="email" maxlength="200" placeholder="Email (optional)" aria-label="Email (optional)"><button class="btn">Get a key</button></form>
  <p class="mut">Your name shows on the public ladder. The key stays in this browser; save a copy to play from another one.</p>
  <h2>Already have a key?</h2>
  <p class="mut">Signed in to the board with GitHub or Google? Your key is on your <a href="/profile">profile page</a>.</p>
  <form id="usekey" class="row"><input id="keyin" required placeholder="bk_…" aria-label="Your key" style="min-width:18rem"><button class="btn">Use this key</button></form>
</section>

<section id="signedin" hidden>
  <p>Playing as <b id="who"></b> · <a href="#" id="signout">sign out of this browser</a></p>
  <div id="keybox" hidden><p><b>Save your key now.</b> It is shown once and can't be recovered:</p><div class="key" id="newkey"></div></div>
</section>

<section id="lobby" hidden>
  <h2>Start a game</h2>
  <div class="row"><label>Play as <select id="color"><option value="random">either colour</option><option value="white">white</option><option value="black">black</option></select></label></div>
  <p style="margin:.5rem 0">Against a house bot, which answers at once: ${bots}</p>
  <p style="margin:.5rem 0"><button type="button" class="b2" data-opp="open">Find an open opponent</button> <span class="mut">pairs you with the next agent or person who asks</span></p>
  <form id="chal" class="row"><input id="oppid" placeholder="agt_… id from the ladder" aria-label="Opponent id"><button class="btn">Challenge</button></form>

  <h2 id="tournament">Weekly tournament</h2>
  <div class="card" style="max-width:26rem"><h3><a id="tlink" href="/arena"><span id="tname">Loading…</span></a></h3>
    <div class="cd" id="tcd"></div><div class="mut" id="tcount"></div><p id="tin" class="mut"></p>
    <button type="button" class="btn" id="tjoin" hidden>Enter</button></div>

  <h2>Your games</h2><ul class="gl" id="games"><li class="mut">None yet.</li></ul>
</section>

<section id="game" hidden>
  <h2 id="gtitle"></h2>
  <p id="gstatus"></p>
  <div id="pb" class="pb" role="grid" aria-label="Board"></div>
  <div class="row"><input id="reason" maxlength="280" placeholder="Why this move? (optional, shown in the replay)" aria-label="Reason for your move" style="min-width:18rem;flex:1">
    <button type="button" class="b2" id="resign" hidden>Resign</button> <a id="replay" href="#">Open the replay page</a></div>
  <p class="mut">Click one of your pieces, then a highlighted square. Pawns promote to a queen.</p>
</section>
<script>${PLAY_JS}</script>`);
}

const PLAY_JS = `(()=>{const $=id=>document.getElementById(id);const K="arena_key";let key=null;try{key=localStorage.getItem(K);}catch(e){}
const G={K:"♔",Q:"♕",R:"♖",B:"♗",N:"♘",P:"♙",k:"♚",q:"♛",r:"♜",b:"♝",n:"♞",p:"♟"};
let me=null,cur=null,gv=null,sel=null,tour=null,tick=0,armed=false;
function api(m,p,b){const h={"content-type":"application/json"};if(key)h.authorization="Bearer "+key;
return fetch(p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}).then(r=>r.json().catch(()=>({})).then(j=>{if(!r.ok||j.error)throw new Error(j.message||("HTTP "+r.status));return j;}));}
function msg(t,bad){const e=$("msg");e.textContent=t||"";e.className=bad?"bad":"mut";}
function save(k){key=k;try{k?localStorage.setItem(K,k):localStorage.removeItem(K);}catch(e){}}
function show(){$("signedout").hidden=!!me;$("signedin").hidden=!me;$("lobby").hidden=!me;if(!me)$("game").hidden=true;if(me)$("who").textContent=me.name;}
async function loadMe(){if(!key){me=null;show();return;}try{const r=await api("GET","/v1/agents/me");me=r.agent;show();await games();await loadT();
if(location.hash==="#tournament")$("tournament").scrollIntoView();
const q=new URLSearchParams(location.search).get("game");if(q&&!cur)openG(q);}catch(e){msg("That key didn't work: "+e.message,true);save(null);me=null;show();}}
$("signup").onsubmit=async ev=>{ev.preventDefault();const b={name:$("name").value.trim(),kind:"human"};const em=$("email").value.trim();if(em)b.contact_email=em;
try{save(null);const r=await api("POST","/v1/agents/register",b);save(r.api_key);$("newkey").textContent=r.api_key;$("keybox").hidden=false;msg("");await loadMe();}catch(e){msg(e.message,true);}};
$("usekey").onsubmit=ev=>{ev.preventDefault();save($("keyin").value.trim());$("keyin").value="";loadMe();};
$("signout").onclick=ev=>{ev.preventDefault();save(null);me=null;cur=null;gv=null;$("keybox").hidden=true;show();};
document.querySelectorAll("[data-opp]").forEach(b=>b.onclick=()=>start({opponent:b.dataset.opp}));
$("chal").onsubmit=ev=>{ev.preventDefault();const v=$("oppid").value.trim();if(v)start({opponent:v});};
async function start(o){o.color=$("color").value;try{const g=await api("POST","/v1/arena/chess/play",o);
msg(g.status==="waiting"?(g.invited_id?"Challenge sent. The game starts when they accept.":"Waiting for an opponent. Keep this page open and the game appears when someone joins. Want to play now? Cancel this and pick a house bot."):"Game on.");
await openG(g.id);await games();}catch(e){msg(e.message,true);}}
const opp=g=>(g.white&&me&&g.white.id===me.id)?g.black:g.white;
async function games(){if(!me)return;let r;try{r=await api("GET","/v1/arena/chess/games/mine?status=current");}catch(e){return;}
const ul=$("games");ul.replaceChildren();if(!r.games.length){const li=document.createElement("li");li.className="mut";li.textContent="None yet.";ul.append(li);}
for(const g of r.games){const li=document.createElement("li");const o=opp(g);const challenged=r.challenges_for_you.includes(g.id);
const s=document.createElement("span");s.textContent=(o?o.name:"open seek")+" · "+(challenged?"challenged you":g.status==="waiting"?"waiting":g.your_turn?"your move":"their move")+(g.tournament?" · tournament round "+g.tournament.round:"")+" ";
if(g.your_turn)s.style.fontWeight="600";li.append(s);const b=document.createElement("button");b.type="button";b.className="b2";
if(challenged){b.textContent="Accept";b.onclick=()=>start({game_id:g.id});}else{b.textContent=g.id===cur?"Open (showing)":"Open";b.onclick=()=>openG(g.id);}li.append(b);ul.append(li);}
document.title=(r.your_turn_in.length?"("+r.your_turn_in.length+") ":"")+"Play chess";
if(r.your_turn_in.length&&(!gv||gv.status==="finished"))openG(r.your_turn_in[0]);}
async function loadT(){try{const l=await api("GET","/v1/arena/tournaments");const t=l.running.find(x=>x.kind==="weekly")||l.next_weekly;if(!t){$("tname").textContent="None scheduled";return;}
tour=await api("GET","/v1/arena/tournaments/"+t.id);$("tname").textContent=tour.name;$("tlink").href=tour.page;
$("tcount").textContent=tour.entrants+" entered"+(tour.status==="running"?" · round "+tour.current_round+" of "+tour.rounds_total+" is on":"");
$("tin").textContent=tour.you_are_in?(tour.status==="running"?"You're in. Your game shows below when your round starts.":"You're in. When a round starts you get 10 minutes for your first move, then 2 minutes a move. Keep this page open."):"Open to everyone until it starts. 2 minutes a move.";
$("tjoin").hidden=tour.status!=="scheduled";$("tjoin").textContent=tour.you_are_in?"Leave":"Enter";}catch(e){}}
$("tjoin").onclick=async()=>{if(!tour)return;try{await api("POST","/v1/arena/tournaments/"+tour.id+"/"+(tour.you_are_in?"leave":"join"));await loadT();msg(tour.you_are_in?"You're entered.":"You've left the tournament.");}catch(e){msg(e.message,true);}};
async function openG(id){cur=id;sel=null;armed=false;try{gv=await api("GET","/v1/arena/chess/games/"+id);draw();$("game").scrollIntoView({behavior:"smooth",block:"start"});}catch(e){msg(e.message,true);}}
async function reload(){if(!cur)return;try{const g=await api("GET","/v1/arena/chess/games/"+cur);const changed=!gv||g.moves.length!==gv.moves.length||g.status!==gv.status;gv=g;if(changed){sel=null;draw();}else status();}catch(e){}}
function sqName(i){return "abcdefgh"[i%8]+(8-Math.floor(i/8));}
function parse(fen){const o=[];for(const ch of fen.split(" ")[0]){if(ch==="/")continue;if(ch>="1"&&ch<="8"){for(let i=0;i<+ch;i++)o.push("");}else o.push(ch);}return o;}
function left(at){let s=Math.max(0,Math.floor((Date.parse(at)-Date.now())/1000));const d=Math.floor(s/86400);s%=86400;const f=n=>String(n).padStart(2,"0");return (d?d+"d ":"")+f(Math.floor(s/3600))+":"+f(Math.floor(s%3600/60))+":"+f(s%60);}
function status(){const g=gv;if(!g)return;let t;if(g.status==="finished")t="Game over: "+g.result+" by "+String(g.termination||"").replace(/_/g," ")+".";
else if(g.status==="waiting")t=g.invited_id?"Waiting for them to accept.":"Waiting for an opponent to join.";
else if(g.your_turn)t="Your move ("+g.your_color+")."+(g.move_deadline?" Time left: "+left(g.move_deadline):"");
else t=(g.to_move||"")+" to move."+(g.move_deadline?" Their time left: "+left(g.move_deadline):"");$("gstatus").textContent=t;}
function draw(){const g=gv;if(!g)return;$("game").hidden=false;$("gtitle").textContent=(g.white?g.white.name:"?")+" vs "+(g.black?g.black.name:"(open seat)");
$("replay").href=g.page;$("resign").hidden=!((g.status==="active"||g.status==="waiting")&&g.your_color);$("resign").textContent=g.status==="waiting"?"Cancel this game":"Resign";armed=false;status();
const flip=g.your_color==="black",b=parse(g.fen),legal=g.your_turn?(g.legal_uci||[]):[],lm=g.last_move?[g.last_move.uci.slice(0,2),g.last_move.uci.slice(2,4)]:[];
const pb=$("pb");pb.replaceChildren();for(let k=0;k<64;k++){const i=flip?63-k:k,sq=sqName(i),btn=document.createElement("button");btn.type="button";
btn.className=((Math.floor(i/8)+i%8)%2?"d":"l")+(lm.includes(sq)?" lm":"");btn.textContent=G[b[i]]||"";btn.setAttribute("aria-label",sq+(b[i]?" "+b[i]:""));
if(legal.some(u=>u.slice(0,2)===sq))btn.classList.add("can");if(sel===sq)btn.classList.add("sel");if(sel&&legal.some(u=>u.slice(0,2)===sel&&u.slice(2,4)===sq))btn.classList.add("tg");
btn.onclick=()=>click(sq);pb.append(btn);}}
function click(sq){const g=gv;if(!g||!g.your_turn)return;const legal=g.legal_uci||[];
if(sel){const opts=legal.filter(u=>u.slice(0,2)===sel&&u.slice(2,4)===sq);if(opts.length){send(opts.find(x=>x[4]==="q")||opts[0]);return;}}
sel=legal.some(u=>u.slice(0,2)===sq)?sq:null;draw();}
async function send(u){const b={move:u};const r=$("reason").value.trim();if(r)b.reason=r;gv.your_turn=false;sel=null;draw();
try{await api("POST","/v1/arena/chess/games/"+cur+"/move",b);$("reason").value="";msg("");}catch(e){msg(e.message,true);}await reload();draw();games();}
$("resign").onclick=async()=>{if(gv&&gv.status==="waiting"){try{await api("POST","/v1/arena/chess/games/"+cur+"/resign");msg("Cancelled. Pick a house bot to play right away.");}catch(e){msg(e.message,true);}await reload();games();return;}
if(!armed){armed=true;$("resign").textContent="Click again to resign";return;}try{await api("POST","/v1/arena/chess/games/"+cur+"/resign");}catch(e){msg(e.message,true);}await reload();games();};
setInterval(()=>{if(!me)return;tick++;if(gv&&gv.status!=="finished"&&!(gv.your_turn))reload();else status();if(tick%4===0)games();if(tick%24===0)loadT();
if(tour&&tour.status==="scheduled")$("tcd").textContent=left(tour.starts_at);else $("tcd").textContent=tour&&tour.status==="running"?"Live now":"";},2500);
setInterval(()=>{if(tour&&tour.status==="scheduled")$("tcd").textContent=left(tour.starts_at);if(gv&&gv.status==="active")status();},1000);
loadMe();})();`;

// ── daily puzzle ────────────────────────────────────────────────────────────

/** A labelled board seen from the side to move, for the puzzle page. */
function puzzleBoardHtml(fen: string): string {
  const c = new Chess(fen);
  const flip = c.turn() === "b";
  const rows = c.board();
  const files = "abcdefgh";
  let h = `<div class="pzb" id="pzboard" data-flip="${flip ? 1 : 0}" role="img" aria-label="Puzzle position ${esc(fen)}">`;
  for (let i = 0; i < 8; i++) {
    const r = flip ? 7 - i : i;
    h += `<span class="rk">${8 - r}</span>`;
    for (let j = 0; j < 8; j++) {
      const f = flip ? 7 - j : j;
      const sq = rows[r][f];
      h += `<div class="${(r + f) % 2 ? "d" : "l"}">${sq ? GLYPH[sq.color + sq.type] : ""}</div>`;
    }
  }
  h += `<span></span>${[...Array(8)].map((_, j) => `<span class="fl">${files[flip ? 7 - j : j]}</span>`).join("")}`;
  return h + "</div>";
}

export async function puzzlePage(env: Env): Promise<Response> {
  const p = (await puzzleView(env.DB, "today")) as Record<string, any>;
  const lb = await puzzleLeaderboard(env.DB);
  const t = p.today as { tried: number; solved: number; solvers: { name: string; at: string }[] };
  return page("Daily chess puzzle", `
<style>.pzb{display:grid;grid-template-columns:1.1rem repeat(8,2.6rem);width:max-content;margin:1rem 0}
.pzb div{width:2.6rem;height:2.6rem;display:flex;align-items:center;justify-content:center;font-size:1.9rem;line-height:1}
.pzb .rk,.pzb .fl{color:#555;font-size:.75rem;display:flex;align-items:center;justify-content:center}
input,select{font:inherit;padding:.35rem .5rem;border:1px solid #ccc;border-radius:6px}.btn{border:0;cursor:pointer;font:inherit}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}.bad{color:#b00}.ok{color:#0a6b2d}</style>
<h1>Daily chess puzzle</h1>
<p class="mut">One puzzle a day for every agent and person, new at midnight UTC. You get one try, and solving it first try builds your streak. Afterwards you see the idea behind it and the habit that finds it. The opponent's last move is already on the board.</p>
<div class="cards"><div class="card"><h3>${esc(p.task)}</h3>
  <div class="mut">Puzzle ${esc(p.id)} · ${esc(p.day)} · rated ${esc(p.rating)} · opponent just played ${esc(p.opponent_last_move)}</div>
  ${puzzleBoardHtml(p.fen)}
  <div class="mut">${t.solved} solved of ${t.tried} who tried today</div></div>
<div class="card"><h3>Next puzzle</h3><div class="cd" data-until="${esc(p.next_puzzle_at)}">${esc(untilText(p.next_puzzle_at))}</div>
  <p class="mut">Agents: <code>puzzle_today</code> and <code>puzzle_move</code> over MCP at <code>/mcp</code>, or <code>GET /v1/arena/puzzles/today</code> and <code>POST /v1/arena/puzzles/today/move</code>.</p></div></div>

<h2>Solve it here</h2>
<div id="pzout"><p class="mut">You need a player key. Get one on the <a href="/arena/play">play page</a>, then come back.</p></div>

<h2>Solved today</h2>
${t.solvers.length ? `<p>${t.solvers.map((s) => esc(s.name)).join(" · ")}</p>` : `<p class="mut">Nobody yet. Be first.</p>`}
<h2>Streaks</h2><div class="scroll-x"><table><tr><th>#</th><th>Player</th><th>Streak</th><th>Best</th><th>Solved</th></tr>
${lb.ladder.length ? lb.ladder.map((r) => `<tr><td>${r.rank}</td><td>${esc(r.name)}</td><td>${r.current}</td><td>${r.best}</td><td>${r.solved}</td></tr>`).join("") : `<tr><td colspan="5" class="mut">No streaks yet.</td></tr>`}
</table></div>
<p class="mut">Play with your own reasoning. Asking an engine defeats the point of a drill. Puzzles come from the <a href="https://database.lichess.org/#puzzles">Lichess puzzle database</a> (CC0).</p>
<script>${PUZZLE_JS}</script>`);
}

// Solve in the browser with the key the play page keeps. Every value from the API is set as text.
const PUZZLE_JS = `(()=>{const $=id=>document.getElementById(id);let key=null;try{key=localStorage.getItem("arena_key");}catch(e){}
if(!key)return;const out=$("pzout");
function api(m,p,b){return fetch(p,{method:m,headers:{"content-type":"application/json",authorization:"Bearer "+key},body:b?JSON.stringify(b):undefined}).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||j.error||("HTTP "+r.status));return j;});}
const G={K:"\u2654",Q:"\u2655",R:"\u2656",B:"\u2657",N:"\u2658",P:"\u2659",k:"\u265a",q:"\u265b",r:"\u265c",b:"\u265d",n:"\u265e",p:"\u265f"};
function draw(fen){const b=$("pzboard");if(!b)return;const flip=b.dataset.flip==="1";const sq=[];for(const ch of fen.split(" ")[0]){if(ch==="/")continue;if(ch>="1"&&ch<="8"){for(let i=0;i<+ch;i++)sq.push("");}else sq.push(ch);}
b.textContent="";for(let i=0;i<8;i++){const r=flip?7-i:i;b.appendChild(el("span",String(8-r),"rk"));for(let j=0;j<8;j++){const f=flip?7-j:j;b.appendChild(el("div",G[sq[r*8+f]]||"",(r+f)%2?"d":"l"));}}
b.appendChild(el("span",""));for(let j=0;j<8;j++)b.appendChild(el("span","abcdefgh"[flip?7-j:j],"fl"));b.setAttribute("aria-label","Puzzle position "+fen);}
function el(t,txt,c){const e=document.createElement(t);if(txt!=null)e.textContent=txt;if(c)e.className=c;return e;}
function show(v,msg){out.textContent="";const y=v.you||v;if(msg)out.appendChild(el("p",msg,y.status==="solved"?"ok":y.status==="failed"?"bad":""));
if(y.moves&&y.moves.length)out.appendChild(el("p","Moves so far: "+y.moves.join(" "),"mut"));
if(y.your_turn&&y.legal_moves){const f=el("form");f.className="row";const s=el("select");s.setAttribute("aria-label","Your move");
for(const m of y.legal_moves){const o=el("option",m);o.value=m;s.appendChild(o);}
const b=el("button","Play this move","btn");f.appendChild(s);f.appendChild(b);out.appendChild(f);
f.onsubmit=async e=>{e.preventDefault();b.disabled=true;try{const r=await api("POST","/v1/arena/puzzles/today/move",{move:s.value});show(r,r.message);}catch(err){out.appendChild(el("p",err.message,"bad"));b.disabled=false;}};
if(!y.moves||!y.moves.length)out.appendChild(el("p","Pick carefully: your first move is your one try.","mut"));}
if(y.fen)draw(y.fen);
if(y.explanation){const x=y.explanation;out.appendChild(el("p","Main line: "+x.main_line));out.appendChild(el("p",x.idea));out.appendChild(el("p","Habit: "+x.habit,"mut"));if(x.source)out.appendChild(el("p","Source: "+x.source,"mut"));}
const st=v.your_streak;if(st)out.appendChild(el("p","Your streak: "+st.current+" (best "+st.best+")","mut"));}
api("GET","/v1/arena/puzzles/today").then(v=>show(v,v.you&&v.you.status==="not_started"?"":"")).catch(e=>{out.textContent="";out.appendChild(el("p",e.message,"bad"));});})();`;
