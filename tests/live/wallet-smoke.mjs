// Live check of payout wallets against the deployed board. Run by hand only
// (.github/workflows/live-wallet-smoke.yml). It registers one clearly named
// test agent, never moves money, and prints that agent's id so it can be
// removed afterwards. The test addresses are the public EIP-55 reference
// vectors: nobody pays a test agent, so no funds can reach them.
import assert from "node:assert/strict";

const B = (process.env.BASE_URL || "https://bounty.brelsfordsoftware.com").replace(/\/$/, "");
const WAIT = Number(process.env.WAIT_FOR_HOLD_SECONDS || 0);
const A1 = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const A2 = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const TYPO = A1.slice(0, -1) + "D"; // last letter's case flipped
const NAME = `brelsford-wallet-selftest-${Date.now().toString(36)}`;
let key = "";
const results = [];

async function call(method, path, body) {
  const r = await fetch(B + path, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name]); console.log("FAIL", name, "-", e.message); }
}
const inboxTypes = async () => ((await call("GET", "/v1/agents/me/inbox?limit=100")).j?.events ?? []).map((e) => e.type);

for (const [label, body] of [
  ["malformed address", { payout_address: "0x1234" }],
  ["wrong checksum", { payout_address: TYPO }],
  ["other chain", { payout_address: A1, payout_chain: "ethereum" }],
  ["burn address", { payout_address: "0x000000000000000000000000000000000000dEaD" }],
  ["USDC contract as wallet", { payout_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }],
]) {
  await check(`signup refuses ${label}, creates nothing`, async () => {
    const r = await call("POST", "/v1/agents/register", { name: `${NAME}-bad`, ...body });
    assert.equal(r.status, 400, JSON.stringify(r.j));
    assert.ok(!r.j?.api_key);
  });
}

await check("signup with a valid Base address saves it", async () => {
  const r = await call("POST", "/v1/agents/register", { name: NAME, payout_address: A1 });
  assert.equal(r.status, 201, JSON.stringify(r.j));
  key = r.j.api_key;
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${key}`);
  console.log("TEST_AGENT_ID", r.j.agent_id);
  assert.equal(r.j.payout_address, A1);
  assert.equal(r.j.payout_chain, "base");
});
if (!key) { console.log("No test agent was created; stopping."); process.exit(1); }

await check("wallet shows on GET payout-address and in /me", async () => {
  const v = (await call("GET", "/v1/agents/me/payout-address")).j;
  assert.equal(v.payout_address, A1);
  assert.equal(v.pending_change, null);
  const me = (await call("GET", "/v1/agents/me")).j;
  assert.equal(me.payout?.payout_address, A1);
});
await check("inbox has payout.address_set", async () => assert.ok((await inboxTypes()).includes("payout.address_set")));

await check("later update refuses malformed and wrong-checksum addresses", async () => {
  assert.equal((await call("POST", "/v1/agents/me/payout-address", { payout_address: "0xZZ" })).status, 400);
  const t = await call("POST", "/v1/agents/me/payout-address", { payout_address: TYPO });
  assert.equal(t.status, 400);
  assert.match(String(t.j?.message ?? t.j?.error ?? ""), /checksum/);
  assert.equal((await call("GET", "/v1/agents/me/payout-address")).j.payout_address, A1);
});

let firstEffective = "";
await check("a change is held about 24 hours and the old address stays active", async () => {
  const r = await call("POST", "/v1/agents/me/payout-address", { payout_address: A2 });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.status, "pending");
  assert.equal(r.j.payout_address, A1);
  assert.equal(r.j.pending_change.payout_address, A2);
  firstEffective = r.j.pending_change.effective_at;
  const held = (Date.parse(firstEffective) - Date.now()) / 3_600_000;
  assert.ok(held > 23.5 && held <= 24.05, `hold ${held}h`);
  assert.equal((await call("GET", "/v1/agents/me/payout-address")).j.payout_address, A1);
});
await check("inbox has payout.address_change_requested", async () =>
  assert.ok((await inboxTypes()).includes("payout.address_change_requested")));

await check("re-sending the current address cancels the change", async () => {
  const r = await call("POST", "/v1/agents/me/payout-address", { payout_address: A1 });
  assert.equal(r.j.status, "active");
  assert.equal((await call("GET", "/v1/agents/me/payout-address")).j.pending_change, null);
  assert.ok((await inboxTypes()).includes("payout.address_change_cancelled"));
});

await check("payout addresses never appear in public feeds", async () => {
  for (const p of ["/v1/activity", "/v1/events?replay=1"]) {
    const r = await fetch(B + p);
    const text = (await r.text()).toLowerCase();
    assert.ok(!text.includes(A1.toLowerCase().slice(2)) && !text.includes(A2.toLowerCase().slice(2)), p);
  }
});

if (WAIT > 0) {
  await check("after the hold the new address takes effect, with a notice", async () => {
    const r = await call("POST", "/v1/agents/me/payout-address", { payout_address: A2 });
    assert.equal(r.j.status, "pending");
    console.log(`WAITING_FOR_HOLD up to ${WAIT}s (move payout_pending_effective_at into the past to finish)`);
    const until = Date.now() + WAIT * 1000;
    let v;
    while (Date.now() < until) {
      v = (await call("GET", "/v1/agents/me/payout-address")).j;
      if (v.payout_address === A2) break;
      await new Promise((s) => setTimeout(s, 10_000));
    }
    assert.equal(v.payout_address, A2, "change never applied");
    assert.ok((await inboxTypes()).includes("payout.address_changed"));
  });
}

const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
