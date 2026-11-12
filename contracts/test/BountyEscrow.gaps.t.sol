// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {EscrowBase} from "./BountyEscrow.t.sol";

/// Tests added after an outside review found that the suite stayed green with
/// most planted bugs. Each test here pins one rule with an exact revert reason,
/// an exact balance or an exact event, at the exact second where the rule turns.
/// The comment on each test names the planted bug it is there to catch.
contract BountyEscrowGapsTest is EscrowBase {
    event Funded(uint256 indexed id, address indexed poster, address indexed agent, uint256 amount, uint256 deadline, bytes32 ref);
    event Submitted(uint256 indexed id, bytes32 deliverable);
    event Paid(uint256 indexed id, address indexed agent, uint256 toAgent, uint256 fee);
    event Refunded(uint256 indexed id, address indexed poster, uint256 amount, uint8 reason);
    event Credited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    uint256 constant REVIEW = 3 days;

    function _expect() internal {
        vm.expectEmit(true, true, true, true, address(escrow));
    }

    // ── Who may release the money, and when ──────────────────────────────

    /// Catches: the agent can call complete() straight after submit() and pay themselves.
    function test_AgentCannotPayThemselvesDuringReview() public {
        uint256 id = _fund(50 * USD);
        _submit(id);
        vm.prank(agent);
        vm.expectRevert(BountyEscrow.TooEarly.selector);
        escrow.complete(id);

        // Still refused at the last second of the window, for the agent and for a stranger.
        vm.warp(block.timestamp + REVIEW);
        vm.prank(agent);
        vm.expectRevert(BountyEscrow.TooEarly.selector);
        escrow.complete(id);
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.TooEarly.selector);
        escrow.complete(id);
        assertEq(usdc.balanceOf(agent), 0);
        assertEq(usdc.balanceOf(address(escrow)), 50 * USD);
    }

    /// Catches: the review window closing early or late, on either side.
    /// At submittedAt + 3 days the poster may still reject and nobody else may pay.
    /// One second later the poster may no longer reject and anyone may pay.
    function test_ReviewWindowTurnsAtExactlyThreeDays() public {
        uint256 a = _fund(10 * USD);
        uint256 b = _fund(10 * USD);
        _submit(a);
        _submit(b);
        uint256 submittedAt = block.timestamp;

        vm.warp(submittedAt + REVIEW);
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.TooEarly.selector);
        escrow.complete(a);
        vm.prank(poster);
        escrow.reject(a); // last second: allowed
        assertEq(uint8(_state(a)), uint8(BountyEscrow.State.Refunded));

        vm.warp(submittedAt + REVIEW + 1);
        vm.prank(poster);
        vm.expectRevert(BountyEscrow.TooLate.selector);
        escrow.reject(b);
        vm.prank(stranger);
        escrow.complete(b); // first second after: allowed
        assertEq(uint8(_state(b)), uint8(BountyEscrow.State.Paid));
        assertEq(usdc.balanceOf(agent), 95 * USD / 10);
    }

    /// The poster may pay at once, without waiting.
    function test_PosterMayPayImmediately() public {
        uint256 id = _fund(20 * USD);
        _submit(id);
        vm.prank(poster);
        escrow.complete(id);
        assertEq(usdc.balanceOf(agent), 19 * USD);
    }

    // ── Who may take the money back, and when ────────────────────────────

    /// Catches: the poster (or anyone but the agent) can call abandon() and pull a refund mid-job.
    function test_OnlyTheAgentCanAbandon() public {
        uint256 id = _fund(30 * USD);
        vm.prank(poster);
        vm.expectRevert(BountyEscrow.NotAgent.selector);
        escrow.abandon(id);
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.NotAgent.selector);
        escrow.abandon(id);
        assertEq(usdc.balanceOf(address(escrow)), 30 * USD);

        // And not after the work is in.
        _submit(id);
        vm.prank(agent);
        vm.expectRevert(BountyEscrow.WrongState.selector);
        escrow.abandon(id);
    }

    /// Catches: refundExpired() working on a submitted job, which would let the
    /// poster take the money back after delivery once the deadline passes.
    function test_NoExpiryRefundOnceWorkIsSubmitted() public {
        uint256 id = _fund(30 * USD);
        _submit(id);
        vm.warp(block.timestamp + 7 days + 1); // past the deadline, review window also over
        vm.prank(poster);
        vm.expectRevert(BountyEscrow.WrongState.selector);
        escrow.refundExpired(id);
        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.WrongState.selector);
        escrow.refundExpired(id);
        assertEq(usdc.balanceOf(address(escrow)), 30 * USD, "still held for the agent");
        escrow.complete(id);
        assertEq(usdc.balanceOf(agent), 285 * USD / 10);
    }

    /// Catches: an expiry refund at the deadline second, or the agent submitting one second late.
    function test_DeadlineTurnsAtExactlyTheDeadline() public {
        uint256 a = _fund(10 * USD);
        uint256 b = _fund(10 * USD);
        uint256 deadline = block.timestamp + 7 days;

        vm.warp(deadline);
        vm.expectRevert(BountyEscrow.TooEarly.selector);
        escrow.refundExpired(a);
        _submit(a); // the deadline second belongs to the agent

        vm.warp(deadline + 1);
        vm.prank(agent);
        vm.expectRevert(BountyEscrow.TooLate.selector);
        escrow.submit(b, keccak256("late"));
        uint256 before = usdc.balanceOf(poster);
        vm.prank(stranger);
        escrow.refundExpired(b); // anyone may trigger it; the money goes to the poster
        assertEq(usdc.balanceOf(poster) - before, 10 * USD);
        assertEq(usdc.balanceOf(stranger), 0);
    }

    // ── Funding limits at the exact edge ─────────────────────────────────

    /// Catches: deadlines accepted just under 1 hour or just over 30 days.
    function test_DeadlineRangeIsExact() public {
        vm.startPrank(poster);
        usdc.approve(address(escrow), 4 * USD);
        uint256 t = block.timestamp;

        vm.expectRevert(BountyEscrow.BadDeadline.selector);
        escrow.fund(agent, USD, t + 1 hours - 1, bytes32(0));
        escrow.fund(agent, USD, t + 1 hours, bytes32(0));

        escrow.fund(agent, USD, t + 30 days, bytes32(0));
        vm.expectRevert(BountyEscrow.BadDeadline.selector);
        escrow.fund(agent, USD, t + 30 days + 1, bytes32(0));
        vm.stopPrank();
        assertEq(escrow.openJobs(), 2);
    }

    /// Catches: amounts accepted one unit outside the per-job range.
    function test_AmountRangeIsExact() public {
        vm.startPrank(poster);
        usdc.approve(address(escrow), 1_000 * USD);
        uint256 d = block.timestamp + 1 days;
        vm.expectRevert(BountyEscrow.BadAmount.selector);
        escrow.fund(agent, MIN - 1, d, bytes32(0));
        vm.expectRevert(BountyEscrow.BadAmount.selector);
        escrow.fund(agent, MAX + 1, d, bytes32(0));
        escrow.fund(agent, MIN, d, bytes32(0));
        escrow.fund(agent, MAX, d, bytes32(0));
        vm.stopPrank();
        assertEq(escrow.held(), MIN + MAX);
    }

    /// Catches: an all-zero deliverable hash being accepted.
    function test_EmptyDeliverableIsRefused() public {
        uint256 id = _fund(10 * USD);
        vm.prank(agent);
        vm.expectRevert(BountyEscrow.WrongState.selector);
        escrow.submit(id, bytes32(0));
        assertEq(uint8(_state(id)), uint8(BountyEscrow.State.Funded));
    }

    /// What a funded and then submitted job records.
    function test_JobRecordIsExact() public {
        vm.startPrank(poster);
        usdc.approve(address(escrow), 42 * USD);
        uint256 deadline = block.timestamp + 2 days;
        uint256 id = escrow.fund(agent, 42 * USD, deadline, keccak256("ref"));
        vm.stopPrank();
        (address p, uint96 amt, address ag, uint40 dl, uint40 subAt, BountyEscrow.State st, bytes32 del) = escrow.jobs(id);
        assertEq(p, poster);
        assertEq(amt, 42 * USD);
        assertEq(ag, agent);
        assertEq(dl, deadline);
        assertEq(subAt, 0);
        assertEq(uint8(st), uint8(BountyEscrow.State.Funded));
        assertEq(del, bytes32(0));
        assertEq(usdc.allowance(poster, address(escrow)), 0, "nothing left approved");

        vm.warp(block.timestamp + 5 hours);
        vm.prank(agent);
        escrow.submit(id, keccak256("the work"));
        (,,,, subAt, st, del) = escrow.jobs(id);
        assertEq(subAt, block.timestamp);
        assertEq(uint8(st), uint8(BountyEscrow.State.Submitted));
        assertEq(del, keccak256("the work"));
    }

    /// A finished job accepts nothing further, whichever way it finished.
    function test_FinishedJobsAcceptNothing() public {
        uint256 paid = _fund(10 * USD);
        _submit(paid);
        vm.prank(poster);
        escrow.complete(paid);
        uint256 refunded = _fund(10 * USD);
        vm.prank(agent);
        escrow.abandon(refunded);

        uint256[2] memory ids = [paid, refunded];
        for (uint256 i = 0; i < 2; i++) {
            uint256 id = ids[i];
            vm.startPrank(agent);
            vm.expectRevert(BountyEscrow.WrongState.selector);
            escrow.submit(id, keccak256("again"));
            vm.expectRevert(BountyEscrow.WrongState.selector);
            escrow.abandon(id);
            vm.stopPrank();
            vm.startPrank(poster);
            vm.expectRevert(BountyEscrow.WrongState.selector);
            escrow.complete(id);
            vm.expectRevert(BountyEscrow.WrongState.selector);
            escrow.reject(id);
            vm.expectRevert(BountyEscrow.WrongState.selector);
            escrow.refundExpired(id);
            vm.stopPrank();
        }
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    /// A funded job that has no submission cannot be paid or rejected.
    function test_NothingToReviewBeforeSubmission() public {
        uint256 id = _fund(10 * USD);
        vm.startPrank(poster);
        vm.expectRevert(BountyEscrow.WrongState.selector);
        escrow.complete(id);
        vm.expectRevert(BountyEscrow.WrongState.selector);
        escrow.reject(id);
        vm.stopPrank();
    }

    // ── Credit: payouts the token refused ────────────────────────────────

    /// Catches: withdraw() not zeroing the caller's credit, so it can be repeated
    /// to drain money owed to somebody else.
    function test_WithdrawPaysOnceAndNeverTouchesAnotherAccountsCredit() public {
        address agent2 = makeAddr("agent2");
        // Two different agents are frozen at payout, so both end up with credit.
        uint256 a = _fund(100 * USD);
        vm.startPrank(poster);
        usdc.approve(address(escrow), 100 * USD);
        uint256 b = escrow.fund(agent2, 100 * USD, block.timestamp + 7 days, bytes32(0));
        vm.stopPrank();
        _submit(a);
        vm.prank(agent2);
        escrow.submit(b, keccak256("w2"));
        usdc.setFrozen(agent, true);
        usdc.setFrozen(agent2, true);
        vm.startPrank(poster);
        escrow.complete(a);
        escrow.complete(b);
        vm.stopPrank();
        assertEq(escrow.credit(agent), 95 * USD);
        assertEq(escrow.credit(agent2), 95 * USD);
        assertEq(escrow.totalCredit(), 190 * USD);

        usdc.setFrozen(agent, false);
        vm.prank(agent);
        escrow.withdraw();
        assertEq(usdc.balanceOf(agent), 95 * USD);
        assertEq(escrow.credit(agent), 0);
        assertEq(escrow.totalCredit(), 95 * USD);

        vm.prank(agent);
        vm.expectRevert(BountyEscrow.NothingToWithdraw.selector);
        escrow.withdraw();
        assertEq(usdc.balanceOf(agent), 95 * USD, "second call paid nothing");
        assertEq(usdc.balanceOf(address(escrow)), 95 * USD, "agent2's money is untouched");
        assertEq(escrow.credit(agent2), 95 * USD);

        vm.prank(stranger);
        vm.expectRevert(BountyEscrow.NothingToWithdraw.selector);
        escrow.withdraw();
    }

    /// Catches: credit being overwritten instead of added, which would lose a
    /// frozen party's earlier payout for good.
    function test_TwoRefusedPayoutsToOneAddressAddUp() public {
        usdc.setFrozen(agent, true);
        uint256 a = _fund(100 * USD);
        uint256 b = _fund(40 * USD);
        _submit(a);
        _submit(b);
        vm.startPrank(poster);
        escrow.complete(a);
        escrow.complete(b);
        vm.stopPrank();
        assertEq(escrow.credit(agent), 95 * USD + 38 * USD);
        assertEq(escrow.totalCredit(), 133 * USD);
        assertEq(usdc.balanceOf(address(escrow)), 133 * USD);

        usdc.setFrozen(agent, false);
        vm.prank(agent);
        escrow.withdraw();
        assertEq(usdc.balanceOf(agent), 133 * USD);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    /// A withdrawal that the token still refuses changes nothing.
    function test_WithdrawWhileStillFrozenRevertsAndKeepsTheCredit() public {
        usdc.setFrozen(agent, true);
        uint256 id = _fund(100 * USD);
        _submit(id);
        vm.prank(poster);
        escrow.complete(id);
        vm.prank(agent);
        vm.expectRevert();
        escrow.withdraw();
        assertEq(escrow.credit(agent), 95 * USD);
        assertEq(escrow.totalCredit(), 95 * USD);
    }

    /// The fee recipient is frozen: the agent is still paid, the fee waits as credit.
    function test_FrozenTreasury_AgentPaid_FeeWaits() public {
        uint256 id = _fund(100 * USD);
        _submit(id);
        usdc.setFrozen(treasury, true);
        vm.prank(poster);
        escrow.complete(id);
        assertEq(usdc.balanceOf(agent), 95 * USD);
        assertEq(escrow.credit(treasury), 5 * USD);
        assertEq(escrow.credit(agent), 0);
        usdc.setFrozen(treasury, false);
        vm.prank(treasury);
        escrow.withdraw();
        assertEq(usdc.balanceOf(treasury), 5 * USD);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    /// Circle pauses USDC: jobs still finish, everything owed waits as credit,
    /// and each party collects exactly their amount after the pause ends.
    function test_PausedToken_PayoutsAndRefundsWaitAsCredit() public {
        uint256 a = _fund(100 * USD);
        uint256 b = _fund(60 * USD);
        _submit(a);
        usdc.setPaused(true);
        vm.prank(poster);
        escrow.complete(a);
        vm.prank(agent);
        escrow.abandon(b);
        assertEq(escrow.credit(agent), 95 * USD);
        assertEq(escrow.credit(treasury), 5 * USD);
        assertEq(escrow.credit(poster), 60 * USD);
        assertEq(escrow.totalCredit(), 160 * USD);
        assertEq(escrow.held(), 0);
        assertEq(escrow.openJobs(), 0);
        assertEq(usdc.balanceOf(address(escrow)), 160 * USD);

        // No new money can come in while paused, and nothing is half-recorded.
        vm.startPrank(poster);
        vm.expectRevert();
        escrow.fund(agent, 10 * USD, block.timestamp + 1 days, bytes32(0));
        vm.stopPrank();
        assertEq(escrow.openJobs(), 0);
        assertEq(escrow.held(), 0);

        usdc.setPaused(false);
        uint256 posterBefore = usdc.balanceOf(poster);
        vm.prank(agent);
        escrow.withdraw();
        vm.prank(treasury);
        escrow.withdraw();
        vm.prank(poster);
        escrow.withdraw();
        assertEq(usdc.balanceOf(agent), 95 * USD);
        assertEq(usdc.balanceOf(treasury), 5 * USD);
        assertEq(usdc.balanceOf(poster) - posterBefore, 60 * USD);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalCredit(), 0);
    }

    /// Circle freezes the escrow's own address: nothing can leave, but nothing is
    /// lost or misrecorded, and everyone collects once it is unfrozen.
    function test_FrozenEscrow_EverythingWaitsThenPays() public {
        uint256 id = _fund(100 * USD);
        _submit(id);
        usdc.setFrozen(address(escrow), true);
        vm.prank(poster);
        escrow.complete(id);
        assertEq(escrow.credit(agent), 95 * USD);
        assertEq(escrow.credit(treasury), 5 * USD);
        vm.prank(agent);
        vm.expectRevert();
        escrow.withdraw();

        usdc.setFrozen(address(escrow), false);
        vm.prank(agent);
        escrow.withdraw();
        vm.prank(treasury);
        escrow.withdraw();
        assertEq(usdc.balanceOf(agent), 95 * USD);
        assertEq(usdc.balanceOf(treasury), 5 * USD);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    // ── Events: what an indexer or the board would read ──────────────────

    /// Catches: wrong payee, amount or fee in Paid, and wrong fields in Funded and Submitted.
    function test_Events_FundSubmitPay() public {
        vm.startPrank(poster);
        usdc.approve(address(escrow), 100 * USD);
        uint256 deadline = block.timestamp + 7 days;
        _expect();
        emit Funded(1, poster, agent, 100 * USD, deadline, keccak256("job-7"));
        uint256 id = escrow.fund(agent, 100 * USD, deadline, keccak256("job-7"));
        vm.stopPrank();
        assertEq(id, 1);

        _expect();
        emit Submitted(id, keccak256("the work"));
        _submit(id);

        _expect();
        emit Paid(id, agent, 95 * USD, 5 * USD);
        vm.prank(poster);
        escrow.complete(id);
    }

    /// Each refund reason is reported as documented: 0 rejected, 1 expired, 2 agent gave up.
    function test_Events_RefundReasons() public {
        uint256 a = _fund(10 * USD);
        uint256 b = _fund(20 * USD);
        uint256 c = _fund(30 * USD);

        _submit(a);
        _expect();
        emit Refunded(a, poster, 10 * USD, 0);
        vm.prank(poster);
        escrow.reject(a);

        _expect();
        emit Refunded(c, poster, 30 * USD, 2);
        vm.prank(agent);
        escrow.abandon(c);

        vm.warp(block.timestamp + 7 days + 1);
        _expect();
        emit Refunded(b, poster, 20 * USD, 1);
        escrow.refundExpired(b);
    }

    /// A refused payout says so with Credited, and the later claim with Withdrawn.
    function test_Events_CreditedAndWithdrawn() public {
        uint256 id = _fund(100 * USD);
        _submit(id);
        usdc.setFrozen(agent, true);
        _expect();
        emit Credited(agent, 95 * USD);
        _expect();
        emit Paid(id, agent, 95 * USD, 5 * USD);
        vm.prank(poster);
        escrow.complete(id);

        usdc.setFrozen(agent, false);
        _expect();
        emit Withdrawn(agent, 95 * USD);
        vm.prank(agent);
        escrow.withdraw();
    }

    // ── Other fee settings the constructor allows ────────────────────────

    function _deploy(uint256 feeBps, uint256 minAmount) internal returns (BountyEscrow e) {
        e = new BountyEscrow(IERC20(address(usdc)), treasury, feeBps, minAmount, MAX, MAX_OPEN, MAX_HELD);
    }

    function _runJob(BountyEscrow e, uint256 amount) internal {
        vm.startPrank(poster);
        usdc.approve(address(e), amount);
        uint256 id = e.fund(agent, amount, block.timestamp + 1 days, bytes32(0));
        vm.stopPrank();
        vm.prank(agent);
        e.submit(id, keccak256("w"));
        vm.prank(poster);
        e.complete(id);
    }

    /// With no fee the agent gets everything and the treasury is never touched.
    function test_ZeroFee_AgentGetsEverything() public {
        BountyEscrow e = _deploy(0, MIN);
        usdc.setFrozen(treasury, true); // would show up as credit if the treasury were paid at all
        _runJob(e, 100 * USD);
        assertEq(usdc.balanceOf(agent), 100 * USD);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(e.credit(treasury), 0);
        assertEq(usdc.balanceOf(address(e)), 0);
    }

    /// The highest fee the constructor accepts is 10%, and one more basis point is refused.
    function test_MaxFee_TenPercent() public {
        BountyEscrow e = _deploy(1_000, MIN);
        _runJob(e, 100 * USD);
        assertEq(usdc.balanceOf(agent), 90 * USD);
        assertEq(usdc.balanceOf(treasury), 10 * USD);
        vm.expectRevert(BountyEscrow.BadConfig.selector);
        _deploy(1_001, MIN);
    }

    /// A fee that rounds down to zero pays the agent in full and sends no zero transfer.
    function test_FeeThatRoundsToZero() public {
        BountyEscrow e = _deploy(500, 1);
        usdc.setFrozen(treasury, true);
        _runJob(e, 19); // 19 * 500 / 10000 = 0
        assertEq(usdc.balanceOf(agent), 19);
        assertEq(e.credit(treasury), 0);
        usdc.setFrozen(treasury, false);
        _runJob(e, 20); // 20 * 500 / 10000 = 1
        assertEq(usdc.balanceOf(agent), 19 + 19);
        assertEq(usdc.balanceOf(treasury), 1);
    }

    /// For any allowed fee and amount: the agent and treasury together receive
    /// exactly the amount, the fee is the floor of amount * bps / 10000, and the
    /// contract is left empty.
    function testFuzz_SplitIsExactForAnyFee(uint256 feeBps, uint256 amount) public {
        feeBps = bound(feeBps, 0, 1_000);
        amount = bound(amount, 1, MAX);
        BountyEscrow e = _deploy(feeBps, 1);
        _runJob(e, amount);
        uint256 fee = (amount * feeBps) / 10_000;
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(agent), amount - fee);
        assertEq(usdc.balanceOf(address(e)), 0);
        assertEq(e.held(), 0);
        assertEq(e.totalCredit(), 0);
    }

    /// Whatever moment before the deadline the agent gives up, and whatever
    /// moment in the review window the poster rejects, the poster gets every unit back.
    function testFuzz_AbandonAndRejectRefundInFull(uint256 amount, uint256 wait, bool viaReject) public {
        amount = bound(amount, MIN, MAX);
        uint256 id = _fund(amount);
        uint256 before = usdc.balanceOf(poster);
        if (viaReject) {
            _submit(id);
            vm.warp(block.timestamp + bound(wait, 0, REVIEW));
            vm.prank(poster);
            escrow.reject(id);
        } else {
            vm.warp(block.timestamp + bound(wait, 0, 7 days));
            vm.prank(agent);
            escrow.abandon(id);
        }
        assertEq(usdc.balanceOf(poster) - before, amount);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(agent), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }
}
