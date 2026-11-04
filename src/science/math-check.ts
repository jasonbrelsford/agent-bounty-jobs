/**
 * Math Record Hunt — exact checkers. Pure functions, no database, no network.
 *
 * Every problem family has TWO checkers written separately (A and B), with their
 * own parsing and their own arithmetic. A construction only counts as a record
 * claim when both pass. Neither uses floating point to decide anything.
 *
 *  packing  N circles in the unit square, no overlaps; score = sum of radii.
 *           Coordinates are decimals, checked as exact rationals.
 *  kissing  Integer vectors in dimension d, all the same squared length L, every
 *           pair at least 60 degrees apart (2·u·v ≤ L); score = how many vectors.
 *  ramsey   A graph on n vertices with no s-clique and no t-independent set,
 *           which proves R(s,t) ≥ n+1; score = n. Search has a work budget: a
 *           graph too big to settle within it is "over_budget", never "pass".
 *
 * The site runs these within one request's CPU time, so each family has a work
 * cap. Anything over the cap is left for the offline checker (tools/math-check.mjs).
 */

export type CheckResult =
  | { ok: true; value: string; detail: string }
  | { ok: false; over_budget?: false; reason: string }
  | { ok: false; over_budget: true; reason: string };

export const LIMITS = {
  decimal_chars: 60,          // one coordinate as text
  packing_circles: 40,
  kissing_vectors: 1000,
  kissing_coord_abs: 1 << 20, // keeps every dot product an exact double (≤ 16·2^40 < 2^53)
  kissing_work: 2_200_000,    // pairs × dimension the site will check in one request (605 vectors in 11 dimensions)
  ramsey_vertices: 160,
  ramsey_nodes: 15_000,       // search nodes per request, both searches together
} as const;

const bad = (reason: string): CheckResult => ({ ok: false, reason });
const overBudget = (reason: string): CheckResult => ({ ok: false, over_budget: true, reason });

// ── decimals ────────────────────────────────────────────────────────────────

/** Checker A's decimal: an integer numerator over 10^scale. Accepts "0.25", "-1.5e-3", 0.25. */
export function parseDecimalA(v: unknown): { n: bigint; scale: number } | null {
  if (typeof v === "number") { if (!Number.isFinite(v)) return null; v = String(v); }
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > LIMITS.decimal_chars) return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const frac = m[3] ?? "";
  let scale = frac.length - Number(m[4] ?? 0);
  let n = BigInt((m[2] || "0") + frac);
  if (scale < 0) { n *= 10n ** BigInt(-scale); scale = 0; }
  if (scale > 200) return null;
  return { n: m[1] === "-" ? -n : n, scale };
}

/** Checker B's decimal: a fraction p/q in lowest terms, parsed character by character. */
export function parseDecimalB(v: unknown): [bigint, bigint] | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : typeof v === "string" ? v.trim() : "";
  if (!s || s.length > LIMITS.decimal_chars) return null;
  let i = 0, neg = false;
  if (s[i] === "+" || s[i] === "-") { neg = s[i] === "-"; i++; }
  let p = 0n, q = 1n, digits = 0, dot = false;
  for (; i < s.length && s[i] !== "e" && s[i] !== "E"; i++) {
    const c = s[i];
    if (c === "." && !dot) { dot = true; continue; }
    if (c < "0" || c > "9") return null;
    p = p * 10n + BigInt(c.charCodeAt(0) - 48);
    if (dot) q *= 10n;
    digits++;
  }
  if (!digits) return null;
  if (i < s.length) {
    const e = s.slice(i + 1);
    if (!/^[+-]?\d{1,3}$/.test(e)) return null;
    const k = Number(e);
    if (k >= 0) p *= 10n ** BigInt(k); else q *= 10n ** BigInt(-k);
    if (q > 10n ** 200n) return null;
  }
  const g = gcd(p, q);
  return [neg ? -p / g : p / g, q / g];
}

function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

/** A positive scaled integer as a decimal string with `digits` places, rounded down. */
function scaledToDecimal(n: bigint, scale: number, digits = 15): string {
  const target = scale > digits ? n / 10n ** BigInt(scale - digits) : n * 10n ** BigInt(digits - scale);
  const s = target.toString().padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** Compare a submitted value with a record. Values are decimal strings or integers as text. */
export function compareDecimal(a: string, b: string): number {
  const x = parseDecimalA(a), y = parseDecimalA(b);
  if (!x || !y) throw new Error("not a decimal");
  const s = Math.max(x.scale, y.scale);
  const xn = x.n * 10n ** BigInt(s - x.scale), yn = y.n * 10n ** BigInt(s - y.scale);
  return xn === yn ? 0 : xn > yn ? 1 : -1;
}

/** a − b as a decimal string (for "beats the record by"). */
export function diffDecimal(a: string, b: string, digits = 15): string {
  const x = parseDecimalA(a)!, y = parseDecimalA(b)!;
  const s = Math.max(x.scale, y.scale);
  const d = x.n * 10n ** BigInt(s - x.scale) - y.n * 10n ** BigInt(s - y.scale);
  return (d < 0n ? "-" : "") + scaledToDecimal(d < 0n ? -d : d, s, digits);
}

// ── circle packing in the unit square, sum of radii ────────────────────────

type Circle = unknown;
const circlesOf = (c: unknown, n: number): Circle[][] | string => {
  if (!Array.isArray(c)) return "construction.circles must be a list of [x, y, r]";
  if (c.length !== n) return `this problem needs exactly ${n} circles; got ${c.length}`;
  for (const k of c) if (!Array.isArray(k) || k.length !== 3) return "each circle is [x, y, r] (decimal strings recommended)";
  return c as Circle[][];
};

/** Checker A: one common power-of-ten scale, integer arithmetic throughout. */
export function checkPackingA(construction: unknown, n: number): CheckResult {
  const list = circlesOf((construction as { circles?: unknown })?.circles, n);
  if (typeof list === "string") return bad(list);
  const parsed = list.map((c) => c.map(parseDecimalA));
  if (parsed.some((c) => c.some((x) => x === null))) return bad("every x, y and r must be a plain decimal of at most 60 characters");
  const S = Math.max(...parsed.flat().map((x) => x!.scale));
  const up = (x: { n: bigint; scale: number }) => x.n * 10n ** BigInt(S - x.scale);
  const one = 10n ** BigInt(S);
  const C = parsed.map(([x, y, r]) => [up(x!), up(y!), up(r!)]);
  for (let i = 0; i < C.length; i++) {
    const [x, y, r] = C[i];
    if (r <= 0n) return bad(`circle ${i + 1}: the radius must be positive`);
    if (x - r < 0n || x + r > one || y - r < 0n || y + r > one) return bad(`circle ${i + 1} sticks out of the unit square`);
  }
  for (let i = 0; i < C.length; i++)
    for (let j = i + 1; j < C.length; j++) {
      const dx = C[i][0] - C[j][0], dy = C[i][1] - C[j][1], rr = C[i][2] + C[j][2];
      if (dx * dx + dy * dy < rr * rr) return bad(`circles ${i + 1} and ${j + 1} overlap`);
    }
  const sum = C.reduce((s, c) => s + c[2], 0n);
  return { ok: true, value: scaledToDecimal(sum, S), detail: `${n} circles inside the unit square, no overlaps, checked in exact arithmetic` };
}

/** Checker B: every number its own fraction, cross-multiplied; pairs swept in order of x. */
export function checkPackingB(construction: unknown, n: number): CheckResult {
  const list = circlesOf((construction as { circles?: unknown })?.circles, n);
  if (typeof list === "string") return bad(list);
  const F = list.map((c) => c.map(parseDecimalB));
  if (F.some((c) => c.some((x) => x === null))) return bad("every x, y and r must be a plain decimal");
  const fr = F as [bigint, bigint][][];
  // a/b ≤ c/d with b, d > 0
  const le = ([a, b]: [bigint, bigint], [c, d]: [bigint, bigint]) => a * d <= c * b;
  const add = ([a, b]: [bigint, bigint], [c, d]: [bigint, bigint]): [bigint, bigint] => [a * d + c * b, b * d];
  const sub = ([a, b]: [bigint, bigint], [c, d]: [bigint, bigint]): [bigint, bigint] => [a * d - c * b, b * d];
  const mul = ([a, b]: [bigint, bigint], [c, d]: [bigint, bigint]): [bigint, bigint] => [a * c, b * d];
  const ONE: [bigint, bigint] = [1n, 1n], ZERO: [bigint, bigint] = [0n, 1n];
  for (const [x, y, r] of fr) {
    if (le(r, ZERO)) return bad("a radius is not positive");
    if (!le(r, x) || !le(add(x, r), ONE) || !le(r, y) || !le(add(y, r), ONE)) return bad("a circle leaves the unit square");
  }
  const order = fr.map((_, i) => i).sort((i, j) => { const d = sub(fr[i][0], fr[j][0]); return d[0] < 0n ? -1 : d[0] > 0n ? 1 : 0; });
  for (let a = 0; a < order.length; a++)
    for (let b = a + 1; b < order.length; b++) {
      const [x1, y1, r1] = fr[order[a]], [x2, y2, r2] = fr[order[b]];
      const dx = sub(x2, x1), dy = sub(y2, y1), rs = add(r1, r2);
      if (!le(mul(rs, rs), add(mul(dx, dx), mul(dy, dy)))) return bad("two circles overlap");
    }
  const [p, q] = fr.reduce((s, c) => add(s, c[2]), ZERO);
  // Exact sum to 15 places, rounded down.
  const digits = 15n;
  const scaled = (p * 10n ** digits) / q;
  const s = scaled.toString().padStart(16, "0");
  return { ok: true, value: `${s.slice(0, -15)}.${s.slice(-15)}`, detail: "second check: every number as its own fraction" };
}

// ── kissing configurations ─────────────────────────────────────────────────

const vectorsOf = (c: unknown, dim: number): number[][] | string => {
  const v = (c as { vectors?: unknown })?.vectors;
  if (!Array.isArray(v) || v.length === 0) return "construction.vectors must be a list of integer vectors";
  if (v.length > LIMITS.kissing_vectors) return `at most ${LIMITS.kissing_vectors} vectors per construction`;
  for (const x of v) {
    if (!Array.isArray(x) || x.length !== dim) return `every vector needs exactly ${dim} integer coordinates`;
    for (const k of x) if (typeof k !== "number" || !Number.isInteger(k) || Math.abs(k) > LIMITS.kissing_coord_abs)
      return `coordinates must be integers from -${LIMITS.kissing_coord_abs} to ${LIMITS.kissing_coord_abs} (scale rational vectors up to integers)`;
  }
  return v as number[][];
};

/** Checker A: doubles, exact because every product and sum stays below 2^53. Condition 2·u·v ≤ L. */
export function checkKissingA(construction: unknown, dim: number): CheckResult {
  const V = vectorsOf(construction, dim);
  if (typeof V === "string") return bad(V);
  if ((V.length * V.length * dim) / 2 > LIMITS.kissing_work) return overBudget(`${V.length} vectors in ${dim} dimensions is more than the site checks in one request; the offline checker settles it`);
  const L = V[0].reduce((s, x) => s + x * x, 0);
  if (L === 0) return bad("the zero vector is not allowed");
  for (let i = 0; i < V.length; i++) {
    if (V[i].reduce((s, x) => s + x * x, 0) !== L) return bad(`vector ${i + 1} has a different length from vector 1; all must have the same squared length (${L})`);
    for (let j = 0; j < i; j++) {
      let d = 0;
      for (let k = 0; k < dim; k++) d += V[i][k] * V[j][k];
      if (2 * d > L) return bad(`vectors ${j + 1} and ${i + 1} are closer than 60 degrees (or the same)`);
    }
  }
  return { ok: true, value: String(V.length), detail: `${V.length} vectors of squared length ${L}, every pair at least 60 degrees apart` };
}

/**
 * Checker B: distance form. Unit spheres touching a central one, centred at the vectors, do not
 * overlap iff |u−v|² ≥ L. Exact in doubles: each squared distance is at most 16·(2^21)² = 2^46.
 * The lengths are confirmed separately with BigInt.
 */
export function checkKissingB(construction: unknown, dim: number): CheckResult {
  const V = vectorsOf(construction, dim);
  if (typeof V === "string") return bad(V);
  if ((V.length * V.length * dim) / 2 > LIMITS.kissing_work) return overBudget("too many vectors for one request");
  const norms = V.map((v) => v.reduce((s, x) => s + BigInt(x) * BigInt(x), 0n));
  if (norms[0] === 0n) return bad("zero vector");
  if (norms.some((n) => n !== norms[0])) return bad("vectors of different lengths");
  const L = Number(norms[0]);
  const flat = Float64Array.from(V.flat());
  for (let i = V.length - 1; i > 0; i--)
    for (let j = i - 1; j >= 0; j--) {
      let d2 = 0;
      for (let k = 0, a = i * dim, b = j * dim; k < dim; k++) { const t = flat[a + k] - flat[b + k]; d2 += t * t; }
      if (d2 < L) return bad("two touching spheres overlap");
    }
  return { ok: true, value: String(V.length), detail: "second check: exact distances between sphere centres" };
}

// ── Ramsey lower bounds ─────────────────────────────────────────────────────

/** A graph from {n, edges: [[i, j], ...]} (0-based) or {graph6: "..."}; adjacency matrix. */
export function parseGraph(construction: unknown): { n: number; adj: boolean[][] } | string {
  const c = (construction ?? {}) as { n?: unknown; edges?: unknown; graph6?: unknown };
  if (typeof c.graph6 === "string") return parseGraph6(c.graph6);
  const n = c.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > LIMITS.ramsey_vertices) return `n must be an integer from 1 to ${LIMITS.ramsey_vertices} (or send graph6)`;
  if (!Array.isArray(c.edges)) return "send edges: [[i, j], ...] with vertices 0 to n-1, or graph6";
  const adj = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (const e of c.edges) {
    if (!Array.isArray(e) || e.length !== 2) return "each edge is [i, j]";
    const [i, j] = e;
    if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= n || j >= n || i === j) return `edge [${String(i)}, ${String(j)}] is not between two different vertices 0 to ${n - 1}`;
    adj[i][j] = adj[j][i] = true;
  }
  return { n, adj };
}

/** graph6, the usual format for Ramsey graphs (n ≤ 62 uses one byte for n; up to 258047 uses four). */
export function parseGraph6(s: string): { n: number; adj: boolean[][] } | string {
  s = s.trim().replace(/^>>graph6<</, "");
  if (!s || [...s].some((ch) => ch.charCodeAt(0) < 63 || ch.charCodeAt(0) > 126)) return "graph6 must use characters ? to ~";
  let i = 0, n: number;
  if (s.charCodeAt(0) !== 126) { n = s.charCodeAt(0) - 63; i = 1; }
  else { if (s.length < 4 || s.charCodeAt(1) === 126) return "graph6 too large"; n = ((s.charCodeAt(1) - 63) << 12) | ((s.charCodeAt(2) - 63) << 6) | (s.charCodeAt(3) - 63); i = 4; }
  if (n < 1 || n > LIMITS.ramsey_vertices) return `graph6 has ${n} vertices; the limit is ${LIMITS.ramsey_vertices}`;
  const bits = (n * (n - 1)) / 2;
  if (s.length - i !== Math.ceil(bits / 6)) return `graph6 length does not match ${n} vertices`;
  const adj = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  let k = 0;
  for (let j = 1; j < n; j++)
    for (let r = 0; r < j; r++, k++) {
      const byte = s.charCodeAt(i + Math.floor(k / 6)) - 63;
      if ((byte >> (5 - (k % 6))) & 1) adj[r][j] = adj[j][r] = true;
    }
  return { n, adj };
}

/** Checker A: bitset branch and bound. true = has a k-clique, false = none, null = over budget. */
function hasCliqueBits(n: number, adj: boolean[][], k: number, want: boolean, budget: { nodes: number }): boolean | null {
  const W = Math.ceil(n / 32);
  const N = Array.from({ length: n }, (_, v) => {
    const b = new Uint32Array(W);
    for (let u = 0; u < n; u++) if (u !== v && adj[v][u] === want) b[u >>> 5] |= 1 << (u & 31);
    return b;
  });
  const pop = (b: Uint32Array) => { let c = 0; for (let x of b) { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); c += (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; } return c; };
  let over = false;
  const go = (P: Uint32Array, size: number): boolean => {
    if (size >= k) return true;
    if (size + pop(P) < k) return false;
    if (--budget.nodes < 0) { over = true; return false; }
    const Q = P.slice();
    for (let w = 0; w < W; w++)
      while (Q[w]) {
        const bit = Q[w] & -Q[w], v = (w << 5) + (31 - Math.clz32(bit));
        Q[w] &= ~bit;
        if (size + 1 + pop(Q) < k) return false;
        const R = new Uint32Array(W);
        for (let x = 0; x < W; x++) R[x] = Q[x] & N[v][x];
        if (go(R, size + 1)) return true;
        if (over) return false;
      }
    return false;
  };
  const all = new Uint32Array(W);
  for (let v = 0; v < n; v++) all[v >>> 5] |= 1 << (v & 31);
  const r = go(all, 0);
  return over ? null : r;
}

/** Checker B: plain matrix, grow vertex lists in increasing order. Same answer, separate code. */
function hasCliqueList(n: number, adj: boolean[][], k: number, want: boolean, budget: { nodes: number }): boolean | null {
  const link = (a: number, b: number) => adj[a][b] === want;
  const chosen: number[] = [];
  let over = false;
  const extend = (cands: number[]): boolean => {
    if (chosen.length === k) return true;
    if (chosen.length + cands.length < k) return false;
    if (--budget.nodes < 0) { over = true; return false; }
    for (let idx = 0; idx < cands.length; idx++) {
      if (chosen.length + cands.length - idx < k) return false;
      const v = cands[idx];
      chosen.push(v);
      const next: number[] = [];
      for (let j = idx + 1; j < cands.length; j++) if (link(v, cands[j])) next.push(cands[j]);
      if (extend(next)) return true;
      chosen.pop();
      if (over) return false;
    }
    return false;
  };
  const r = extend(Array.from({ length: n }, (_, i) => i));
  return over ? null : r;
}

function checkRamsey(construction: unknown, s: number, t: number, search: typeof hasCliqueBits, label: string): CheckResult {
  const g = parseGraph(construction);
  if (typeof g === "string") return bad(g);
  const budget = { nodes: LIMITS.ramsey_nodes }; // shared by both searches in this request
  const clique = search(g.n, g.adj, s, true, budget);
  if (clique === true) return bad(`the graph has ${s} vertices that are all joined (a ${s}-clique)`);
  const indep = clique === null ? null : search(g.n, g.adj, t, false, budget);
  if (indep === true) return bad(`the graph has ${t} vertices with no edges among them (an independent set of ${t})`);
  if (clique === null || indep === null) return overBudget(`the clique search on ${g.n} vertices ran past the site's budget; the offline checker settles it`);
  return { ok: true, value: String(g.n), detail: `${label}: ${g.n} vertices, no ${s}-clique, no independent set of ${t}, so R(${s},${t}) ≥ ${g.n + 1}` };
}

export const checkRamseyA = (c: unknown, s: number, t: number) => checkRamsey(c, s, t, hasCliqueBits, "bitset search");
export const checkRamseyB = (c: unknown, s: number, t: number) => checkRamsey(c, s, t, hasCliqueList, "second check, list search");

/** Offline use: the same checkers with no work caps. */
export function withoutBudget<T>(fn: () => T): T {
  const saved = { ...LIMITS };
  const L = LIMITS as { -readonly [K in keyof typeof LIMITS]: number };
  L.kissing_work = Number.MAX_SAFE_INTEGER;
  L.ramsey_nodes = Number.MAX_SAFE_INTEGER;
  try { return fn(); } finally { L.kissing_work = saved.kissing_work; L.ramsey_nodes = saved.ramsey_nodes; }
}
