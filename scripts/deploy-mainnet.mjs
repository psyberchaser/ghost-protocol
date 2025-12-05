#!/usr/bin/env node
/**
 * Ghost Bridge - Mainnet Deployment Script
 * 
 * This script deploys all Ghost Bridge contracts to:
 * - Ethereum Mainnet (EVM contracts)
 * - Solana Mainnet (Solana program)
 * 
 * IMPORTANT: This uses REAL funds. Review carefully before running.
 * 
 * Usage:
 *   node deploy-mainnet.mjs --evm      # Deploy EVM contracts only
 *   node deploy-mainnet.mjs --solana   # Deploy Solana program only
 *   node deploy-mainnet.mjs --all      # Deploy everything
 *   node deploy-mainnet.mjs --dry-run  # Estimate costs without deploying
 */

import { ethers } from "ethers";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import * as readline from "readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.mainnet") });

// Parse CLI args
const args = process.argv.slice(2);
const deployEVM = args.includes("--evm") || args.includes("--all");
const deploySolana = args.includes("--solana") || args.includes("--all");
const dryRun = args.includes("--dry-run");

if (!deployEVM && !deploySolana && !dryRun) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║         Ghost Bridge - Mainnet Deployment Script             ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Usage:                                                      ║
║    node deploy-mainnet.mjs --evm      Deploy EVM contracts   ║
║    node deploy-mainnet.mjs --solana   Deploy Solana program  ║
║    node deploy-mainnet.mjs --all      Deploy everything      ║
║    node deploy-mainnet.mjs --dry-run  Estimate costs only    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
  process.exit(0);
}

// Load contract artifacts
const artifacts = {
  GhostWallet: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/GhostWallet.sol/GhostWallet.json"))),
  MasterBridge: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/MasterBridge.sol/MasterBridge.json"))),
  ValidatorSlashing: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/validators/ValidatorSlashing.sol/ValidatorSlashing.json"))),
  ZKProofSystem: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/zk/ZKProofSystem.sol/ZKProofSystem.json"))),
  GhostZKVerifier: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/verifiers/GhostZKVerifier.sol/GhostZKVerifier.json"))),
};

// Config
const config = {
  evmRpc: process.env.EVM_RPC,
  relayerKey: process.env.RELAYER_KEY,
  solRpc: process.env.SOL_RPC,
  solanaKeypair: process.env.SOLANA_KEYPAIR,
};

// Prompt for confirmation
async function confirm(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve) => {
    rl.question(`${message} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "yes" || answer.toLowerCase() === "y");
    });
  });
}

// ─────────────────────────────────────────────────────────────
// EVM Deployment
// ─────────────────────────────────────────────────────────────

async function deployEVMContracts() {
  console.log("\n" + "═".repeat(60));
  console.log("EVM Mainnet Deployment");
  console.log("═".repeat(60));

  if (!config.evmRpc || !config.relayerKey) {
    console.error("❌ Missing EVM_RPC or RELAYER_KEY in .env.mainnet");
    return null;
  }

  const provider = new ethers.JsonRpcProvider(config.evmRpc);
  const wallet = new ethers.Wallet(config.relayerKey, provider);
  
  console.log("Deployer address:", wallet.address);
  
  const balance = await provider.getBalance(wallet.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  // Estimate gas costs
  const gasPrice = await provider.getFeeData();
  console.log("\nCurrent gas prices:");
  console.log("  Base fee:", ethers.formatUnits(gasPrice.gasPrice || 0n, "gwei"), "gwei");
  console.log("  Max fee:", ethers.formatUnits(gasPrice.maxFeePerGas || 0n, "gwei"), "gwei");

  // Estimate deployment costs
  console.log("\n📊 Estimated deployment costs:");
  
  let totalGas = 0n;
  const estimates = {};
  
  for (const [name, artifact] of Object.entries(artifacts)) {
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
    try {
      // Get deployment gas estimate
      const deployTx = await factory.getDeployTransaction();
      const gasEstimate = await provider.estimateGas({ ...deployTx, from: wallet.address });
      estimates[name] = gasEstimate;
      totalGas += gasEstimate;
      
      const cost = ethers.formatEther(gasEstimate * (gasPrice.maxFeePerGas || gasPrice.gasPrice));
      console.log(`  ${name}: ${gasEstimate.toLocaleString()} gas (~${cost} ETH)`);
    } catch (e) {
      console.log(`  ${name}: Unable to estimate (constructor may have args)`);
    }
  }
  
  const totalCost = ethers.formatEther(totalGas * (gasPrice.maxFeePerGas || gasPrice.gasPrice));
  console.log("\n  Total estimated cost: ~" + totalCost + " ETH");
  
  if (parseFloat(ethers.formatEther(balance)) < parseFloat(totalCost) * 1.2) {
    console.error("\n❌ Insufficient balance. Need at least", (parseFloat(totalCost) * 1.2).toFixed(4), "ETH");
    return null;
  }

  if (dryRun) {
    console.log("\n🔍 Dry run complete. No contracts deployed.");
    return null;
  }

  // Confirm deployment
  console.log("\n⚠️  WARNING: You are about to deploy to MAINNET");
  console.log("    This will use REAL ETH and cannot be undone.");
  
  const confirmed = await confirm("\nProceed with deployment?");
  if (!confirmed) {
    console.log("Deployment cancelled.");
    return null;
  }

  console.log("\n🚀 Deploying contracts...\n");

  const deployed = {};

  try {
    // 1. Deploy ZKProofSystem
    console.log("1/5 Deploying ZKProofSystem...");
    const zkFactory = new ethers.ContractFactory(artifacts.ZKProofSystem.abi, artifacts.ZKProofSystem.bytecode, wallet);
    const zkSystem = await zkFactory.deploy();
    await zkSystem.waitForDeployment();
    deployed.zkSystem = await zkSystem.getAddress();
    console.log("    ✓ ZKProofSystem:", deployed.zkSystem);

    // 2. Deploy GhostZKVerifier
    console.log("2/5 Deploying GhostZKVerifier...");
    const verifierFactory = new ethers.ContractFactory(artifacts.GhostZKVerifier.abi, artifacts.GhostZKVerifier.bytecode, wallet);
    const verifier = await verifierFactory.deploy(deployed.zkSystem);
    await verifier.waitForDeployment();
    deployed.verifier = await verifier.getAddress();
    console.log("    ✓ GhostZKVerifier:", deployed.verifier);

    // 3. Deploy ValidatorSlashing
    console.log("3/5 Deploying ValidatorSlashing...");
    const validatorFactory = new ethers.ContractFactory(artifacts.ValidatorSlashing.abi, artifacts.ValidatorSlashing.bytecode, wallet);
    const validator = await validatorFactory.deploy();
    await validator.waitForDeployment();
    deployed.validator = await validator.getAddress();
    console.log("    ✓ ValidatorSlashing:", deployed.validator);

    // 4. Deploy GhostWallet
    console.log("4/5 Deploying GhostWallet...");
    const ghostFactory = new ethers.ContractFactory(artifacts.GhostWallet.abi, artifacts.GhostWallet.bytecode, wallet);
    const ghostWallet = await ghostFactory.deploy(deployed.verifier);
    await ghostWallet.waitForDeployment();
    deployed.ghostWallet = await ghostWallet.getAddress();
    console.log("    ✓ GhostWallet:", deployed.ghostWallet);

    // 5. Deploy MasterBridge
    console.log("5/5 Deploying MasterBridge...");
    const bridgeFactory = new ethers.ContractFactory(artifacts.MasterBridge.abi, artifacts.MasterBridge.bytecode, wallet);
    const bridge = await bridgeFactory.deploy(deployed.ghostWallet, deployed.validator);
    await bridge.waitForDeployment();
    deployed.bridge = await bridge.getAddress();
    console.log("    ✓ MasterBridge:", deployed.bridge);

    // Configure contracts
    console.log("\n⚙️  Configuring contracts...");
    
    const ghostWalletContract = new ethers.Contract(deployed.ghostWallet, artifacts.GhostWallet.abi, wallet);
    
    // Add relayer as validator
    console.log("   Adding relayer as validator...");
    const tx = await ghostWalletContract.addValidator(wallet.address);
    await tx.wait();
    console.log("   ✓ Relayer registered as validator");

    console.log("\n" + "═".repeat(60));
    console.log("✅ EVM Mainnet Deployment Complete!");
    console.log("═".repeat(60));
    console.log("\nDeployed Addresses:");
    console.log("  EVM_GHOST_WALLET=" + deployed.ghostWallet);
    console.log("  EVM_BRIDGE=" + deployed.bridge);
    console.log("  EVM_VERIFIER=" + deployed.verifier);
    console.log("  EVM_ZK_SYSTEM=" + deployed.zkSystem);
    console.log("  EVM_VALIDATOR=" + deployed.validator);

    return deployed;
  } catch (e) {
    console.error("\n❌ Deployment failed:", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Solana Deployment
// ─────────────────────────────────────────────────────────────

async function deploySolanaProgram() {
  console.log("\n" + "═".repeat(60));
  console.log("Solana Mainnet Deployment");
  console.log("═".repeat(60));

  if (!config.solRpc || !config.solanaKeypair) {
    console.error("❌ Missing SOL_RPC or SOLANA_KEYPAIR in .env.mainnet");
    return null;
  }

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
  
  console.log("Deployer address:", keypair.publicKey.toBase58());
  
  const balance = await connection.getBalance(keypair.publicKey);
  console.log("Balance:", (balance / LAMPORTS_PER_SOL).toFixed(4), "SOL");

  // Check if program is already deployed
  const programPath = path.join(__dirname, "../solana-program/target/deploy/ghost_solana-keypair.json");
  
  if (!fs.existsSync(programPath)) {
    console.error("\n❌ Solana program not built. Run:");
    console.error("   cd solana-program && cargo build-sbf");
    return null;
  }

  const programKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(programPath)))
  );

  console.log("Program ID:", programKeypair.publicKey.toBase58());

  // Estimate deployment cost (program size * rent-exempt minimum)
  const programData = fs.readFileSync(path.join(__dirname, "../solana-program/target/deploy/ghost_solana.so"));
  const rentExempt = await connection.getMinimumBalanceForRentExemption(programData.length);
  
  console.log("\n📊 Deployment estimate:");
  console.log("  Program size:", (programData.length / 1024).toFixed(2), "KB");
  console.log("  Rent-exempt minimum:", (rentExempt / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  console.log("  Estimated total: ~", ((rentExempt * 2) / LAMPORTS_PER_SOL).toFixed(4), "SOL");

  if (balance < rentExempt * 2) {
    console.error("\n❌ Insufficient balance. Need at least", ((rentExempt * 2) / LAMPORTS_PER_SOL).toFixed(4), "SOL");
    return null;
  }

  if (dryRun) {
    console.log("\n🔍 Dry run complete. No program deployed.");
    return null;
  }

  console.log("\n⚠️  WARNING: Solana mainnet deployment");
  console.log("    This requires running 'solana program deploy' manually");
  console.log("    with the mainnet RPC configured.");
  console.log("\n📝 Commands to run:");
  console.log(`   solana config set --url ${config.solRpc}`);
  console.log("   solana program deploy ./solana-program/target/deploy/ghost_solana.so");

  return { programId: programKeypair.publicKey.toBase58() };
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           🔴 MAINNET DEPLOYMENT - USE CAUTION 🔴            ║
╚══════════════════════════════════════════════════════════════╝
  `);

  if (deployEVM) {
    await deployEVMContracts();
  }

  if (deploySolana) {
    await deploySolanaProgram();
  }

  if (dryRun && !deployEVM && !deploySolana) {
    // Just show costs for both
    await deployEVMContracts();
    await deploySolanaProgram();
  }

  console.log("\n✅ Done\n");
}

main().catch(console.error);



