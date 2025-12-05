// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IValidatorRegistry.sol";

/**
 * @notice GrailX-inspired validator staking + slashing with active set tracking.
 *         Acts as the canonical validator registry for the Ghost MVP.
 */
contract ValidatorSlashing is AccessControl, ReentrancyGuard, IValidatorRegistry {
    bytes32 public constant VALIDATOR_ROLE = keccak256("VALIDATOR_ROLE");
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

    struct Validator {
        uint256 stake;
        uint256 reputation;
        uint256 slashCount;
        uint256 lastSlashTime;
        bool isActive;
        uint256 joinTime;
        uint256 totalRewards;
        uint256 totalSlashed;
    }

    struct SlashEvent {
        address validator;
        uint256 amount;
        string reason;
        uint256 timestamp;
        address slasher;
        bool appealed;
        bool resolved;
    }

    IERC20 public immutable stakingToken;

    uint256 public minimumStake = 1_000 ether;
    uint256 public maximumSlashPercent = 30;
    uint256 public slashCooldown = 7 days;
    uint256 public totalRewardPool;
    uint256 public rewardDistributionInterval = 1 days;
    uint256 public lastRewardDistribution;

    uint256 public slashEventCounter;
    uint256 public aggregateStake;

    mapping(address => Validator) public validators;
    mapping(uint256 => SlashEvent) public slashEvents;
    mapping(address => uint256[]) public validatorSlashHistory;

    address[] private activeValidators;
    mapping(address => uint256) private activeIndex; // index + 1

    event ValidatorJoined(address indexed validator, uint256 stake);
    event ValidatorExited(address indexed validator, uint256 returnedStake);
    event ValidatorSlashed(address indexed validator, uint256 amount, string reason, uint256 eventId);
    event StakeIncreased(address indexed validator, uint256 amount);
    event RewardsDistributed(uint256 totalAmount, uint256 validatorCount);
    event SlashAppealed(uint256 indexed eventId, address indexed validator);

    constructor(address stakingToken_) {
        stakingToken = IERC20(stakingToken_);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(SLASHER_ROLE, msg.sender);
        lastRewardDistribution = block.timestamp;
    }

    modifier validatorExists(address validator) {
        require(validators[validator].stake > 0, "Validator missing");
        _;
    }

    function isValidator(address account) public view override returns (bool) {
        return validators[account].isActive;
    }

    function joinAsValidator(uint256 stakeAmount) external nonReentrant {
        require(stakeAmount >= minimumStake, "Stake too low");
        require(!validators[msg.sender].isActive, "Already validator");

        require(stakingToken.transferFrom(msg.sender, address(this), stakeAmount), "Transfer failed");

        validators[msg.sender] = Validator({
            stake: stakeAmount,
            reputation: 100,
            slashCount: 0,
            lastSlashTime: 0,
            isActive: true,
            joinTime: block.timestamp,
            totalRewards: 0,
            totalSlashed: 0
        });

        _addActiveValidator(msg.sender);
        aggregateStake += stakeAmount;

        _grantRole(VALIDATOR_ROLE, msg.sender);
        emit ValidatorJoined(msg.sender, stakeAmount);
    }

    function increaseStake(uint256 amount) external nonReentrant validatorExists(msg.sender) {
        require(amount > 0, "Amount=0");
        require(stakingToken.transferFrom(msg.sender, address(this), amount), "Transfer failed");

        validators[msg.sender].stake += amount;
        aggregateStake += amount;

        emit StakeIncreased(msg.sender, amount);
    }

    function exitValidator() external nonReentrant validatorExists(msg.sender) {
        Validator storage val = validators[msg.sender];
        require(val.isActive, "Inactive");

        uint256 toReturn = val.stake;
        val.isActive = false;
        val.stake = 0;

        _removeActiveValidator(msg.sender);
        aggregateStake -= toReturn;

        _revokeRole(VALIDATOR_ROLE, msg.sender);
        require(stakingToken.transfer(msg.sender, toReturn), "Return failed");

        emit ValidatorExited(msg.sender, toReturn);
    }

    function slashValidator(address validator, uint256 slashPercent, string calldata reason)
        external
        onlyRole(SLASHER_ROLE)
        validatorExists(validator)
    {
        require(slashPercent <= maximumSlashPercent, "Slash too high");
        require(block.timestamp >= validators[validator].lastSlashTime + slashCooldown, "Cooldown");

        Validator storage val = validators[validator];
        uint256 slashAmount = (val.stake * slashPercent) / 100;

        val.stake -= slashAmount;
        aggregateStake -= slashAmount;
        val.slashCount += 1;
        val.lastSlashTime = block.timestamp;
        val.reputation = val.reputation > 20 ? val.reputation - 20 : 0;
        val.totalSlashed += slashAmount;

        if (val.stake < minimumStake) {
            val.isActive = false;
            _revokeRole(VALIDATOR_ROLE, validator);
            _removeActiveValidator(validator);
        }

        uint256 eventId = ++slashEventCounter;
        slashEvents[eventId] = SlashEvent({
            validator: validator,
            amount: slashAmount,
            reason: reason,
            timestamp: block.timestamp,
            slasher: msg.sender,
            appealed: false,
            resolved: false
        });
        validatorSlashHistory[validator].push(eventId);

        totalRewardPool += slashAmount / 2;
        emit ValidatorSlashed(validator, slashAmount, reason, eventId);
    }

    function appealSlash(uint256 eventId) external {
        SlashEvent storage slashEvent = slashEvents[eventId];
        require(slashEvent.validator == msg.sender, "Not your event");
        require(!slashEvent.appealed, "Appealed");
        require(!slashEvent.resolved, "Resolved");
        require(block.timestamp <= slashEvent.timestamp + 7 days, "Expired");

        slashEvent.appealed = true;
        emit SlashAppealed(eventId, msg.sender);
    }

    function distributeRewards() external {
        require(block.timestamp >= lastRewardDistribution + rewardDistributionInterval, "Too soon");
        require(totalRewardPool > 0, "No rewards");

        uint256 count = activeValidators.length;
        require(count > 0, "No validators");

        uint256 rewards = totalRewardPool;
        totalRewardPool = 0;

        for (uint256 i = 0; i < count; i++) {
            address validator = activeValidators[i];
            Validator storage val = validators[validator];
            uint256 stakeWeight = (val.stake * 1e18) / aggregateStake;
            uint256 reputationBonus = val.reputation > 80 ? 110 : 100;
            uint256 reward = (rewards * stakeWeight * reputationBonus) / (1e18 * 100);
            val.totalRewards += reward;
            require(stakingToken.transfer(validator, reward), "Reward transfer failed");
        }

        lastRewardDistribution = block.timestamp;
        emit RewardsDistributed(rewards, count);
    }

    function getActiveValidators() external view returns (address[] memory) {
        return activeValidators;
    }

    function getValidatorInfo(address validator)
        external
        view
        returns (
            uint256 stake,
            uint256 reputation,
            uint256 slashCount,
            bool isActive,
            uint256 totalRewards,
            uint256 totalSlashed
        )
    {
        Validator storage val = validators[validator];
        return (val.stake, val.reputation, val.slashCount, val.isActive, val.totalRewards, val.totalSlashed);
    }

    function getSlashHistory(address validator) external view returns (uint256[] memory) {
        return validatorSlashHistory[validator];
    }

    function _addActiveValidator(address validator) private {
        activeIndex[validator] = activeValidators.length + 1;
        activeValidators.push(validator);
    }

    function _removeActiveValidator(address validator) private {
        uint256 idxPlusOne = activeIndex[validator];
        if (idxPlusOne == 0) return;
        uint256 idx = idxPlusOne - 1;
        uint256 lastIdx = activeValidators.length - 1;

        if (idx != lastIdx) {
            address lastVal = activeValidators[lastIdx];
            activeValidators[idx] = lastVal;
            activeIndex[lastVal] = idx + 1;
        }

        activeValidators.pop();
        activeIndex[validator] = 0;
    }
}

