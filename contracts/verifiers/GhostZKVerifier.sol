// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IGhostVerifier.sol";
import "../interfaces/IValidatorRegistry.sol";
import "../zk/IZKProofSystem.sol";

contract GhostZKVerifier is IGhostVerifier, Ownable {
    enum Stage {
        Lock,
        Burn,
        Mint
    }

    IZKProofSystem public immutable zkProofSystem;
    IValidatorRegistry public validatorRegistry;
    mapping(address => bool) public localValidators;
    mapping(bytes32 => mapping(Stage => bytes)) public ghostProofPayload;

    event ProofBound(bytes32 indexed ghostId, Stage indexed stage, bytes32 proofId);
    event ValidatorRegistryUpdated(address indexed registry);
    event LocalValidatorUpdated(address indexed validator, bool allowed);

    constructor(address owner_, address zkProofSystem_) Ownable(owner_) {
        require(zkProofSystem_ != address(0), "Verifier: zk system missing");
        zkProofSystem = IZKProofSystem(zkProofSystem_);
    }

    modifier onlyValidator() {
        require(_isValidator(msg.sender), "Verifier: not validator");
        _;
    }

    function setValidatorRegistry(address registry) external onlyOwner {
        validatorRegistry = IValidatorRegistry(registry);
        emit ValidatorRegistryUpdated(registry);
    }

    function setLocalValidator(address validator, bool allowed) external onlyOwner {
        localValidators[validator] = allowed;
        emit LocalValidatorUpdated(validator, allowed);
    }

    function bindProof(bytes32 ghostId, Stage stage, bytes calldata payload) external onlyValidator {
        if (stage == Stage.Lock) {
            bytes32 proofId = abi.decode(payload, (bytes32));
            if (!zkProofSystem.isSNARKVerified(proofId)) {
                require(zkProofSystem.verifySNARKProof(proofId), "Verifier: SNARK invalid");
            }
            ghostProofPayload[ghostId][stage] = payload;
            emit ProofBound(ghostId, stage, proofId);
        } else if (stage == Stage.Burn) {
            bytes32 proofId = abi.decode(payload, (bytes32));
            if (!zkProofSystem.isSTARKVerified(proofId)) {
                require(zkProofSystem.verifySTARKProof(proofId), "Verifier: STARK invalid");
            }
            ghostProofPayload[ghostId][stage] = payload;
            emit ProofBound(ghostId, stage, proofId);
        } else {
            (bytes32 snarkProofId, bytes32 starkProofId) = abi.decode(payload, (bytes32, bytes32));
            require(zkProofSystem.isSNARKVerified(snarkProofId), "Verifier: SNARK missing");
            require(zkProofSystem.isSTARKVerified(starkProofId), "Verifier: STARK missing");
            ghostProofPayload[ghostId][stage] = payload;
            emit ProofBound(ghostId, stage, snarkProofId);
        }
    }

    function verifyLockProof(bytes32 ghostId, bytes calldata proof) external view override returns (bool) {
        bytes memory stored = ghostProofPayload[ghostId][Stage.Lock];
        if (stored.length == 0 || keccak256(stored) != keccak256(proof)) {
            return false;
        }
        bytes32 proofId = abi.decode(proof, (bytes32));
        return zkProofSystem.isSNARKVerified(proofId);
    }

    function verifyBurnProof(bytes32 ghostId, bytes calldata proof) external view override returns (bool) {
        bytes memory stored = ghostProofPayload[ghostId][Stage.Burn];
        if (stored.length == 0 || keccak256(stored) != keccak256(proof)) {
            return false;
        }
        bytes32 proofId = abi.decode(proof, (bytes32));
        return zkProofSystem.isSTARKVerified(proofId);
    }

    function verifyMintProof(bytes32 ghostId, bytes calldata proof) external view override returns (bool) {
        bytes memory stored = ghostProofPayload[ghostId][Stage.Mint];
        if (stored.length == 0 || keccak256(stored) != keccak256(proof)) {
            return false;
        }
        (bytes32 snarkProofId, bytes32 starkProofId) = abi.decode(proof, (bytes32, bytes32));
        return zkProofSystem.isSNARKVerified(snarkProofId) && zkProofSystem.isSTARKVerified(starkProofId);
    }

    function _isValidator(address account) private view returns (bool) {
        if (localValidators[account]) return true;
        if (address(validatorRegistry) != address(0) && validatorRegistry.isValidator(account)) return true;
        return false;
    }
}

