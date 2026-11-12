// Mutation check: plant one bug at a time in a copy of BountyEscrow.sol and
// confirm the test suite fails. A planted bug that leaves every test green is
// a rule nobody is testing.
//
//   npm run test:mutants            all of them (several minutes)
//   npm run test:mutants -- A D     only the named ones
//
// Works in a temporary copy; the repo's files are never changed.
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir, availableParallelism } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "src/BountyEscrow.sol";

// [id, what the bug does, exact text to find (must occur once), replacement]
const MUTANTS = [
  ["A", "agent can pay themselves straight after submitting",
    "if (msg.sender != j.poster && block.timestamp <=", "if (msg.sender != j.poster && msg.sender != j.agent && block.timestamp <="],
  ["B", "expiry refund works on a submitted job",
    "if (j.state != State.Funded) revert WrongState();\n        if (block.timestamp <= j.deadline) revert TooEarly();",
    "if (j.state != State.Funded && j.state != State.Submitted) revert WrongState();\n        if (block.timestamp <= j.deadline) revert TooEarly();"],
  ["C", "poster can abandon and pull a refund mid-job",
    "if (msg.sender != j.agent) revert NotAgent();\n        _refund(id, j, 2);",
    "if (msg.sender != j.agent && msg.sender != j.poster) revert NotAgent();\n        _refund(id, j, 2);"],
  ["D", "withdraw never zeroes the caller's credit", "credit[msg.sender] = 0;", ""],
  ["E", "credit is overwritten instead of added", "credit[to] += amount;", "credit[to] = amount;"],
  ["F", "reject window closes an hour early",
    "+ REVIEW_WINDOW) revert TooLate();", "+ REVIEW_WINDOW - 1 hours) revert TooLate();"],
  ["G", "strangers can force payment an hour early",
    "+ REVIEW_WINDOW) revert TooEarly();", "+ REVIEW_WINDOW - 1 hours) revert TooEarly();"],
  ["H1", "deadlines 30 seconds under one hour are accepted",
    "deadline < block.timestamp + MIN_DURATION", "deadline < block.timestamp + MIN_DURATION - 30"],
  ["H2", "deadlines 12 hours over 30 days are accepted",
    "deadline > block.timestamp + MAX_DURATION", "deadline > block.timestamp + MAX_DURATION + 12 hours"],
  ["J", "an all-zero deliverable hash is accepted", "if (deliverable == bytes32(0)) revert WrongState();", ""],
  ["L", "Paid event reports the wrong payee, amount and fee",
    "emit Paid(id, agent, amount - fee, fee);", "emit Paid(id, treasury, amount, 0);"],
  ["I", "submit is allowed on a finished job",
    "if (j.state != State.Funded) revert WrongState();\n        if (msg.sender != j.agent) revert NotAgent();\n        if (block.timestamp > j.deadline) revert TooLate();",
    "if (j.state == State.None || j.state == State.Submitted) revert WrongState();\n        if (msg.sender != j.agent) revert NotAgent();\n        if (block.timestamp > j.deadline) revert TooLate();"],
  ["N", "withdraw does not reduce totalCredit", "totalCredit -= amount;", ""],
  ["O", "expiry refund is allowed at the deadline second",
    "if (block.timestamp <= j.deadline) revert TooEarly();", "if (block.timestamp < j.deadline) revert TooEarly();"],
  ["P", "anyone can reject", "if (msg.sender != j.poster) revert NotPoster();", ""],
  ["Q", "the total-held cap is gone", "if (held + amount > maxHeld) revert TooMuchHeld();", ""],
  ["R", "the fee is paid to the agent", "if (fee != 0) _pay(treasury, fee);", "if (fee != 0) _pay(agent, fee);"],
  ["S", "the agent cannot submit in the deadline second",
    "if (block.timestamp > j.deadline) revert TooLate();", "if (block.timestamp >= j.deadline) revert TooLate();"],
  ["T", "an expiry refund is reported as 'agent gave up'", "_refund(id, j, 1);", "_refund(id, j, 2);"],
  ["U", "the fee is computed slightly low", "(amount * feeBps) / 10_000;", "(amount * feeBps) / 10_001;"],
  ["V", "the poster cannot pay before the review window ends",
    "if (msg.sender != j.poster && block.timestamp <=", "if (block.timestamp <="],
  ["W", "anyone can submit for the agent",
    "if (msg.sender != j.agent) revert NotAgent();\n        if (block.timestamp > j.deadline) revert TooLate();",
    "if (block.timestamp > j.deadline) revert TooLate();"],
  ["X", "a transfer that returns false counts as paid",
    "if (!ok || (data.length != 0 && (data.length != 32 || abi.decode(data, (uint256)) != 1))) {", "if (!ok) {"],
  ["Y", "the open-job count is not reduced on payout",
    "j.state = State.Paid;\n        openJobs -= 1;", "j.state = State.Paid;"],
  ["Z", "the open-job cap is gone", "if (openJobs >= maxOpenJobs) revert TooManyOpenJobs();", ""],
];

const original = readFileSync(join(ROOT, SRC), "utf8");
const only = process.argv.slice(2);
const chosen = MUTANTS.filter(([id]) => !only.length || only.includes(id));

function run(dir) {
  return new Promise((resolve) => {
    const p = spawn("npx", ["hardhat", "test", "solidity"], { cwd: dir });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

function workdir(source) {
  const dir = mkdtempSync(join(tmpdir(), "escrow-mutant-"));
  for (const f of ["src", "test", "hardhat.config.ts", "package.json", "remappings.txt"])
    cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  // Fewer random runs: a planted bug should be caught by a named test, not by luck.
  const cfg = readFileSync(join(dir, "hardhat.config.ts"), "utf8").replace(/runs: \d+/, "runs: 50");
  writeFileSync(join(dir, "hardhat.config.ts"), cfg);
  writeFileSync(join(dir, SRC), source);
  return dir;
}

async function check([id, what, find, replace]) {
  if (original.split(find).length !== 2) return { id, what, verdict: "BROKEN", detail: "text to replace not found exactly once" };
  const dir = workdir(original.replace(find, replace));
  try {
    const { code, out } = await run(dir);
    const ran = /Running Solidity tests/.test(out);
    const failing = out.match(/(\d+) failing/);
    if (!ran) return { id, what, verdict: "BROKEN", detail: "did not compile or run:\n" + out.slice(-600) };
    if (code !== 0 && failing) {
      const names = [...out.matchAll(/✘ (\w+)\(/g)].map((m) => m[1]);
      return { id, what, verdict: "caught", detail: `${failing[1]} failing: ${[...new Set(names)].slice(0, 4).join(", ")}` };
    }
    return { id, what, verdict: "SURVIVED", detail: "every test passed" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const results = [];
const queue = [...chosen];
const workers = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
await Promise.all(
  Array.from({ length: workers }, async () => {
    for (let m; (m = queue.shift()); ) {
      const r = await check(m);
      results.push(r);
      console.log(`${r.verdict.padEnd(8)} ${r.id.padEnd(3)} ${r.what}${r.verdict === "caught" ? "" : "\n         " + r.detail}`);
    }
  }),
);

const caught = results.filter((r) => r.verdict === "caught").length;
console.log(`\n${caught} of ${results.length} planted bugs caught`);
for (const r of results.filter((r) => r.verdict === "caught").sort((a, b) => a.id.localeCompare(b.id)))
  console.log(`  ${r.id.padEnd(3)} ${r.detail}`);
process.exit(caught === results.length ? 0 : 1);
