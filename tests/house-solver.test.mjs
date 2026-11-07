// The house solver: only a GitHub OIDC token from our own math-solver workflow on main
// can post, its entries go through the same exact checks, and it plays as a labelled house team.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import { verifyHouseSolverToken, houseSolverSubmit, houseSolverAgent, HOUSE_SOLVER } from "../.test-build/science/house-solver.js";
import { authByKey } from "../.test-build/core.js";

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pub = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const fakeFetch = async () => new Response(JSON.stringify({ keys: [pub] }), { status: 200 });
const now = Date.now();
const good = {
  iss: HOUSE_SOLVER.issuer, aud: HOUSE_SOLVER.audience, exp: Math.floor(now / 1000) + 300, iat: Math.floor(now / 1000),
  repository: HOUSE_SOLVER.repository, ref: "refs/heads/main", job_workflow_ref: HOUSE_SOLVER.workflow, event_name: "schedule", run_id: "42",
};
async function sign(claims, key = pair.privateKey, kid = "k1") {
  const h = enc({ alg: "RS256", kid, typ: "JWT" }), p = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}
const rejects = (p, status) => assert.rejects(p, (e) => e.status === status);

test("accepts only our own workflow on main, signed by GitHub", async () => {
  const c = await verifyHouseSolverToken(await sign(good), fakeFetch, now);
  assert.equal(c.run_id, "42");
  await rejects(verifyHouseSolverToken(await sign({ ...good, repository: "someone/fork" }), fakeFetch, now), 403);
  await rejects(verifyHouseSolverToken(await sign({ ...good, ref: "refs/heads/feature" }), fakeFetch, now), 403);
  await rejects(verifyHouseSolverToken(await sign({ ...good, job_workflow_ref: "jasonbrelsford/agent-bounty-jobs/.github/workflows/other.yml@refs/heads/main" }), fakeFetch, now), 403);
  await rejects(verifyHouseSolverToken(await sign({ ...good, aud: "https://elsewhere.example" }), fakeFetch, now), 401);
  await rejects(verifyHouseSolverToken(await sign({ ...good, exp: Math.floor(now / 1000) - 600 }), fakeFetch, now), 401);
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  await rejects(verifyHouseSolverToken(await sign(good, other.privateKey), fakeFetch, now), 401);
  await rejects(verifyHouseSolverToken("not-a-token", fakeFetch, now), 401);
});

test("posts as a labelled house team through the normal checks, and no API key opens it", async () => {
  const db = makeD1();
  const circles = [["0.25", "0.25", "0.25"], ["0.75", "0.75", "0.25"]];
  const r = await houseSolverSubmit(db, { problem_id: "packing-2", construction: { circles } }, good);
  assert.equal(r.vet.status, "scored");
  const again = await houseSolverAgent(db);
  assert.equal(again.id, HOUSE_SOLVER.agent_id);
  const team = await db.prepare("SELECT name FROM sci_teams WHERE id = ?").bind(HOUSE_SOLVER.team_id).first();
  assert.match(team.name, /house team/);
  await assert.rejects(houseSolverSubmit(db, { problem_id: "packing-2", construction: { circles: [["0.5", "0.5", "0.6"], ["0.1", "0.1", "0.1"]] } }, good), (e) => e.status === 422);
  assert.equal(await authByKey(db, "house:no-api-key:math-solver"), null);
});
