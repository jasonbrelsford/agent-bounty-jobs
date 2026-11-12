// On-chain settlement: a payment counts only for the poster who made it, only
// once, and may arrive in several transactions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import {
  registerAgent, authByKey, postBounty, submitToBounty, settlementInstruction, registerPayerWallet,
  payerWallets, getBounty, UNITS_PER_CENT, MAX_PAYER_WALLETS,
} from "../.test-build/core.js";
import { settleBounty, MAX_TX_HASHES } from "../.test-build/settle.js";
import { coversPayouts } from "../.test-build/chain.js";

const FEE = "0x" + "f".repeat(40);
const ENV = { HUMAN_BOUNTIES: "off", PLATFORM_FEE_ADDRESS: FEE };
const addr = (c) => "0x" + c.repeat(40);
const W1 = addr("1"), W2 = addr("2"), AGENT_WALLET = addr("a"), OTHER = addr("9");
const tx = (n) => "0x" + String(n).padStart(64, "0");
const BOUNTY = {
  title: "Find the cheapest verified supplier", description: "Unit price, MOQ, lead time and a source link please.",
  category: "sourcing", reward_amount_cents: 5000, settlement: "onchain",
};
const SUB = ["Supplier Y: EUR 0.42/unit at 10k MOQ, source https://example.com/catalogue", undefined,
  "Verified EU supplier at EUR 0.42/unit for 10k MOQ, confirmed against their public catalogue."];

async function agent(db, name, extra = {}) {
  const r = await registerAgent(db, name, { contact_email: `${name}@example.com`, ...extra });
  return { ...r, a: await authByKey(db, r.api_key) };
}
const nowSec = () => Math.floor(Date.now() / 1000);
/** A fake chain: hash -> { transfers, blockTime }. Counts reads. */
function chain(txs) {
  const c = { reads: 0, txs };
  c.readTx = async (h) => {
    c.reads++;
    const t = c.txs[h];
    if (!t) throw Object.assign(new Error("transaction not found"), { status: 404 });
    return { transfers: t.transfers, blockTime: t.blockTime ?? nowSec() + 5 };
  };
  return c;
}
const pay = (from, to, cents) => ({ from, to, units: BigInt(cents) * UNITS_PER_CENT });
const env = (db) => ({ ...ENV, DB: db });
const status = (code, re) => (e) => { assert.equal(e.status, code, e.message); if (re) assert.match(e.message, re); return true; };

/** One poster, one filler with a payout wallet, one pending submission. */
async function setup(db, tag = "", reward = 5000) {
  const poster = await agent(db, `poster${tag}`);
  const filler = tag === "-second" ? null : await agent(db, `filler${tag}`, { payout_address: AGENT_WALLET });
  const b = await postBounty(db, poster.a, ENV, { ...BOUNTY, reward_amount_cents: reward });
  return { poster, filler, b };
}
async function instructionFor(db, poster, b, s, payFrom) {
  const ins = await settlementInstruction(db, ENV, poster.a, b.bounty_id, s.submission_id, payFrom);
  const owed = Object.fromEntries(ins.recipients.map((r) => [r.role, r.amount_cents]));
  return { ins, toAgent: owed.contributor, fee: owed.platform_fee };
}

test("an instruction is refused until the poster names the wallet they will pay from", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  await assert.rejects(settlementInstruction(db, ENV, poster.a, b.bounty_id, s.submission_id), status(400, /pay_from/));
  const { ins } = await instructionFor(db, poster, b, s, W1);
  assert.deepEqual(ins.pay_from.map((w) => w.address), [W1]);
  // Once registered it need not be repeated.
  const again = await settlementInstruction(db, ENV, poster.a, b.bounty_id, s.submission_id);
  assert.deepEqual(again.pay_from.map((w) => w.address), [W1]);
  assert.doesNotMatch(again.note, /present each hash\. Then/);
});

test("a paying wallet belongs to one account, cannot be a burn or fee address, and is capped", async () => {
  const db = makeD1();
  const p1 = await agent(db, "owner-one"), p2 = await agent(db, "owner-two");
  await registerPayerWallet(db, ENV, p1.a, W1);
  await registerPayerWallet(db, ENV, p1.a, W1.toUpperCase().replace("0X", "0x")); // same wallet again is a no-op
  assert.equal((await payerWallets(db, p1.agent_id)).length, 1);
  await assert.rejects(registerPayerWallet(db, ENV, p2.a, W1), status(409, /another account/));
  await assert.rejects(registerPayerWallet(db, ENV, p2.a, FEE), status(400, /fee address/));
  await assert.rejects(registerPayerWallet(db, ENV, p2.a, "0x" + "0".repeat(40)), status(400, /burn/));
  await assert.rejects(registerPayerWallet(db, ENV, p2.a, "0x1234"), status(400));
  for (let i = 0; i < MAX_PAYER_WALLETS; i++) await registerPayerWallet(db, ENV, p2.a, "0x" + String(i + 3).repeat(40));
  await assert.rejects(registerPayerWallet(db, ENV, p2.a, addr("b")), status(409, /already have/));
});

test("one transaction paying everyone settles and releases the work", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { toAgent, fee } = await instructionFor(db, poster, b, s, W1);
  const c = chain({ [tx(1)]: { transfers: [pay(W1, AGENT_WALLET, toAgent), pay(W1, FEE, fee)] } });
  const r = await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c);
  assert.equal(r.settled, true);
  assert.equal(r.tx_hash, tx(1));
  const view = await getBounty(db, b.bounty_id, poster.a);
  assert.equal(view.bounty.status, "awarded");
  assert.equal(view.submissions.find((x) => x.id === s.submission_id).content, SUB[0], "the sealed work is released to the payer");
  // Presenting it again is safe, does not touch the chain, and charges nothing.
  const again = await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1).toUpperCase().replace("0X", "0x"), c);
  assert.equal(again.already_settled, true);
  assert.equal(c.reads, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM settlements WHERE submission_id = ?").get(s.submission_id).n, 2);
});

test("H1: another poster cannot present someone else's payment as their own", async () => {
  const db = makeD1();
  // P1 and P2 each have a pending submission from the same filler; P2's bounty is the same size.
  const { poster: p1, filler, b: b1 } = await setup(db);
  const p2 = await agent(db, "thief");
  const b2 = await postBounty(db, p2.a, ENV, BOUNTY);
  const s1 = await submitToBounty(db, filler.a, b1.bounty_id, ...SUB);
  const s2 = await submitToBounty(db, filler.a, b2.bounty_id, ...SUB);
  const { toAgent, fee } = await instructionFor(db, p1, b1, s1, W1);
  const c = chain({ [tx(1)]: { transfers: [pay(W1, AGENT_WALLET, toAgent), pay(W1, FEE, fee)] } });

  // P2 cannot take P1's wallet, so registers their own and presents P1's hash first.
  await assert.rejects(settlementInstruction(db, ENV, p2.a, b2.bounty_id, s2.submission_id, W1), status(409, /another account/));
  await instructionFor(db, p2, b2, s2, W2);
  await assert.rejects(
    settleBounty(env(db), p2.a, b2.bounty_id, s2.submission_id, tx(1), c),
    status(400, /wallet you registered/),
  );
  assert.equal((await getBounty(db, b2.bounty_id, p2.a)).bounty.status, "open", "nothing was released to the thief");
  assert.equal((await getBounty(db, b2.bounty_id, p2.a)).submissions[0].content, null, "the work stays sealed");
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM settlement_payments").get().n, 0, "and the hash was not burned");

  // The real payer is not locked out.
  const r = await settleBounty(env(db), p1.a, b1.bounty_id, s1.submission_id, tx(1), c);
  assert.equal(r.settled, true);
  // And the used hash cannot settle anything else, whoever presents it.
  await assert.rejects(settleBounty(env(db), p2.a, b2.bounty_id, s2.submission_id, tx(1), c), status(409, /different submission/));
});

test("H1: registering a wallet after watching its payment go by does not claim that payment", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  // Somebody paid the filler and the fee address from W1 an hour ago. Only then is W1 registered.
  const { toAgent, fee } = await instructionFor(db, poster, b, s, W1);
  const c = chain({
    [tx(1)]: { transfers: [pay(W1, AGENT_WALLET, toAgent), pay(W1, FEE, fee)], blockTime: nowSec() - 3600 },
    [tx(2)]: { transfers: [pay(W1, AGENT_WALLET, toAgent), pay(W1, FEE, fee)], blockTime: nowSec() + 30 },
  });
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(400, /registered before paying/));
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c)).settled, true);
});

test("H1: only money that left the poster's wallet is counted inside a mixed transaction", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { toAgent, fee } = await instructionFor(db, poster, b, s, W1);
  // A batch where a stranger pays the agent in full and the poster only pays the fee.
  const c = chain({ [tx(1)]: { transfers: [pay(OTHER, AGENT_WALLET, toAgent), pay(W1, FEE, fee)] } });
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(400, /needs \$\d+\.\d\d more/));
  assert.equal((await getBounty(db, b.bounty_id, poster.a)).bounty.status, "open");
});

test("H2: paying the agent and the fee in two ordinary transactions settles", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { toAgent, fee } = await instructionFor(db, poster, b, s, W1);
  const c = chain({
    [tx(1)]: { transfers: [pay(W1, AGENT_WALLET, toAgent)] },
    [tx(2)]: { transfers: [pay(W1, FEE, fee)] },
  });
  // First hash alone: recorded, not released, and the message says what is left, not "pay again".
  await assert.rejects(
    settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /recorded and will count/);
      assert.match(e.message, new RegExp(`needs \\$${(fee / 100).toFixed(2)} more`));
      assert.match(e.message, /Do not pay the full amounts again/);
      assert.ok(!e.message.includes(AGENT_WALLET), "the agent is covered and is not listed as short");
      return true;
    },
  );
  assert.equal((await getBounty(db, b.bounty_id, poster.a)).bounty.status, "open");
  // Second hash completes it; the first is not read from the chain again.
  const r = await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c);
  assert.equal(r.settled, true);
  assert.deepEqual([...r.tx_hashes].sort(), [tx(1), tx(2)]);
  assert.equal(c.reads, 2);
  assert.equal((await getBounty(db, b.bounty_id, poster.a)).bounty.status, "awarded");
});

test("H2: both hashes can be presented together, in either order, and duplicates are ignored", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { toAgent, fee } = await instructionFor(db, poster, b, s, W1);
  const c = chain({
    [tx(1)]: { transfers: [pay(W1, AGENT_WALLET, toAgent)] },
    [tx(2)]: { transfers: [pay(W1, FEE, fee)] },
  });
  const r = await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, [tx(2), tx(1), tx(2)], c);
  assert.equal(r.settled, true);
  assert.equal(c.reads, 2);
});

test("H2: a bad hash in a group records nothing from that group", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { toAgent } = await instructionFor(db, poster, b, s, W1);
  const c = chain({
    [tx(1)]: { transfers: [pay(W1, AGENT_WALLET, toAgent)] },
    [tx(2)]: { transfers: [pay(OTHER, FEE, 9999)] },
  });
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, [tx(1), tx(2)], c), status(400));
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM settlement_payments").get().n, 0);
});

test("a payment recorded for one submission never counts toward another, even for the same poster", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const b2 = await postBounty(db, poster.a, ENV, BOUNTY);
  const s1 = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const s2 = await submitToBounty(db, filler.a, b2.bounty_id, ...SUB);
  const { toAgent, fee } = await instructionFor(db, poster, b, s1, W1);
  const c = chain({ [tx(1)]: { transfers: [pay(W1, AGENT_WALLET, toAgent), pay(W1, FEE, fee)] } });
  await settleBounty(env(db), poster.a, b.bounty_id, s1.submission_id, tx(1), c);
  await assert.rejects(settleBounty(env(db), poster.a, b2.bounty_id, s2.submission_id, tx(1), c), status(409, /counts once/));
  // Also when it is only a partial, not-yet-settled payment.
  const db2 = makeD1();
  const x = await setup(db2);
  const y2 = await postBounty(db2, x.poster.a, ENV, BOUNTY);
  const t1 = await submitToBounty(db2, x.filler.a, x.b.bounty_id, ...SUB);
  const t2 = await submitToBounty(db2, x.filler.a, y2.bounty_id, ...SUB);
  const owed = await instructionFor(db2, x.poster, x.b, t1, W1);
  const c2 = chain({ [tx(1)]: { transfers: [pay(W1, AGENT_WALLET, owed.toAgent)] } });
  await assert.rejects(settleBounty(env(db2), x.poster.a, x.b.bounty_id, t1.submission_id, tx(1), c2), status(400));
  await assert.rejects(settleBounty(env(db2), x.poster.a, y2.bounty_id, t2.submission_id, tx(1), c2), status(409, /counts once/));
});

test("an extra hash for an already settled submission is refused and not recorded", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { toAgent, fee } = await instructionFor(db, poster, b, s, W1);
  const c = chain({
    [tx(1)]: { transfers: [pay(W1, AGENT_WALLET, toAgent), pay(W1, FEE, fee)] },
    [tx(2)]: { transfers: [pay(W1, AGENT_WALLET, toAgent)] },
  });
  await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c);
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c), status(409, /already settled/));
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM settlement_payments").get().n, 1);
});

test("input checks: hash format, hash count, only the poster, RPC required", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  await instructionFor(db, poster, b, s, W1);
  const c = chain({});
  for (const bad of ["0x123", "", undefined, [], [tx(1), "nope"], Array.from({ length: MAX_TX_HASHES + 1 }, (_, i) => tx(i + 1))])
    await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, bad, c), status(400));
  await assert.rejects(settleBounty(env(db), filler.a, b.bounty_id, s.submission_id, tx(1), c), status(403));
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1)), status(503, /RPC/));
});

test("carry-over: the migration's INSERT copies old settlements into settlement_payments", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const b2 = await postBounty(db, poster.a, ENV, BOUNTY);
  const s2 = await submitToBounty(db, filler.a, b2.bounty_id, ...SUB);
  const { toAgent, fee } = await instructionFor(db, poster, b2, s2, W1);
  const now = new Date().toISOString();
  const ins = db.raw.prepare("INSERT INTO settlements (id, bounty_id, milestone_id, submission_id, tx_hash, recipient, amount_cents, role, verified_at, created_at) VALUES (?, ?, NULL, 'sub_old', ?, ?, ?, ?, ?, ?)");
  ins.run("stl_1", b.bounty_id, tx(7), AGENT_WALLET, 4750, "contributor", now, now);
  ins.run("stl_2", b.bounty_id, tx(7), FEE, 250, "platform_fee", now, now);
  // Run just the carry-over statement from the real migration file.
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../migrations/0026_settlement_binding.sql", import.meta.url), "utf8");
  const carry = sql.slice(sql.indexOf("INSERT OR IGNORE INTO settlement_payments"));
  db.raw.exec(carry);
  const row = db.raw.prepare("SELECT * FROM settlement_payments WHERE tx_hash = ?").get(tx(7));
  assert.equal(row.submission_id, "sub_old");
  assert.deepEqual(
    JSON.parse(row.transfers).sort((a, z) => a.to.localeCompare(z.to)),
    [{ to: AGENT_WALLET, units: "47500000" }, { to: FEE, units: "2500000" }],
  );
  db.raw.exec(carry); // running it twice changes nothing
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM settlement_payments").get().n, 1);
  const c = chain({ [tx(7)]: { transfers: [pay(W1, AGENT_WALLET, toAgent), pay(W1, FEE, fee)] } });
  await assert.rejects(settleBounty(env(db), poster.a, b2.bounty_id, s2.submission_id, tx(7), c), status(409, /counts once/));
  assert.equal(c.reads, 0);
});

test("coversPayouts counts only the named payers when given them", () => {
  const req = [{ address: AGENT_WALLET, amount_cents: 100 }];
  const t = [pay(OTHER, AGENT_WALLET, 100)];
  assert.equal(coversPayouts(t, req).ok, true, "unfiltered, as before");
  assert.equal(coversPayouts(t, req, new Set([W1])).ok, false);
  assert.equal(coversPayouts([pay(W1.toUpperCase().replace("0X", "0x"), AGENT_WALLET, 100)], req, new Set([W1])).ok, true);
  assert.equal(coversPayouts([{ to: AGENT_WALLET, units: 100n * UNITS_PER_CENT }], req, new Set([W1])).ok, false, "no sender, not counted");
});
