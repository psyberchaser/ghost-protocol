// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IGhostToken.sol";
import "./interfaces/IGhostVerifier.sol";
import "./interfaces/IValidatorRegistry.sol";

/**
 * @title GhostWallet (MVP)
 * @notice Minimal implementation of the Ghost Wallet lifecycle:
 *         user deposit -> lock -> burn -> mint -> settle.
 *         The contract stays opinionated about ERC20 custody while keeping
 *         hooks for external ZK proof systems through IGhostVerifier.
 */
contract GhostWallet is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum GhostState {
        None,
        Created,
        Locked,
        Burned,
        Minted,
        Settled
    }

    struct GhostTransaction {
        address initiator;
        address sourceToken;
        address destinationToken;
        uint64 sourceChainId;
        uint64 destinationChainId;
        bytes destinationAddress; // raw address for non-EVM targets
        address evmDestination;   // optional direct mint target
        uint256 amount;
        bytes32 amountCommitment;
        GhostState state;
        bool isRemote;
        bool remoteAck;
        uint64 createdAt;
        uint64 lockedAt;
        uint64 burnedAt;
        uint64 mintedAt;
        bytes32 lockProof;
        bytes32 burnProof;
        bytes32 mintProof;
    }

    uint256 public constant GHOST_TIMEOUT = 1 hours;
    uint256 public constant ATOMIC_WINDOW = 5 minutes;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IGhostVerifier public verifier;
    IValidatorRegistry public validatorRegistry;
    uint256 private ghostNonce;

    mapping(bytes32 => GhostTransaction) private ghosts;
    mapping(address => bool) public localValidators;

    event GhostInitiated(bytes32 indexed ghostId, address indexed initiator, address indexed token, uint256 amount);
    event GhostLocked(bytes32 indexed ghostId, bytes32 proofHash);
    event GhostBurned(bytes32 indexed ghostId, bytes32 proofHash);
    event GhostMinted(bytes32 indexed ghostId, address recipient, bytes32 proofHash);
    event GhostSettled(bytes32 indexed ghostId);
    event GhostReclaimed(bytes32 indexed ghostId);
    event ValidatorRegistryUpdated(address indexed registry);
    event LocalValidatorUpdated(address indexed validator, bool allowed);
    event VerifierUpdated(address indexed verifier);
    event GhostMirrored(bytes32 indexed ghostId, uint64 indexed sourceChainId, address indexed destinationToken);
    event RemoteMintAcknowledged(bytes32 indexed ghostId);

    modifier onlyValidator() {
        require(_isValidator(msg.sender), "GhostWallet: not validator");
        _;
    }

    modifier ghostExists(bytes32 ghostId) {
        require(ghosts[ghostId].state != GhostState.None, "GhostWallet: ghost missing");
        _;
    }

    modifier notExpired(bytes32 ghostId) {
        GhostTransaction storage ghost = ghosts[ghostId];
        uint256 referenceTime = ghost.isRemote ? ghost.burnedAt : ghost.createdAt;
        require(block.timestamp <= referenceTime + GHOST_TIMEOUT, "GhostWallet: timeout");
        _;
    }

    constructor(address owner_, address verifier_, address validatorRegistry_) Ownable(owner_) {
        if (verifier_ != address(0)) {
            verifier = IGhostVerifier(verifier_);
            emit VerifierUpdated(verifier_);
        }
        if (validatorRegistry_ != address(0)) {
            validatorRegistry = IValidatorRegistry(validatorRegistry_);
            emit ValidatorRegistryUpdated(validatorRegistry_);
        }
    }

    // --- admin ---

    function setVerifier(address newVerifier) external onlyOwner {
        verifier = IGhostVerifier(newVerifier);
        emit VerifierUpdated(newVerifier);
    }

    function setValidatorRegistry(address registry) external onlyOwner {
        validatorRegistry = IValidatorRegistry(registry);
        emit ValidatorRegistryUpdated(registry);
    }

    function setLocalValidator(address validator, bool allowed) external onlyOwner {
        localValidators[validator] = allowed;
        emit LocalValidatorUpdated(validator, allowed);
    }

    // --- lifecycle ---

    function initiateGhost(
        address initiator,
        address sourceToken,
        address destinationToken,
        uint64 destinationChainId,
        bytes calldata destinationAddress,
        address evmDestination,
        uint256 amount,
        bytes32 amountCommitment
    ) external nonReentrant returns (bytes32 ghostId) {
        address actualInitiator = initiator == address(0) ? msg.sender : initiator;
        require(actualInitiator != address(0), "GhostWallet: initiator missing");
        require(sourceToken != address(0), "GhostWallet: invalid source");
        require(destinationToken != address(0), "GhostWallet: invalid destination token");
        require(amount > 0, "GhostWallet: amount=0");
        require(destinationAddress.length > 0 || evmDestination != address(0), "GhostWallet: destination missing");

        IERC20(sourceToken).safeTransferFrom(msg.sender, address(this), amount);

        ghostId = keccak256(
            abi.encodePacked(
                ++ghostNonce,
                block.chainid,
                block.timestamp,
                actualInitiator,
                sourceToken,
                destinationToken,
                destinationChainId,
                destinationAddress,
                evmDestination,
                amount,
                amountCommitment
            )
        );

        ghosts[ghostId] = GhostTransaction({
            initiator: actualInitiator,
            sourceToken: sourceToken,
            destinationToken: destinationToken,
            sourceChainId: uint64(block.chainid),
            destinationChainId: destinationChainId,
            destinationAddress: destinationAddress,
            evmDestination: evmDestination,
            amount: amount,
            amountCommitment: amountCommitment,
            state: GhostState.Created,
            isRemote: false,
            remoteAck: false,
            createdAt: uint64(block.timestamp),
            lockedAt: 0,
            burnedAt: 0,
            mintedAt: 0,
            lockProof: bytes32(0),
            burnProof: bytes32(0),
            mintProof: bytes32(0)
        });

        emit GhostInitiated(ghostId, actualInitiator, sourceToken, amount);
    }

    function mirrorGhost(
        bytes32 ghostId,
        address sourceToken,
        address destinationToken,
        uint64 sourceChainId,
        uint64 destinationChainId,
        bytes calldata destinationAddress,
        address evmDestination,
        uint256 amount,
        bytes32 burnProof,
        uint64 burnTimestamp
    ) external onlyValidator returns (bytes32) {
        require(ghosts[ghostId].state == GhostState.None, "GhostWallet: ghost exists");
        require(destinationChainId == block.chainid, "GhostWallet: wrong destination");

        ghosts[ghostId] = GhostTransaction({
            initiator: address(0),
            sourceToken: sourceToken,
            destinationToken: destinationToken,
            sourceChainId: sourceChainId,
            destinationChainId: destinationChainId,
            destinationAddress: destinationAddress,
            evmDestination: evmDestination,
            amount: amount,
            amountCommitment: bytes32(0),
            state: GhostState.Burned,
            isRemote: true,
            remoteAck: false,
            createdAt: burnTimestamp,
            lockedAt: burnTimestamp,
            burnedAt: burnTimestamp,
            mintedAt: 0,
            lockProof: bytes32(0),
            burnProof: burnProof,
            mintProof: bytes32(0)
        });

        emit GhostMirrored(ghostId, sourceChainId, destinationToken);
        return ghostId;
    }

    function lockGhost(bytes32 ghostId, bytes calldata proof) external onlyValidator ghostExists(ghostId) notExpired(ghostId) {
        GhostTransaction storage ghost = ghosts[ghostId];
        require(ghost.state == GhostState.Created, "GhostWallet: not created");
        _verifyLock(ghostId, proof);

        ghost.state = GhostState.Locked;
        ghost.lockedAt = uint64(block.timestamp);
        ghost.lockProof = keccak256(proof);

        emit GhostLocked(ghostId, ghost.lockProof);
    }

    function burnGhost(bytes32 ghostId, bytes calldata proof) external onlyValidator ghostExists(ghostId) notExpired(ghostId) {
        GhostTransaction storage ghost = ghosts[ghostId];
        require(ghost.state == GhostState.Locked, "GhostWallet: not locked");
        _verifyBurn(ghostId, proof);

        IERC20(ghost.sourceToken).safeTransfer(BURN_ADDRESS, ghost.amount);

        ghost.state = GhostState.Burned;
        ghost.burnedAt = uint64(block.timestamp);
        ghost.remoteAck = false;
        ghost.burnProof = keccak256(proof);

        emit GhostBurned(ghostId, ghost.burnProof);
    }

    function mintGhost(bytes32 ghostId, bytes calldata proof, address recipient)
        external
        onlyValidator
        ghostExists(ghostId)
        notExpired(ghostId)
    {
        GhostTransaction storage ghost = ghosts[ghostId];
        require(ghost.state == GhostState.Burned, "GhostWallet: not burned");
        require(block.timestamp <= ghost.burnedAt + ATOMIC_WINDOW, "GhostWallet: atomic window");
        _verifyMint(ghostId, proof);

        address target = ghost.evmDestination != address(0) ? ghost.evmDestination : recipient;
        require(target != address(0), "GhostWallet: recipient missing");

        IGhostToken(ghost.destinationToken).mint(target, ghost.amount);

        ghost.state = GhostState.Minted;
        ghost.mintedAt = uint64(block.timestamp);
        ghost.mintProof = keccak256(proof);

        emit GhostMinted(ghostId, target, ghost.mintProof);
    }

    function settleGhost(bytes32 ghostId) external onlyValidator ghostExists(ghostId) {
        GhostTransaction storage ghost = ghosts[ghostId];
        uint256 timeRef = ghost.isRemote ? ghost.burnedAt : ghost.createdAt;
        bool finished = ghost.state == GhostState.Minted || (ghost.state == GhostState.Burned && ghost.remoteAck);
        require(finished || block.timestamp > timeRef + GHOST_TIMEOUT, "GhostWallet: cannot settle");

        ghost.state = GhostState.Settled;
        emit GhostSettled(ghostId);
        delete ghosts[ghostId];
    }

    function confirmRemoteMint(bytes32 ghostId) external onlyValidator ghostExists(ghostId) {
        GhostTransaction storage ghost = ghosts[ghostId];
        require(!ghost.isRemote, "GhostWallet: remote ghost");
        require(ghost.state == GhostState.Burned, "GhostWallet: not burned");
        ghost.remoteAck = true;
        emit RemoteMintAcknowledged(ghostId);
    }

    function reclaimExpired(bytes32 ghostId) external onlyValidator ghostExists(ghostId) {
        GhostTransaction storage ghost = ghosts[ghostId];
        require(
            ghost.state == GhostState.Created || ghost.state == GhostState.Locked,
            "GhostWallet: reclaim invalid"
        );
        require(!ghost.isRemote, "GhostWallet: remote ghost");
        require(block.timestamp > ghost.createdAt + GHOST_TIMEOUT, "GhostWallet: still active");

        ghost.state = GhostState.Settled;
        IERC20(ghost.sourceToken).safeTransfer(ghost.initiator, ghost.amount);
        emit GhostReclaimed(ghostId);
        delete ghosts[ghostId];
    }

    // --- view helpers ---

    function getGhost(bytes32 ghostId) external view returns (GhostTransaction memory) {
        return ghosts[ghostId];
    }

    function _verifyLock(bytes32 ghostId, bytes calldata proof) private view {
        if (address(verifier) == address(0)) return;
        require(verifier.verifyLockProof(ghostId, proof), "GhostWallet: invalid lock proof");
    }

    function _verifyBurn(bytes32 ghostId, bytes calldata proof) private view {
        if (address(verifier) == address(0)) return;
        require(verifier.verifyBurnProof(ghostId, proof), "GhostWallet: invalid burn proof");
    }

    function _verifyMint(bytes32 ghostId, bytes calldata proof) private view {
        if (address(verifier) == address(0)) return;
        require(verifier.verifyMintProof(ghostId, proof), "GhostWallet: invalid mint proof");
    }

    function _isValidator(address account) private view returns (bool) {
        if (localValidators[account]) return true;
        if (address(validatorRegistry) != address(0) && validatorRegistry.isValidator(account)) return true;
        return false;
    }
}

