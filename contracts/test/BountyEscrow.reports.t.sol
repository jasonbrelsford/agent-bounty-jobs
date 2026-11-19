// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";
import {LyingFalseToken} from "./mocks/BadTokens.sol";
import {EscrowBase} from "./BountyEscrow.t.sol";

/// Regressions for the two reports sent to our own bug bounty on Nov 17, 2026.
/// Neither is reachable against the deployed contract (Circle USDC never moves
/// money and returns false; timestamps are nowhere near 2^40), but both broke a
/// stated rule in the published source, so both are fixed in the source.

/// Report on "Break our USDC escrow": a token that moves the payout and then
/// returns false used to leave a credit too, so the agent could withdraw twice,
/// taking the second payment out of another job's money.
contract LyingTokenTest is Test {
    uint256 constant USD = 1e6;
    LyingFalseToken token;
    BountyEscrow escrow;
    address treasury = makeAddr("treasury");
    address poster1 = makeAddr("poster1");
    address poster2 = makeAddr("poster2");
    address agent = makeAddr("agent");
    address agent2 = makeAddr("agent2");

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new LyingFalseToken();
        escrow = new BountyEscrow(IERC20(address(token)), treasury, 500, 1 * USD, 100 * USD, 10, 500 * USD);
        token.mint(poster1, 1_000 * USD);
        token.mint(poster2, 1_000 * USD);
    }

    function _fund(address p, address a, uint256 amount) internal returns (uint256 id) {
        vm.startPrank(p);
        token.approve(address(escrow), amount);
        id = escrow.fund(a, amount, block.timestamp + 7 days, keccak256("job"));
        vm.stopPrank();
    }

    function test_DeliveredPaymentIsNeverAlsoCredited() public {
        uint256 id = _fund(poster1, agent, 100 * USD);
        vm.prank(agent);
        escrow.submit(id, keccak256("work"));
        token.setLie(true);
        vm.prank(poster1);
        escrow.complete(id);
        token.setLie(false);

        assertEq(token.balanceOf(agent), 95 * USD, "agent paid once");
        assertEq(token.balanceOf(treasury), 5 * USD, "fee paid once");
        assertEq(escrow.credit(agent), 0, "no credit for money already delivered");
        assertEq(escrow.credit(treasury), 0);
        assertEq(escrow.totalCredit(), 0);

        // A later job stays fully backed, and nothing is left to withdraw.
        _fund(poster2, agent2, 100 * USD);
        vm.prank(agent);
        vm.expectRevert(BountyEscrow.NothingToWithdraw.selector);
        escrow.withdraw();
        assertEq(token.balanceOf(address(escrow)), escrow.held() + escrow.totalCredit());
    }
}

/// Report on "Get around our escrow's limits or timing rules": a deadline past
/// 2^40 used to be truncated when stored, so the poster could reclaim early.
contract Uint40DeadlineTest is EscrowBase {
    function test_DeadlinePastUint40IsRefused() public {
        uint256 t = uint256(type(uint40).max) - 30 minutes;
        vm.warp(t);
        vm.startPrank(poster);
        usdc.approve(address(escrow), 10 * USD);
        vm.expectRevert(BountyEscrow.BadDeadline.selector);
        escrow.fund(agent, 10 * USD, t + 1 hours, keccak256("job"));
        vm.stopPrank();
    }

    function test_DeadlineAtUint40MaxStillWorks() public {
        uint256 t = uint256(type(uint40).max) - 2 hours;
        vm.warp(t);
        vm.startPrank(poster);
        usdc.approve(address(escrow), 10 * USD);
        uint256 id = escrow.fund(agent, 10 * USD, type(uint40).max, keccak256("job"));
        vm.stopPrank();
        vm.expectRevert(BountyEscrow.TooEarly.selector);
        escrow.refundExpired(id);
    }
}
