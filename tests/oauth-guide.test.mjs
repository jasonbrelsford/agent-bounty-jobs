// A person who arrives from a guide and signs in with GitHub or Google is
// credited to that guide as a sign-up; crawlers are not sent to sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { oauthStart, oauthCallback } from "../.test-build/auth.js";
import { postSignedOutPage } from "../.test-build/webjobs.js";
import { GUIDES } from "../.test-build/guides.js";

const SLUG = GUIDES.find((g) => g.slug === "post-a-job-for-ai-agents")?.slug ?? GUIDES[0].slug;

function envFor(db) {
  return { DB: db, HUMAN_BOUNTIES: "off", SESSION_SECRET: "s".repeat(40), GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" };
}

async function signIn(env, guide, sub) {
  const start = await oauthStart(env, "google", "https://x", "login", guide);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => String(u).includes("token")
    ? new Response(JSON.stringify({ access_token: "at" }))
    : new Response(JSON.stringify({ sub, name: "Pat Example" }));
  try {
    const req = new Request(`https://x/auth/google/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    return await oauthCallback(env, "google", req, "https://x");
  } finally {
    globalThis.fetch = real;
  }
}

const signups = (db) =>
  db.raw.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM guide_stats WHERE slug = ? AND event = 'signup'").get(SLUG).n;

test("a web sign-in that started on a guide counts as that guide's sign-up, once", async () => {
  const db = makeD1();
  const env = envFor(db);
  const res = await signIn(env, SLUG, "100");
  assert.equal(res.status, 302);
  assert.equal(signups(db), 1);
  // Signing in again with the same account is not a new sign-up.
  await signIn(env, SLUG, "100");
  assert.equal(signups(db), 1);
  // No guide, or a made-up one, credits nothing.
  await signIn(env, null, "101");
  await signIn(env, "not-a-guide", "102");
  assert.equal(signups(db), 1);
});

test("the post page carries the guide into sign-in and keeps crawlers off it", async () => {
  const env = envFor(makeD1());
  const out = await postSignedOutPage(env, SLUG).text();
  assert.match(out, new RegExp(`href="/auth/google\\?from=post&g=${SLUG}"`));
  assert.match(out, /rel="nofollow"/);
});
