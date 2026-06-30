// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only 6-decimal ERC-20 standing in for USDC. NOT for production.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A second, non-whitelisted token to exercise rescueNonWhitelistedToken.
contract MockOtherToken is ERC20 {
    constructor() ERC20("Other", "OTH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
