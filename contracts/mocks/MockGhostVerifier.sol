// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IGhostVerifier.sol";

/**
 * @dev Deterministic verifier used in tests. It lets us pre-register expected
 * proof commitments so that GhostWallet can exercise the full ZK flow.
 */
contract MockGhostVerifier is IGhostVerifier {
    mapping(bytes32 => bool) public lockProofs;
    mapping(bytes32 => bool) public burnProofs;
    mapping(bytes32 => bool) public mintProofs;

    function registerLockProof(bytes32 ghostId, bytes calldata proof) external {
        lockProofs[_key(ghostId, proof)] = true;
    }

    function registerBurnProof(bytes32 ghostId, bytes calldata proof) external {
        burnProofs[_key(ghostId, proof)] = true;
    }

    function registerMintProof(bytes32 ghostId, bytes calldata proof) external {
        mintProofs[_key(ghostId, proof)] = true;
    }

    function verifyLockProof(bytes32 ghostId, bytes calldata proof) external view override returns (bool) {
        return lockProofs[_key(ghostId, proof)];
    }

    function verifyBurnProof(bytes32 ghostId, bytes calldata proof) external view override returns (bool) {
        return burnProofs[_key(ghostId, proof)];
    }

    function verifyMintProof(bytes32 ghostId, bytes calldata proof) external view override returns (bool) {
        return mintProofs[_key(ghostId, proof)];
    }

    function _key(bytes32 ghostId, bytes memory proof) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(ghostId, proof));
    }
}

