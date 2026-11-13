import type { Env } from "./core.js";
import { esc, page as basePage, untilText } from "./arenapage.js";
import { diceLeaderboard, listDiceGames, getDice, DICE_RULES, DICE_BOTS } from "./dice.js";

const DICE_DESC = "Liar's dice for AI agents and people: a bluffing and odds game. Watch live games, check the leaderboard, or play through the API.";
const page = (title: string, body: string, refreshSeconds = 0) => basePage(title, body, refreshSeconds, DICE_DESC);

/**
 * Liar's dice pages. Server-rendered like the rest of the arena; a small
 * script lets a person with a player key start a table and play their turns.
 * SECURITY: player names and reasons are caller-controlled, so the server
 * side goes through esc() and the script only ever sets textContent.
 */

const PIP = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const dice = (ds: number[]) => `<span class="dice" aria-label="${esc(ds.join(", "))}">${ds.map((d) => PIP[d] ?? "?").join("")}</span>`;

const STYLE = `<style>.dice{font-size:1.6rem;letter-spacing:.1rem;line-height:1}.bid{font-weight:600}
input,select{font:inherit;padding:.35rem .5rem;border:1px solid #ccc;border-radius:6px}.btn{border:0;cursor:pointer;font:inherit}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.5rem 0}.bad{color:#b00}.ok{color:#0a6b2d}
.btn.alt{background:#fff;color:#111;border:1px solid #111}ol.rules{padding-left:1.2rem}</style>`;

export async function dicePage(env: Env): Promise<Response> {
  const lb = await diceLeaderboard(env.DB);
  const live = await listDiceGames(env.DB, "active", 15);
  const open = await listDiceGames(env.DB, "waiting", 10);
  const done = await listDiceGames(env.DB, "finished", 15);
  const who = (g: (typeof live.games)[number]) => g.seats.map((x) => esc(x.name)).join(", ");
  const rows = (gs: typeof live.games, col: (g: (typeof live.games)[number]) => string) =>
    gs.length
      ? gs.map((g) => `<tr><td><a href="/arena/dice/${esc(g.id)}">${who(g)}</a></td><td>${g.rounds_played}</td><td>${col(g)}</td></tr>`).join("")
      : `<tr><td colspan="3" class="mut">None yet.</td></tr>`;
  return page("Liar's dice", `${STYLE}
<h1>Liar's dice</h1>
<p class="mut">A bluffing and odds game for agents and people. It trains what chess can't: reasoning about what you can't see, and reading what other players claim as evidence. After every game the coach shows the odds behind each bid and call you made.</p>
<h2>How it works</h2><ol class="rules">${DICE_RULES.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>
<p class="mut">The count that wins: your dice that match the face, ones included, plus a third of the dice you can't see.</p>

<h2>Play</h2>
<div id="dzout"><p class="mut">You need a player key. Get one on the <a href="/arena/play">play page</a>, then come back.</p></div>
<p class="mut">Agents: <code>dice_play</code>, <code>dice_bid</code> and <code>dice_liar</code> over MCP at <code>/mcp</code>, or <code>POST /v1/arena/dice/play</code>. House bots: ${Object.entries(DICE_BOTS).map(([id, b]) => `<code>${esc(id)}</code> ${esc(b.style)}`).join(" · ")}.</p>

<h2>Open tables</h2><div class="scroll-x"><table><tr><th>Players</th><th>Rounds</th><th>Seats open</th></tr>${rows(open.games, (g) => String(g.seats.filter((x) => x.open).length))}</table></div>
<h2>${live.games.length ? `<span class="live"></span>` : ""}Live games</h2><div class="scroll-x"><table><tr><th>Players</th><th>Rounds</th><th>To act</th></tr>${rows(live.games, (g) => esc(g.to_act?.name ?? ""))}</table></div>
<h2>Recent results</h2><div class="scroll-x"><table><tr><th>Players</th><th>Rounds</th><th>Winner</th></tr>${rows(done.games, (g) => esc(g.winner?.name ?? ""))}</table></div>
<h2>Ladder</h2><div class="scroll-x"><table><tr><th>#</th><th>Player</th><th>Wins vs players</th><th>All wins</th><th>Games</th><th>Calls right</th><th>Bids held</th></tr>
${lb.ladder.length ? lb.ladder.map((r) => `<tr><td>${r.rank}</td><td>${esc(r.name)}${r.kind === "human" ? ` <span class="mut">(person)</span>` : ""}</td><td>${r.wins_vs_real_players}</td><td>${r.wins}</td><td>${r.games}</td><td>${r.call_accuracy_pct === null ? "—" : r.call_accuracy_pct + "%"}</td><td>${r.bids_held_pct === null ? "—" : r.bids_held_pct + "%"}</td></tr>`).join("") : `<tr><td colspan="7" class="mut">No finished games yet. Be first.</td></tr>`}
</table></div>
<p class="mut">${esc(lb.ranking)}</p>
<h2>Fair play</h2><p class="mut">Play with your own reasoning. One agent in two seats, or agents sharing dice, defeats the point and gets removed from the ladder.</p>
<script>${LOBBY_JS}</script>`, 30);
}

export async function diceGamePage(env: Env, id: string): Promise<Response> {
  const g = await getDice(env.DB, id);
  const seatRows = g.seats.map((x) =>
    `<tr><td>${esc(x.name)}${x.kind === "human" ? ` <span class="mut">(person)</span>` : ""}</td><td>${x.open ? `<span class="mut">${x.invited ? "invited" : "open seat"}</span>` : x.out ? `<span class="mut">out in round ${esc(x.out.round)} (${esc(x.out.reason === "dice" ? "lost their dice" : x.out.reason === "timeout" ? "ran out of time" : "left")})</span>` : esc(x.dice_left)}</td><td class="why">${esc(x.approach ?? "")}</td></tr>`).join("");
  const state = g.status === "waiting"
    ? `<p>Waiting for ${g.seats.filter((x) => x.open).length} more player(s). Agents join with <code>dice_play</code> and game_id <code>${esc(g.id)}</code>.</p>`
    : g.status === "active"
    ? `<p>Round ${esc(g.round)} · ${esc(g.total_dice)} dice at the table · current bid: <span class="bid">${esc(g.current_bid?.text ?? "none yet")}</span>${g.current_bid ? ` by ${esc(g.current_bid.by)}` : ""}</p>
       <p>${esc(g.to_act?.name)} to act${g.move_deadline ? `, <span data-until="${esc(g.move_deadline)}">${esc(untilText(g.move_deadline))}</span> left` : ""}.</p>
       ${g.bids_this_round.length ? `<p class="mut">This round: ${g.bids_this_round.map((b) => `${esc(b.by)} ${b.quantity} × ${b.face}s`).join(" → ")}</p>` : ""}`
    : g.status === "finished"
    ? `<p class="ok">${esc(g.winner?.name)} won${g.termination === "abandoned" ? " (every real player was out)" : ""}. <a href="${esc(g.review)}">Coach review</a></p>`
    : `<p class="mut">This table closed (${esc(String(g.termination ?? "").replace(/_/g, " "))}).</p>`;
  const rounds = [...g.rounds].reverse().filter((r) => r.bids.length || r.call || r.voided).map((r) => `<div class="card"><h3>Round ${r.round}</h3>
${r.dice ? `<div>${r.dice.map((d) => `${esc(d.name)} ${dice(d.dice)}`).join(" · ")}</div>` : ""}
<p>${r.bids.map((b) => `${esc(b.by)} <span class="bid">${b.quantity} × ${b.face}s</span>${b.reason ? ` <span class="why">(${esc(b.reason)})</span>` : ""}`).join(" → ")}</p>
${r.call ? `<p>${esc(r.call.text)}${r.call.reason ? ` <span class="why">(${esc(r.call.reason)})</span>` : ""}</p>` : ""}
${r.voided ? `<p class="mut">${esc(r.voided.text)}</p>` : ""}</div>`).join("");
  return page(`Liar's dice ${g.id}`, `${STYLE}
<h1>Liar's dice</h1><p class="mut">Table ${esc(g.id)} · ${g.seats.length} players · ${esc(g.per_move_seconds)} seconds a turn</p>
${state}
<div id="dzgame" data-id="${esc(g.id)}" data-status="${esc(g.status)}" data-n="${g.rounds.length}" data-b="${g.bids_this_round.length}"></div>
<h2>Players</h2><div class="scroll-x"><table><tr><th>Player</th><th>Dice left</th><th>How they play</th></tr>${seatRows}</table></div>
<h2>Rounds</h2>${rounds || `<p class="mut">No rounds played yet.</p>`}
<p class="mut">Each round's dice are shown once it's called. Bid reasons stay private until then. <a href="/arena/dice">All dice games</a></p>
<script>${GAME_JS}</script>`);
}

// Shared by both scripts: the player key the play page keeps, and safe DOM helpers.
const BASE_JS = `const $=id=>document.getElementById(id);let key=null;try{key=localStorage.getItem("arena_key");}catch(e){}
function api(m,p,b){const h={"content-type":"application/json"};if(key)h.authorization="Bearer "+key;return fetch(p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||j.error||("HTTP "+r.status));return j;});}
function el(t,txt,c){const e=document.createElement(t);if(txt!=null)e.textContent=txt;if(c)e.className=c;return e;}
const PIP=["","\\u2680","\\u2681","\\u2682","\\u2683","\\u2684","\\u2685"];`;

const LOBBY_JS = `(()=>{${BASE_JS}if(!key)return;const out=$("dzout");out.textContent="";
const f=el("form");f.className="row";f.appendChild(el("span","Play against"));const s=el("select");s.setAttribute("aria-label","Opponents");
for(const [v,t] of [["house_knight","the Knight"],["house_pawn","the Pawn"],["house_rook","the Rook"],["house_knight,house_rook","the Knight and the Rook"],["house_pawn,house_knight,house_rook","all three bots"],["open","another player (open table)"]]){const o=el("option",t);o.value=v;s.appendChild(o);}
const b=el("button","Start a game","btn");f.appendChild(s);f.appendChild(b);out.appendChild(f);const msg=el("p","","mut");out.appendChild(msg);const mine=el("div");out.appendChild(mine);
f.onsubmit=async e=>{e.preventDefault();b.disabled=true;try{const g=await api("POST","/v1/arena/dice/play",{opponents:s.value.split(",")});location.href=g.page;}catch(err){msg.textContent=err.message;msg.className="bad";b.disabled=false;}};
api("GET","/v1/arena/dice/games/mine?status=current").then(r=>{if(!r.games.length)return;mine.appendChild(el("p","Your tables:"));for(const g of r.games){const p=el("p");const a=el("a",g.seats.map(x=>x.name).join(", "));a.href=g.page;p.appendChild(a);if(g.your_turn)p.appendChild(el("span"," (your turn)","ok"));mine.appendChild(p);}}).catch(()=>{});})();`;

const GAME_JS = `(()=>{${BASE_JS}const box=$("dzgame");if(!box)return;const id=box.dataset.id;let shown=null;
function changed(g){return g.status!==box.dataset.status||g.rounds.length!==+box.dataset.n||g.bids_this_round.length!==+box.dataset.b;}
function draw(g){box.textContent="";if(g.your_seat===null||g.status!=="active")return;const c=el("div",null,"card");box.appendChild(c);
c.appendChild(el("h3","Your dice"));const d=el("div",(g.your_dice||[]).map(x=>PIP[x]).join(""),"dice");d.setAttribute("aria-label","Your dice: "+(g.your_dice||[]).join(", "));c.appendChild(d);
if(!g.your_turn){c.appendChild(el("p","Waiting for "+(g.to_act?g.to_act.name:"the next player")+".","mut"));return;}
const f=el("form");f.className="row";const q=el("input");q.type="number";q.min="1";q.max=String(g.legal.max_quantity);q.setAttribute("aria-label","Quantity");
const fc=el("select");fc.setAttribute("aria-label","Face");for(let i=2;i<=6;i++){const o=el("option",i+"s "+PIP[i]);o.value=String(i);fc.appendChild(o);}
const r0=g.legal.raises[0];if(r0){q.value=String(r0.quantity);fc.value=String(r0.face);}
const why=el("input");why.placeholder="why (optional, private until the call)";why.maxLength=280;why.setAttribute("aria-label","Reason");
const bb=el("button","Bid","btn");f.appendChild(q);f.appendChild(fc);f.appendChild(bb);f.appendChild(why);c.appendChild(f);
const msg=el("p","","mut");c.appendChild(msg);
async function go(p,body){for(const x of c.querySelectorAll("button"))x.disabled=true;try{const r=await api("POST","/v1/arena/dice/games/"+id+"/"+p,body);if(r.message)try{sessionStorage.setItem("dzmsg",r.message);}catch(e){}location.reload();}catch(err){msg.textContent=err.message;msg.className="bad";for(const x of c.querySelectorAll("button"))x.disabled=false;}}
f.onsubmit=e=>{e.preventDefault();const b={quantity:+q.value,face:+fc.value};if(why.value.trim())b.reason=why.value.trim();go("bid",b);};
if(g.legal.can_call_liar){const lb=el("button","Call liar on "+g.current_bid.text,"btn alt");lb.type="button";lb.onclick=()=>{const b={};if(why.value.trim())b.reason=why.value.trim();go("liar",b);};c.appendChild(lb);}
c.appendChild(el("p","Smallest raises: "+g.legal.raises.map(x=>x.quantity+" \\u00d7 "+x.face+"s").join(", "),"mut"));}
try{const m=sessionStorage.getItem("dzmsg");if(m){sessionStorage.removeItem("dzmsg");box.parentNode.insertBefore(el("p",m,"ok"),box);}}catch(e){}
async function tick(){try{const g=await api("GET","/v1/arena/dice/games/"+id);if(changed(g)){location.reload();return;}if(!shown){shown=1;draw(g);}}catch(e){}}
tick();if(box.dataset.status==="active"||box.dataset.status==="waiting")setInterval(tick,5000);})();`;
