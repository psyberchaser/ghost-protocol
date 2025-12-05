// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "../interfaces/IGhostToken.sol";

/**
 * @dev Simple mintable/burnable token used for the Ghost Wallet MVP tests.
 * The MasterBridge (or validator multisig) receives MINTER_ROLE/BURNER_ROLE.
 */
contract GhostERC20 is ERC20, AccessControl, IGhostToken {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    constructor(string memory name_, string memory symbol_, address admin) ERC20(name_, symbol_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function mint(address to, uint256 amount) external override onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external override onlyRole(BURNER_ROLE) {
        _burn(from, amount);
    }
}

