// On-chain settlement: a transfer counts only for the one submission it pays,
// only once, and a settlement may be paid in several transactions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeD1 } from "./d1shim.mjs";
import {
  registerAgent, authByKey, postBounty, submitToBounty, settlementInstruction, setPayoutAddress,
  getBounty, expireOverdue, unitsToUsdc, LEG_TAG_MAX, UNITS_PER_CENT,
} from "../.test-build/core.js";
import { settleBounty, MAX_TX_HASHES, LEG_CLOCK_ALLOWANCE_S } from "../.test-build/settle.js";
import { parseTransferLogs } from "../.test-build/chain.js";

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
  const { joinSubmission } = await import("../.test-build/core.js");
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

test("a payout address change before anything is paid moves the instruction to the new address", async () => {
  const db = makeD1();
  const { poster, filler, b } = await setup(db);
  const s = await submitToBounty(db, filler.a, b.bounty_id, ...SUB);
  await setPayoutAddress(db, filler.a, NEW_WALLET);
  const first = await owed(db, poster, b, s);
  db.raw.prepare("UPDATE agents SET payout_pending_effective_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), filler.agent_id);
  const second = await owed(db, poster, b, s);
  assert.equal(second.by.contributor.address, NEW_WALLET);
  assert.equal(count(db, "settlement_legs", "open = 1"), 2, "the old legs were retired");
  // Paying the retired amounts to the old address settles nothing.
  const c = chain({
    [tx(1)]: { transfers: [[PAYER, AGENT_WALLET, first.agentUnits], [PAYER, FEE, first.feeUnits]] },
    [tx(2)]: { transfers: [[PAYER, NEW_WALLET, second.agentUnits], [PAYER, FEE, second.feeUnits]] },
  });
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), status(400, /no transfer/));
  assert.equal((await settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(2), c)).settled, true);
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
      assert.match(e.message, /payment is verified and recorded, but the award could not be made/);
      assert.match(e.message, /Do not pay again/);
      return true;
    },
  );
  assert.equal(count(db, "settlements", "submission_id = ?", s.submission_id), 0, "no settlement rows are left behind");
  assert.equal(count(db, "settlement_payments", "submission_id = ?", s.submission_id), 2, "the payment itself stays on record");
  // A retry does not say "already settled".
  c.readTx = inner;
  await assert.rejects(settleBounty(env(db), poster.a, b.bounty_id, s.submission_id, tx(1), c), (e) => {
    assert.ok(!/already verified and applied/.test(e.message));
    return true;
  });
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
