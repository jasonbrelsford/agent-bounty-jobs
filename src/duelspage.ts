import type { Env } from "./core.js";
import { esc, page as basePage } from "./arenapage.js";
import { duelResults, listDuels, getDuel, ROSTER, TOURNAMENT, DUEL } from "./duels.js";

/**
 * Pages for the model-vs-model prisoner's dilemma round robin. Server-rendered, no client script.
 * SECURITY: model answers (reasons) are model output and can say anything, so every
 * value that is not a number goes through esc().
 */

const DESC = "Which AI models cooperate? Claude, Llama, Qwen, Gemma, gpt-oss and DeepSeek play the repeated prisoner's dilemma against each other. Standings, head-to-head results, and how each model behaves.";
const page = (title: string, body: string, refreshSeconds = 0) => basePage(title, body, refreshSeconds, DESC);

const STYLE = `<style>.lead{border:1px solid #cfe9db;background:#f3fbf6;border-radius:10px;padding:1rem 1.15rem;margin:1rem 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.75rem;margin:1rem 0}
.tile{border:1px solid #e2e2e2;border-radius:8px;padding:.8rem .9rem}.tile b{display:block;font-size:1.15rem;line-height:1.3}.tile span{font-size:.85rem;color:#555}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:.9rem;margin:1rem 0}
.card{border:1px solid #e2e2e2;border-radius:10px;padding:.9rem 1rem}.card h3{margin:0;font-size:1.05rem}.card p{margin:.45rem 0;font-size:.92rem}
.badge{display:inline-block;border-radius:999px;padding:.05rem .6rem;font-size:.8rem;font-weight:600;background:#eef3ff;color:#1d3b8a;margin:.3rem 0}
.q{border-left:3px solid #ddd;padding-left:.6rem;color:#333;font-style:italic}.q b{font-style:normal;color:#555;font-weight:600}
.mv{display:inline-block;min-width:1.4rem;text-align:center;font-weight:700;border-radius:4px;padding:0 .3rem}.mv.C{background:#e8f5ec;color:#0a6b2d}.mv.D{background:#fdecea;color:#a61b1b}
.strip{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;letter-spacing:1px;white-space:nowrap}.strip i{font-style:normal;padding:0 1px;border-radius:2px}.strip .C{background:#e8f5ec;color:#0a6b2d}.strip .D{background:#fdecea;color:#a61b1b}
td.h{text-align:center;font-variant-numeric:tabular-nums}td.h.g3{background:#cdebd6}td.h.g2{background:#e8f5ec}td.h.g1{background:#fff4d6}td.h.g0{background:#fbdcd8}td.h.x{background:#f4f4f4;color:#999}
.bar{height:.5rem;background:#eee;border-radius:4px;overflow:hidden;margin:.6rem 0}.bar span{display:block;height:100%;background:#0b5}
pre{background:#f4f4f4;border-radius:6px;padding:.9rem;overflow-x:auto;font-size:.85rem;white-space:pre-wrap}</style>`;

const pc = (v: number | null) => (v === null ? "—" : `${v}%`);
const nm = (v: number | null) => (v === null ? "—" : String(v));
const strip = (s: string) => `<span class="strip">${[...s].map((m) => `<i class="${m === "C" ? "C" : "D"}">${m === "C" ? "C" : "D"}</i>`).join("")}</span>`;
const heat = (v: number) => (v >= 2.75 ? "g3" : v >= 2 ? "g2" : v >= 1.25 ? "g1" : "g0");

type Results = Awaited<ReturnType<typeof duelResults>>;
type Standing = Results["standings"][number];

/** A few plain-words headlines, only once each model has enough games to say anything. */
export function headlines(r: Results): string[] {
  const s = r.standings.filter((x) => x.matches >= 2);
  if (s.length < 2) return [];
  const by = (f: (x: Standing) => number | null, dir: 1 | -1) =>
    s.filter((x) => f(x) !== null).sort((a, b) => dir * ((f(b) ?? 0) - (f(a) ?? 0)))[0];
  const out: string[] = [];
  const top = by((x) => x.points_per_round, 1);
  if (top) out.push(`<b>${esc(top.name)} leads</b><span>${top.points_per_round} points per round. Mutual cooperation every round is 3.</span>`);
  const nice = by((x) => x.cooperate_pct, 1);
  if (nice) out.push(`<b>Most cooperative: ${esc(nice.name)}</b><span>cooperated in ${nice.cooperate_pct}% of rounds.</span>`);
  const first = by((x) => (x.never_defected_first_pct === null ? null : 100 - x.never_defected_first_pct), 1);
  if (first && (first.never_defected_first_pct ?? 100) < 100) out.push(`<b>Most likely to strike first: ${esc(first.name)}</b><span>defected first in ${100 - (first.never_defected_first_pct ?? 100)}% of its matches.</span>`);
  const fg = by((x) => x.forgive_after_betrayal_pct, 1);
  if (fg) out.push(`<b>Most forgiving: ${esc(fg.name)}</b><span>cooperated again right after a betrayal ${fg.forgive_after_betrayal_pct}% of the time.</span>`);
  return out;
}

function quotes(q: Record<string, string>): string {
  const label: Record<string, string> = { opened: "Its first move", unprovoked: "Striking first", retaliated: "Hitting back", forgave: "Forgiving" };
  return ["opened", "unprovoked", "retaliated", "forgave"]
    .filter((k) => q[k])
    .map((k) => `<p class="q"><b>${label[k]}:</b> “${esc(q[k])}”</p>`)
    .join("");
}

export async function duelsPage(env: Env): Promise<Response> {
  const r = await duelResults(env.DB);
  const matches = await listDuels(env.DB);
  const st = r.status;
  const done = st.finished + st.failed;
  const running = st.total === 0 || done < st.total;
  const claudeWaiting = !env.ANTHROPIC_API_KEY && matches.some((m) => m.status === "queued" && (ROSTER[m.a]?.provider === "anthropic" || ROSTER[m.b]?.provider === "anthropic"));
  const ranked = r.standings.filter((x) => x.matches > 0);
  const waiting = r.standings.filter((x) => x.matches === 0);

  const heads = headlines(r);
  const standings = ranked.length
    ? ranked.map((x) => `<tr><td>${x.rank}</td><td><strong>${esc(x.name)}</strong><br><span class="mut">${esc(x.maker)}</span></td><td>${esc(x.style)}</td><td>${nm(x.points_per_round)}</td><td>${x.wins}-${x.draws}-${x.losses}</td><td>${pc(x.cooperate_pct)}</td><td>${pc(x.never_defected_first_pct)}</td><td>${pc(x.forgive_after_betrayal_pct)}</td><td>${pc(x.unprovoked_defection_pct)}</td></tr>`).join("")
    : `<tr><td colspan="9" class="mut">No finished matches yet. The first ones finish within a few minutes of the start.</td></tr>`;

  const cards = ranked.map((x) => `<div class="card"><h3>${esc(x.name)}</h3><span class="mut">${esc(x.maker)} · runs on ${esc(x.runs_on)}</span><br>
<span class="badge">${esc(x.style)}</span>${x.style_about ? `<p>It ${esc(x.style_about)}.</p>` : ""}
<p>${esc(x.profile)}</p>
${x.against_itself ? `<p><b>Against a copy of itself:</b> both cooperated in ${pc(x.against_itself.mutual_cooperation_pct)} of rounds.</p>` : ""}
${quotes(x.quotes as Record<string, string>)}</div>`).join("");

  const keys = TOURNAMENT.players.filter((k) => ranked.some((x) => x.key === k));
  const grid = keys.length >= 2
    ? `<div class="scroll-x"><table><tr><th>Row scored against column</th>${keys.map((k) => `<th>${esc(ROSTER[k].name)}</th>`).join("")}</tr>${
      r.head_to_head.filter((h) => keys.includes(h.model)).map((h) => `<tr><th>${esc(h.name)}</th>${keys.map((o) => {
        if (o === h.model) return `<td class="h x">·</td>`;
        const g = (h.against as Record<string, { matches: number; points_per_round: number } | null>)[o];
        return g ? `<td class="h ${heat(g.points_per_round)}" title="${g.matches} match(es)">${g.points_per_round}</td>` : `<td class="h x">—</td>`;
      }).join("")}</tr>`).join("")}</table></div>
<p class="mut">Points per round the row model scored against the column model. Green is 3 or close: they cooperated. Red is under 1.25: the row model was exploited or both kept defecting.</p>`
    : `<p class="mut">The grid fills in as pairs finish their matches.</p>`;

  const live = matches.filter((m) => m.status === "active");
  const fin = matches.filter((m) => m.status === "finished").slice(0, 30);
  const mrow = (m: (typeof matches)[number]) => `<tr><td><a href="/arena/dilemma/models/${esc(m.id)}">${esc(m.a_name)} vs ${esc(m.b_name)}</a></td><td>${m.rounds}</td><td>${m.score_a}–${m.score_b}</td><td>${strip(m.a_moves)}<br>${strip(m.b_moves)}</td></tr>`;
  const table = (rows: typeof matches, empty: string) => rows.length
    ? `<div class="scroll-x"><table><tr><th>Match</th><th>Rounds</th><th>Score</th><th>Moves (top: first model)</th></tr>${rows.map(mrow).join("")}</table></div>`
    : `<p class="mut">${empty}</p>`;

  const pctDone = st.total ? Math.round((100 * done) / st.total) : 0;
  return page("Which AI models cooperate? Model vs model prisoner's dilemma", `${STYLE}
<h1>Which AI models cooperate?</h1>
<div class="lead"><p><strong>AI models play the repeated prisoner's dilemma against each other.</strong> Each round both sides choose at the same time: cooperate or defect. Both cooperating pays 3 each, both defecting 1 each, and a defector facing a cooperator takes 5 while the cooperator gets nothing. Neither side knows who it is playing or when the match ends, and each says why it made every move.</p>
<p>${esc(r.how.format)} This is the same game as the <a href="/arena/dilemma">agent experiment</a>, but here the models play each other directly.</p></div>
<p><strong>${st.finished} of ${st.total || "—"} matches finished</strong>${st.active ? `, ${st.active} being played now` : ""}${st.failed ? `, ${st.failed} stopped after repeated errors` : ""}.${running ? " This page refreshes every minute." : " The round robin is complete."}</p>
<div class="bar"><span style="width:${pctDone}%"></span></div>
${claudeWaiting ? `<p class="mut">The Claude models' matches are queued and start as soon as they are switched on.</p>` : ""}
${heads.length ? `<div class="tiles">${heads.map((h) => `<div class="tile">${h}</div>`).join("")}</div>` : ""}
<h2>Standings</h2>
<div class="scroll-x"><table><tr><th>#</th><th>Model</th><th>Style</th><th>Points / round</th><th>W-D-L</th><th>Cooperate</th><th>Never struck first</th><th>Forgive</th><th>Unprovoked D</th></tr>${standings}</table></div>
<p class="mut">${esc(r.how.ranking)} “Forgive” is how often it cooperated right after being betrayed. “Unprovoked D” is how often it defected on an opponent that had just cooperated.${waiting.length ? ` Still waiting for their first finished match: ${waiting.map((x) => esc(x.name)).join(", ")}.` : ""}</p>
<h2>How each model plays</h2>
${cards ? `<div class="cards">${cards}</div>` : `<p class="mut">Profiles appear once each model has finished a match.</p>`}
<h2>Head to head</h2>
${grid}
<h2>Being played now</h2>
${table(live, "Nothing is mid-match right now.")}
<h2>Finished matches</h2>
${table(fin, "None yet.")}
<p class="mut">Every move and every reason: <a href="${esc(r.download)}">download the CSV</a> or read the <a href="/v1/arena/dilemma/models">JSON</a>.</p>
<h2>How it works</h2>
<p>${esc(r.how.settings)} A model that gives no clear answer is asked again; a match stops after ${DUEL.max_fails} failed tries in a row.</p>
<p>The exact prompt every model gets, followed by its own side of the history so far:</p>
<pre>${esc(r.how.prompt)}</pre>
<p class="mut">Model versions: ${r.standings.map((x) => `${esc(x.name)} (${x.model_ids.length ? x.model_ids.map(esc).join(", ") : "not played yet"})`).join(" · ")}.</p>`, running ? 60 : 0);
}

export async function duelMatchPage(env: Env, id: string): Promise<Response> {
  const d = await getDuel(env.DB, id);
  const title = `${d.a.name} vs ${d.b.name}${d.self_play ? " (itself)" : ""}`;
  const rows = d.rounds.map((x) => `<tr><td>${x.n}</td><td><span class="mv ${x.a}">${x.a}</span> ${x.a_reason ? esc(x.a_reason) : '<span class="mut">no reason given</span>'}</td><td><span class="mv ${x.b}">${x.b}</span> ${x.b_reason ? esc(x.b_reason) : '<span class="mut">no reason given</span>'}</td><td>${x.points[0]}–${x.points[1]}</td></tr>`).join("");
  const state = d.status === "finished" ? `Finished after ${d.rounds_played} rounds.` : d.status === "failed" ? `Stopped after ${d.rounds_played} rounds because a model kept failing to answer.` : d.status === "active" ? `Being played now: ${d.rounds_played} rounds so far.` : "Queued.";
  return page(`${title}: prisoner's dilemma`, `${STYLE}
<p class="mut"><a href="/arena/dilemma/models">← All model matches</a></p>
<h1>${esc(title)}</h1>
<p>${state} Score <strong>${d.score.a}–${d.score.b}</strong>.</p>
<div class="scroll-x"><table><tr><th>Round</th><th>${esc(d.a.name)}${d.a.model ? `<br><span class="mut">${esc(d.a.model)}</span>` : ""}</th><th>${esc(d.b.name)}${d.self_play ? " (copy)" : ""}${d.b.model ? `<br><span class="mut">${esc(d.b.model)}</span>` : ""}</th><th>Points</th></tr>${rows || `<tr><td colspan="4" class="mut">No rounds yet.</td></tr>`}</table></div>`, d.status === "active" || d.status === "queued" ? 30 : 0);
}
