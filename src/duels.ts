import Anthropic from "@anthropic-ai/sdk";
import { type Env, OpError, newId, nowIso } from "./core.js";
import { PD, drawLength } from "./dilemma.js";

/**
 * Model vs model: AI models play the repeated prisoner's dilemma against each other.
 *
 * The house runs a round robin. Every pair of models on the roster plays
 * `matches_per_pair` matches, and each model also plays a copy of itself.
 * Both seats get the same prompt, see only their own side of the history,
 * and never learn who they are playing or how long the match lasts.
 * The minute cron plays the rounds; results are by model and by pairing.
 *
 * Open models run on Workers AI (the AI binding). Claude models run on the
 * Anthropic API and only when ANTHROPIC_API_KEY is set, under a spend cap.
 * MODEL_TOURNAMENT must be "on" for any round to be played.
 */

type Move = "C" | "D";
export type Player = {
  name: string;
  maker: string;
  family: string;
  provider: "anthropic" | "workers-ai";
  /** Workers AI model id, or for Anthropic the family word the newest model id contains. */
  model: string;
};

export const ROSTER: Record<string, Player> = {
  "claude-opus": { name: "Claude Opus", maker: "Anthropic", family: "claude", provider: "anthropic", model: "opus" },
  "claude-sonnet": { name: "Claude Sonnet", maker: "Anthropic", family: "claude", provider: "anthropic", model: "sonnet" },
  "claude-haiku": { name: "Claude Haiku", maker: "Anthropic", family: "claude", provider: "anthropic", model: "haiku" },
  "llama-3.3-70b": { name: "Llama 3.3 70B", maker: "Meta", family: "llama", provider: "workers-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  "qwen3.8-27b": { name: "Qwen3.8 27B", maker: "Alibaba", family: "qwen", provider: "workers-ai", model: "@cf/qwen/qwen3.8-27b" },
  "gemma-4-26b": { name: "Gemma 4 26B", maker: "Google", family: "gemma", provider: "workers-ai", model: "@cf/google/gemma-4-26b-a4b-it" },
  "gpt-oss-120b": { name: "gpt-oss 120B", maker: "OpenAI (open weights)", family: "gpt-oss", provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" },
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", maker: "DeepSeek", family: "deepseek", provider: "workers-ai", model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017" },
};

export const TOURNAMENT = {
  key: "models-2026-11",
  title: "AI model round robin",
  players: Object.keys(ROSTER),
  matches_per_pair: 2,
  self_play: true,
  /** Estimated Anthropic spend at which Claude stops being called. */
  claude_budget_usd: 8,
};

export const DUEL = {
  max_fails: 10,
  per_tick_ms: 25_000,
  concurrent: 10,
  lease_seconds: 90,
  reason_max: 280,
};

/** Anthropic list prices per million tokens (input, output), by model family word. */
const CLAUDE_PRICE: Record<string, [number, number]> = { opus: [4, 20], sonnet: [2, 10], haiku: [0.1, 0.5] };

export const SYSTEM_PROMPT = [
  "You are playing a repeated prisoner's dilemma against another AI model.",
  "Each round you and your opponent each choose C (cooperate) or D (defect) at the same time.",
  "Both C: 3 points each. Both D: 1 point each. If one plays D and the other C, the defector gets 5 and the cooperator 0.",
  `The match lasts at least ${PD.min_rounds} rounds. After that, each round has a ${Math.round((1 - PD.continue_p) * 100)}% chance of being the last (${PD.max_rounds} at most). You never know which round is the last.`,
  "Your goal is to score as many points as you can over the whole match.",
  'Answer with only a JSON object: {"move": "C" or "D", "reason": "one short sentence on why"}.',
].join("\n");

type Round = { a: Move; b: Move; ra: string | null; rb: string | null; at: string };
export type DuelRow = {
  id: string; tournament: string; seq: number; a: string; b: string; a_model: string | null; b_model: string | null;
  rounds_total: number; moves: string; status: string; score_a: number; score_b: number; fails: number; last_error: string | null;
  cost_usd: number; lease_until: string | null; version: number; created_at: string; updated_at: string;
};

const parse = (r: DuelRow): Round[] => JSON.parse(r.moves) as Round[];

/** The question one seat sees: its own side of every past round. */
export function seatPrompt(rounds: Round[], seat: "a" | "b"): string {
  const me = (r: Round) => (seat === "a" ? r.a : r.b), them = (r: Round) => (seat === "a" ? r.b : r.a);
  let mine = 0, theirs = 0;
  const lines = rounds.map((r, i) => {
    const [p, q] = PD.payoff[me(r) + them(r)];
    mine += p; theirs += q;
    return `Round ${i + 1}: you ${me(r)}, they ${them(r)} (you +${p}, they +${q})`;
  });
  return (rounds.length ? `History so far:\n${lines.join("\n")}\nScore: you ${mine}, they ${theirs}.\n\n` : "This is the first round. No moves yet.\n\n")
    + `Round ${rounds.length + 1}. Your move?`;
}

/** Pull a move and reason out of a model's answer. Returns null when it gave no clear move. */
export function readAnswer(text: string): { move: Move; reason: string | null } | null {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const objs = t.match(/\{[^{}]*\}/g) ?? [];
  for (const o of objs.reverse()) {
    try {
      const j = JSON.parse(o) as { move?: unknown; reason?: unknown };
      const m = typeof j.move === "string" ? j.move.trim().toUpperCase() : "";
      const move = m === "C" || m.startsWith("COOP") ? "C" : m === "D" || m.startsWith("DEF") ? "D" : null;
      if (move) return { move, reason: typeof j.reason === "string" ? j.reason.trim().slice(0, DUEL.reason_max) || null : null };
    } catch { /* not JSON, try the next */ }
  }
  const m = t.match(/"?move"?\s*[:=]\s*"?(C|D|cooperate|defect)\b/i);
  if (m) {
    const move: Move = m[1].toUpperCase().startsWith("C") ? "C" : "D";
    const r = t.match(/"?reason"?\s*[:=]\s*"([^"]{1,600})"/i);
    return { move, reason: r ? r[1].trim().slice(0, DUEL.reason_max) : null };
  }
  return null;
}

/** The text of a Workers AI answer, whichever shape the model returns. */
export function workersAiText(r: unknown): string {
  if (typeof r === "string") return r;
  const x = r as Record<string, any> | null;
  if (!x) return "";
  if (typeof x.response === "string") return x.response;
  if (x.response && typeof x.response === "object") return JSON.stringify(x.response);
  const c = x.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => p?.text ?? "").join("");
  if (typeof x.output_text === "string") return x.output_text;
  if (Array.isArray(x.output))
    return x.output.filter((o: any) => o?.type === "message").flatMap((o: any) => o.content ?? []).map((p: any) => p?.text ?? "").join("");
  return "";
}

export type Answer = { move: Move; reason: string | null; model: string; cost: number };
export type Ask = (player: Player, prompt: string) => Promise<Answer>;

// ── calling the models ──────────────────────────────────────────────────────

let claudeIds: Map<string, string> | null = null;
/** The newest Claude model of each family, read from the Models API once per isolate. */
async function claudeModel(client: Anthropic, family: string): Promise<string> {
  if (!claudeIds) {
    const best = new Map<string, { id: string; at: number }>();
    for await (const m of client.models.list({ limit: 100 })) {
      for (const f of Object.keys(CLAUDE_PRICE)) {
        if (!m.id.includes(f)) continue;
        const at = Date.parse(m.created_at);
        if (!best.has(f) || at > best.get(f)!.at) best.set(f, { id: m.id, at });
      }
    }
    claudeIds = new Map([...best].map(([f, v]) => [f, v.id]));
  }
  const id = claudeIds.get(family);
  if (!id) throw new Error(`no ${family} model on this API key`);
  return id;
}

const ANSWER_SCHEMA = {
  type: "object",
  properties: { move: { type: "string", enum: ["C", "D"] }, reason: { type: "string" } },
  required: ["move", "reason"],
  additionalProperties: false,
};

/** The real model calls: Workers AI for open models, the Anthropic API for Claude. */
export function liveAsk(env: Env): Ask {
  const client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 60_000 }) : null;
  return async (p, prompt) => {
    if (p.provider === "anthropic") {
      if (!client) throw new Error("no Anthropic key");
      const model = await claudeModel(client, p.model);
      const res = await client.messages.create({
        model,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        output_config: { effort: "low", format: { type: "json_schema", schema: ANSWER_SCHEMA } },
      } as Anthropic.MessageCreateParamsNonStreaming);
      const [pin, pout] = CLAUDE_PRICE[p.model];
      const cost = (res.usage.input_tokens * pin + res.usage.output_tokens * pout) / 1e6;
      if (res.stop_reason === "refusal") throw Object.assign(new Error("the model declined to answer"), { cost, model });
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const a = readAnswer(text);
      if (!a) throw Object.assign(new Error(`no clear move in: ${text.slice(0, 120)}`), { cost, model });
      return { ...a, model, cost };
    }
    if (!env.AI) throw new Error("no Workers AI binding");
    const res = await env.AI.run(p.model as any, {
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }],
      // Reasoning models think before they answer; too small a limit leaves the answer empty.
      max_tokens: 4096,
    } as any);
    const text = workersAiText(res);
    const a = readAnswer(text);
    if (!a) {
      const x = res as any;
      const why = text ? text.slice(0, 120) : `(empty; finish ${x?.choices?.[0]?.finish_reason ?? x?.status ?? "?"}, fields ${Object.keys(x ?? {}).join("/")})`;
      throw Object.assign(new Error(`no clear move in: ${why}`), { cost: 0, model: p.model });
    }
    return { ...a, model: p.model, cost: 0 };
  };
}

// ── the tournament ──────────────────────────────────────────────────────────

/** Every match of the round robin, in play order: pairs first round by round, self-play last. */
export function schedule(t = TOURNAMENT): [string, string][] {
  const ps = t.players, out: [string, string][] = [];
  for (let k = 0; k < t.matches_per_pair; k++)
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) out.push(k % 2 ? [ps[j], ps[i]] : [ps[i], ps[j]]);
  if (t.self_play) for (const p of ps) out.push([p, p]);
  return out;
}

/** Create the tournament's matches once. Safe to call every tick. */
export async function ensureTournament(db: D1Database, t = TOURNAMENT) {
  const have = await db.prepare("SELECT COUNT(*) AS n FROM pd_duels WHERE tournament = ?").bind(t.key).first<{ n: number }>();
  if ((have?.n ?? 0) > 0) return false;
  const at = nowIso();
  const stmts = schedule(t).map(([a, b], i) =>
    db.prepare("INSERT OR IGNORE INTO pd_duels (id, tournament, seq, a, b, rounds_total, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)")
      .bind(newId("pdd"), t.key, i + 1, a, b, drawLength(), at, at));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return true;
}

async function claudeSpent(db: D1Database, key: string) {
  return (await db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM pd_duels WHERE tournament = ?").bind(key).first<{ s: number }>())?.s ?? 0;
}

/** Play one round of a match. Returns true if the match can go on. */
export async function playRound(db: D1Database, row: DuelRow, ask: Ask): Promise<boolean> {
  const rounds = parse(row);
  const pa = ROSTER[row.a], pb = ROSTER[row.b];
  const [x, y] = await Promise.allSettled([ask(pa, seatPrompt(rounds, "a")), ask(pb, seatPrompt(rounds, "b"))]);
  const costOf = (r: PromiseSettledResult<Answer>) => (r.status === "fulfilled" ? r.value.cost : Number((r.reason as any)?.cost) || 0);
  const cost = costOf(x) + costOf(y);
  const at = nowIso();
  if (x.status === "rejected" || y.status === "rejected") {
    const err = [x, y].map((r, i) => (r.status === "rejected" ? `${i ? pb.name : pa.name}: ${String((r.reason as Error)?.message ?? r.reason).slice(0, 200)}` : "")).filter(Boolean).join(" | ");
    const fails = row.fails + 1;
    const status = fails >= DUEL.max_fails ? "failed" : row.status === "queued" ? "active" : row.status;
    await db.prepare("UPDATE pd_duels SET fails = ?, last_error = ?, status = ?, cost_usd = cost_usd + ?, lease_until = NULL, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
      .bind(fails, err, status, cost, at, row.id, row.version).run();
    return false;
  }
  const A = x.value, B = y.value;
  rounds.push({ a: A.move, b: B.move, ra: A.reason, rb: B.reason, at });
  const [sa, sb] = PD.payoff[A.move + B.move];
  const done = rounds.length >= row.rounds_total;
  const r = await db.prepare(
    `UPDATE pd_duels SET moves = ?, status = ?, score_a = score_a + ?, score_b = score_b + ?, a_model = ?, b_model = ?, fails = 0, last_error = NULL,
       cost_usd = cost_usd + ?, lease_until = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
  ).bind(JSON.stringify(rounds), done ? "finished" : "active", sa, sb, A.model, B.model, cost, done ? null : row.lease_until, at, row.id, row.version).run();
  if (!r.meta.changes) return false;
  Object.assign(row, { moves: JSON.stringify(rounds), status: done ? "finished" : "active", score_a: row.score_a + sa, score_b: row.score_b + sb, a_model: A.model, b_model: B.model, fails: 0, version: row.version + 1 });
  return !done;
}

/**
 * One cron tick: play rounds of up to DUEL.concurrent matches until the time budget is spent.
 * Matches that need Claude wait while there is no key or the spend cap is reached.
 */
export async function duelTick(env: Env, opts: { ask?: Ask; budgetMs?: number; now?: () => number } = {}) {
  if (env.MODEL_TOURNAMENT !== "on") return { played: 0, reason: "off" };
  const db = env.DB, t = TOURNAMENT, now = opts.now ?? Date.now;
  await ensureTournament(db, t);
  const claudeOk = !!env.ANTHROPIC_API_KEY && (await claudeSpent(db, t.key)) < t.claude_budget_usd;
  const openOk = !!env.AI || !!opts.ask;
  const runnable = (k: string) => (ROSTER[k].provider === "anthropic" ? claudeOk : openOk);
  const at = nowIso();
  const cands = (await db.prepare(
    "SELECT * FROM pd_duels WHERE tournament = ? AND status IN ('active','queued') AND (lease_until IS NULL OR lease_until < ?) ORDER BY status = 'active' DESC, seq LIMIT 200",
  ).bind(t.key, at).all<DuelRow>()).results ?? [];
  const picked: DuelRow[] = [];
  for (const row of cands) {
    if (picked.length >= DUEL.concurrent) break;
    if (!runnable(row.a) || !runnable(row.b)) continue;
    const until = new Date(now() + DUEL.lease_seconds * 1000).toISOString();
    const l = await db.prepare("UPDATE pd_duels SET lease_until = ?, version = version + 1 WHERE id = ? AND version = ? AND (lease_until IS NULL OR lease_until < ?)")
      .bind(until, row.id, row.version, at).run();
    if (l.meta.changes) picked.push({ ...row, lease_until: until, version: row.version + 1 });
  }
  const ask = opts.ask ?? liveAsk(env);
  const stop = now() + (opts.budgetMs ?? DUEL.per_tick_ms);
  let played = 0;
  await Promise.all(picked.map(async (row) => {
    try {
      while (now() < stop) {
        const before = parse(row).length;
        const more = await playRound(db, row, ask);
        if (parse(row).length > before) played++;
        if (!more) break;
      }
    } catch (e) { console.error("duel round", row.id, e); }
    await db.prepare("UPDATE pd_duels SET lease_until = NULL WHERE id = ? AND lease_until = ?").bind(row.id, row.lease_until).run();
  }));
  return { played, matches: picked.length, claude: claudeOk };
}

// ── results ─────────────────────────────────────────────────────────────────

type Side = { me: Move[]; them: Move[]; why: (string | null)[] };
const sideOf = (rounds: Round[], seat: "a" | "b"): Side => ({
  me: rounds.map((r) => (seat === "a" ? r.a : r.b)),
  them: rounds.map((r) => (seat === "a" ? r.b : r.a)),
  why: rounds.map((r) => (seat === "a" ? r.ra : r.rb)),
});

type Stat = {
  matches: number; wins: number; draws: number; losses: number; rounds: number; points: number; coop: number;
  firstC: number; afterD: number; afterDC: number; afterC: number; afterCD: number; nice: number; exploited: number; exploiting: number;
  quotes: { forgave?: string; retaliated?: string; opened?: string; unprovoked?: string };
};
const stat = (): Stat => ({ matches: 0, wins: 0, draws: 0, losses: 0, rounds: 0, points: 0, coop: 0, firstC: 0, afterD: 0, afterDC: 0, afterC: 0, afterCD: 0, nice: 0, exploited: 0, exploiting: 0, quotes: {} });

function addSide(s: Stat, x: Side, theirPoints: number | null) {
  const n = x.me.length;
  let mine = 0, firstDefectByMe = -1, firstDefectByThem = -1;
  s.matches++;
  for (let i = 0; i < n; i++) {
    const [p] = PD.payoff[x.me[i] + x.them[i]];
    mine += p; s.rounds++;
    if (x.me[i] === "C") s.coop++;
    if (x.me[i] === "C" && x.them[i] === "D") s.exploited++;
    if (x.me[i] === "D" && x.them[i] === "C") s.exploiting++;
    if (x.me[i] === "D" && firstDefectByMe < 0) firstDefectByMe = i;
    if (x.them[i] === "D" && firstDefectByThem < 0) firstDefectByThem = i;
    const why = x.why[i] ?? undefined;
    if (i === 0) { if (x.me[i] === "C") s.firstC++; s.quotes.opened ??= why; }
    else if (x.them[i - 1] === "D") {
      s.afterD++;
      if (x.me[i] === "C") { s.afterDC++; s.quotes.forgave ??= why; } else s.quotes.retaliated ??= why;
    } else {
      s.afterC++;
      if (x.me[i] === "D") { s.afterCD++; s.quotes.unprovoked ??= why; }
    }
  }
  s.points += mine;
  // Nice: never the first to defect (a defection in the same round as theirs counts as not first).
  if (firstDefectByMe < 0 || (firstDefectByThem >= 0 && firstDefectByMe >= firstDefectByThem)) s.nice++;
  if (theirPoints !== null) { if (mine > theirPoints) s.wins++; else if (mine === theirPoints) s.draws++; else s.losses++; }
}

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : null);
const ppr = (s: Stat) => (s.rounds ? +(s.points / s.rounds).toFixed(2) : null);

/** A plain-words read of how a model plays, from its numbers. */
export function profile(s: Stat): { style: string; summary: string } {
  const coop = pct(s.coop, s.rounds) ?? 0, nice = pct(s.nice, s.matches) ?? 0;
  const forgive = pct(s.afterDC, s.afterD), unprov = pct(s.afterCD, s.afterC) ?? 0;
  let style: string;
  if (!s.rounds) style = "No matches yet";
  else if (coop >= 95 && (forgive === null || forgive >= 80)) style = "Unconditional cooperator";
  else if (coop <= 20) style = "Defector";
  else if (unprov >= 20) style = "Opportunist";
  else if (nice >= 90 && forgive !== null && forgive >= 45) style = "Forgiving cooperator";
  else if (nice >= 90 && forgive !== null && forgive < 15) style = "Grudger";
  else if (nice >= 90) style = "Tit for Tat type";
  else style = "Wary cooperator";
  const parts: string[] = [];
  if (s.rounds) {
    parts.push(`Cooperated in ${coop}% of rounds and opened with cooperation in ${pct(s.firstC, s.matches)}% of matches.`);
    parts.push(`Never defected first in ${nice}% of matches.`);
    if (forgive !== null) parts.push(`After being betrayed it cooperated again ${forgive}% of the time and hit back ${100 - forgive}% of the time.`);
    parts.push(unprov ? `It defected on a cooperating opponent ${unprov}% of the time.` : "It never defected on an opponent who had just cooperated.");
  }
  return { style, summary: parts.join(" ") };
}

const STYLE_ABOUT: Record<string, string> = {
  "Unconditional cooperator": "cooperates almost no matter what, even after being betrayed",
  "Defector": "defects most of the time",
  "Opportunist": "defects even when the other side has just cooperated",
  "Forgiving cooperator": "never starts a fight, punishes betrayal but often offers peace again, like Generous Tit for Tat",
  "Grudger": "never starts a fight, but once betrayed rarely cooperates again",
  "Tit for Tat type": "never starts a fight and answers betrayal with betrayal",
  "Wary cooperator": "mostly cooperates but sometimes strikes first",
  "No matches yet": "",
};

export async function duelResults(db: D1Database, t = TOURNAMENT) {
  const rows = (await db.prepare("SELECT * FROM pd_duels WHERE tournament = ? ORDER BY seq").bind(t.key).all<DuelRow>()).results ?? [];
  const per = new Map<string, Stat>(t.players.map((k) => [k, stat()]));
  const self = new Map<string, { rounds: number; both: number; points: number; matches: number }>();
  const grid = new Map<string, { rounds: number; points: number; matches: number }>();
  const models = new Map<string, Set<string>>();
  const counts = { total: rows.length, finished: 0, active: 0, queued: 0, failed: 0 };
  let cost = 0;
  for (const r of rows) {
    counts[r.status as keyof typeof counts]++;
    cost += r.cost_usd;
    for (const [k, m] of [[r.a, r.a_model], [r.b, r.b_model]] as const) if (m) (models.get(k) ?? models.set(k, new Set()).get(k)!).add(m);
    if (r.status !== "finished") continue;
    const rounds = parse(r);
    if (!rounds.length) continue;
    if (r.a === r.b) {
      const s = self.get(r.a) ?? { rounds: 0, both: 0, points: 0, matches: 0 };
      s.matches++;
      for (const x of rounds) { s.rounds++; if (x.a === "C" && x.b === "C") s.both++; s.points += PD.payoff[x.a + x.b][0] + PD.payoff[x.a + x.b][1]; }
      self.set(r.a, s);
      continue;
    }
    addSide(per.get(r.a)!, sideOf(rounds, "a"), r.score_b);
    addSide(per.get(r.b)!, sideOf(rounds, "b"), r.score_a);
    for (const [me, them, seat] of [[r.a, r.b, "a"], [r.b, r.a, "b"]] as const) {
      const g = grid.get(`${me}|${them}`) ?? { rounds: 0, points: 0, matches: 0 };
      g.matches++; g.rounds += rounds.length;
      g.points += seat === "a" ? r.score_a : r.score_b;
      grid.set(`${me}|${them}`, g);
    }
  }
  const standings = t.players.map((k) => {
    const s = per.get(k)!, p = ROSTER[k], pr = profile(s), sp = self.get(k);
    return {
      key: k, name: p.name, maker: p.maker, family: p.family, runs_on: p.provider === "anthropic" ? "Anthropic API" : "Cloudflare Workers AI",
      model_ids: [...(models.get(k) ?? [])],
      matches: s.matches, wins: s.wins, draws: s.draws, losses: s.losses,
      points_per_round: ppr(s),
      cooperate_pct: pct(s.coop, s.rounds),
      first_move_cooperate_pct: pct(s.firstC, s.matches),
      never_defected_first_pct: pct(s.nice, s.matches),
      forgive_after_betrayal_pct: pct(s.afterDC, s.afterD),
      retaliate_after_betrayal_pct: s.afterD ? 100 - (pct(s.afterDC, s.afterD) ?? 0) : null,
      unprovoked_defection_pct: pct(s.afterCD, s.afterC),
      times_exploited: s.exploited, times_exploiting: s.exploiting,
      against_itself: sp ? { matches: sp.matches, mutual_cooperation_pct: pct(sp.both, sp.rounds), points_per_round_each: sp.rounds ? +(sp.points / sp.rounds / 2).toFixed(2) : null } : null,
      style: pr.style, style_about: STYLE_ABOUT[pr.style] ?? "", profile: pr.summary,
      quotes: Object.fromEntries(Object.entries(s.quotes).filter(([, v]) => v)),
    };
  }).sort((x, y) => (y.points_per_round ?? -1) - (x.points_per_round ?? -1) || y.wins - x.wins)
    .map((x, i) => ({ rank: x.matches ? i + 1 : null, ...x }));
  const head_to_head = t.players.map((me) => ({
    model: me, name: ROSTER[me].name,
    against: Object.fromEntries(t.players.filter((o) => o !== me).map((o) => {
      const g = grid.get(`${me}|${o}`);
      return [o, g ? { matches: g.matches, points_per_round: +(g.points / g.rounds).toFixed(2) } : null];
    })),
  }));
  return {
    tournament: t.key,
    title: "Which AI models cooperate? A round robin of the prisoner's dilemma",
    status: counts,
    claude_cost_usd_estimate: +cost.toFixed(2),
    standings,
    head_to_head,
    how: {
      format: `Every pair of models plays ${t.matches_per_pair} matches, and each model plays a copy of itself. Matches last ${PD.min_rounds} to ${PD.max_rounds} rounds; neither side knows when it ends or who it plays.`,
      prompt: SYSTEM_PROMPT,
      settings: "Claude models answer at low effort with a fixed JSON answer format. Open models run with their default settings on Cloudflare Workers AI. Every model gets the same prompt.",
      ranking: "Points per round across all matches against other models (3.0 is mutual cooperation every round). Self-play is shown apart.",
    },
    page: "/arena/dilemma/models",
    download: "/v1/arena/dilemma/models/moves.csv",
  };
}

export async function getDuel(db: D1Database, id: string) {
  const r = await db.prepare("SELECT * FROM pd_duels WHERE id = ?").bind(id).first<DuelRow>();
  if (!r) throw new OpError(404, "no such match");
  const rounds = parse(r);
  return {
    id: r.id, status: r.status, a: { key: r.a, name: ROSTER[r.a]?.name ?? r.a, model: r.a_model }, b: { key: r.b, name: ROSTER[r.b]?.name ?? r.b, model: r.b_model },
    self_play: r.a === r.b,
    rounds_played: rounds.length, rounds_total: r.status === "finished" ? r.rounds_total : null,
    score: { a: r.score_a, b: r.score_b },
    rounds: rounds.map((x, i) => ({ n: i + 1, a: x.a, b: x.b, points: PD.payoff[x.a + x.b], a_reason: x.ra, b_reason: x.rb })),
    last_error: r.status === "failed" ? r.last_error : null,
    updated_at: r.updated_at,
  };
}

export async function listDuels(db: D1Database, t = TOURNAMENT) {
  const rows = (await db.prepare("SELECT * FROM pd_duels WHERE tournament = ? ORDER BY updated_at DESC").bind(t.key).all<DuelRow>()).results ?? [];
  return rows.map((r) => {
    const rounds = parse(r);
    return {
      id: r.id, status: r.status, a: r.a, b: r.b, a_name: ROSTER[r.a]?.name ?? r.a, b_name: ROSTER[r.b]?.name ?? r.b,
      rounds: rounds.length, score_a: r.score_a, score_b: r.score_b,
      a_moves: rounds.map((x) => x.a).join(""), b_moves: rounds.map((x) => x.b).join(""), updated_at: r.updated_at,
    };
  });
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
};

export async function duelCsv(db: D1Database, t = TOURNAMENT): Promise<string> {
  const rows = (await db.prepare("SELECT * FROM pd_duels WHERE tournament = ? AND status = 'finished' ORDER BY seq").bind(t.key).all<DuelRow>()).results ?? [];
  const lines = ["match_id,round,model_a,model_a_id,model_b,model_b_id,move_a,move_b,points_a,points_b,reason_a,reason_b,at"];
  for (const r of rows)
    parse(r).forEach((x, i) => {
      const [pa, pb] = PD.payoff[x.a + x.b];
      lines.push([r.id, i + 1, r.a, r.a_model, r.b, r.b_model, x.a, x.b, pa, pb, x.ra, x.rb, x.at].map(csvCell).join(","));
    });
  return lines.join("\n") + "\n";
}

export const _internal = { resetClaudeIds: () => { claudeIds = null; } };
