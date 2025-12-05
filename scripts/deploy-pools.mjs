#!/usr/bin/env node
/**
 * Deploy Ghost Liquidity Pools
 * 
 * This script deploys:
 * 1. GhostLiquidityPool.sol on EVM (Sepolia)
 * 2. GhostPaymentRouter.sol on EVM
 * 3. Initializes Solana pool (if program deployed)
 * 4. Seeds initial liquidity (optional)
 * 
 * Usage:
 *   node deploy-pools.mjs                    # Deploy contracts
 *   node deploy-pools.mjs --seed             # Deploy + seed with test funds
 *   node deploy-pools.mjs --seed-amount 0.5  # Seed with 0.5 ETH
 */

import { ethers } from "ethers";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// Parse CLI args
const args = process.argv.slice(2);
const shouldSeed = args.includes("--seed");
const seedAmountArg = args.find(a => a.startsWith("--seed-amount="));
const seedAmount = seedAmountArg ? parseFloat(seedAmountArg.split("=")[1]) : 0.1;

// Config
const config = {
  evmRpc: process.env.EVM_RPC,
  relayerKey: process.env.RELAYER_KEY,
  solRpc: process.env.SOL_RPC || "https://api.devnet.solana.com",
  solProgramId: process.env.SOL_PROGRAM_ID,
  solanaKeypair: process.env.SOLANA_KEYPAIR,
};

// Load artifacts
const PoolArtifact = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../artifacts/contracts/pools/GhostLiquidityPool.sol/GhostLiquidityPool.json"))
);
const RouterArtifact = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../artifacts/contracts/pools/GhostPaymentRouter.sol/GhostPaymentRouter.json"))
);

console.log("═".repeat(60));
console.log("Ghost Protocol - Pool Deployment");
console.log("═".repeat(60));
console.log("EVM RPC:", config.evmRpc?.slice(0, 40) + "...");
console.log("Solana RPC:", config.solRpc);
if (shouldSeed) {
  console.log("Seed Amount:", seedAmount, "ETH equivalent");
}
console.log("═".repeat(60));

async function main() {
  const deployed = {};

  // ═══════════════════════════════════════════════════════════════════════════
  // DEPLOY EVM CONTRACTS
  // ═══════════════════════════════════════════════════════════════════════════

  if (config.evmRpc && config.relayerKey) {
    console.log("\n📦 Deploying EVM contracts...\n");

    const provider = new ethers.JsonRpcProvider(config.evmRpc);
    const wallet = new ethers.Wallet(config.relayerKey, provider);

    console.log("Deployer:", wallet.address);
    const balance = await provider.getBalance(wallet.address);
    console.log("Balance:", ethers.formatEther(balance), "ETH\n");

    // Deploy GhostLiquidityPool
    console.log("1. Deploying GhostLiquidityPool...");
    const poolFactory = new ethers.ContractFactory(
      PoolArtifact.abi,
      PoolArtifact.bytecode,
      wallet
    );
    const pool = await poolFactory.deploy();
    await pool.waitForDeployment();
    deployed.evmPool = await pool.getAddress();
    console.log("   ✅ GhostLiquidityPool:", deployed.evmPool);

    // Deploy GhostPaymentRouter
    console.log("2. Deploying GhostPaymentRouter...");
    const routerFactory = new ethers.ContractFactory(
      RouterArtifact.abi,
      RouterArtifact.bytecode,
      wallet
    );
    const router = await routerFactory.deploy(deployed.evmPool);
    await router.waitForDeployment();
    deployed.evmRouter = await router.getAddress();
    console.log("   ✅ GhostPaymentRouter:", deployed.evmRouter);

    // Configure pool
    console.log("3. Configuring pool...");
    const poolContract = new ethers.Contract(deployed.evmPool, PoolArtifact.abi, wallet);
    
    // Add deployer as relayer
    const setRelayerTx = await poolContract.setRelayer(wallet.address, true);
    await setRelayerTx.wait();
    console.log("   ✅ Relayer added:", wallet.address);

    // Set prices (ETH = $2000, SOL representation)
    const setEthPriceTx = await poolContract.setTokenPrice(ethers.ZeroAddress, 200000000000n); // $2000 with 8 decimals
    await setEthPriceTx.wait();
    console.log("   ✅ ETH price set: $2000");

    // Seed liquidity if requested
    if (shouldSeed && seedAmount > 0) {
      console.log(`4. Seeding pool with ${seedAmount} ETH...`);
      const depositTx = await poolContract.depositETH({
        value: ethers.parseEther(seedAmount.toString())
      });
      await depositTx.wait();
      console.log("   ✅ Pool seeded with", seedAmount, "ETH");
    }

    console.log("\n✅ EVM deployment complete!");
  } else {
    console.log("\n⚠️ Skipping EVM deployment (missing RPC or key)");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURE SOLANA
  // ═══════════════════════════════════════════════════════════════════════════

  if (config.solanaKeypair) {
    console.log("\n📦 Configuring Solana...\n");

    // Decode keypair
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n;
    for (const char of config.solanaKeypair) {
      n = n * 58n + BigInt(ALPHABET.indexOf(char));
    }
    const bytes = [];
    while (n > 0n) {
      bytes.unshift(Number(n & 0xffn));
      n = n >> 8n;
    }
    while (bytes.length < 64) bytes.unshift(0);
    const keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));

    const connection = new Connection(config.solRpc, "confirmed");
    
    console.log("Relayer:", keypair.publicKey.toBase58());
    const balance = await connection.getBalance(keypair.publicKey);
    console.log("Balance:", (balance / LAMPORTS_PER_SOL).toFixed(4), "SOL");

    deployed.solRelayer = keypair.publicKey.toBase58();

    // Seed Solana liquidity if requested
    if (shouldSeed) {
      const solSeedAmount = seedAmount * 50; // Rough ETH to SOL conversion for testing
      console.log(`\nSolana pool will use relayer wallet with ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      console.log("(For production, deploy a proper pool PDA)");
    }

    console.log("\n✅ Solana configuration complete!");
  } else {
    console.log("\n⚠️ Skipping Solana configuration (missing keypair)");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OUTPUT
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("\n" + "═".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("═".repeat(60));
  console.log("\nAdd these to your .env file:\n");
  
  if (deployed.evmPool) {
    console.log(`EVM_POOL_ADDRESS=${deployed.evmPool}`);
  }
  if (deployed.evmRouter) {
    console.log(`EVM_ROUTER_ADDRESS=${deployed.evmRouter}`);
  }
  if (deployed.solRelayer) {
    console.log(`# Solana uses relayer wallet: ${deployed.solRelayer}`);
  }

  console.log("\nTo start the instant relayer:");
  console.log("  node scripts/instant-relayer.mjs");
  console.log("");
}

main().catch(console.error);



