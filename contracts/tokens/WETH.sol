// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Wrapped ETH implementation for bridging native ETH
contract WETH is ERC20 {
    event Deposit(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    constructor() ERC20("Wrapped Ether", "WETH") {}

    /// @notice Wrap ETH to WETH
    function deposit() external payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    /// @notice Unwrap WETH to ETH
    function withdraw(uint256 amount) external {
        require(balanceOf(msg.sender) >= amount, "WETH: insufficient balance");
        _burn(msg.sender, amount);
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "WETH: ETH transfer failed");
        emit Withdrawal(msg.sender, amount);
    }

    /// @notice Receive ETH and auto-wrap
    receive() external payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }
}

