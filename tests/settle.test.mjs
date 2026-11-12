// On-chain settlement: a transfer counts only for the one submission it pays,
// only once, and a settlement may be paid in several transactions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeD1 } from "./d1shim.mjs";
import {
  registerAgent, authByKey, postBounty, submitToBounty, settlementInstruction, setPayoutAddress,
  getBounty, expireOverdue, unitsToUsdc, randomTag, withdrawSubmission, reviewSubmission, joinSubmission,
  LEG_TAG_MAX, UNITS_PER_CENT, HALF_AWARD_RETRY_MS,
} from "../.test-build/core.js";
import { settleBounty, MAX_TX_HASHES, LEG_CLOCK_ALLOWANCE_S } from "../.test-build/settle.js";
import { parseTransferLogs, usdcTransfers } from "../.test-build/chain.js";

// Addresses and hashes carry hex letters so that case handling is really tested.
const addr = (c) => "0x" + c.repeat(20);
const FEE = addr("fe");
const ENV = { HUMAN_BOUNTIES: "off", PLATFORM_FEE_ADDRESS: FEE };
const AGENT_WALLET = addr("a1"), AGENT2_WALLET = addr("b2"), NEW_WALLET = addr("c3");
const PAYER = addr("d4"), STRANGER = addr("e5"), DISPERSE = addr("f6");
const tx = (n) => "0x" + n.toString(16).padStart(60, "0") + "abcd";
const upper = (h) => "0x" + h.slice(2).toUpperCase();
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
/** A fake chain: hash -> { transfers: [[from, to, units]], blockTime }. Counts reads. */
function chain(txs) {
  const c = { reads: 0, txs };
  c.readTx = async (h) => {
    c.reads++;
    const t = c.txs[h];
    if (!t) throw Object.assign(new Error("transaction not found"), { status: 404 });
    return {
      transfers: t.transfers.map(([from, to, units], i) => ({ from, to, units: BigInt(units), logIndex: t.firstLog != null ? t.firstLog + i : i })),
      blockTime: t.blockTime ?? nowSec() + 5,
    };
  };
  return c;
}
const env = (db) => ({ ...ENV, DB: db });
const status = (code, re) => (e) => { assert.equal(e.status, code, e.message); if (re) assert.match(e.message, re); return true; };
const count = (db, table, where = "1=1", ...args) => db.raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...args).n;
const bountyStatus = async (db, b, who) => (await getBounty(db, b.bounty_id, who.a)).bounty.status;
const content = async (db, b, who, s) => (await getBounty(db, b.bounty_id, who.a)).submissions.find((x) => x.id === s.submission_id).content;

/** One poster, one filler with a payout wallet, one on-chain bounty. */
async function setup(db, reward = 5000) {
  const poster = await agent(db, "poster");
  const filler = await agent(db, "filler", { payout_address: AGENT_WALLET });
  const b = await postBounty(db, poster.a, ENV, { ...BOUNTY, reward_amount_cents: reward });
  return { poster, filler, b };
}
/** The instruction, plus the two exact amounts as BigInt units. */
async function owed(db, poster, b, s) {
  const ins = await settlementInstruction(db, ENV, poster.a, b.bounty_id, s.submission_id);
  const by = Object.fromEntries(ins.recipients.map((r) => [r.role, r]));
  return { ins, agentUnits: BigInt(by.contributor.amount_units), feeUnits: BigInt(by.platform_fee.amount_units), by };
}

// ── The instruction ─────────────────────────────────────────────────────

test("each recipient gets an exact amount: what is owed plus a tag under one cent, stable across calls", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { ins, by } = await owed(db, poster, b, s);
  assert.equal(by.contributor.amount_cents, 4750);
  assert.equal(by.platform_fee.amount_cents, 250);
  for (const r of ins.recipients) {
    const tag = BigInt(r.amount_units) - BigInt(r.amount_cents) * UNITS_PER_CENT;
    assert.ok(tag >= 1n && tag <= BigInt(LEG_TAG_MAX), `tag ${tag} is between 1 unit and just under a cent`);
    assert.equal(r.amount_usdc, unitsToUsdc(BigInt(r.amount_units)));
    assert.match(r.amount_usdc, /^\d+\.\d{6}$/);
    assert.equal(r.paid, false);
  }
  assert.equal(ins.total_cents, 5000);
  assert.match(ins.note, /EXACTLY/);
  assert.doesNotMatch(ins.note, /separate transactions work if you settle each/);
  const again = await settlementInstruction(db, ENV, poster.a, b.bounty_id, s.submission_id);
  assert.deepEqual(again.recipients.map((r) => r.amount_units), ins.recipients.map((r) => r.amount_units), "asking twice does not change the amounts");
  assert.equal(count(db, "settlement_legs"), 2);
  assert.equal(ins.total_usdc, unitsToUsdc(ins.recipients.reduce((a, r) => a + BigInt(r.amount_units), 0n)));
});

test("unitsToUsdc prints six decimals for any size", () => {
  assert.equal(unitsToUsdc(47503917n), "47.503917");
  assert.equal(unitsToUsdc(1n), "0.000001");
  assert.equal(unitsToUsdc(1000000n), "1.000000");
  assert.equal(unitsToUsdc(123456789012n), "123456.789012");
});

test("no two open legs anywhere share a recipient and amount, even for identical bounties", async () => {
  const db = makeD1();
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const p = await agent(db, `poster-${i}`);
    const filler = await agent(db, `filler-${i}`, { payout_address: AGENT_WALLET }); // all paid at one address
    const b = await postBounty(db, p.a, ENV, BOUNTY);
    const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
    const ins = await settlementInstruction(db, ENV, p.a, b.bounty_id, s.submission_id);
    for (const r of ins.recipients) {
      const k = `${r.address}|${r.amount_units}`;
      assert.ok(!seen.has(k), `duplicate amount ${k}`);
      seen.add(k);
    }
  }
  // And the database refuses a duplicate outright, whatever the code above it does.
  const leg = db.raw.prepare("SELECT * FROM settlement_legs LIMIT 1").get();
  assert.throws(() =>
    db.raw.prepare("INSERT INTO settlement_legs (id, bounty_id, submission_id, role, agent_id, address, amount_cents, units, open, created_at) VALUES ('leg_x', ?, 'sub_other', 'contributor', 'agt_x', ?, ?, ?, 1, ?)")
      .run(leg.bounty_id, leg.address, leg.amount_cents, leg.units, leg.created_at));
});

// ── Paying ──────────────────────────────────────────────────────────────

test("one transaction paying both exact amounts settles and releases the work", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  assert.equal(await content(db, b, poster, s), null, "sealed before payment");
  const c = chain({ [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]] } });
  const r = await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c);
  assert.equal(r.settled, true);
  assert.equal(r.tx_hash, tx(1));
  assert.equal(await bountyStatus(db, b, poster), "awarded");
  assert.equal(await content(db, b, poster, s), SUB[0], "released to the payer");
  assert.equal(count(db, "settlements", "submission_id = ?", s.submission_id), 2);
  assert.equal(count(db, "settlement_legs", "open = 1"), 0, "the amounts are free to be reused");
  // Presenting it again, in any letter case, is safe, reads nothing and charges nothing.
  const again = await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, upper(tx(1)), c);
  assert.equal(again.already_settled, true);
  assert.equal(c.reads, 1);
  assert.equal(count(db, "settlements", "submission_id = ?", s.submission_id), 2);
});

test("who sent it does not matter: a batch contract that pulls then pays is recognised", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const c = chain({ [tx(1)]: { transfers: [
    [PAYER, DISPERSE, agentUnits + feeUnits], [DISPERSE, upper(AGENT_WALLET), agentUnits], [DISPERSE, FEE, feeUnits],
  ] } });
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c)).settled, true);
});

test("amounts must be exact: rounded, short, over, or split in two is not recognised and records nothing", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const base = 4750n * UNITS_PER_CENT;
  const tries = {
    rounded: [[PAYER, AGENT_WALLET, base], [PAYER, FEE, 250n * UNITS_PER_CENT]],
    short: [[PAYER, AGENT_WALLET, agentUnits - 1n], [PAYER, FEE, feeUnits - 1n]],
    over: [[PAYER, AGENT_WALLET, agentUnits + 1n], [PAYER, FEE, feeUnits * 2n]],
    split: [[PAYER, AGENT_WALLET, agentUnits - 5n], [PAYER, AGENT_WALLET, 5n], [PAYER, FEE, 0n]],
    swapped: [[PAYER, AGENT_WALLET, feeUnits], [PAYER, FEE, agentUnits]],
  };
  let n = 10;
  for (const [name, transfers] of Object.entries(tries)) {
    const c = chain({ [tx(++n)]: { transfers } });
    await assert.rejects(
      settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(n), c),
      (e) => {
        assert.equal(e.status, 400, name);
        assert.match(e.message, /no transfer in what you presented matches/, name);
        assert.ok(e.message.includes(unitsToUsdc(agentUnits)) && e.message.includes(unitsToUsdc(feeUnits)), "the exact amounts are spelled out");
        assert.match(e.message, /contact the operator/);
        return true;
      },
    );
  }
  assert.equal(count(db, "settlement_payments"), 0);
  assert.equal(await bountyStatus(db, b, poster), "open");
  // A hash that matched nothing is not used up: the right payment in the same hash list still works.
  const c = chain({
    [tx(11)]: { transfers: tries.rounded },
    [tx(30)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]] },
  });
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, [tx(11), tx(30)], c)).settled, true);
});

// ── H1: somebody else's payment ─────────────────────────────────────────

test("H1: another poster cannot present someone else's payment, and the real payer is not locked out", async () => {
  const db = makeD1();
  const { poster: p1, filler, b: b1 } = await setup(db);
  const p2 = await agent(db, "thief");
  const b2 = await postBounty(db, p2.a, ENV, { ...BOUNTY, reward_amount_cents: 4000 }); // smaller, so "at least" would pass
  const b3 = await postBounty(db, p2.a, ENV, BOUNTY);                                    // identical
  const s1 = await submitToBounty(db, filler.a, b1.bounty_id, ...SUB);
  const s2 = await submitToBounty(db, filler.a, b2.bounty_id, ...SUB);
  const s3 = await submitToBounty(db, filler.a, b3.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, p1, b1, s1);
  await owed(db, p2, b2, s2);
  await owed(db, p2, b3, s3);
  const c = chain({ [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]] } });

  for (const [b, s] of [[b2, s2], [b3, s3]]) {
    await assert.rejects(settleBounty(env(db), p2.a, b.bounty_id, s.submission_id, tx(1), c), status(400, /no transfer in what you presented matches/));
    assert.equal(await bountyStatus(db, b, p2), "open");
    assert.equal(await content(db, b, p2, s), null, "the work stays sealed");
  }
  assert.equal(count(db, "settlement_payments"), 0, "the thief's attempts did not use the hash up");

  const r = await settleBounty(env(db), p1.a, b1.bounty_id, s1.submission_id, tx(1), c);
  assert.equal(r.settled, true);
  // Still nothing for the thief afterwards, and nobody but the poster may settle a bounty.
  await assert.rejects(settleBounty(env(db), p2.a, b3.bounty_id, s3.submission_id, tx(1), c), status(400));
  await assert.rejects(settleBounty(env(db), p2.a, b1.bounty_id, s1.submission_id, tx(1), c), status(403));
});

test("H1: a third party's transfers to the agent (exchange, other client) never count toward a settlement", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  // The agent receives plenty from elsewhere; the poster pays only the fee.
  const c = chain({
    [tx(1)]: { transfers: [[STRANGER, AGENT_WALLET, 4750n * UNITS_PER_CENT], [STRANGER, AGENT_WALLET, 90_000_000n]] },
    [tx(2)]: { transfers: [[PAYER, FEE, feeUnits]] },
  });
  await assert.rejects(
    settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, [tx(1), tx(2)], c),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /^recorded: /, "the fee they did pay is recorded");
      assert.ok(e.message.includes(`Still to pay, each as ONE transfer of EXACTLY this amount: ${unitsToUsdc(agentUnits)} USDC to ${AGENT_WALLET}`));
      return true;
    },
  );
  assert.equal(await content(db, b, poster, s), null);
});

test("H1: a transfer made before the instruction existed does not count, however exact", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const transfers = [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]];
  const issued = Math.floor(Date.parse(db.raw.prepare("SELECT created_at FROM settlement_legs LIMIT 1").get().created_at) / 1000);
  const c = chain({
    [tx(1)]: { transfers, blockTime: issued - LEG_CLOCK_ALLOWANCE_S - 1 },
    [tx(2)]: { transfers, blockTime: issued - LEG_CLOCK_ALLOWANCE_S },
  });
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(400, /no transfer/));
  assert.equal(count(db, "settlement_payments"), 0);
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c)).settled, true, "the edge of the allowance counts");
});

test("H1: one transfer pays one leg once, including two posters' payments inside one transaction", async () => {
  const db = makeD1();
  const { poster: p1, filler, b: b1 } = await setup(db);
  const p2 = await agent(db, "second-poster");
  const b2 = await postBounty(db, p2.a, ENV, BOUNTY);
  const s1 = await submitToBounty(db, filler.a, b1.bounty_id, ...SUB);
  const s2 = await submitToBounty(db, filler.a, b2.bounty_id, ...SUB);
  const o1 = await owed(db, p1, b1, s1), o2 = await owed(db, p2, b2, s2);
  // A bundle carrying both posters' payments, plus a zero-value transfer.
  const c = chain({ [tx(1)]: { firstLog: 7, transfers: [
    [PAYER, AGENT_WALLET, o1.agentUnits], [PAYER, FEE, o1.feeUnits], [STRANGER, STRANGER, 0n],
    [STRANGER, AGENT_WALLET, o2.agentUnits], [STRANGER, FEE, o2.feeUnits],
  ] } });
  // Whoever goes first, both settle from the same hash and neither takes the other's transfers.
  assert.equal((await settleBounty(env(db), p2.a, b2.bounty_id, s2.submission_id, tx(1), c)).settled, true);
  assert.equal((await settleBounty(env(db), p1.a, b1.bounty_id, s1.submission_id, upper(tx(1)), c)).settled, true);
  const rows = db.raw.prepare("SELECT log_index, submission_id FROM settlement_payments ORDER BY log_index").all();
  assert.deepEqual(rows.map((r) => [r.log_index, r.submission_id]), [
    [7, s1.submission_id], [8, s1.submission_id], [10, s2.submission_id], [11, s2.submission_id],
  ]);
  // The database itself refuses to count a transfer twice.
  assert.throws(() => db.raw.prepare("INSERT INTO settlement_payments (tx_hash, log_index, leg_id, bounty_id, submission_id, verified_at) VALUES (?, 7, 'leg_y', ?, 'sub_y', 'now')").run(tx(1), b1.bounty_id));
});

test("H1: an amount freed by a finished settlement cannot be paid for with the old transfer", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const c = chain({ [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]] } });
  await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c);
  // A new submission is, by bad luck or design, issued the very same amounts.
  const b2 = await postBounty(db, poster.a, ENV, BOUNTY);
  const s2 = await submitToBounty(db, filler.a, b2.bounty_id, ...SUB);
  await owed(db, poster, b2, s2);
  db.raw.prepare("UPDATE settlement_legs SET units = ? WHERE submission_id = ? AND role = 'contributor'").run(agentUnits.toString(), s2.submission_id);
  db.raw.prepare("UPDATE settlement_legs SET units = ? WHERE submission_id = ? AND role = 'platform_fee'").run(feeUnits.toString(), s2.submission_id);
  await assert.rejects(settleBounty(env(db), poster.a, b2.bounty_id, s2.submission_id, tx(1), c), status(400, /no transfer/));
  assert.equal(await content(db, b2, poster, s2), null);
});

// ── H2: several transactions ────────────────────────────────────────────

test("H2: paying the agent and the fee in two ordinary transactions settles", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const c = chain({
    [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits]] },
    [tx(2)]: { transfers: [[PAYER, FEE, feeUnits]] },
  });
  // First hash alone: recorded, nothing released, and the message says exactly what is left.
  await assert.rejects(
    settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c),
    (e) => {
      assert.equal(e.status, 400);
      assert.ok(e.message.startsWith(`recorded: ${unitsToUsdc(agentUnits)} USDC to ${AGENT_WALLET}. `), e.message);
      assert.ok(e.message.includes(`Still to pay, each as ONE transfer of EXACTLY this amount: ${unitsToUsdc(feeUnits)} USDC to ${FEE}. `), e.message);
      assert.ok(e.message.includes(`Already paid and not to be sent again: ${unitsToUsdc(agentUnits)} USDC to ${AGENT_WALLET}. `), e.message);
      return true;
    },
  );
  assert.equal(await bountyStatus(db, b, poster), "open");
  assert.equal(await content(db, b, poster, s), null);
  const mid = await settlementInstruction(db, ENV, poster.a, b.bounty_id, s.submission_id);
  assert.deepEqual(mid.recipients.map((r) => [r.role, r.paid]), [["contributor", true], ["platform_fee", false]]);
  // Presenting the first hash again changes nothing and still says what is left.
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(400, /Still to pay/));
  assert.equal(count(db, "settlement_payments"), 1);
  // The second hash completes it.
  const r = await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c);
  assert.equal(r.settled, true);
  assert.deepEqual([...r.tx_hashes].sort(), [tx(1), tx(2)].sort());
  assert.equal(await content(db, b, poster, s), SUB[0]);
  const rows = db.raw.prepare("SELECT role, tx_hash, amount_cents FROM settlements WHERE submission_id = ? ORDER BY role").all(s.submission_id);
  assert.deepEqual(rows.map((x) => [x.role, x.tx_hash, x.amount_cents]), [["contributor", tx(1), 4750], ["platform_fee", tx(2), 250]]);
  // Either hash, or both, now reports already settled.
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, [tx(2), tx(1)], c)).already_settled, true);
});

test("H2: both hashes together, in either order, with duplicates", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const c = chain({
    [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits]] },
    [tx(2)]: { transfers: [[STRANGER, FEE, feeUnits]] }, // paid from a different wallet: fine
  });
  const r = await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, [tx(2), upper(tx(1)), tx(2)], c);
  assert.equal(r.settled, true);
  assert.equal(c.reads, 2);
});

test("H2: a team of two plus the fee, paid in three transactions", async () => {
  const db = makeD1();
  const poster = await agent(db, "team-poster");
  const lead = await agent(db, "lead", { payout_address: AGENT_WALLET });
  const mate = await agent(db, "mate", { payout_address: AGENT2_WALLET });
  const b = await postBounty(db, poster.a, ENV, BOUNTY);
  const s = await submitToBounty(db, lead.a, b.bounty_id, SUB[0], [{ agent_id: lead.agent_id, share_bp: 6000 }, { agent_id: mate.agent_id, share_bp: 4000 }], SUB[2]);
  await joinSubmission(db, mate.a, s.submission_id);
  const ins = await settlementInstruction(db, ENV, poster.a, b.bounty_id, s.submission_id);
  assert.equal(ins.recipients.length, 3);
  const c = chain(Object.fromEntries(ins.recipients.map((r, i) => [tx(i + 1), { transfers: [[PAYER, r.address, r.amount_units]] }])));
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(400, /Still to pay/));
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(3), c), status(400, /Still to pay/));
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c)).settled, true);
  assert.equal(count(db, "settlements", "submission_id = ?", s.submission_id), 3);
});

// ── Things that change between paying and settling ──────────────────────

test("a payout address change after part is paid does not strand the money already sent", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  await setPayoutAddress(db, filler.a, NEW_WALLET); // queued: takes effect after the hold
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const c = chain({
    [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits]] },
    [tx(2)]: { transfers: [[PAYER, FEE, feeUnits]] },
  });
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(400, /^recorded/));
  db.raw.prepare("UPDATE agents SET payout_pending_effective_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), filler.agent_id);
  // The change is now in effect, but this settlement keeps the address the poster was told to pay.
  const mid = await settlementInstruction(db, ENV, poster.a, b.bounty_id, s.submission_id);
  assert.equal(mid.recipients.find((r) => r.role === "contributor").address, AGENT_WALLET);
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c)).settled, true);
});

test("a payout address change that comes due after the poster paid, but before they present the hash, still settles", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  await setPayoutAddress(db, filler.a, NEW_WALLET);
  const first = await owed(db, poster, b, s); // told to pay the current (old) address
  const c = chain({ [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, first.agentUnits], [PAYER, FEE, first.feeUnits]] } });
  // The poster pays exactly that. While it confirms, the hold lapses, and they even look at the instruction again.
  db.raw.prepare("UPDATE agents SET payout_pending_effective_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), filler.agent_id);
  const second = await owed(db, poster, b, s);
  assert.equal(second.by.contributor.address, NEW_WALLET, "someone who has not paid yet is now sent to the new address");
  assert.notEqual(second.agentUnits, first.agentUnits);
  assert.equal(second.feeUnits, first.feeUnits, "the fee leg did not change, so it was not reissued");
  // The payment already made is honoured.
  const r = await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c);
  assert.equal(r.settled, true);
  assert.equal(await content(db, b, poster, s), SUB[0]);
  assert.equal(count(db, "settlement_legs", "open = 1"), 0);
});

test("after an address change either the old or the new amount pays the agent, but only once", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  await setPayoutAddress(db, filler.a, NEW_WALLET);
  const first = await owed(db, poster, b, s);
  db.raw.prepare("UPDATE agents SET payout_pending_effective_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), filler.agent_id);
  const second = await owed(db, poster, b, s);
  const c = chain({
    [tx(1)]: { transfers: [[PAYER, NEW_WALLET, second.agentUnits]] },
    [tx(2)]: { transfers: [[PAYER, AGENT_WALLET, first.agentUnits]] },
    [tx(3)]: { transfers: [[PAYER, FEE, second.feeUnits]] },
  });
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(400, /^recorded/));
  assert.equal(count(db, "settlement_legs", "open = 1 AND role = 'contributor' AND paid_tx IS NULL"), 0, "the agent's other amount is closed once one is paid");
  // The old amount no longer counts for anything.
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c), status(400, /no transfer in what you presented matches/));
  assert.equal(count(db, "settlement_payments"), 1);
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(3), c)).settled, true);
  const rows = db.raw.prepare("SELECT recipient FROM settlements WHERE submission_id = ? AND role = 'contributor'").all(s.submission_id);
  assert.deepEqual(rows.map((r) => r.recipient), [NEW_WALLET]);
  // The database itself refuses a second paid leg for one recipient.
  assert.throws(() => db.raw.prepare("UPDATE settlement_legs SET paid_tx = 'x', paid_log = 1 WHERE submission_id = ? AND role = 'contributor' AND paid_tx IS NULL").run(s.submission_id));
});

test("two instruction requests at the same moment both hand out amounts that work", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const [one, two] = await Promise.all([owed(db, poster, b, s), owed(db, poster, b, s)]);
  // Whether or not they were given the same amounts, a mix of the two sets settles.
  const c = chain({ [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, two.agentUnits], [PAYER, FEE, one.feeUnits]] } });
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c)).settled, true);
});

test("once the poster has started paying, the agent cannot withdraw the submission", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  db.raw.prepare("UPDATE submissions SET pending_at = ?, created_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 86400_000).toISOString(), new Date(Date.now() - 40 * 86400_000).toISOString(), s.submission_id);
  const c = chain({ [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits]] }, [tx(2)]: { transfers: [[PAYER, FEE, feeUnits]] } });
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(400, /^recorded/));
  await assert.rejects(withdrawSubmission(db, filler.a, s.submission_id), status(409, /started paying/));
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c)).settled, true);
  // Without a payment, a stale submission can still be withdrawn as before.
  const b2 = await postBounty(db, poster.a, ENV, BOUNTY);
  const s2 = await submitToBounty(db, filler.a, b2.bounty_id, ...SUB);
  await owed(db, poster, b2, s2);
  db.raw.prepare("UPDATE submissions SET pending_at = ?, created_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 86400_000).toISOString(), new Date(Date.now() - 40 * 86400_000).toISOString(), s2.submission_id);
  assert.equal((await withdrawSubmission(db, filler.a, s2.submission_id)).status, "withdrawn");
  await assert.rejects(settlementInstruction(db, ENV, poster.a, b2.bounty_id, s2.submission_id), status(409));
  const b3 = await postBounty(db, poster.a, ENV, BOUNTY);
  const s3 = await submitToBounty(db, filler.a, b3.bounty_id, ...SUB);
  await owed(db, poster, b3, s3);
  assert.equal(count(db, "settlement_legs", "open = 1 AND submission_id = ?", s2.submission_id), 0, "a dead submission's amounts are released");
});

test("a request that dies after paying but before the award is finished by presenting the hash again", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const c = chain({ [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]] } });
  // The award fails once with a database error, after the payments were recorded.
  const real = db.prepare;
  let armed = true;
  db.prepare = (sql) => {
    if (armed && /^UPDATE bounties SET status = 'awarded'/.test(sql.trim())) { armed = false; throw new Error("D1_ERROR: transient"); }
    return real(sql);
  };
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), (e) => {
    assert.equal(e.status, 503);
    assert.match(e.message, /verified and recorded/);
    assert.match(e.message, /Do not pay again\. Present the same hash again/);
    return true;
  });
  db.prepare = real;
  assert.equal(count(db, "settlements", "submission_id = ?", s.submission_id), 0, "nothing says settled");
  assert.equal(await content(db, b, poster, s), null);
  const r = await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c);
  assert.equal(r.settled, true);
  assert.equal(c.reads, 1, "the chain is not read again: the payment was already recorded");
  assert.equal(await content(db, b, poster, s), SUB[0]);
});

test("an award that stopped half way (pot awarded, submission still pending) is finished on retry, but not while it may still be running", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const c = chain({ [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]] } });
  // Fail the second step of the award: the bounty is already marked awarded.
  const real = db.batch;
  let armed = true;
  db.batch = async (stmts) => {
    if (armed && stmts.some((st) => /UPDATE submissions SET status = 'accepted'/.test(st.sql))) { armed = false; throw new Error("D1_ERROR: transient"); }
    return real(stmts);
  };
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(409, /award is in progress\. Do not pay again/));
  db.batch = real;
  assert.equal(db.raw.prepare("SELECT status FROM bounties WHERE id = ?").get(b.bounty_id).status, "awarded");
  assert.equal(db.raw.prepare("SELECT status FROM submissions WHERE id = ?").get(s.submission_id).status, "pending");
  // Straight away: it could be another request still working, so it is not taken over.
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(409, /in progress/));
  // A minute later it is clearly dead, and the same submission finishes it.
  assert.equal(HALF_AWARD_RETRY_MS, 60_000);
  db.raw.prepare("UPDATE bounties SET awarded_at = ? WHERE id = ?").run(new Date(Date.now() - HALF_AWARD_RETRY_MS - 1000).toISOString(), b.bounty_id);
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c)).settled, true);
  assert.equal(await content(db, b, poster, s), SUB[0]);
  assert.equal(count(db, "settlements", "submission_id = ?", s.submission_id), 2);
});

test("an award made by a request that died before writing its records gets them on the next call", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const c = chain({ [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]] } });
  await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c);
  db.raw.prepare("DELETE FROM settlements WHERE submission_id = ?").run(s.submission_id);
  db.raw.prepare("UPDATE bounties SET settled_tx = NULL WHERE id = ?").run(b.bounty_id);
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c)).already_settled, true);
  assert.equal(count(db, "settlements", "submission_id = ?", s.submission_id), 2);
  assert.equal(db.raw.prepare("SELECT settled_tx FROM bounties WHERE id = ?").get(b.bounty_id).settled_tx, tx(1));
  // Leftover rows for a submission that was never awarded do not make it "already settled".
  const b2 = await postBounty(db, poster.a, ENV, BOUNTY);
  const s2 = await submitToBounty(db, filler.a, b2.bounty_id, ...SUB);
  const o2 = await owed(db, poster, b2, s2);
  const now = new Date().toISOString();
  db.raw.prepare("INSERT INTO settlements (id, bounty_id, milestone_id, submission_id, tx_hash, recipient, amount_cents, role, verified_at, created_at) VALUES ('stl_left', ?, NULL, ?, ?, ?, 4750, 'contributor', ?, ?)").run(b2.bounty_id, s2.submission_id, tx(9), AGENT_WALLET, now, now);
  const c2 = chain({ [tx(2)]: { transfers: [[PAYER, FEE, 1n]] }, [tx(3)]: { transfers: [[PAYER, AGENT_WALLET, o2.agentUnits], [PAYER, FEE, o2.feeUnits]] } });
  await assert.rejects(settleBounty(env(db), poster.a, b2.bounty_id, s2.submission_id, tx(2), c2), status(400, /no transfer/));
  assert.equal(await content(db, b2, poster, s2), null);
  assert.equal((await settleBounty(env(db), poster.a, b2.bounty_id, s2.submission_id, tx(3), c2)).settled, true);
});

test("a milestone is settled on its own and its id is kept all the way through", async () => {
  const db = makeD1();
  const poster = await agent(db, "ms-poster");
  const filler = await agent(db, "ms-filler", { payout_address: AGENT_WALLET });
  const b = await postBounty(db, poster.a, ENV, {
    ...BOUNTY, reward_amount_cents: undefined,
    milestones: [{ title: "Part one", reward_amount_cents: 2000 }, { title: "Part two", reward_amount_cents: 3000 }],
  });
  const ms = db.raw.prepare("SELECT id, title FROM milestones WHERE bounty_id = ? ORDER BY rowid").all(b.bounty_id);
  const s = await submitToBounty(db, filler.a, b.bounty_id, SUB[0], undefined, SUB[2], ms[0].id);
  const ins = await settlementInstruction(db, ENV, poster.a, b.bounty_id, s.submission_id);
  assert.equal(ins.milestone_id, ms[0].id);
  assert.equal(ins.total_cents, 2000);
  assert.equal(ins.total_usdc, unitsToUsdc(ins.recipients.reduce((a, r) => a + BigInt(r.amount_units), 0n)), "the total is the sum of the exact amounts");
  const c = chain({ [tx(1)]: { transfers: ins.recipients.map((r) => [PAYER, r.address, r.amount_units]) } });
  const r = await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c);
  assert.equal(r.settled, true);
  assert.equal(r.milestone_id, ms[0].id);
  assert.deepEqual(db.raw.prepare("SELECT DISTINCT milestone_id FROM settlement_legs WHERE submission_id = ?").all(s.submission_id).map((x) => x.milestone_id), [ms[0].id]);
  assert.deepEqual(db.raw.prepare("SELECT DISTINCT milestone_id FROM settlements WHERE submission_id = ?").all(s.submission_id).map((x) => x.milestone_id), [ms[0].id]);
  assert.deepEqual(db.raw.prepare("SELECT status FROM milestones WHERE bounty_id = ? ORDER BY rowid").all(b.bounty_id).map((x) => x.status), ["awarded", "open"]);
  assert.equal(db.raw.prepare("SELECT settled_tx FROM bounties WHERE id = ?").get(b.bounty_id).settled_tx, tx(1));
});

test("an on-chain bounty cannot be awarded without a verified payment", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  await assert.rejects(reviewSubmission(db, poster.a, b.bounty_id, s.submission_id, "accept"), status(409));
  await assert.rejects(reviewSubmission(db, poster.a, b.bounty_id, s.submission_id, "accept", undefined, tx(1)), status(409));
  assert.equal(await content(db, b, poster, s), null);
});

test("the limits are what the documentation says", () => {
  assert.equal(LEG_TAG_MAX, 9999, "a tag is always under one cent");
  assert.equal(LEG_CLOCK_ALLOWANCE_S, 600);
  assert.equal(MAX_TX_HASHES, 10);
  assert.equal(UNITS_PER_CENT, 10000n);
});

test("tags run from 1 to 9999 and never 0, whatever the random source returns", () => {
  const real = crypto.getRandomValues.bind(crypto);
  const feed = (values) => { let i = 0; crypto.getRandomValues = (buf) => { buf[0] = values[i++ % values.length]; return buf; }; };
  try {
    feed([0]); assert.equal(randomTag(), 1);
    feed([9998]); assert.equal(randomTag(), 9999);
    feed([9999]); assert.equal(randomTag(), 1);
    // Values at the very top of the range would make some tags likelier than others; they are redrawn.
    feed([0xffffffff, 4]); assert.equal(randomTag(), 5);
  } finally { crypto.getRandomValues = real; }
  const seen = new Set();
  for (let i = 0; i < 4000; i++) { const t = randomTag(); assert.ok(t >= 1 && t <= 9999); seen.add(t); }
  assert.ok(seen.size > 3000, "tags are spread out, not drawn from a handful of values");
});

// ── Reading the chain ───────────────────────────────────────────────────

/** A stand-in for the Base RPC endpoint. */
function rpcStub({ receipt, head = "0x64", block = { timestamp: "0x65000000" } }) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push(method);
    const result = method === "eth_getTransactionReceipt" ? receipt
      : method === "eth_blockNumber" ? head
      : method === "eth_getBlockByNumber" ? (params[0] === receipt?.blockNumber ? block : null)
      : undefined;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => "0x" + "0".repeat(24) + a.slice(2);
const usdcLog = (to, units, logIndex) => ({ address: USDC, topics: [TOPIC, pad(PAYER), pad(to)], data: "0x" + BigInt(units).toString(16), logIndex });

test("reading a transaction: transfers, log positions and the block's own time", async () => {
  const receipt = { status: "0x1", blockNumber: "0x50", logs: [usdcLog(AGENT_WALLET, 47503917, "0x2b"), usdcLog(FEE, 2500142, "0x2c")] };
  const stub = rpcStub({ receipt, head: "0x55", block: { timestamp: "0x65000000" } }); // 6 confirmations
  try {
    const r = await usdcTransfers("https://rpc.example", tx(1));
    assert.equal(r.blockTime, 0x65000000, "the time comes from the block, not from this machine's clock");
    assert.deepEqual(r.transfers.map((t) => [t.to, t.units, t.logIndex]), [[AGENT_WALLET, 47503917n, 43], [FEE, 2500142n, 44]]);
    assert.deepEqual(stub.calls, ["eth_getTransactionReceipt", "eth_blockNumber", "eth_getBlockByNumber"]);
  } finally { stub.restore(); }
});

test("reading a transaction refuses reverted, missing, shallow and untimed ones", async () => {
  const logs = [usdcLog(AGENT_WALLET, 1, "0x0")];
  const cases = [
    [{ receipt: null }, 404],
    [{ receipt: { status: "0x0", blockNumber: "0x50", logs } }, 400],
    [{ receipt: { status: "0x1", blockNumber: "0x50", logs }, head: "0x54" }, 409],       // 5 confirmations
    [{ receipt: { status: "0x1", blockNumber: "0x50", logs }, head: "0x55", block: null }, 502],
    [{ receipt: { status: "0x1", blockNumber: "0x50", logs }, head: "0x55", block: { timestamp: "0x0" } }, 502],
  ];
  for (const [setup, code] of cases) {
    const stub = rpcStub(setup);
    try { await assert.rejects(usdcTransfers("https://rpc.example", tx(1)), (e) => e.status === code, `expected ${code}`); }
    finally { stub.restore(); }
  }
});

test("if the bounty expires while the payment is being read, nothing claims to be settled", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const c = chain({ [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]] } });
  const inner = c.readTx;
  c.readTx = async (h) => {
    // The deadline passes and the hourly sweep runs during the chain read.
    db.raw.prepare("UPDATE bounties SET deadline = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), b.bounty_id);
    await expireOverdue(db);
    return inner(h);
  };
  await assert.rejects(
    settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c),
    (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /payment is verified and recorded, but the award could not be made/);
      assert.match(e.message, /Do not pay again\. Contact the operator/);
      return true;
    },
  );
  assert.equal(count(db, "settlements", "submission_id = ?", s.submission_id), 0, "no settlement rows are left behind");
  assert.equal(count(db, "settlement_payments", "submission_id = ?", s.submission_id), 2, "the payment itself stays on record");
  // A retry does not say "already settled".
  c.readTx = inner;
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(409, /submission is closed, not pending/));
  assert.equal(count(db, "settlement_legs", "submission_id = ? AND paid_tx IS NOT NULL", s.submission_id), 2, "the paid legs stay on record for the operator");
});

test("two requests settling one submission at the same moment leave one settlement", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const transfers = [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]];
  // The poster paid twice by mistake and presents each hash in parallel.
  const c = chain({ [tx(1)]: { transfers }, [tx(2)]: { transfers } });
  const results = await Promise.allSettled([
    settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c),
    settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  assert.equal(count(db, "settlements", "submission_id = ?", s.submission_id), 2, "one row per recipient, not two");
  assert.equal(count(db, "settlement_payments", "submission_id = ?", s.submission_id), 2, "only one payment was counted");
  assert.equal(await bountyStatus(db, b, poster), "awarded");
});

// ── Edges ───────────────────────────────────────────────────────────────

test("an extra hash for an already settled submission is refused and not recorded", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b, s);
  const transfers = [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]];
  const c = chain({ [tx(1)]: { transfers }, [tx(2)]: { transfers } });
  await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c);
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c), status(409, /already settled/));
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, [tx(1), tx(2)], c), status(409, /already settled/));
  assert.equal(count(db, "settlement_payments"), 2);
  assert.equal(c.reads, 1);
});

test("input checks: hash format, hash count, only the poster, RPC required", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  const c = chain({});
  for (const bad of ["0x123", "", undefined, null, 5, [], [tx(1), "nope"], Array.from({ length: MAX_TX_HASHES + 1 }, (_, i) => tx(i + 1))])
    await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, bad, c), status(400));
  await assert.rejects(settleBounty(env(db), filler.a, b.bounty_id, s.submission_id, tx(1), c), status(403));
  await assert.rejects(settleBounty(env(db), poster.a, "bty_missing", s.submission_id, tx(1), c), status(404));
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, "sub_missing", tx(1), c), status(404));
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1)), status(503, /RPC/));
  assert.equal(c.reads, 0);
});

test("transactions used before this change are carried over and cannot be presented again", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const b2 = await postBounty(db, poster.a, ENV, BOUNTY);
  const s2 = await submitToBounty(db, filler.a, b2.bounty_id, ...SUB);
  const { agentUnits, feeUnits } = await owed(db, poster, b2, s2);
  const now = new Date().toISOString();
  const ins = db.raw.prepare("INSERT INTO settlements (id, bounty_id, milestone_id, submission_id, tx_hash, recipient, amount_cents, role, verified_at, created_at) VALUES (?, ?, NULL, 'sub_old', ?, ?, ?, ?, ?, ?)");
  ins.run("stl_1", b.bounty_id, tx(7), AGENT_WALLET, 4750, "contributor", now, now);
  ins.run("stl_2", b.bounty_id, tx(7), FEE, 250, "platform_fee", now, now);
  // Run just the carry-over statement from the real migration file.
  const sql = readFileSync(new URL("../migrations/0027_settlement_binding.sql", import.meta.url), "utf8");
  const from = sql.indexOf("INSERT OR IGNORE INTO settlement_payments");
  const carry = sql.slice(from, sql.indexOf(";", from) + 1);
  db.raw.exec(carry);
  const row = db.raw.prepare("SELECT * FROM settlement_payments WHERE tx_hash = ?").get(tx(7));
  assert.equal(row.submission_id, "sub_old");
  assert.equal(row.log_index, -1);
  db.raw.exec(carry); // running it twice changes nothing
  assert.equal(count(db, "settlement_payments"), 1);
  const c = chain({ [tx(7)]: { transfers: [[PAYER, AGENT_WALLET, agentUnits], [PAYER, FEE, feeUnits]] } });
  await assert.rejects(settleBounty(env(db), poster.a, b2.bounty_id, s2.submission_id, upper(tx(7)), c), status(409, /counts once/));
  assert.equal(c.reads, 0);
});

test("the log index comes from the receipt, so the same transfer is the same transfer however it is fetched", () => {
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const pad = (a) => "0x" + "0".repeat(24) + a.slice(2);
  const log = (to, units, logIndex) => ({ address: USDC, topics: [topic, pad(PAYER), pad(to)], data: "0x" + units.toString(16), logIndex });
  const out = parseTransferLogs([
    { address: addr("99"), topics: [topic, pad(PAYER), pad(FEE)], data: "0x1", logIndex: "0x2a" }, // another token: dropped
    log(AGENT_WALLET, 47503917, "0x2b"), log(FEE, 2500142, "0x2c"),
  ]);
  assert.deepEqual(out.map((t) => [t.to, t.units, t.logIndex]), [[AGENT_WALLET, 47503917n, 43], [FEE, 2500142n, 44]]);
  // Without a logIndex field the position in the list stands in.
  assert.deepEqual(parseTransferLogs([log(FEE, 1, undefined), log(FEE, 2, undefined)]).map((t) => t.logIndex), [0, 1]);
});
