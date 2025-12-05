// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title GhostLiquidityPool
 * @notice Liquidity pool for instant cross-chain payments
 * @dev LPs deposit funds, users get instant cross-chain transfers
 * 
 * How it works:
 * 1. LPs deposit ETH/tokens into the pool, receive LP shares
 * 2. User wants to pay X on Chain A, receive Y on Chain B
 * 3. User's funds go INTO this pool on Chain A
 * 4. Relayer instantly sends from pool on Chain B
 * 5. ZK proof settles the accounting
 * 6. LPs earn fees from each transaction
 */
contract GhostLiquidityPool is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    struct Pool {
        uint256 totalDeposited;      // Total amount in pool
        uint256 totalShares;         // Total LP shares issued
        uint256 totalFees;           // Accumulated fees for LPs
        uint256 availableLiquidity;  // Currently available (not locked)
        bool active;                 // Pool is accepting deposits
    }

    struct LPPosition {
        uint256 shares;              // LP's share of the pool
        uint256 depositedAt;         // Timestamp of deposit
    }

    struct PaymentIntent {
        bytes32 id;                  // Unique intent ID
        address sender;              // Who is paying
        address token;               // Token being paid (address(0) = ETH)
        uint256 amount;              // Amount being paid
        uint256 destChainId;         // Destination chain
        bytes destAddress;           // Recipient on destination
        bytes destToken;             // Token to receive on destination
        uint256 minDestAmount;       // Minimum amount to receive
        uint256 deadline;            // Expiry timestamp
        bool executed;               // Has been processed
        bool refunded;               // Has been refunded
    }

    struct ZKProofInfo {
        bytes32 snarkProofId;        // SNARK proof for source chain deposit
        bytes32 starkProofId;        // STARK proof for destination transfer
        bool snarkVerified;          // SNARK proof verified on-chain
        bool starkVerified;          // STARK proof verified on-chain
        uint256 verifiedAt;          // Timestamp of verification
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    // Pool for each token (address(0) = ETH)
    mapping(address => Pool) public pools;
    
    // LP positions: token => user => position
    mapping(address => mapping(address => LPPosition)) public lpPositions;
    
    // Payment intents: intentId => intent
    mapping(bytes32 => PaymentIntent) public intents;
    
    // ZK proofs: intentId => proof info
    mapping(bytes32 => ZKProofInfo) public zkProofs;
    
    // Authorized relayers who can execute payments
    mapping(address => bool) public relayers;
    
    // Protocol fee (basis points, 100 = 1%)
    uint256 public protocolFeeBps = 10; // 0.1%
    
    // LP fee (basis points)
    uint256 public lpFeeBps = 20; // 0.2%
    
    // Price oracle (simplified - in production use Chainlink)
    mapping(address => uint256) public tokenPricesUSD; // 8 decimals
    
    // Protocol fee recipient
    address public feeRecipient;
    
    // Chain ID for cross-chain identification
    uint256 public immutable chainId;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event PoolCreated(address indexed token);
    event LiquidityDeposited(address indexed token, address indexed provider, uint256 amount, uint256 shares);
    event LiquidityWithdrawn(address indexed token, address indexed provider, uint256 amount, uint256 shares);
    event PaymentIntentCreated(bytes32 indexed intentId, address indexed sender, uint256 amount, uint256 destChainId);
    event PaymentExecuted(bytes32 indexed intentId, address indexed relayer);
    event PaymentRefunded(bytes32 indexed intentId);
    event CrossChainReceived(bytes32 indexed intentId, address indexed recipient, uint256 amount);
    event RelayerUpdated(address indexed relayer, bool active);
    event PriceUpdated(address indexed token, uint256 price);
    
    // ZK Proof events
    event SNARKProofSubmitted(bytes32 indexed intentId, bytes32 proofId);
    event STARKProofSubmitted(bytes32 indexed intentId, bytes32 proofId);
    event ZKProofVerified(bytes32 indexed intentId, bool snarkValid, bool starkValid);

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor() Ownable(msg.sender) {
        chainId = block.chainid;
        feeRecipient = msg.sender;
        
        // Initialize ETH pool
        pools[address(0)] = Pool({
            totalDeposited: 0,
            totalShares: 0,
            totalFees: 0,
            availableLiquidity: 0,
            active: true
        });
        
        emit PoolCreated(address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // LIQUIDITY PROVIDER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit ETH into the pool
     * @return shares Amount of LP shares received
     */
    function depositETH() external payable nonReentrant returns (uint256 shares) {
        require(msg.value > 0, "Zero deposit");
        require(pools[address(0)].active, "Pool not active");
        
        Pool storage pool = pools[address(0)];
        
        // Calculate shares
        if (pool.totalShares == 0) {
            shares = msg.value;
        } else {
            shares = (msg.value * pool.totalShares) / pool.totalDeposited;
        }
        
        // Update pool
        pool.totalDeposited += msg.value;
        pool.totalShares += shares;
        pool.availableLiquidity += msg.value;
        
        // Update LP position
        lpPositions[address(0)][msg.sender].shares += shares;
        lpPositions[address(0)][msg.sender].depositedAt = block.timestamp;
        
        emit LiquidityDeposited(address(0), msg.sender, msg.value, shares);
    }

    /**
     * @notice Deposit ERC20 tokens into the pool
     * @param token Token address
     * @param amount Amount to deposit
     * @return shares Amount of LP shares received
     */
    function depositToken(address token, uint256 amount) external nonReentrant returns (uint256 shares) {
        require(amount > 0, "Zero deposit");
        require(token != address(0), "Use depositETH for ETH");
        
        // Create pool if doesn't exist
        if (!pools[token].active) {
            pools[token] = Pool({
                totalDeposited: 0,
                totalShares: 0,
                totalFees: 0,
                availableLiquidity: 0,
                active: true
            });
            emit PoolCreated(token);
        }
        
        Pool storage pool = pools[token];
        
        // Transfer tokens
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        
        // Calculate shares
        if (pool.totalShares == 0) {
            shares = amount;
        } else {
            shares = (amount * pool.totalShares) / pool.totalDeposited;
        }
        
        // Update pool
        pool.totalDeposited += amount;
        pool.totalShares += shares;
        pool.availableLiquidity += amount;
        
        // Update LP position
        lpPositions[token][msg.sender].shares += shares;
        lpPositions[token][msg.sender].depositedAt = block.timestamp;
        
        emit LiquidityDeposited(token, msg.sender, amount, shares);
    }

    /**
     * @notice Withdraw ETH from the pool
     * @param shares Amount of LP shares to redeem
     * @return amount Amount of ETH withdrawn
     */
    function withdrawETH(uint256 shares) external nonReentrant returns (uint256 amount) {
        require(shares > 0, "Zero shares");
        
        LPPosition storage position = lpPositions[address(0)][msg.sender];
        require(position.shares >= shares, "Insufficient shares");
        
        Pool storage pool = pools[address(0)];
        
        // Calculate amount including earned fees
        amount = (shares * pool.totalDeposited) / pool.totalShares;
        require(pool.availableLiquidity >= amount, "Insufficient liquidity");
        
        // Update pool
        pool.totalDeposited -= amount;
        pool.totalShares -= shares;
        pool.availableLiquidity -= amount;
        
        // Update LP position
        position.shares -= shares;
        
        // Transfer ETH
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "ETH transfer failed");
        
        emit LiquidityWithdrawn(address(0), msg.sender, amount, shares);
    }

    /**
     * @notice Withdraw tokens from the pool
     * @param token Token address
     * @param shares Amount of LP shares to redeem
     * @return amount Amount of tokens withdrawn
     */
    function withdrawToken(address token, uint256 shares) external nonReentrant returns (uint256 amount) {
        require(shares > 0, "Zero shares");
        require(token != address(0), "Use withdrawETH for ETH");
        
        LPPosition storage position = lpPositions[token][msg.sender];
        require(position.shares >= shares, "Insufficient shares");
        
        Pool storage pool = pools[token];
        
        // Calculate amount including earned fees
        amount = (shares * pool.totalDeposited) / pool.totalShares;
        require(pool.availableLiquidity >= amount, "Insufficient liquidity");
        
        // Update pool
        pool.totalDeposited -= amount;
        pool.totalShares -= shares;
        pool.availableLiquidity -= amount;
        
        // Update LP position
        position.shares -= shares;
        
        // Transfer tokens
        IERC20(token).safeTransfer(msg.sender, amount);
        
        emit LiquidityWithdrawn(token, msg.sender, amount, shares);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PAYMENT FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Create a cross-chain payment intent with ETH
     * @param destChainId Destination chain ID
     * @param destAddress Recipient address on destination chain
     * @param destToken Token to receive on destination (encoded)
     * @param minDestAmount Minimum amount to receive
     * @param deadline Expiry timestamp
     * @return intentId The payment intent ID
     */
    function payWithETH(
        uint256 destChainId,
        bytes calldata destAddress,
        bytes calldata destToken,
        uint256 minDestAmount,
        uint256 deadline
    ) external payable nonReentrant returns (bytes32 intentId) {
        require(msg.value > 0, "Zero payment");
        require(deadline > block.timestamp, "Invalid deadline");
        require(destAddress.length > 0, "Invalid destination");
        
        // Generate intent ID
        intentId = keccak256(abi.encodePacked(
            msg.sender,
            address(0),
            msg.value,
            destChainId,
            destAddress,
            block.timestamp,
            block.number
        ));
        
        require(intents[intentId].sender == address(0), "Intent exists");
        
        // Calculate fees
        uint256 totalFee = (msg.value * (protocolFeeBps + lpFeeBps)) / 10000;
        uint256 protocolFee = (msg.value * protocolFeeBps) / 10000;
        uint256 lpFee = totalFee - protocolFee;
        uint256 netAmount = msg.value - totalFee;
        
        // Store intent
        intents[intentId] = PaymentIntent({
            id: intentId,
            sender: msg.sender,
            token: address(0),
            amount: netAmount,
            destChainId: destChainId,
            destAddress: destAddress,
            destToken: destToken,
            minDestAmount: minDestAmount,
            deadline: deadline,
            executed: false,
            refunded: false
        });
        
        // Add to pool (fees go to LPs and protocol)
        Pool storage pool = pools[address(0)];
        pool.totalDeposited += lpFee;
        pool.availableLiquidity += netAmount;
        pool.totalFees += lpFee;
        
        // Send protocol fee
        if (protocolFee > 0) {
            (bool success, ) = payable(feeRecipient).call{value: protocolFee}("");
            require(success, "Protocol fee transfer failed");
        }
        
        emit PaymentIntentCreated(intentId, msg.sender, msg.value, destChainId);
    }

    /**
     * @notice Create a cross-chain payment intent with ERC20
     */
    function payWithToken(
        address token,
        uint256 amount,
        uint256 destChainId,
        bytes calldata destAddress,
        bytes calldata destToken,
        uint256 minDestAmount,
        uint256 deadline
    ) external nonReentrant returns (bytes32 intentId) {
        require(amount > 0, "Zero payment");
        require(token != address(0), "Use payWithETH for ETH");
        require(deadline > block.timestamp, "Invalid deadline");
        require(destAddress.length > 0, "Invalid destination");
        
        // Transfer tokens
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        
        // Generate intent ID
        intentId = keccak256(abi.encodePacked(
            msg.sender,
            token,
            amount,
            destChainId,
            destAddress,
            block.timestamp,
            block.number
        ));
        
        require(intents[intentId].sender == address(0), "Intent exists");
        
        // Calculate fees
        uint256 totalFee = (amount * (protocolFeeBps + lpFeeBps)) / 10000;
        uint256 protocolFee = (amount * protocolFeeBps) / 10000;
        uint256 lpFee = totalFee - protocolFee;
        uint256 netAmount = amount - totalFee;
        
        // Store intent
        intents[intentId] = PaymentIntent({
            id: intentId,
            sender: msg.sender,
            token: token,
            amount: netAmount,
            destChainId: destChainId,
            destAddress: destAddress,
            destToken: destToken,
            minDestAmount: minDestAmount,
            deadline: deadline,
            executed: false,
            refunded: false
        });
        
        // Ensure pool exists
        if (!pools[token].active) {
            pools[token] = Pool({
                totalDeposited: 0,
                totalShares: 0,
                totalFees: 0,
                availableLiquidity: 0,
                active: true
            });
            emit PoolCreated(token);
        }
        
        // Add to pool
        Pool storage pool = pools[token];
        pool.totalDeposited += lpFee;
        pool.availableLiquidity += netAmount;
        pool.totalFees += lpFee;
        
        // Send protocol fee
        if (protocolFee > 0) {
            IERC20(token).safeTransfer(feeRecipient, protocolFee);
        }
        
        emit PaymentIntentCreated(intentId, msg.sender, amount, destChainId);
    }

    /**
     * @notice Execute incoming cross-chain payment (called by relayer)
     * @dev Sends funds from pool to recipient on THIS chain
     * @param intentId The payment intent ID from source chain
     * @param recipient Recipient address
     * @param token Token to send (address(0) = ETH)
     * @param amount Amount to send
     */
    function executePayment(
        bytes32 intentId,
        address recipient,
        address token,
        uint256 amount
    ) external nonReentrant {
        require(relayers[msg.sender], "Not authorized relayer");
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Zero amount");
        
        Pool storage pool = pools[token];
        require(pool.availableLiquidity >= amount, "Insufficient pool liquidity");
        
        // Deduct from pool
        pool.availableLiquidity -= amount;
        
        // Send funds
        if (token == address(0)) {
            (bool success, ) = payable(recipient).call{value: amount}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }
        
        emit CrossChainReceived(intentId, recipient, amount);
    }

    /**
     * @notice Mark intent as executed (called after destination confirms)
     */
    function confirmExecution(bytes32 intentId) external {
        require(relayers[msg.sender], "Not authorized relayer");
        require(intents[intentId].sender != address(0), "Intent not found");
        require(!intents[intentId].executed, "Already executed");
        require(!intents[intentId].refunded, "Already refunded");
        
        intents[intentId].executed = true;
        
        emit PaymentExecuted(intentId, msg.sender);
    }

    /**
     * @notice Refund a failed/expired intent
     */
    function refundIntent(bytes32 intentId) external nonReentrant {
        PaymentIntent storage intent = intents[intentId];
        require(intent.sender != address(0), "Intent not found");
        require(!intent.executed, "Already executed");
        require(!intent.refunded, "Already refunded");
        require(
            block.timestamp > intent.deadline || msg.sender == owner(),
            "Not expired yet"
        );
        
        intent.refunded = true;
        
        Pool storage pool = pools[intent.token];
        pool.availableLiquidity -= intent.amount;
        
        // Refund
        if (intent.token == address(0)) {
            (bool success, ) = payable(intent.sender).call{value: intent.amount}("");
            require(success, "ETH refund failed");
        } else {
            IERC20(intent.token).safeTransfer(intent.sender, intent.amount);
        }
        
        emit PaymentRefunded(intentId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ZK PROOF FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Submit SNARK proof for source chain deposit verification
     * @param intentId The payment intent ID
     * @param snarkProofId The SNARK proof ID from ZKProofSystem
     */
    function submitSNARKProof(bytes32 intentId, bytes32 snarkProofId) external {
        require(relayers[msg.sender], "Not authorized relayer");
        require(intents[intentId].sender != address(0), "Intent not found");
        require(zkProofs[intentId].snarkProofId == bytes32(0), "SNARK already submitted");
        
        zkProofs[intentId].snarkProofId = snarkProofId;
        
        emit SNARKProofSubmitted(intentId, snarkProofId);
    }

    /**
     * @notice Submit STARK proof for destination transfer verification
     * @param intentId The payment intent ID
     * @param starkProofId The STARK proof ID from ZKProofSystem
     */
    function submitSTARKProof(bytes32 intentId, bytes32 starkProofId) external {
        require(relayers[msg.sender], "Not authorized relayer");
        require(intents[intentId].sender != address(0), "Intent not found");
        require(zkProofs[intentId].starkProofId == bytes32(0), "STARK already submitted");
        
        zkProofs[intentId].starkProofId = starkProofId;
        
        emit STARKProofSubmitted(intentId, starkProofId);
    }

    /**
     * @notice Verify both ZK proofs for a payment (called after off-chain verification)
     * @param intentId The payment intent ID
     * @param snarkValid Whether SNARK proof was verified valid
     * @param starkValid Whether STARK proof was verified valid
     */
    function verifyZKProofs(bytes32 intentId, bool snarkValid, bool starkValid) external {
        require(relayers[msg.sender], "Not authorized relayer");
        require(intents[intentId].sender != address(0), "Intent not found");
        require(zkProofs[intentId].snarkProofId != bytes32(0), "SNARK not submitted");
        require(zkProofs[intentId].starkProofId != bytes32(0), "STARK not submitted");
        
        zkProofs[intentId].snarkVerified = snarkValid;
        zkProofs[intentId].starkVerified = starkValid;
        zkProofs[intentId].verifiedAt = block.timestamp;
        
        emit ZKProofVerified(intentId, snarkValid, starkValid);
    }

    /**
     * @notice Get ZK proof info for an intent
     */
    function getZKProofInfo(bytes32 intentId) external view returns (
        bytes32 snarkProofId,
        bytes32 starkProofId,
        bool snarkVerified,
        bool starkVerified,
        uint256 verifiedAt
    ) {
        ZKProofInfo storage proof = zkProofs[intentId];
        return (
            proof.snarkProofId,
            proof.starkProofId,
            proof.snarkVerified,
            proof.starkVerified,
            proof.verifiedAt
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    function setRelayer(address relayer, bool active) external onlyOwner {
        relayers[relayer] = active;
        emit RelayerUpdated(relayer, active);
    }

    function setFees(uint256 _protocolFeeBps, uint256 _lpFeeBps) external onlyOwner {
        require(_protocolFeeBps + _lpFeeBps <= 100, "Fees too high"); // Max 1%
        protocolFeeBps = _protocolFeeBps;
        lpFeeBps = _lpFeeBps;
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "Invalid recipient");
        feeRecipient = _feeRecipient;
    }

    function setTokenPrice(address token, uint256 priceUSD) external onlyOwner {
        tokenPricesUSD[token] = priceUSD;
        emit PriceUpdated(token, priceUSD);
    }

    function setPoolActive(address token, bool active) external onlyOwner {
        pools[token].active = active;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Get LP's current value in a pool
     */
    function getLPValue(address token, address lp) external view returns (uint256) {
        Pool storage pool = pools[token];
        LPPosition storage position = lpPositions[token][lp];
        
        if (pool.totalShares == 0) return 0;
        return (position.shares * pool.totalDeposited) / pool.totalShares;
    }

    /**
     * @notice Get pool info
     */
    function getPoolInfo(address token) external view returns (
        uint256 totalDeposited,
        uint256 totalShares,
        uint256 totalFees,
        uint256 availableLiquidity,
        bool active
    ) {
        Pool storage pool = pools[token];
        return (
            pool.totalDeposited,
            pool.totalShares,
            pool.totalFees,
            pool.availableLiquidity,
            pool.active
        );
    }

    /**
     * @notice Calculate expected output for a cross-chain payment
     * @dev Simple calculation - in production use proper oracle
     */
    function quotePayment(
        address inputToken,
        uint256 inputAmount,
        address outputToken
    ) external view returns (uint256 outputAmount, uint256 fee) {
        uint256 inputPrice = tokenPricesUSD[inputToken];
        uint256 outputPrice = tokenPricesUSD[outputToken];
        
        require(inputPrice > 0 && outputPrice > 0, "Price not set");
        
        fee = (inputAmount * (protocolFeeBps + lpFeeBps)) / 10000;
        uint256 netInput = inputAmount - fee;
        
        // Convert: (inputAmount * inputPrice) / outputPrice
        outputAmount = (netInput * inputPrice) / outputPrice;
    }

    /**
     * @notice Check if pool has enough liquidity
     */
    function hasLiquidity(address token, uint256 amount) external view returns (bool) {
        return pools[token].availableLiquidity >= amount;
    }

    // Allow receiving ETH
    receive() external payable {}
}

