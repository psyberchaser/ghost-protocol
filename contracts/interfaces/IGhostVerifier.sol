// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev Minimal interface abstracting the ZK system we plug into the MVP.
 * Contracts can swap this verifier without touching the GhostWallet logic.
 */
interface IGhostVerifier {
    function verifyLockProof(bytes32 ghostId, bytes calldata proof) external view returns (bool);
    function verifyBurnProof(bytes32 ghostId, bytes calldata proof) external view returns (bool);
    function verifyMintProof(bytes32 ghostId, bytes calldata proof) external view returns (bool);
}

