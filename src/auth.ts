/**
 * Human identity via OAuth. Agents authenticate with a bearer key they store;
 * a person needs an account they can get back into, which a key they might lose
 * is not.
 *
 * Sessions are STATELESS: a cookie carrying `agentId.expiry.hmac`, verified with
 * SESSION_SECRET. No session table, so no extra D1 read on every page view. The
 * trade is that revocation before expiry is not possible — acceptable at a 7-day
 * lifetime for a board where the session grants no destructive power, and the
 * thing worth revoking (the API key) is separately rotatable.
 *
 * Fail-closed throughout: a provider whose credentials are absent is not
 * offered, and a missing SESSION_SECRET disables human sign-in entirely.
 */
import { type Env, type Agent, OpError, LIMITS } from "./core";

const SESSION_TTL_S = 7 * 24 * 3600;
const STATE_TTL_S = 600; // an OAuth round-trip that takes >10 min has failed

type Provider = "github" | "google";

const PROVIDERS: Record<Provider, {
  authorize: string; token: string; userinfo: string; scope: string;
}> = {
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    userinfo: "https://api.github.com/user",
    scope: "read:user",
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://www.googleapis.com/oauth2/v3/userinfo",
    scope: "openid profile",
  },
};

export function isProvider(v: string): v is Provider {
  return v === "github" || v === "google";
}

function creds(env: Env, p: Provider): { id: string; secret: string } | null {
  const id = p === "github" ? env.GITHUB_CLIENT_ID : env.GOOGLE_CLIENT_ID;
  const secret = p === "github" ? env.GITHUB_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

/** Providers actually configured — drives which buttons the UI renders. */
export function enabledProviders(env: Env): Provider[] {
  if (!env.SESSION_SECRET) return [];
  return (["github", "google"] as Provider[]).filter((p) => creds(env, p));
}

// ── signing ─────────────────────────────────────────────────────────────────

const b64url = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

/** Constant-time compare so a signature cannot be probed byte by byte. */
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function seal(secret: string, payload: string, ttl: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const body = `${payload}.${exp}`;
  return `${body}.${await hmac(secret, body)}`;
}

async function unseal(secret: string, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!safeEq(sig, await hmac(secret, body))) return null;
  const j = body.lastIndexOf(".");
  const exp = Number(body.slice(j + 1));
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  return body.slice(0, j);
}

// ── cookies ─────────────────────────────────────────────────────────────────

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export function readCookie(header: string | null, name: string): string | undefined {
  return header
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** The signed-in human, or null. Never throws — callers decide what to do. */
export async function sessionAgent(env: Env, request: Request): Promise<Agent | null> {
  if (!env.SESSION_SECRET) return null;
  const id = await unseal(env.SESSION_SECRET, readCookie(request.headers.get("cookie"), "sid"));
  if (!id) return null;
  return env.DB.prepare("SELECT id, name, created_at FROM agents WHERE id = ? AND kind = 'human'")
    .bind(id)
    .first<Agent>();
}

// ── flow ────────────────────────────────────────────────────────────────────

export async function oauthStart(env: Env, p: Provider, origin: string): Promise<Response> {
  const c = creds(env, p);
  if (!c || !env.SESSION_SECRET) throw new OpError(503, `${p} sign-in is not configured on this board`);
  // `state` is signed and cookie-bound: an attacker cannot mint one, and a
  // callback that did not originate here has no matching cookie to compare to.
  const nonce = crypto.randomUUID();
  const state = await seal(env.SESSION_SECRET, nonce, STATE_TTL_S);
  const u = new URL(PROVIDERS[p].authorize);
  u.searchParams.set("client_id", c.id);
  u.searchParams.set("redirect_uri", `${origin}/auth/${p}/callback`);
  u.searchParams.set("scope", PROVIDERS[p].scope);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  return new Response(null, {
    status: 302,
    headers: { location: u.toString(), "set-cookie": cookie("ostate", state, STATE_TTL_S) },
  });
}

export async function oauthCallback(env: Env, p: Provider, request: Request, origin: string): Promise<Response> {
  const c = creds(env, p);
  if (!c || !env.SESSION_SECRET) throw new OpError(503, `${p} sign-in is not configured on this board`);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = readCookie(request.headers.get("cookie"), "ostate");
  if (!code) throw new OpError(400, "no authorization code returned");
  if (!state || !expected || !safeEq(state, expected) || !(await unseal(env.SESSION_SECRET, state)))
    throw new OpError(403, "sign-in state did not validate — start again from the sign-in page");

  const tokRes = await fetch(PROVIDERS[p].token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.id, client_secret: c.secret, code,
      redirect_uri: `${origin}/auth/${p}/callback`, grant_type: "authorization_code",
    }),
  });
  const tok = (await tokRes.json()) as { access_token?: string };
  if (!tok.access_token) throw new OpError(502, `${p} did not return an access token`);

  const uRes = await fetch(PROVIDERS[p].userinfo, {
    headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/json", "user-agent": "agent-bounty-jobs" },
  });
  const prof = (await uRes.json()) as Record<string, unknown>;
  const subject = `${p}:${String(prof.id ?? prof.sub ?? "")}`;
  if (subject.endsWith(":")) throw new OpError(502, `${p} did not return a usable account id`);
  const rawName = String(prof.name ?? prof.login ?? "").trim() || `${p} user`;
  const name = rawName.slice(0, LIMITS.name.max).padEnd(LIMITS.name.min, ".");

  const agentId = await upsertHuman(env, subject, name);
  return new Response(null, {
    status: 302,
    headers: [
      ["location", "/jobs"],
      ["set-cookie", await seal(env.SESSION_SECRET, agentId, SESSION_TTL_S).then((t) => cookie("sid", t, SESSION_TTL_S))],
      // The one-shot state cookie has done its job; leaving it set would let a
      // stale value be replayed against a later callback.
      ["set-cookie", cookie("ostate", "", 0)],
    ],
  });
}

/**
 * Find-or-create the human behind an OAuth subject.
 *
 * Humans get a real API key like agents do, so the same person can use the web
 * UI and the JSON API. It is generated here and never shown by this function —
 * the profile page is responsible for revealing or rotating it.
 */
async function upsertHuman(env: Env, subject: string, name: string): Promise<string> {
  const found = await env.DB.prepare("SELECT id FROM agents WHERE oauth_subject = ?")
    .bind(subject)
    .first<{ id: string }>();
  if (found) return found.id;

  const id = `agt_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const rawKey = `bk_${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
  const keyHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO agents (id, name, key_hash, kind, oauth_subject, created_at) VALUES (?, ?, ?, 'human', ?, ?)",
    ).bind(id, name, keyHash, subject, at),
    env.DB.prepare("INSERT INTO events (at, kind, bounty_id, agent_id, detail) VALUES (?, 'agent_registered', NULL, ?, ?)")
      .bind(at, id, `${name} joined as a human via ${subject.split(":")[0]}`),
  ]);
  return id;
}

export function logout(): Response {
  return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookie("sid", "", 0) } });
}
