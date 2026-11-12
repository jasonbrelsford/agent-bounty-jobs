// Payout wallets: address checks (keccak + EIP-55), setting one at signup,
// and the 24-hour hold on changes that stops a stolen key redirecting pay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import {
  registerAgent, authByKey, postBounty, submitToBounty, settlementInstruction, setPayoutAddress,
  payoutView, myActivity, readInbox, PAYOUT_CHANGE_HOLD_MS,
} from "../.test-build/core.js";
import { keccak256, toChecksumAddress, checkPayoutAddress } from "../.test-build/wallet.js";
import { FEED_KINDS } from "../.test-build/livefeed.js";

const ENV = { HUMAN_BOUNTIES: "off", PLATFORM_FEE_ADDRESS: "0x" + "1".repeat(40) };
// EIP-55 reference vectors.
const GOOD = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];
const A1 = GOOD[0], A2 = GOOD[1], A3 = GOOD[2];
const BOUNTY = {
  title: "Find the cheapest verified supplier", description: "Unit price, MOQ, lead time and a source link please.",
  category: "sourcing", reward_amount_cents: 2500, settlement: "onchain",
};
const SUB = ["Supplier Y: EUR 0.42/unit at 10k MOQ, source https://example.com/catalogue", undefined,
  "Verified EU supplier at EUR 0.42/unit for 10k MOQ, confirmed against their public catalogue."];

async function agent(db, name, extra = {}) {
  const r = await registerAgent(db, name, { contact_email: `${name}@example.com`, ...extra });
  return { ...r, a: await authByKey(db, r.api_key) };
}
const types = async (db, id) => (await readInbox(db, id)).events.map((e) => e.type);
/** Pretend the hold has passed. */
const elapse = (db, id) =>
  db.raw.prepare("UPDATE agents SET payout_pending_effective_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);

test("keccak-256 matches published vectors", () => {
  assert.equal(keccak256(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  // The ERC-20 Transfer topic that chain.ts filters on.
  assert.equal(keccak256("Transfer(address,address,uint256)"), "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  // Longer than one 136-byte block.
  assert.equal(keccak256("a".repeat(200)).length, 64);
});

test("EIP-55 checksums round-trip and catch typos", () => {
  for (const a of GOOD) {
    assert.equal(toChecksumAddress(a.toLowerCase()), a);
    const c = checkPayoutAddress(a);
    assert.ok(c.ok && c.checksum_verified && c.address === a.toLowerCase());
  }
  // All-lower and all-upper carry no checksum, so they are accepted unverified.
  assert.equal(checkPayoutAddress(A1.toLowerCase()).checksum_verified, false);
  assert.ok(checkPayoutAddress("0x" + A1.slice(2).toUpperCase()).ok);
  // One flipped case = a mistyped address.
  const typo = A1.slice(0, 3) + (A1[3] === "a" ? "A" : "a") + A1.slice(4);
  assert.match(checkPayoutAddress(typo).error, /checksum/);
});

test("unusable addresses and other chains are refused", () => {
  for (const bad of ["", "0x123", "0xZZ" + "0".repeat(38), A1.slice(2), `${A1} `.repeat(2)])
    assert.equal(checkPayoutAddress(bad).ok, false, String(bad));
  assert.match(checkPayoutAddress("0x" + "0".repeat(40)).error, /burn/);
  assert.match(checkPayoutAddress("0x000000000000000000000000000000000000dEaD").error, /burn/);
  assert.match(checkPayoutAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").error, /token contract/);
  assert.match(checkPayoutAddress(A1, "ethereum").error, /Base/);
  assert.ok(checkPayoutAddress(A1, "BASE").ok);
});

test("agents can add their wallet at signup; a bad one fails the signup", async () => {
  const db = makeD1();
  const r = await agent(db, "wallet-at-signup", { payout_address: A1 });
  assert.equal(r.payout_address, A1);
  assert.equal(r.payout_chain, "base");
  const view = await payoutView(db, r.agent_id);
  assert.equal(view.payout_address, A1);
  assert.equal(view.pending_change, null);
  assert.ok((await types(db, r.agent_id)).includes("payout.address_set"), "signup with a wallet leaves the same inbox notice");

  await assert.rejects(registerAgent(db, "typo-wallet", { payout_address: "0x1234" }), (e) => e.status === 400);
  const none = await db.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE name = 'typo-wallet'").get();
  assert.equal(none.n, 0);

  const later = await agent(db, "no-wallet-yet");
  assert.match(later.payout_note, /set_payout_address/);
  assert.match((await payoutView(db, later.agent_id)).action_needed, /USDC wallet on Base/);
});

test("first address is immediate; a change is held 24h and posters keep paying the old one", async () => {
  const db = makeD1();
  const poster = await agent(db, "paying-poster");
  const filler = await agent(db, "careful-filler");

  const first = await setPayoutAddress(db, filler.a, A1);
  assert.equal(first.status, "active");
  assert.ok((await types(db, filler.agent_id)).includes("payout.address_set"));

  const b = await postBounty(db, poster.a, ENV, BOUNTY);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);

  const change = await setPayoutAddress(db, filler.a, A2);
  assert.equal(change.status, "pending");
  assert.equal(change.payout_address, A1);
  assert.equal(change.pending_change.payout_address, A2);
  const held = Date.parse(change.pending_change.effective_at) - Date.now();
  assert.ok(held > PAYOUT_CHANGE_HOLD_MS - 60_000 && held <= PAYOUT_CHANGE_HOLD_MS);
  const notice = (await readInbox(db, filler.agent_id)).events.find((e) => e.type === "payout.address_change_requested");
  assert.ok(notice, "the owner is told about the change");

  // During the hold the settlement instruction still pays the old address.
  let ins = await settlementInstruction(db, ENV, poster.a, b.bounty_id, s.submission_id, A3);
  assert.equal(ins.recipients.find((x) => x.role === "contributor").address, A1.toLowerCase());

  // Re-sending the same pending address does not restart the clock.
  const again = await setPayoutAddress(db, filler.a, A2);
  assert.equal(again.pending_change.effective_at, change.pending_change.effective_at);

  // After the hold the new address is used, and the owner is told.
  elapse(db, filler.agent_id);
  ins = await settlementInstruction(db, ENV, poster.a, b.bounty_id, s.submission_id);
  assert.equal(ins.recipients.find((x) => x.role === "contributor").address, A2.toLowerCase());
  assert.ok((await types(db, filler.agent_id)).includes("payout.address_changed"));
  const log = db.raw.prepare("SELECT status FROM payout_address_changes WHERE agent_id = ? ORDER BY requested_at").all(filler.agent_id);
  assert.deepEqual(log.map((r) => r.status), ["applied", "applied"]);
});

test("sending the current address again cancels a pending change", async () => {
  const db = makeD1();
  const f = await agent(db, "cancel-filler", { payout_address: A1 });
  await setPayoutAddress(db, f.a, A2);
  await setPayoutAddress(db, f.a, A3); // supersedes A2
  const cancel = await setPayoutAddress(db, f.a, A1.toLowerCase());
  assert.equal(cancel.status, "active");
  assert.equal(cancel.cancelled_pending_change, A3);
  elapse(db, f.agent_id);
  const view = await payoutView(db, f.agent_id);
  assert.equal(view.payout_address, A1);
  assert.equal(view.pending_change, null);
  const log = db.raw.prepare("SELECT new_address, status FROM payout_address_changes WHERE agent_id = ? ORDER BY rowid").all(f.agent_id);
  assert.deepEqual(log.map((r) => r.status), ["applied", "superseded", "cancelled"]);
  assert.ok((await types(db, f.agent_id)).includes("payout.address_change_cancelled"));
});

test("payout details stay private: in the agent's own view, never in the public feed", async () => {
  const db = makeD1();
  const f = await agent(db, "private-filler", { payout_address: A1 });
  await setPayoutAddress(db, f.a, A2);
  const me = await myActivity(db, f.a);
  assert.equal(me.payout.payout_address, A1);
  assert.equal(me.payout.pending_change.payout_address, A2);
  for (const k of ["payout_address_set", "payout_address_change_requested", "payout_address_changed", "payout_address_change_cancelled"])
    assert.equal(FEED_KINDS[k], undefined, k);
});
