// Escrow fee math (M3 / #65): the board's escrow numbers match BountyEscrow.sol
// to the base unit, while stated rewards, multi-contributor teams, milestones,
// already-awarded bounties and direct settlement_legs keep their cent + tag math.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1 } from "./d1shim.mjs";
import {
  escrowFeeSplitUnits, escrowFeeSplit, feeSplit, unitsToUsdc, UNITS_PER_CENT,
  registerAgent, authByKey, postBounty, getBounty, listBounties, submitToBounty,
  settlementInstruction,
} from "../.test-build/core.js";
import { settleBounty } from "../.test-build/settle.js";
import { bountyPage } from "../.test-build/dashboard.js";

/** Exact Solidity formula in contracts/src/BountyEscrow.sol: complete() line 210. */
function contractRule(amountUnits, feeBps) {
  const fee = (amountUnits * BigInt(feeBps)) / 10_000n;
  return { fee, toAgent: amountUnits - fee };
}

test("table: escrowFeeSplitUnits matches BountyEscrow.complete() across zero-rounding and odd-cent edges", () => {
  const cases = [
    // [label, amountUnits, feeBp, expectedFeeUnits, expectedNetUnits]
    ["zero amount", 0n, 500, 0n, 0n],
    ["1 base unit at 5% rounds fee to zero", 1n, 500, 0n, 1n],
    ["19 base units at 5% still rounds fee to zero", 19n, 500, 0n, 19n],
    ["20 base units at 5% is first 1-unit fee", 20n, 500, 1n, 19n],
    ["99 base units at 1% rounds fee to zero", 99n, 100, 0n, 99n],
    ["100 base units at 1% is 1-unit fee", 100n, 100, 1n, 99n],
    ["zero fee rate on $50", 50_000_000n, 0, 0n, 50_000_000n],
    ["$0.01 (1 cent) at 5% = 500 fee units ($0.000500), not $0.00", 10_000n, 500, 500n, 9_500n],
    ["$1.00 (minAmount on Base Sepolia) at 5%", 1_000_000n, 500, 50_000n, 950_000n],
    ["$1.01 odd cent at 5% = 0.050500 fee, 0.959500 net", 1_010_000n, 500, 50_500n, 959_500n],
    ["$1.99 odd cents at 5% = 0.099500 fee, 1.890500 net", 1_990_000n, 500, 99_500n, 1_890_500n],
    ["$3.33 at 5% = 0.166500 fee, 3.163500 net", 3_330_000n, 500, 166_500n, 3_163_500n],
    ["$25.00 even dollar at 5%", 25_000_000n, 500, 1_250_000n, 23_750_000n],
    ["$99.99 at 5%", 99_990_000n, 500, 4_999_500n, 94_990_500n],
    ["$100.00 (maxAmount on Base Sepolia) at 5%", 100_000_000n, 500, 5_000_000n, 95_000_000n],
    ["prime base units 1_234_567 at 333bp", 1_234_567n, 333, 41_111n, 1_193_456n],
  ];

  for (const [label, amount, bp, wantFee, wantNet] of cases) {
    const sol = contractRule(amount, bp);
    assert.equal(sol.fee, wantFee, `${label}: test table matches Solidity formula`);
    assert.equal(sol.toAgent, wantNet, `${label}: test table net matches Solidity formula`);

    const got = escrowFeeSplitUnits(amount, bp);
    assert.equal(got.amount_units, amount, label);
    assert.equal(got.fee_units, sol.fee, `${label}: board fee_units == contract fee`);
    assert.equal(got.net_units, sol.toAgent, `${label}: board net_units == contract toAgent`);
    assert.equal(got.fee_units + got.net_units, amount, `${label}: conservation of units`);
  }
});

test("RangeError guards reject invalid amounts and fee basis points", () => {
  assert.throws(() => escrowFeeSplitUnits(1000, 500), RangeError);
  assert.throws(() => escrowFeeSplitUnits(-1n, 500), RangeError);
  assert.throws(() => escrowFeeSplitUnits(1000n, -1), RangeError);
  assert.throws(() => escrowFeeSplitUnits(1000n, 10_001), RangeError);
  assert.throws(() => escrowFeeSplitUnits(1000n, 12.5), RangeError);
  assert.throws(() => escrowFeeSplit(-1, 500), RangeError);
  assert.throws(() => escrowFeeSplit(1e21, 500), RangeError);
});

test("property: escrowFeeSplit matches contractRule for all cent rewards and sub-cent boundaries", () => {
  for (const bp of [0, 1, 25, 100, 250, 333, 500, 750, 1000]) {
    for (let units = 0n; units <= 250n; units++) {
      const got = escrowFeeSplitUnits(units, bp);
      const sol = contractRule(units, bp);
      assert.equal(got.fee_units, sol.fee);
      assert.equal(got.net_units, sol.toAgent);
    }
    for (const cents of [0, 1, 2, 3, 19, 20, 99, 100, 101, 199, 333, 999, 1000, 4999, 9999, 10_000]) {
      const s = escrowFeeSplit(cents, bp);
      const sol = contractRule(BigInt(cents) * UNITS_PER_CENT, bp);
      assert.equal(BigInt(s.fee_units), sol.fee);
      assert.equal(BigInt(s.net_units), sol.toAgent);
      assert.equal(s.locked_usdc, unitsToUsdc(BigInt(cents) * UNITS_PER_CENT));
      assert.equal(s.fee_usdc, unitsToUsdc(sol.fee));
      assert.equal(s.net_usdc, unitsToUsdc(sol.toAgent));
    }
  }
});

test("board API, submitToBounty, and bounty page show exact escrow USDC figures while stated, team, milestone, and already-settled bounties stay consistent", async () => {
  const db = makeD1();
  const feeAddr = "0x" + "fe".repeat(20);
  const agentWallet = "0x" + "a1".repeat(20);
  const mateWallet = "0x" + "b2".repeat(20);
  const payerWallet = "0x" + "d4".repeat(20);
  const env = { DB: db, HUMAN_BOUNTIES: "off", PLATFORM_FEE_ADDRESS: feeAddr };

  const pReg = await registerAgent(db, "poster-odd", { contact_email: "poster@example.com" });
  const poster = await authByKey(db, pReg.api_key);
  const fReg = await registerAgent(db, "filler-odd", { contact_email: "filler@example.com", payout_address: agentWallet });
  const filler = await authByKey(db, fReg.api_key);
  const mReg = await registerAgent(db, "mate-odd", { contact_email: "mate@example.com", payout_address: mateWallet });

  // $1.99 stated bounty: uses cent-floored feeSplit ($0.09 / $1.90), no escrow_fee_split.
  assert.deepEqual(feeSplit(199, 500), { fee: 9, net: 190 });
  const stated = await postBounty(db, poster, env, {
    title: "Stated $1.99 bounty",
    description: "Stated rewards settle off-platform and keep cent-floored feeSplit.",
    category: "research",
    reward_amount_cents: 199,
    settlement: "stated",
  });
  assert.equal(stated.platform_fee, "$0.09");
  assert.equal(stated.net_to_filler, "$1.90");
  assert.equal(stated.escrow_fee_split, undefined);
  assert.equal((await getBounty(db, stated.bounty_id, null)).bounty.escrow_fee_split, undefined);

  // $1.99 on-chain bounty: BountyEscrow locks 1.990000 USDC, takes 0.099500 USDC fee, pays 1.890500 USDC.
  const posted = await postBounty(db, poster, env, {
    title: "Verify odd-cent escrow split",
    description: "Check that a $1.99 on-chain bounty shows the exact 6-decimal USDC numbers.",
    category: "research",
    reward_amount_cents: 199,
    settlement: "onchain",
  });
  assert.equal(posted.platform_fee, "0.099500 USDC");
  assert.equal(posted.net_to_filler, "1.890500 USDC");
  assert.deepEqual(posted.escrow_fee_split, {
    locked_units: "1990000",
    locked_usdc: "1.990000",
    fee_bp: 500,
    fee_units: "99500",
    fee_usdc: "0.099500",
    net_units: "1890500",
    net_usdc: "1.890500",
  });

  const listed = await listBounties(db, { status: "open" });
  const listedOnchain = listed.find((b) => b.id === posted.bounty_id);
  assert.deepEqual(listedOnchain.escrow_fee_split, posted.escrow_fee_split);

  const got = await getBounty(db, posted.bounty_id, null);
  assert.deepEqual(got.bounty.escrow_fee_split, posted.escrow_fee_split);

  const html = await (await bountyPage(env, posted.bounty_id)).text();
  assert.match(html, /1\.990000 USDC/);
  assert.match(html, /1\.890500 USDC/);
  assert.match(html, /0\.099500 USDC/);

  // Solo submission on an escrow-eligible bounty shows the exact 1.890500 USDC net payout.
  const soloSub = await submitToBounty(
    db,
    filler,
    posted.bounty_id,
    "Full verified answer with primary sources https://example.com/a",
    undefined,
    "Preview of the verified answer that is at least forty characters long.",
  );
  assert.equal(soloSub.contributors[0].payout_if_awarded, "1.890500 USDC");
  assert.deepEqual(soloSub.escrow_fee_split, posted.escrow_fee_split);

  // Multi-contributor team submission (60/40) settles via direct legs: $1.14 and $0.76, no escrow_fee_split.
  const teamSub = await submitToBounty(
    db,
    filler,
    posted.bounty_id,
    "Team verified answer with primary sources https://example.com/b",
    [
      { agent_id: fReg.agent_id, share_bp: 6000 },
      { agent_id: mReg.agent_id, share_bp: 4000 },
    ],
    "Team preview of the verified answer that is at least forty characters long.",
  );
  assert.equal(teamSub.escrow_fee_split, undefined);
  assert.deepEqual(
    teamSub.contributors.map((c) => c.payout_if_awarded),
    ["$1.14", "$0.76"],
  );

  // Milestone on-chain bounties settle via direct legs, so escrow_fee_split is omitted.
  const milPosted = await postBounty(db, poster, env, {
    title: "Two-part milestone bounty",
    description: "Milestone bounties settle per part via direct settlement legs.",
    category: "research",
    settlement: "onchain",
    milestones: [
      { title: "Part one", reward_amount_cents: 100 },
      { title: "Part two", reward_amount_cents: 99 },
    ],
  });
  assert.equal(milPosted.escrow_fee_split, undefined);
  assert.equal(milPosted.platform_fee, "$0.09");
  assert.equal((await getBounty(db, milPosted.bounty_id, null)).bounty.escrow_fee_split, undefined);

  // Direct settlement legs (settlementInstruction + settleBounty) keep integer-cent + tag math,
  // and once settled via direct legs, getBounty / listBounties / bountyPage no longer attach escrow_fee_split.
  const ins = await settlementInstruction(db, env, poster, posted.bounty_id, soloSub.submission_id);
  const byRole = Object.fromEntries(ins.recipients.map((r) => [r.role, r]));
  assert.equal(byRole.contributor.amount_cents, 190);
  assert.equal(byRole.platform_fee.amount_cents, 9);

  const txHash = "0x" + "1".repeat(60) + "abcd";
  await settleBounty(
    env,
    poster,
    posted.bounty_id,
    soloSub.submission_id,
    txHash,
    {
      readTx: async () => ({
        blockTime: Math.floor(Date.now() / 1000) + 5,
        transfers: [
          { from: payerWallet, to: agentWallet, units: BigInt(byRole.contributor.amount_units), logIndex: 0 },
          { from: payerWallet, to: feeAddr, units: BigInt(byRole.platform_fee.amount_units), logIndex: 1 },
        ],
      }),
    },
  );
  const afterDirectSettle = await getBounty(db, posted.bounty_id, null);
  assert.equal(afterDirectSettle.bounty.status, "awarded");
  assert.equal(afterDirectSettle.bounty.fee_cents, 9);
  assert.equal(afterDirectSettle.bounty.escrow_fee_split, undefined);
  const awardedList = await listBounties(db, { status: "awarded" });
  assert.equal(awardedList.find((b) => b.id === posted.bounty_id).escrow_fee_split, undefined);
  const awardedHtml = await (await bountyPage(env, posted.bounty_id)).text();
  assert.doesNotMatch(awardedHtml, /1\.890500 USDC/);
});
