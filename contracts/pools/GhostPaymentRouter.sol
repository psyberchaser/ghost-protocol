// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./GhostLiquidityPool.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title GhostPaymentRouter
 * @notice Simple interface for instant cross-chain payments
 * @dev This is what dApps integrate with - one function for any payment
 * 
 * Example usage:
 *   ghostPay{value: 1 ether}(
 *     1399811149,                           // Solana chain ID
 *     "SolanaAddressHere...",               // Recipient
 *     "SOL",                                // They want SOL
 *     40e9                                  // Minimum 40 SOL
 *   )
 */
contract GhostPaymentRouter {
    using SafeERC20 for IERC20;

    GhostLiquidityPool public immutable pool;
    
    // Supported destination chains
    mapping(uint256 => bool) public supportedChains;
    
    // Default deadline (5 minutes)
    uint256 public constant DEFAULT_DEADLINE = 5 minutes;

    event PaymentRouted(
        bytes32 indexed intentId,
        address indexed sender,
        uint256 amount,
        uint256 destChainId,
        bytes destAddress
    );

    constructor(address _pool) {
        pool = GhostLiquidityPool(payable(_pool));
        
        // Enable common chains
        supportedChains[1] = true;           // Ethereum Mainnet
        supportedChains[11155111] = true;    // Sepolia
        supportedChains[1399811149] = true;  // Solana
        supportedChains[137] = true;         // Polygon
        supportedChains[42161] = true;       // Arbitrum
        supportedChains[8453] = true;        // Base
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SIMPLE PAYMENT FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Pay with ETH, recipient receives their preferred token
     * @param destChainId Destination chain ID
     * @param destAddress Recipient address (as bytes for cross-chain compat)
     * @param destToken Token symbol or identifier they want to receive
     * @param minAmount Minimum amount they should receive
     * @return intentId The payment intent ID for tracking
     */
    function payETH(
        uint256 destChainId,
        bytes calldata destAddress,
        bytes calldata destToken,
        uint256 minAmount
    ) external payable returns (bytes32 intentId) {
        require(msg.value > 0, "No ETH sent");
        require(supportedChains[destChainId], "Chain not supported");
        
        intentId = pool.payWithETH{value: msg.value}(
            destChainId,
            destAddress,
            destToken,
            minAmount,
            block.timestamp + DEFAULT_DEADLINE
        );
        
        emit PaymentRouted(intentId, msg.sender, msg.value, destChainId, destAddress);
    }

    /**
     * @notice Pay with ERC20, recipient receives their preferred token
     * @param token Token you're paying with
     * @param amount Amount to pay
     * @param destChainId Destination chain ID
     * @param destAddress Recipient address
     * @param destToken Token they want to receive
     * @param minAmount Minimum amount they should receive
     */
    function payToken(
        address token,
        uint256 amount,
        uint256 destChainId,
        bytes calldata destAddress,
        bytes calldata destToken,
        uint256 minAmount
    ) external returns (bytes32 intentId) {
        require(amount > 0, "Zero amount");
        require(supportedChains[destChainId], "Chain not supported");
        
        // Transfer tokens to this contract first
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        
        // Approve pool
        IERC20(token).forceApprove(address(pool), amount);
        
        intentId = pool.payWithToken(
            token,
            amount,
            destChainId,
            destAddress,
            destToken,
            minAmount,
            block.timestamp + DEFAULT_DEADLINE
        );
        
        emit PaymentRouted(intentId, msg.sender, amount, destChainId, destAddress);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONVENIENCE FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Pay to a Solana address (convenience function)
     * @param solanaAddress Base58 Solana address as string
     * @param wantSOL True if they want SOL, false for wETH
     * @param minAmount Minimum SOL/wETH to receive
     */
    function payToSolana(
        string calldata solanaAddress,
        bool wantSOL,
        uint256 minAmount
    ) external payable returns (bytes32 intentId) {
        require(msg.value > 0, "No ETH sent");
        
        bytes memory destToken = wantSOL ? bytes("SOL") : bytes("wETH");
        
        intentId = pool.payWithETH{value: msg.value}(
            1399811149, // Solana chain ID
            bytes(solanaAddress),
            destToken,
            minAmount,
            block.timestamp + DEFAULT_DEADLINE
        );
        
        emit PaymentRouted(intentId, msg.sender, msg.value, 1399811149, bytes(solanaAddress));
    }

    /**
     * @notice Get a quote for a cross-chain payment
     * @param inputToken Token you're paying with (address(0) = ETH)
     * @param inputAmount Amount you're paying
     * @param outputToken Token you want to receive
     * @return outputAmount Expected output amount
     * @return fee Fee amount
     */
    function getQuote(
        address inputToken,
        uint256 inputAmount,
        address outputToken
    ) external view returns (uint256 outputAmount, uint256 fee) {
        return pool.quotePayment(inputToken, inputAmount, outputToken);
    }

    /**
     * @notice Check if there's enough liquidity for a payment
     * @param token Token to check
     * @param amount Amount needed
     */
    function checkLiquidity(address token, uint256 amount) external view returns (bool) {
        return pool.hasLiquidity(token, amount);
    }

    // Allow contract to receive ETH
    receive() external payable {}
}

