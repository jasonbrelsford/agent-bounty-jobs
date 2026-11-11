// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// A token that skims 1% on every transfer, so the escrow would receive less than it asked for.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fake USDC", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 skim = value / 100;
            super._update(from, address(0xdead), skim);
            value -= skim;
        }
        super._update(from, to, value);
    }
}

interface IEscrowLike {
    function complete(uint256 id) external;
    function withdraw() external;
    function refundExpired(uint256 id) external;
    function reject(uint256 id) external;
}

/// A token that calls back into the escrow in the middle of every transfer,
/// trying to get paid twice (reentrancy). It records whether any call back got through.
contract ReentrantToken is ERC20 {
    IEscrowLike public target;
    uint256 public attackId;
    uint256 public reentries;
    uint256 public reentrySucceeded;

    constructor() ERC20("Evil USDC", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(IEscrowLike t, uint256 id) external {
        target = t;
        attackId = id;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(target) != address(0) && from == address(target)) {
            reentries++;
            try target.complete(attackId) { reentrySucceeded++; } catch {}
            try target.withdraw() { reentrySucceeded++; } catch {}
            try target.refundExpired(attackId) { reentrySucceeded++; } catch {}
        }
    }
}

/// A token whose transfer returns false instead of reverting.
contract FalseToken is ERC20 {
    bool public refuse;

    constructor() ERC20("Quiet USDC", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setRefuse(bool on) external {
        refuse = on;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (refuse) return false;
        return super.transfer(to, value);
    }
}
