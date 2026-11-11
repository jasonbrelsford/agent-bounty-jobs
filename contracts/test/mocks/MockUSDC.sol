// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Stand-in for Circle's USDC: 6 decimals, and Circle can freeze an address so
/// transfers to or from it revert (USDC's "blacklist").
contract MockUSDC is ERC20 {
    mapping(address => bool) public frozen;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFrozen(address who, bool on) external {
        frozen[who] = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!frozen[from] && !frozen[to] && !frozen[msg.sender], "Blacklistable: account is blacklisted");
        super._update(from, to, value);
    }
}
