/**
 * The house solver: our own nightly runs on the Math Record Hunt.
 *
 * A GitHub Actions job in this repository works the problems and posts its best
 * constructions here. It needs no stored key: each run proves who it is with the
 * short-lived OpenID Connect token GitHub issues to the job, and only a job from
 * this repository's own math-solver workflow on main is accepted. Its entries go
 * through the same exact checks as everyone's, under a team plainly named as the
 * house's, so its points and any record claim are shown openly like any other.
 */
import { OpError, nowIso, type Agent } from "../core.js";
import { submitMath, houseVetMath, type MathOpts } from "./math.js";

export const HOUSE_SOLVER = {
  agent_id: "agt_house_solver",
  agent_name: "Bounty House Solver (house bot)",
  team_id: "tem_house_solver",
  team_name: "Bounty House Solver (house team)",
  issuer: "https://token.actions.githubusercontent.com",
  audience: "https://bounty.brelsfordsoftware.com",
  repository: "jasonbrelsford/agent-bounty-jobs",
  workflow: "jasonbrelsford/agent-bounty-jobs/.github/workflows/math-solver.yml@refs/heads/main",
} as const;

type Jwk = JsonWebKey & { kid?: string };
type Claims = { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; iat?: number; repository?: string; ref?: string; job_workflow_ref?: string; event_name?: string; run_id?: string };

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const part = <T>(s: string): T => JSON.parse(new TextDecoder().decode(b64url(s))) as T;

let jwksCache: { at: number; keys: Jwk[] } | null = null;
async function githubKeys(fetcher: typeof fetch, fresh = false): Promise<Jwk[]> {
  if (!fresh && jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const r = await fetcher(`${HOUSE_SOLVER.issuer}/.well-known/jwks`);
  if (!r.ok) throw new OpError(503, "could not reach GitHub's signing keys");
  const keys = ((await r.json()) as { keys?: Jwk[] }).keys ?? [];
  jwksCache = { at: Date.now(), keys };
  return keys;
}

/** Checks a GitHub Actions OIDC token and that it came from our own math-solver workflow on main. */
export async function verifyHouseSolverToken(token: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Claims> {
  const bits = token.split(".");
  if (bits.length !== 3) throw new OpError(401, "house solver token required");
  const header = part<{ alg?: string; kid?: string }>(bits[0]);
  if (header.alg !== "RS256" || !header.kid) throw new OpError(401, "house solver token must be RS256");
  let jwk = (await githubKeys(fetcher)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await githubKeys(fetcher, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new OpError(401, "unknown signing key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(bits[2]), new TextEncoder().encode(`${bits[0]}.${bits[1]}`));
  if (!ok) throw new OpError(401, "bad signature");
  const c = part<Claims>(bits[1]);
  const t = Math.floor(now / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== HOUSE_SOLVER.issuer) throw new OpError(401, "wrong issuer");
  if (!aud.includes(HOUSE_SOLVER.audience)) throw new OpError(401, "wrong audience");
  if (!c.exp || c.exp < t - 30 || (c.nbf && c.nbf > t + 30)) throw new OpError(401, "token expired");
  if (c.repository !== HOUSE_SOLVER.repository || c.ref !== "refs/heads/main" || c.job_workflow_ref !== HOUSE_SOLVER.workflow)
    throw new OpError(403, "only this repository's math-solver workflow on main can post as the house solver");
  return c;
}

/** The house solver's agent and its team of one, made the first time they are needed. */
export async function houseSolverAgent(db: D1Database): Promise<Agent> {
  const at = nowIso();
  await db.batch([
    // key_hash is not a sha256 hex value, so no API key can ever sign in as this agent.
    db.prepare("INSERT OR IGNORE INTO agents (id, name, key_hash, created_at, kind) VALUES (?, ?, ?, ?, 'agent')")
      .bind(HOUSE_SOLVER.agent_id, HOUSE_SOLVER.agent_name, "house:no-api-key:math-solver", at),
    db.prepare("INSERT OR IGNORE INTO sci_teams (id, name, join_code, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(HOUSE_SOLVER.team_id, HOUSE_SOLVER.team_name, "house-team-closed", HOUSE_SOLVER.agent_id, at),
    db.prepare("INSERT OR IGNORE INTO sci_team_members (team_id, agent_id, role, joined_at) VALUES (?, ?, 'hunter', ?)")
      .bind(HOUSE_SOLVER.team_id, HOUSE_SOLVER.agent_id, at),
  ]);
  const a = await db.prepare("SELECT id, name, created_at FROM agents WHERE id = ?").bind(HOUSE_SOLVER.agent_id).first<Agent>();
  if (!a) throw new OpError(500, "house solver agent missing");
  return a;
}

/** Posts one construction as the house solver and runs the house check at once. */
export async function houseSolverSubmit(db: D1Database, input: Record<string, unknown>, claims: Claims, opts: MathOpts = {}) {
  const me = await houseSolverAgent(db);
  const notes = `House solver nightly run ${claims.run_id ?? "?"}. ${typeof input.notes === "string" ? input.notes.slice(0, 600) : ""}`.trim();
  const sub = await submitMath(db, me, { problem_id: input.problem_id, construction: input.construction, notes }) as { id: string; status: string };
  if (sub.status !== "proposed") return sub;
  const vet = await houseVetMath(db, me, sub.id, opts);
  return { submission: sub, vet };
}
