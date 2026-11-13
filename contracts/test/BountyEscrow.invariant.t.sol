// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Drives the escrow with random sequences of every call, from posters, agents
/// and strangers, with time jumps and Circle freezing and unfreezing addresses.
contract Handler is Test {
    uint256 constant USD = 1e6;
    BountyEscrow public escrow;
    MockUSDC public usdc;
    address public treasury;
    address[4] public actors;
    uint256[] public ids;

    // Ghost accounting: what the tests expect, kept independently of the contract.
    uint256 public ghostFunded;
    uint256 public ghostPaidOut; // to agents, posters and treasury, including credits later withdrawn
    uint256 public ghostFees;
    uint256 public ghostAgentPay;

    constructor(BountyEscrow e, MockUSDC u, address t) {
        escrow = e;
        usdc = u;
        treasury = t;
        actors = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
        for (uint256 i; i < 4; ++i) usdc.mint(actors[i], 1_000_000 * USD);
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % 4];
    }

    function _id(uint256 s) internal view returns (uint256) {
        return ids.length == 0 ? 0 : ids[s % ids.length];
    }

    function fund(uint256 posterSeed, uint256 agentSeed, uint256 amount, uint256 days_) external {
        address p = _actor(posterSeed);
        address a = _actor(agentSeed);
        amount = bound(amount, 1 * USD, 100 * USD);
        uint256 deadline = block.timestamp + bound(days_, 1 hours, 30 days);
        vm.startPrank(p);
        usdc.approve(address(escrow), amount);
        try escrow.fund(a, amount, deadline, bytes32(0)) returns (uint256 id) {
            ids.push(id);
            ghostFunded += amount;
        } catch {
            usdc.approve(address(escrow), 0);
        }
        vm.stopPrank();
    }

    function submit(uint256 idSeed, uint256 who) external {
        vm.prank(_actor(who));
        try escrow.submit(_id(idSeed), keccak256(abi.encode(idSeed))) {} catch {}
    }

    function complete(uint256 idSeed, uint256 who) external {
        uint256 id = _id(idSeed);
        (, uint96 amount,,,,,) = escrow.jobs(id);
        vm.prank(_actor(who));
        try escrow.complete(id) {
            uint256 fee = (uint256(amount) * escrow.feeBps()) / 10_000;
            ghostFees += fee;
            ghostAgentPay += amount - fee;
        } catch {}
    }

    function reject(uint256 idSeed, uint256 who) external {
        vm.prank(_actor(who));
        try escrow.reject(_id(idSeed)) {} catch {}
    }

    function abandon(uint256 idSeed, uint256 who) external {
        vm.prank(_actor(who));
        try escrow.abandon(_id(idSeed)) {} catch {}
    }

    function refundExpired(uint256 idSeed, uint256 who) external {
        vm.prank(_actor(who));
        try escrow.refundExpired(_id(idSeed)) {} catch {}
    }

    function withdraw(uint256 who) external {
        vm.prank(_actor(who));
        try escrow.withdraw() {} catch {}
    }

    function freeze(uint256 who, bool on) external {
        usdc.setFrozen(_actor(who), on);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 10 days));
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function allIds() external view returns (uint256[] memory) {
        return ids;
    }
}

contract BountyEscrowInvariantTest is StdInvariant, Test {
    uint256 constant USD = 1e6;
    BountyEscrow escrow;
    MockUSDC usdc;
    Handler handler;
    address treasury = makeAddr("treasury");
    address a0;
    address a1;
    address a2;
    address a3;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        escrow = new BountyEscrow(IERC20(address(usdc)), treasury, 500, 1 * USD, 100 * USD, 10, 3, 500 * USD);
        handler = new Handler(escrow, usdc, treasury);
        a0 = handler.actors(0);
        a1 = handler.actors(1);
        a2 = handler.actors(2);
        a3 = handler.actors(3);
        targetContract(address(handler));
    }

    /// The contract always holds exactly what it owes: open jobs plus unclaimed credit.
    function invariant_HoldsExactlyWhatItOwes() public view {
        assertEq(usdc.balanceOf(address(escrow)), escrow.held() + escrow.totalCredit());
    }

    /// `held`, `openJobs`, and per-poster `posterOpenJobs` match every open job.
    function invariant_HeldMatchesOpenJobs() public view {
        uint256 sum;
        uint256 open;
        uint256[4] memory counts;
        address[4] memory actors = [a0, a1, a2, a3];
        uint256[] memory ids = handler.allIds();
        for (uint256 i; i < ids.length; ++i) {
            (address p, uint96 amount,,,, BountyEscrow.State s,) = escrow.jobs(ids[i]);
            if (s == BountyEscrow.State.Funded || s == BountyEscrow.State.Submitted) {
                sum += amount;
                open++;
                if (p == actors[0]) counts[0]++;
                else if (p == actors[1]) counts[1]++;
                else if (p == actors[2]) counts[2]++;
                else if (p == actors[3]) counts[3]++;
            }
        }
        assertEq(escrow.held(), sum);
        assertEq(escrow.openJobs(), open);
        for (uint256 k; k < 4; ++k) {
            assertEq(escrow.posterOpenJobs(actors[k]), counts[k]);
        }
        assertEq(counts[0] + counts[1] + counts[2] + counts[3], open);
    }

    /// The launch limits (global and per-poster) are never exceeded.
    function invariant_LimitsHold() public view {
        uint256 perPosterCap = escrow.maxOpenJobsPerPoster();
        assertLe(escrow.openJobs(), escrow.maxOpenJobs());
        assertLe(escrow.held(), escrow.maxHeld());
        assertLe(escrow.posterOpenJobs(a0), perPosterCap);
        assertLe(escrow.posterOpenJobs(a1), perPosterCap);
        assertLe(escrow.posterOpenJobs(a2), perPosterCap);
        assertLe(escrow.posterOpenJobs(a3), perPosterCap);
    }

    /// No money is created or destroyed: every unit is with a person, the treasury or the escrow.
    function invariant_NoMoneyCreatedOrLost() public view {
        uint256 total = usdc.balanceOf(address(escrow)) + usdc.balanceOf(treasury);
        for (uint256 i; i < 4; ++i) total += usdc.balanceOf(handler.actors(i));
        assertEq(total, usdc.totalSupply());
    }

    /// The treasury never receives more than 5% of what agents were paid for, and never anything else.
    function invariant_FeeOnlyOnPaidJobs() public view {
        assertEq(usdc.balanceOf(treasury) + escrow.credit(treasury), handler.ghostFees());
        assertLe(handler.ghostFees() * 10_000, (handler.ghostFees() + handler.ghostAgentPay()) * 500);
    }
}
