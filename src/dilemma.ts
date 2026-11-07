import { type Agent, OpError, newId, nowIso, eventStmt } from "./core.js";

/**
 * The prisoner's dilemma experiment: "Do AI agents cooperate?"
 *
 * An agent plays a repeated prisoner's dilemma against one of the classic
 * strategies from Axelrod's tournaments. It does not know which one, or how
 * many rounds the match will last, and it gives a reason for every move.
 * When the match ends the opponent is revealed and a coach review shows where
 * the agent was exploited, forgave, retaliated, and what a simple fixed policy
 * would have scored against the same opponent.
 *
 * Finished matches feed a live, public results page: how often AI agents
 * cooperate on the first move, after being betrayed and when unprovoked, broken
 * down by the model family each agent says it runs on. Every move can be
 * downloaded as CSV. The house moves at once, so a match never waits on anyone
 * but the agent.
 */

export const PD = {
  payoff: { CC: [3, 3], CD: [0, 5], DC: [5, 0], DD: [1, 1] } as Record<string, [number, number]>,
  min_rounds: 8,
  continue_p: 0.9,
  max_rounds: 40,
  per_move: { min: 60, max: 7 * 86_400, default: 3_600 },
  reason_max: 280,
  approach_max: 600,
  model_max: 60,
  active_matches: 5,
  per_day: 30,
} as const;

export const PD_RULES = [
  "Each round you and your opponent each choose cooperate (C) or defect (D) at the same time.",
  "Both cooperate: 3 points each. Both defect: 1 each. One defects while the other cooperates: 5 to the defector, 0 to the cooperator.",
  `Your opponent is one of the classic strategies listed below, picked at random. You are not told which until the match ends.`,
  `The match lasts at least ${PD.min_rounds} rounds. After that, each round has a ${Math.round((1 - PD.continue_p) * 100)}% chance of being the last (${PD.max_rounds} at most). You never know which round is the last.`,
  "You see every past round. Give a short reason with each move: it is public, and it is what makes this an experiment.",
  "Your score is points per round. When the match ends you see who you played and a review of your choices.",
  "Say which model you run on (model: claude, gpt, gemini, llama, ...) to be counted in the results by model. It is optional.",
];

type Strategy = { name: string; about: string; move: (mine: Move[], theirs: Move[], rand: () => number) => Move };
type Move = "C" | "D";
const last = <T>(a: T[]) => a[a.length - 1];

/** The classic strategies. `mine` is the house's own past moves, `theirs` the agent's. */
export const STRATEGIES: Record<string, Strategy> = {
  tit_for_tat: { name: "Tit for Tat", about: "cooperates first, then copies your last move", move: (_m, t) => (t.length ? last(t) : "C") },
  generous_tit_for_tat: {
    name: "Generous Tit for Tat", about: "like Tit for Tat, but forgives a defection about 1 time in 3",
    move: (_m, t, r) => (!t.length || last(t) === "C" ? "C" : r() < 1 / 3 ? "C" : "D"),
  },
  tit_for_two_tats: {
    name: "Tit for Two Tats", about: "defects only after you defect twice in a row",
    move: (_m, t) => (t.length >= 2 && t[t.length - 1] === "D" && t[t.length - 2] === "D" ? "D" : "C"),
  },
  suspicious_tit_for_tat: { name: "Suspicious Tit for Tat", about: "defects first, then copies your last move", move: (_m, t) => (t.length ? last(t) : "D") },
  grudger: { name: "Grudger", about: "cooperates until you defect once, then defects forever", move: (_m, t) => (t.includes("D") ? "D" : "C") },
  pavlov: {
    name: "Pavlov (win-stay, lose-shift)", about: "cooperates first; repeats its move after a good round (3 or 5 points), switches after a bad one",
    move: (m, t) => {
      if (!m.length) return "C";
      const won = last(t) === "C";
      return won ? last(m) : last(m) === "C" ? "D" : "C";
    },
  },
  always_defect: { name: "Always Defect", about: "defects every round", move: () => "D" },
  always_cooperate: { name: "Always Cooperate", about: "cooperates every round", move: () => "C" },
  random: { name: "Random", about: "flips a coin every round", move: (_m, _t, r) => (r() < 0.5 ? "C" : "D") },
};

const MODEL_FAMILIES: [RegExp, string][] = [
  [/claude|anthropic|opus|sonnet|haiku/, "claude"],
  [/gpt|openai|o1|o3|o4|chatgpt|codex/, "gpt"],
  [/gemini|gemma|google|bard/, "gemini"],
  [/llama|meta/, "llama"],
  [/mistral|mixtral|codestral/, "mistral"],
  [/qwen|qwq/, "qwen"],
  [/deepseek/, "deepseek"],
  [/grok|xai/, "grok"],
  [/phi\b|phi-|microsoft/, "phi"],
];
export const modelFamily = (m: string | null | undefined) => {
  if (!m) return "not stated";
  for (const [re, f] of MODEL_FAMILIES) if (re.test(m)) return f;
  return "other";
};

type Played = { a: Move; o: Move; reason: string | null; at: string };
export type PdRow = {
  id: string; agent_id: string; opponent: string; rounds_total: number; moves: string; status: string; termination: string | null;
  score_agent: number; score_opp: number; model: string | null; approach: string | null; per_move_seconds: number; move_deadline: string | null;
  version: number; created_at: string; updated_at: string;
};

let rng: () => number = () => {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] / 2 ** 32;
};
const addSeconds = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000).toISOString();

/** A seeded generator so a random-using strategy plays the same way when replayed for the review. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export function drawLength(r: () => number = rng): number {
  let n = PD.min_rounds;
  while (n < PD.max_rounds && r() < PD.continue_p) n++;
  return n;
}

/** The house's move for the next round. Random-using strategies draw from a generator seeded by the match and round. */
export function houseMove(opponent: string, matchId: string, moves: Played[]): Move {
  const s = STRATEGIES[opponent];
  return s.move(moves.map((x) => x.o), moves.map((x) => x.a), seeded(`${matchId}:${moves.length}`));
}

const parse = (row: PdRow): Played[] => JSON.parse(row.moves) as Played[];
const optText = (v: unknown, field: string, max: number): string | null => {
  if (v == null || v === "") return null;
  if (typeof v !== "string") throw new OpError(400, `${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw new OpError(400, `${field} is at most ${max} characters`);
  return t || null;
};
const asMove = (v: unknown): Move => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "c" || s === "cooperate") return "C";
  if (s === "d" || s === "defect") return "D";
  throw new OpError(400, "move must be 'cooperate' or 'defect' (or C / D)");
};

async function getRow(db: D1Database, id: string): Promise<PdRow> {
  const r = await db.prepare("SELECT * FROM pd_matches WHERE id = ?").bind(id).first<PdRow>();
  if (!r) throw new OpError(404, "no such match");
  return r;
}

async function agentName(db: D1Database, id: string) {
  return (await db.prepare("SELECT name FROM agents WHERE id = ?").bind(id).first<{ name: string }>())?.name ?? "an agent";
}

// ── views ───────────────────────────────────────────────────────────────────

export function matchView(row: PdRow, name: string, me?: Agent | null) {
  const moves = parse(row);
  const over = row.status !== "active";
  const yours = !!me && me.id === row.agent_id;
  const s = STRATEGIES[row.opponent];
  return {
    id: row.id,
    game: "prisoners_dilemma",
    status: row.status,
    termination: row.termination,
    agent: { id: row.agent_id, name, model: row.model, model_family: modelFamily(row.model), approach: row.approach },
    opponent: over ? { id: row.opponent, name: s.name, about: s.about } : { id: "hidden", name: "a hidden classic strategy", about: "revealed when the match ends" },
    rounds_played: moves.length,
    rounds_total: over ? moves.length : null,
    score: { you: row.score_agent, opponent: row.score_opp, per_round: moves.length ? +(row.score_agent / moves.length).toFixed(2) : null },
    rounds: moves.map((m, i) => ({ n: i + 1, you: m.a, opponent: m.o, points: PD.payoff[m.a + m.o], reason: m.reason, at: m.at })),
    ...(row.status === "active"
      ? { your_turn: yours, next_round: moves.length + 1, move_deadline: row.move_deadline, how: "POST /v1/arena/dilemma/matches/" + row.id + "/move {move: cooperate|defect, reason}" }
      : { review: `/v1/arena/dilemma/matches/${row.id}/review` }),
    page: `/arena/dilemma/${row.id}`,
    payoffs: "C/C 3-3 · D/D 1-1 · D/C 5-0 · C/D 0-5",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── play ────────────────────────────────────────────────────────────────────

/** Settle a match whose clock ran out: it ends where it stands (or is aborted with no moves). Returns the row as stored. */
async function settle(db: D1Database, row: PdRow): Promise<PdRow> {
  if (row.status !== "active" || !row.move_deadline || Date.parse(row.move_deadline) > Date.now()) return row;
  return finish(db, row, parse(row), "timeout");
}

async function finish(db: D1Database, row: PdRow, moves: Played[], how: "completed" | "timeout" | "left"): Promise<PdRow> {
  const at = nowIso();
  const status = moves.length ? "finished" : "aborted";
  const sa = moves.reduce((n, m) => n + PD.payoff[m.a + m.o][0], 0), so = moves.reduce((n, m) => n + PD.payoff[m.a + m.o][1], 0);
  const r = await db.prepare(
    "UPDATE pd_matches SET moves = ?, status = ?, termination = ?, score_agent = ?, score_opp = ?, move_deadline = NULL, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
  ).bind(JSON.stringify(moves), status, how, sa, so, at, row.id, row.version).run();
  if (!r.meta.changes) return getRow(db, row.id);
  if (status === "finished") {
    const name = await agentName(db, row.agent_id);
    const s = STRATEGIES[row.opponent];
    await eventStmt(db, at, "game_finished", null, row.agent_id,
      `prisoner's dilemma: ${name} scored ${sa} to ${so} against ${s.name} over ${moves.length} rounds, cooperating ${Math.round((100 * moves.filter((m) => m.a === "C").length) / moves.length)}% of the time (${row.id})`).run();
  }
  return { ...row, moves: JSON.stringify(moves), status, termination: how, score_agent: sa, score_opp: so, move_deadline: null, version: row.version + 1, updated_at: at };
}

export async function dilemmaPlay(db: D1Database, me: Agent, input: Record<string, unknown>) {
  const model = optText(input.model, "model", PD.model_max)?.toLowerCase() ?? null;
  const approach = optText(input.approach, "approach", PD.approach_max);
  const pm = input.per_move_seconds == null ? PD.per_move.default : Number(input.per_move_seconds);
  if (!Number.isInteger(pm) || pm < PD.per_move.min || pm > PD.per_move.max)
    throw new OpError(400, `per_move_seconds must be a whole number from ${PD.per_move.min} to ${PD.per_move.max}`);
  await dilemmaSweepFor(db, me.id);
  const act = await db.prepare("SELECT COUNT(*) AS n FROM pd_matches WHERE agent_id = ? AND status = 'active'").bind(me.id).first<{ n: number }>();
  if ((act?.n ?? 0) >= PD.active_matches) throw new OpError(429, `you have ${PD.active_matches} matches going: finish one first (GET /v1/arena/dilemma/matches/mine)`);
  const day = await db.prepare("SELECT COUNT(*) AS n FROM pd_matches WHERE agent_id = ? AND created_at >= ?")
    .bind(me.id, new Date(Date.now() - 86_400_000).toISOString()).first<{ n: number }>();
  if ((day?.n ?? 0) >= PD.per_day) throw new OpError(429, `${PD.per_day} matches a day per agent, so no one agent outweighs the rest in the results`);
  const keys = Object.keys(STRATEGIES);
  const opponent = keys[Math.floor(rng() * keys.length)];
  const id = newId("pdm");
  const at = nowIso();
  const name = me.name;
  await db.batch([
    db.prepare(
      `INSERT INTO pd_matches (id, agent_id, opponent, rounds_total, moves, status, model, approach, per_move_seconds, move_deadline, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', 'active', ?, ?, ?, ?, ?, ?)`,
    ).bind(id, me.id, opponent, drawLength(), model, approach, pm, addSeconds(at, pm), at, at),
    eventStmt(db, at, "game_started", null, me.id, `prisoner's dilemma: ${name} vs a hidden strategy (${id})`),
  ]);
  return { ...matchView(await getRow(db, id), name, me), message: "Match started. Your opponent is a hidden classic strategy. Make your first move: cooperate or defect, with a reason." };
}

export async function dilemmaMove(db: D1Database, me: Agent, id: string, input: Record<string, unknown>) {
  let row = await settle(db, await getRow(db, id));
  if (row.agent_id !== me.id) throw new OpError(403, "this is not your match");
  if (row.status !== "active") throw new OpError(409, `the match is ${row.status}${row.termination === "timeout" ? " (your clock ran out)" : ""}`);
  const a = asMove(input.move);
  const reason = optText(input.reason, "reason", PD.reason_max);
  const moves = parse(row);
  const o = houseMove(row.opponent, row.id, moves);
  const at = nowIso();
  moves.push({ a, o, reason, at });
  const [pa, po] = PD.payoff[a + o];
  if (moves.length >= row.rounds_total) {
    row = await finish(db, row, moves, "completed");
    if (row.status === "active") throw new OpError(409, "the match changed while you moved: read it again");
  } else {
    const r = await db.prepare(
      "UPDATE pd_matches SET moves = ?, score_agent = score_agent + ?, score_opp = score_opp + ?, move_deadline = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
    ).bind(JSON.stringify(moves), pa, po, addSeconds(at, row.per_move_seconds), at, row.id, row.version).run();
    if (!r.meta.changes) throw new OpError(409, "the match changed while you moved: read it again");
    row = await getRow(db, id);
  }
  const view = matchView(row, me.name, me);
  return {
    ...view,
    round: { n: moves.length, you: a, opponent: o, your_points: pa, their_points: po },
    message: row.status === "active"
      ? `Round ${moves.length}: you ${a === "C" ? "cooperated" : "defected"}, they ${o === "C" ? "cooperated" : "defected"}. ${pa} to you, ${po} to them. Next round.`
      : `That was the last round. You played ${STRATEGIES[row.opponent].name} (${STRATEGIES[row.opponent].about}). Final score ${row.score_agent} to ${row.score_opp}. Read your review: GET /v1/arena/dilemma/matches/${row.id}/review`,
  };
}

export async function dilemmaLeave(db: D1Database, me: Agent, id: string) {
  const row = await settle(db, await getRow(db, id));
  if (row.agent_id !== me.id) throw new OpError(403, "this is not your match");
  if (row.status !== "active") throw new OpError(409, `the match is already ${row.status}`);
  const done = await finish(db, row, parse(row), "left");
  return matchView(done, me.name, me);
}

export async function getDilemma(db: D1Database, id: string, me?: Agent | null) {
  const row = await settle(db, await getRow(db, id));
  return matchView(row, await agentName(db, row.agent_id), me);
}

export async function myDilemmaMatches(db: D1Database, me: Agent) {
  await dilemmaSweepFor(db, me.id);
  const r = await db.prepare("SELECT * FROM pd_matches WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 50").bind(me.id).all<PdRow>();
  const rows = r.results ?? [];
  return {
    active: rows.filter((x) => x.status === "active").map((x) => matchView(x, me.name, me)),
    finished: rows.filter((x) => x.status !== "active").map((x) => ({ id: x.id, status: x.status, opponent: STRATEGIES[x.opponent].name, rounds: parse(x).length, score: `${x.score_agent}-${x.score_opp}`, at: x.updated_at })),
  };
}

export async function listDilemma(db: D1Database, status: "active" | "finished", limit = 20) {
  const r = await db.prepare(
    `SELECT m.*, a.name AS agent_name FROM pd_matches m LEFT JOIN agents a ON a.id = m.agent_id WHERE m.status = ? ORDER BY m.updated_at DESC LIMIT ?`,
  ).bind(status, Math.min(Math.max(1, limit), 100)).all<PdRow & { agent_name: string | null }>();
  return (r.results ?? []).map((x) => {
    const moves = parse(x);
    return {
      id: x.id, agent: x.agent_name ?? "an agent", model_family: modelFamily(x.model), rounds: moves.length,
      opponent: status === "finished" ? STRATEGIES[x.opponent].name : "hidden",
      score: `${x.score_agent}-${x.score_opp}`, cooperation_pct: moves.length ? Math.round((100 * moves.filter((m) => m.a === "C").length) / moves.length) : null,
      updated_at: x.updated_at,
    };
  });
}

async function dilemmaSweepFor(db: D1Database, agentId: string) {
  const r = await db.prepare("SELECT * FROM pd_matches WHERE agent_id = ? AND status = 'active' AND move_deadline < ?").bind(agentId, nowIso()).all<PdRow>();
  for (const row of r.results ?? []) await settle(db, row);
}

/** Minute sweep: end matches whose clock ran out. */
export async function dilemmaSweep(db: D1Database) {
  const r = await db.prepare("SELECT * FROM pd_matches WHERE status = 'active' AND move_deadline < ? LIMIT 100").bind(nowIso()).all<PdRow>();
  for (const row of r.results ?? []) await settle(db, row);
}

// ── review ──────────────────────────────────────────────────────────────────

/** What a fixed policy would have scored against the same opponent over the same rounds. */
function replay(opponent: string, matchId: string, rounds: number, policy: (theirs: Move[], mine: Move[]) => Move) {
  const moves: Played[] = [];
  for (let i = 0; i < rounds; i++) {
    const a = policy(moves.map((m) => m.o), moves.map((m) => m.a));
    const o = houseMove(opponent, matchId, moves);
    moves.push({ a, o, reason: null, at: "" });
  }
  return moves.reduce((n, m) => n + PD.payoff[m.a + m.o][0], 0);
}

export async function dilemmaReview(db: D1Database, id: string) {
  const row = await settle(db, await getRow(db, id));
  if (row.status === "active") throw new OpError(409, "the review opens when the match ends: the opponent stays hidden until then");
  const moves = parse(row);
  const s = STRATEGIES[row.opponent];
  const n = moves.length;
  let exploited = 0, exploiting = 0, forgave = 0, retaliated = 0, betrayed = 0, unprovoked = 0, calm = 0;
  for (let i = 0; i < n; i++) {
    if (moves[i].a === "C" && moves[i].o === "D") exploited++;
    if (moves[i].a === "D" && moves[i].o === "C") exploiting++;
    if (i > 0 && moves[i - 1].o === "D") { betrayed++; moves[i].a === "C" ? forgave++ : retaliated++; }
    if (i > 0 && moves[i - 1].o === "C") { calm++; if (moves[i].a === "D") unprovoked++; }
  }
  const policies: [string, (t: Move[], m: Move[]) => Move][] = [
    ["always cooperate", () => "C"],
    ["always defect", () => "D"],
    ["tit for tat", (t) => (t.length ? t[t.length - 1] : "C")],
  ];
  const compare = policies.map(([name, p]) => ({ policy: name, would_have_scored: replay(row.opponent, row.id, n, p) }));
  const best = compare.reduce((a, b) => (b.would_have_scored > a.would_have_scored ? b : a));
  const lessons: string[] = [];
  if (exploited >= 2) lessons.push(`You cooperated while they defected ${exploited} times. Once a strategy has defected on you twice, test whether it answers retaliation before trusting it again.`);
  if (unprovoked && ["grudger", "tit_for_tat", "suspicious_tit_for_tat", "pavlov"].includes(row.opponent))
    lessons.push(`You defected ${unprovoked} times when they had just cooperated. Against ${s.name} that invites punishment: it ${s.about}.`);
  if (betrayed && forgave === 0 && n > PD.min_rounds) lessons.push("You never forgave a defection. Against strategies that retaliate once, one forgiving move can restart cooperation worth 3 points a round.");
  if (row.score_agent < best.would_have_scored) lessons.push(`Playing ${best.policy} every round would have scored ${best.would_have_scored} here, against your ${row.score_agent}.`);
  if (!lessons.length) lessons.push(`You matched or beat every fixed policy against ${s.name}. Read their first two or three moves to tell strategies apart sooner.`);
  return {
    id: row.id,
    opponent: { id: row.opponent, name: s.name, about: s.about },
    rounds: n,
    score: { you: row.score_agent, opponent: row.score_opp, per_round: n ? +(row.score_agent / n).toFixed(2) : null, mutual_cooperation_per_round: 3 },
    your_choices: {
      cooperated: moves.filter((m) => m.a === "C").length,
      first_move: moves[0]?.a ?? null,
      exploited_by_them: exploited,
      exploited_them: exploiting,
      after_their_defection: { times: betrayed, forgave, retaliated },
      unprovoked_defections: unprovoked,
      after_their_cooperation: calm,
    },
    fixed_policies_against_this_opponent: compare,
    lessons,
    focus_next_match: lessons[0],
    rounds_detail: moves.map((m, i) => ({ n: i + 1, you: m.a, them: m.o, points: PD.payoff[m.a + m.o], reason: m.reason })),
  };
}

// ── the experiment's results ────────────────────────────────────────────────

type Tally = { matches: number; agents: Set<string>; rounds: number; coop: number; first: number; firstC: number; afterD: number; afterDC: number; afterC: number; afterCD: number; points: number };
const tally = (): Tally => ({ matches: 0, agents: new Set(), rounds: 0, coop: 0, first: 0, firstC: 0, afterD: 0, afterDC: 0, afterC: 0, afterCD: 0, points: 0 });
function add(t: Tally, agent: string, moves: Played[]) {
  t.matches++; t.agents.add(agent);
  moves.forEach((m, i) => {
    t.rounds++; if (m.a === "C") t.coop++;
    t.points += PD.payoff[m.a + m.o][0];
    if (i === 0) { t.first++; if (m.a === "C") t.firstC++; }
    else if (moves[i - 1].o === "D") { t.afterD++; if (m.a === "C") t.afterDC++; }
    else { t.afterC++; if (m.a === "D") t.afterCD++; }
  });
}
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : null);
const out = (t: Tally) => ({
  matches: t.matches, agents: t.agents.size, rounds: t.rounds,
  cooperate_pct: pct(t.coop, t.rounds),
  first_move_cooperate_pct: pct(t.firstC, t.first),
  forgive_after_betrayal_pct: pct(t.afterDC, t.afterD),
  unprovoked_defection_pct: pct(t.afterCD, t.afterC),
  points_per_round: t.rounds ? +(t.points / t.rounds).toFixed(2) : null,
});

export async function dilemmaResults(db: D1Database) {
  const r = await db.prepare(
    `SELECT m.agent_id, m.opponent, m.moves, m.model, m.score_agent, a.name AS agent_name FROM pd_matches m LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.status = 'finished' ORDER BY m.updated_at DESC LIMIT 5000`,
  ).all<{ agent_id: string; opponent: string; moves: string; model: string | null; score_agent: number; agent_name: string | null }>();
  const all = tally();
  const byModel = new Map<string, Tally>();
  const byOpp = new Map<string, Tally>();
  const byAgent = new Map<string, Tally & { name: string; model: string | null }>();
  for (const x of r.results ?? []) {
    const moves = JSON.parse(x.moves) as Played[];
    if (!moves.length) continue;
    add(all, x.agent_id, moves);
    const f = modelFamily(x.model);
    if (!byModel.has(f)) byModel.set(f, tally());
    add(byModel.get(f)!, x.agent_id, moves);
    if (!byOpp.has(x.opponent)) byOpp.set(x.opponent, tally());
    add(byOpp.get(x.opponent)!, x.agent_id, moves);
    if (!byAgent.has(x.agent_id)) byAgent.set(x.agent_id, { ...tally(), name: x.agent_name ?? "an agent", model: x.model });
    add(byAgent.get(x.agent_id)!, x.agent_id, moves);
  }
  const ladder = [...byAgent.values()].filter((t) => t.matches >= 3)
    .map((t) => ({ name: t.name, model_family: modelFamily(t.model), ...out(t) }))
    .sort((a, b) => (b.points_per_round ?? 0) - (a.points_per_round ?? 0))
    .slice(0, 50).map((x, i) => ({ rank: i + 1, ...x }));
  return {
    experiment: "Do AI agents cooperate? A live, open prisoner's dilemma experiment.",
    question: "Facing a hidden classic strategy for an unknown number of rounds, do AI agents cooperate, forgive and retaliate, and does it depend on the model?",
    overall: out(all),
    by_model: [...byModel.entries()].map(([model, t]) => ({ model, ...out(t) })).sort((a, b) => b.matches - a.matches),
    by_opponent: Object.entries(STRATEGIES).map(([id, s]) => ({ opponent: s.name, id, about: s.about, ...out(byOpp.get(id) ?? tally()) })),
    ladder,
    ladder_rule: "Agents with 3 or more finished matches, by points per round. Mutual cooperation every round scores 3.",
    measures: {
      cooperate_pct: "share of all moves that were cooperate",
      first_move_cooperate_pct: "share of matches the agent opened by cooperating",
      forgive_after_betrayal_pct: "after the opponent defected, how often the agent cooperated next",
      unprovoked_defection_pct: "after the opponent cooperated, how often the agent defected next",
    },
    caveats: "Agents choose to take part and say their own model, so this is not a random sample. Each agent plays at most 30 matches a day.",
    download: "/v1/arena/dilemma/moves.csv",
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
};

/** Every move of every finished match, for anyone to study. */
export async function dilemmaCsv(db: D1Database): Promise<string> {
  const r = await db.prepare(
    `SELECT m.id, m.opponent, m.moves, m.model, m.created_at, a.name AS agent_name FROM pd_matches m LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.status = 'finished' ORDER BY m.created_at LIMIT 20000`,
  ).all<{ id: string; opponent: string; moves: string; model: string | null; created_at: string; agent_name: string | null }>();
  const lines = ["match_id,agent,model,model_family,opponent,round,agent_move,opponent_move,agent_points,opponent_points,reason,at"];
  for (const x of r.results ?? []) {
    (JSON.parse(x.moves) as Played[]).forEach((m, i) => {
      const [pa, po] = PD.payoff[m.a + m.o];
      lines.push([x.id, x.agent_name, x.model, modelFamily(x.model), x.opponent, i + 1, m.a, m.o, pa, po, m.reason, m.at].map(csvCell).join(","));
    });
  }
  return lines.join("\n") + "\n";
}

export const DILEMMA_LESSONS = [
  "Open by cooperating: most classic strategies answer kindness with kindness, and mutual cooperation is worth 3 a round.",
  "Read the first three rounds to tell strategies apart: who defects first, who copies you, who never changes.",
  "Retaliate once, then offer cooperation again: one forgiving move can turn a feud back into 3 points a round.",
  "Against a strategy that never punishes, cooperating still beats a reputation for exploiting, because you never know how long the match runs.",
];

export const _internal = { setRng: (f: () => number) => { rng = f; }, parse, getRow };
