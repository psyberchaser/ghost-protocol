// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./GhostWallet.sol";
import "./interfaces/IValidatorRegistry.sol";
import "./interfaces/IWETH.sol";

/**
 * @notice Orchestrates GhostWallet lifecycle with validator multi-sig approvals.
 *         Supports auto-wrapping of native ETH to WETH for seamless bridging.
 */
contract MasterBridge is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Step {
        Lock,
        Burn,
        Mint
    }

    struct StepApproval {
        uint256 approvals;
        bytes payload;
        bool executed;
        mapping(address => bool) voted;
    }

    GhostWallet public ghostWallet;
    IValidatorRegistry public validatorRegistry;
    IWETH public weth;
    
    mapping(address => bool) public localValidators;
    mapping(address => bool) public supportedTokens;
    uint256 public validatorThreshold = 1;

    mapping(bytes32 => StepApproval) private stepApprovals;

    event GhostWalletUpdated(address indexed newWallet);
    event TokenSupportUpdated(address indexed token, bool supported);
    event GhostBridgeInitiated(bytes32 indexed ghostId, address indexed user, address indexed token, uint256 amount);
    event GhostBridgeETH(bytes32 indexed ghostId, address indexed user, uint256 amount);
    event ValidatorRegistryUpdated(address indexed registry);
    event LocalValidatorUpdated(address indexed validator, bool allowed);
    event ValidatorThresholdUpdated(uint256 threshold);
    event LifecycleStepApproved(bytes32 indexed ghostId, Step indexed step, address indexed validator, uint256 approvals);
    event LifecycleStepExecuted(bytes32 indexed ghostId, Step indexed step);
    event WETHUpdated(address indexed weth);

    constructor(address owner_, address ghostWallet_, address weth_) Ownable(owner_) {
        require(ghostWallet_ != address(0), "MasterBridge: wallet missing");
        ghostWallet = GhostWallet(ghostWallet_);
        emit GhostWalletUpdated(ghostWallet_);
        
        if (weth_ != address(0)) {
            weth = IWETH(weth_);
            emit WETHUpdated(weth_);
        }
    }

    function setGhostWallet(address newWallet) external onlyOwner {
        require(newWallet != address(0), "MasterBridge: wallet missing");
        ghostWallet = GhostWallet(newWallet);
        emit GhostWalletUpdated(newWallet);
    }

    function setSupportedToken(address token, bool supported) external onlyOwner {
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    function setValidatorRegistry(address registry) external onlyOwner {
        validatorRegistry = IValidatorRegistry(registry);
        emit ValidatorRegistryUpdated(registry);
    }

    function setLocalValidator(address validator, bool allowed) external onlyOwner {
        localValidators[validator] = allowed;
        emit LocalValidatorUpdated(validator, allowed);
    }

    function setValidatorThreshold(uint256 threshold) external onlyOwner {
        require(threshold > 0, "MasterBridge: threshold=0");
        validatorThreshold = threshold;
        emit ValidatorThresholdUpdated(threshold);
    }

    function setWETH(address weth_) external onlyOwner {
        require(weth_ != address(0), "MasterBridge: weth missing");
        weth = IWETH(weth_);
        emit WETHUpdated(weth_);
    }

    /// @notice Bridge native ETH - auto-wraps to WETH and initiates ghost
    /// @param destinationToken The token to receive on destination chain
    /// @param destinationChainId The destination chain ID
    /// @param destinationAddress The recipient address on destination (raw bytes for non-EVM)
    /// @param evmDestination The recipient address if destination is EVM
    function bridgeETH(
        address destinationToken,
        uint64 destinationChainId,
        bytes calldata destinationAddress,
        address evmDestination
    ) external payable nonReentrant returns (bytes32 ghostId) {
        require(msg.value > 0, "MasterBridge: no ETH sent");
        require(address(weth) != address(0), "MasterBridge: WETH not set");
        require(supportedTokens[address(weth)], "MasterBridge: WETH unsupported");

        // Auto-wrap ETH to WETH
        weth.deposit{value: msg.value}();
        
        // Approve WETH to GhostWallet
        weth.approve(address(ghostWallet), msg.value);

        // Initiate ghost with WETH
        ghostId = ghostWallet.initiateGhost(
            msg.sender,
            address(weth),
            destinationToken,
            destinationChainId,
            destinationAddress,
            evmDestination,
            msg.value,
            bytes32(0)
        );

        emit GhostBridgeETH(ghostId, msg.sender, msg.value);
        emit GhostBridgeInitiated(ghostId, msg.sender, address(weth), msg.value);
    }

    function initiateGhostBridge(
        address sourceToken,
        address destinationToken,
        uint64 destinationChainId,
        bytes calldata destinationAddress,
        address evmDestination,
        uint256 amount,
        bytes32 amountCommitment
    ) external nonReentrant returns (bytes32 ghostId) {
        require(supportedTokens[sourceToken], "MasterBridge: token unsupported");

        IERC20(sourceToken).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(sourceToken).forceApprove(address(ghostWallet), amount);

        ghostId = ghostWallet.initiateGhost(
            msg.sender,
            sourceToken,
            destinationToken,
            destinationChainId,
            destinationAddress,
            evmDestination,
            amount,
            amountCommitment
        );

        emit GhostBridgeInitiated(ghostId, msg.sender, sourceToken, amount);
    }

    function approveStep(bytes32 ghostId, Step step, bytes calldata payload) external {
        require(_isValidator(msg.sender), "MasterBridge: not validator");
        bytes32 stepKey = keccak256(abi.encodePacked(ghostId, step));
        StepApproval storage approval = stepApprovals[stepKey];
        require(!approval.voted[msg.sender], "MasterBridge: already approved");

        if (approval.payload.length == 0) {
            approval.payload = payload;
        } else {
            require(keccak256(approval.payload) == keccak256(payload), "MasterBridge: payload mismatch");
        }

        approval.voted[msg.sender] = true;
        approval.approvals += 1;
        emit LifecycleStepApproved(ghostId, step, msg.sender, approval.approvals);

        if (approval.approvals >= validatorThreshold && !approval.executed) {
            _executeStep(ghostId, step, approval.payload);
            approval.executed = true;
            emit LifecycleStepExecuted(ghostId, step);
            delete stepApprovals[stepKey];
        }
    }

    function _executeStep(bytes32 ghostId, Step step, bytes memory payload) internal {
        if (step == Step.Lock) {
            ghostWallet.lockGhost(ghostId, payload);
        } else if (step == Step.Burn) {
            ghostWallet.burnGhost(ghostId, payload);
        } else {
            (bytes memory proof, address recipient) = abi.decode(payload, (bytes, address));
            ghostWallet.mintGhost(ghostId, proof, recipient);
        }
    }

    function _isValidator(address account) internal view returns (bool) {
        if (localValidators[account]) {
            return true;
        }
        if (address(validatorRegistry) != address(0) && validatorRegistry.isValidator(account)) {
            return true;
        }
        return false;
    }
}

