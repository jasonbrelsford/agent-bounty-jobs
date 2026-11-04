#!/usr/bin/env node
// Math Record Hunt offline checker: runs BOTH of the site's checkers on a construction with no
// work budget, for claims too big to settle inside one request ("needs_manual_check").
//
//   npm run build:test
//   node tools/math/check.mjs clm_0123456789abcdef            # fetches the public claim
//   node tools/math/check.mjs packing-26 construction.json     # a local file
//
// It only reads. It never posts a result anywhere: a person records the outcome with the
// admin review route.
import { readFileSync } from "node:fs";
import { mathProblem } from "../../.test-build/science/math-records.js";
import { runCheck } from "../../.test-build/science/math.js";
import { withoutBudget } from "../../.test-build/science/math-check.js";

const [a, b] = process.argv.slice(2);
if (!a) { console.error("usage: check.mjs <claim_id> | <problem_id> <construction.json>"); process.exit(2); }
let problemId, construction;
if (a.startsWith("clm_")) {
  const origin = process.env.BOUNTY_ORIGIN ?? "https://bounty.brelsfordsoftware.com";
  const r = await fetch(`${origin}/v1/science/math/claims/${a}`);
  if (!r.ok) { console.error(`could not read claim: HTTP ${r.status}`); process.exit(1); }
  const c = await r.json();
  problemId = c.problem_id; construction = c.construction;
} else {
  problemId = a; construction = JSON.parse(readFileSync(b, "utf8"));
  if (construction.construction) construction = construction.construction;
}
const p = mathProblem(problemId);
if (!p) { console.error(`no problem ${problemId}`); process.exit(1); }
for (const which of ["A", "B"]) {
  const t = Date.now();
  const r = withoutBudget(() => runCheck(p, construction, which));
  console.log(`checker ${which}: ${r.ok ? `PASS value ${r.value} (${r.detail})` : `FAIL ${r.reason}`} in ${Date.now() - t} ms`);
}
console.log(`listed value to beat: ${p.record} (${p.source}, read ${p.as_of})`);
