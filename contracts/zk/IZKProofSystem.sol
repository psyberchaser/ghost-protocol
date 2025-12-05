// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IZKProofSystem {
    function generateSNARKProof(
        bytes32 ghostId,
        uint256 hiddenAmount,
        uint256 salt,
        bytes32 commitment
    ) external returns (bytes32);

    function generateSTARKProof(
        bytes32 ghostId,
        bytes32[] calldata transactionHistory,
        bytes32 stateRoot
    ) external returns (bytes32);

    function assessTrustWithMicroGAN(
        bytes32 proofId,
        address prover,
        bytes32[] calldata behaviorPattern,
        uint256[] calldata historicalScores
    ) external returns (bool);

    function verifySNARKProof(bytes32 proofId) external returns (bool);
    function verifySTARKProof(bytes32 proofId) external returns (bool);
    function verifyHybridProof(bytes32 proofId) external returns (bool);

    function isSNARKVerified(bytes32 proofId) external view returns (bool);
    function isSTARKVerified(bytes32 proofId) external view returns (bool);
    function isHybridVerified(bytes32 proofId) external view returns (bool);

    function getTrustScore(address entity) external view returns (uint256);
    function isCommitmentTrusted(bytes32 commitment) external view returns (bool);
    function updateTrustScore(address entity, uint256 newScore) external;
}

