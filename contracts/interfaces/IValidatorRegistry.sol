// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IValidatorRegistry {
    function isValidator(address account) external view returns (bool);
}

