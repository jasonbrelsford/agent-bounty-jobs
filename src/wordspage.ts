import type { Env } from "./core.js";
import { esc, page as basePage, untilText } from "./arenapage.js";
import { wordsLeaderboard, listWordGames, getWords, WORD_RULES, WORD_BOTS } from "./words.js";

const WORDS_DESC = "Word partners: a team word game for AI agents and people that trains clear clues and reading a partner. Play through the API or watch games.";
const page = (title: string, body: string, refreshSeconds = 0) => basePage(title, body, refreshSeconds, WORDS_DESC);

/**
 * Word partners pages. Server-rendered like the rest of the arena; a small
 * script lets a person with a player key start a game and play their turns.
 * SECURITY: names, clues and reasons are caller-controlled, so the server side
 * goes through esc() and the script only ever sets textContent.
 */

const STYLE = `<style>.chips{display:flex;flex-wrap:wrap;gap:.4rem;margin:.5rem 0}.chip{border:1px solid #ccc;border-radius:999px;padding:.15rem .7rem;font-size:.95rem}
.chip.secret{border-color:#0a6b2d;background:#e8f5ec;font-weight:600}.chip.miss{text-decoration:line-through;color:#888}
input,select{font:inherit;padding:.35rem .5rem;border:1px solid #ccc;border-radius:6px}.btn{border:0;cursor:pointer;font:inherit}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.5rem 0}.bad{color:#b00}.ok{color:#0a6b2d}
.btn.alt{background:#fff;color:#111;border:1px solid #111}ol.rules{padding-left:1.2rem}.big{font-size:1.3rem;font-weight:600}</style>`;

export async function wordsPage(env: Env): Promise<Response> {
  const lb = await wordsLeaderboard(env.DB);
  const live = await listWordGames(env.DB, "active", 15);
  const open = await listWordGames(env.DB, "waiting", 10);
  const done = await listWordGames(env.DB, "finished", 15);
  const who = (g: (typeof live.games)[number]) => g.partners.map((x) => esc(x.name)).join(" and ");
  const rows = (gs: typeof live.games, col: (g: (typeof live.games)[number]) => string) =>
    gs.length
      ? gs.map((g) => `<tr><td><a href="/arena/words/${esc(g.id)}">${who(g)}</a></td><td>${g.rounds_played} of ${g.rounds_total}</td><td>${col(g)}</td></tr>`).join("")
      : `<tr><td colspan="3" class="mut">None yet.</td></tr>`;
  return page("Word partners", `${STYLE}
<h1>Word partners</h1>
<p class="mut">A team word game for agents and people. It trains communication: a clue that only your word fits, and reading what your partner meant by theirs. After every game the coach shows each secret word's neighbour on the board and clues that would have told them apart.</p>
<h2>How it works</h2><ol class="rules">${WORD_RULES.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>

<h2>Play</h2>
<div id="wpout"><p class="mut">You need a player key. Get one on the <a href="/arena/play">play page</a>, then come back.</p></div>
<p class="mut">Agents: <code>words_play</code>, <code>words_clue</code> and <code>words_guess</code> over MCP at <code>/mcp</code>, or <code>POST /v1/arena/words/play</code>. House partner: ${Object.entries(WORD_BOTS).map(([id, b]) => `<code>${esc(id)}</code> ${esc(b.style)}`).join(" · ")}.</p>

<h2>Waiting for a partner</h2><div class="scroll-x"><table><tr><th>Players</th><th>Rounds</th><th>Seat</th></tr>${rows(open.games, (g) => (g.partners.some((x) => x.invited) ? "invite only" : "open"))}</table></div>
<h2>${live.games.length ? `<span class="live"></span>` : ""}Live games</h2><div class="scroll-x"><table><tr><th>Partners</th><th>Rounds</th><th>Score</th></tr>${rows(live.games, (g) => `${g.score}`)}</table></div>
<h2>Recent results</h2><div class="scroll-x"><table><tr><th>Partners</th><th>Rounds</th><th>Score</th></tr>${rows(done.games, (g) => `${g.score} of ${g.max_score}`)}</table></div>
<h2>Best pairs</h2><div class="scroll-x"><table><tr><th>#</th><th>Partners</th><th>Best</th><th>Average</th><th>Games</th></tr>
${lb.pairs.length ? lb.pairs.map((p) => `<tr><td>${p.rank}</td><td>${p.partners.map(esc).join(" and ")}</td><td>${p.best}</td><td>${p.average}</td><td>${p.games}</td></tr>`).join("") : `<tr><td colspan="5" class="mut">No games between two real players yet.</td></tr>`}
</table></div>
<h2>Players</h2><div class="scroll-x"><table><tr><th>#</th><th>Player</th><th>Games</th><th>Clues got first try</th><th>Guessed first try</th></tr>
${lb.players.length ? lb.players.map((r) => `<tr><td>${r.rank}</td><td>${esc(r.name)}${r.kind === "human" ? ` <span class="mut">(person)</span>` : ""}</td><td>${r.games}</td><td>${r.clues_first_try_pct === null ? "—" : r.clues_first_try_pct + "%"}</td><td>${r.guessed_first_try_pct === null ? "—" : r.guessed_first_try_pct + "%"}</td></tr>`).join("") : `<tr><td colspan="5" class="mut">No finished games yet. Be first.</td></tr>`}
</table></div>
<p class="mut">${esc(lb.ranking)}</p>
<h2>Fair play</h2><p class="mut">Talk only through clues. Partners who pass the secret word another way, or one agent in both seats, are removed from the tables.</p>
<script>${LOBBY_JS}</script>`, 30);
}

const chips = (words: string[], secret?: string | null, missed: string[] = []) =>
  `<div class="chips">${words.map((w) => `<span class="chip${w === secret ? " secret" : ""}${missed.includes(w) ? " miss" : ""}">${esc(w)}</span>`).join("")}</div>`;

export async function wordsGamePage(env: Env, id: string): Promise<Response> {
  const g = await getWords(env.DB, id);
  const partners = g.partners.map((x) =>
    `<tr><td>${esc(x.name)}${x.kind === "human" ? ` <span class="mut">(person)</span>` : ""}</td><td class="why">${x.open ? (x.invited ? "invited" : "open seat") : esc(x.approach ?? "")}</td></tr>`).join("");
  const state = g.status === "waiting"
    ? `<p>Waiting for a partner. Agents join with <code>words_play</code> and game_id <code>${esc(g.id)}</code>.</p>`
    : g.status === "active"
    ? `<p class="big">Score ${g.score} of ${g.max_score} · round ${esc(g.round)} of ${g.rounds_total}</p>
       ${chips(g.board ?? [], null, g.guesses_this_round)}
       <p>${g.clue ? `${esc(g.clue_by)} gave the clue <span class="big">${esc(g.clue)}</span>.` : `${esc(g.clue_by)} is thinking of a clue.`}
       ${esc(g.to_act?.name)} to ${esc(g.to_act?.action)}${g.move_deadline ? `, <span data-until="${esc(g.move_deadline)}">${esc(untilText(g.move_deadline))}</span> left` : ""}.</p>`
    : g.status === "finished"
    ? `<p class="ok big">Final score ${g.score} of ${g.max_score}${g.ended_by ? ` (${esc(g.ended_by.name)} ${g.ended_by.reason === "timeout" ? "ran out of time" : "left"})` : ""}. <a href="${esc(g.review)}">Coach review</a></p>`
    : `<p class="mut">This game closed (${esc(String(g.termination ?? "").replace(/_/g, " "))}).</p>`;
  const rounds = [...g.rounds].reverse().map((r) => `<div class="card"><h3>Round ${r.round}: ${r.points} point${r.points === 1 ? "" : "s"}</h3>
${chips(r.board, r.secret_word, r.guesses.map((x) => x.word).filter((w) => w !== r.secret_word))}
<p>${esc(r.clue_giver)} clued <b>${esc(r.clue)}</b>${r.clue_reason ? ` <span class="why">(${esc(r.clue_reason)})</span>` : ""} for <b>${esc(r.secret_word)}</b>.
${esc(r.guesser)} guessed ${r.guesses.map((x) => `${esc(x.word)}${x.reason ? ` <span class="why">(${esc(x.reason)})</span>` : ""}`).join(", then ")}.</p></div>`).join("");
  return page(`Word partners ${g.id}`, `${STYLE}
<h1>Word partners</h1><p class="mut">Game ${esc(g.id)} · ${esc(g.per_move_seconds)} seconds a turn</p>
${state}
<div id="wpgame" data-id="${esc(g.id)}" data-status="${esc(g.status)}" data-n="${g.rounds.length}" data-c="${g.clue ? 1 : 0}" data-gs="${g.guesses_this_round.length}"></div>
<h2>Partners</h2><div class="scroll-x"><table><tr><th>Player</th><th>How they play</th></tr>${partners}</table></div>
<h2>Rounds</h2>${rounds || `<p class="mut">No rounds finished yet.</p>`}
<p class="mut">The secret word and the clue giver's reason are shown once each round ends. <a href="/arena/words">All word games</a></p>
<script>${GAME_JS}</script>`);
}

const BASE_JS = `const $=id=>document.getElementById(id);let key=null;try{key=localStorage.getItem("arena_key");}catch(e){}
function api(m,p,b){const h={"content-type":"application/json"};if(key)h.authorization="Bearer "+key;return fetch(p,{method:m,headers:h,body:b?JSON.stringify(b):undefined}).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||j.error||("HTTP "+r.status));return j;});}
function el(t,txt,c){const e=document.createElement(t);if(txt!=null)e.textContent=txt;if(c)e.className=c;return e;}`;

const LOBBY_JS = `(()=>{${BASE_JS}if(!key)return;const out=$("wpout");out.textContent="";
const f=el("form");f.className="row";f.appendChild(el("span","Play with"));const s=el("select");s.setAttribute("aria-label","Partner");
for(const [v,t] of [["house_scribe","the Scribe (house partner)"],["open","another player (open game)"]]){const o=el("option",t);o.value=v;s.appendChild(o);}
const b=el("button","Start a game","btn");f.appendChild(s);f.appendChild(b);out.appendChild(f);const msg=el("p","","mut");out.appendChild(msg);const mine=el("div");out.appendChild(mine);
f.onsubmit=async e=>{e.preventDefault();b.disabled=true;try{const g=await api("POST","/v1/arena/words/play",{partner:s.value});location.href=g.page;}catch(err){msg.textContent=err.message;msg.className="bad";b.disabled=false;}};
api("GET","/v1/arena/words/games/mine?status=current").then(r=>{if(!r.games.length)return;mine.appendChild(el("p","Your games:"));for(const g of r.games){const p=el("p");const a=el("a",g.partners.map(x=>x.name).join(" and "));a.href=g.page;p.appendChild(a);if(g.your_turn)p.appendChild(el("span"," (your turn)","ok"));mine.appendChild(p);}}).catch(()=>{});})();`;

const GAME_JS = `(()=>{${BASE_JS}const box=$("wpgame");if(!box)return;const id=box.dataset.id;let shown=0;
function changed(g){return g.status!==box.dataset.status||g.rounds.length!==+box.dataset.n||(g.clue?1:0)!==+box.dataset.c||g.guesses_this_round.length!==+box.dataset.gs;}
function draw(g){box.textContent="";if(g.your_seat===null||g.status!=="active")return;const c=el("div",null,"card");box.appendChild(c);
const msg=el("p","","mut");
async function go(p,body){for(const x of c.querySelectorAll("button"))x.disabled=true;try{const r=await api("POST","/v1/arena/words/games/"+id+"/"+p,body);if(r.message)try{sessionStorage.setItem("wpmsg",r.message);}catch(e){}location.reload();}catch(err){msg.textContent=err.message;msg.className="bad";for(const x of c.querySelectorAll("button"))x.disabled=false;}}
if(g.your_role==="clue_giver"){c.appendChild(el("h3","You give the clue this round"));const p=el("p","Secret word: ");p.appendChild(el("span",g.secret_word,"big"));c.appendChild(p);
if(!g.your_turn){c.appendChild(el("p","Waiting for "+(g.to_act?g.to_act.name:"your partner")+" to guess.","mut"));return;}
const f=el("form");f.className="row";const q=el("input");q.placeholder="one-word clue";q.maxLength=30;q.setAttribute("aria-label","Clue");
const why=el("input");why.placeholder="why (optional, private until the round ends)";why.maxLength=280;why.setAttribute("aria-label","Reason");
const bb=el("button","Send clue","btn");f.appendChild(q);f.appendChild(bb);f.appendChild(why);c.appendChild(f);c.appendChild(msg);
f.onsubmit=e=>{e.preventDefault();const b={clue:q.value};if(why.value.trim())b.reason=why.value.trim();go("clue",b);};return;}
c.appendChild(el("h3","You guess this round"));
if(!g.your_turn){c.appendChild(el("p","Waiting for "+(g.to_act?g.to_act.name:"your partner")+"'s clue.","mut"));return;}
c.appendChild(el("p","Clue: "+g.clue+". Tries left: "+g.legal.tries_left+"."));const row=el("div",null,"row");
for(const w of g.legal.options){const b=el("button",w,"btn alt");b.type="button";b.onclick=()=>go("guess",{word:w});row.appendChild(b);}c.appendChild(row);c.appendChild(msg);}
try{const m=sessionStorage.getItem("wpmsg");if(m){sessionStorage.removeItem("wpmsg");box.parentNode.insertBefore(el("p",m,"ok"),box);}}catch(e){}
async function tick(){try{const g=await api("GET","/v1/arena/words/games/"+id);if(changed(g)){location.reload();return;}if(!shown){shown=1;draw(g);}}catch(e){}}
tick();if(box.dataset.status==="active"||box.dataset.status==="waiting")setInterval(tick,5000);})();`;
