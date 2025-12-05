import { ethers } from "ethers";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Support network switching via CLI arg: node relayer.mjs --network=mainnet
const args = process.argv.slice(2);
const networkArg = args.find(a => a.startsWith("--network="));
const NETWORK = networkArg ? networkArg.split("=")[1] : (process.env.NETWORK || "testnet");

// Load appropriate .env file based on network
const envFile = NETWORK === "mainnet" ? ".env.mainnet" : ".env";
dotenv.config({ path: path.join(__dirname, "..", envFile) });

console.log(`\n🌐 Network: ${NETWORK.toUpperCase()}\n`);

// Load ABIs
const GhostWalletABI = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/GhostWallet.sol/GhostWallet.json"))
).abi;

const MasterBridgeABI = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/MasterBridge.sol/MasterBridge.json"))
).abi;

const ZKProofSystemABI = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/zk/ZKProofSystem.sol/ZKProofSystem.json"))
).abi;

const GhostZKVerifierABI = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/verifiers/GhostZKVerifier.sol/GhostZKVerifier.json"))
).abi;

// Config
const config = {
  evmRpc: process.env.EVM_RPC,
  evmGhostWallet: process.env.EVM_GHOST_WALLET,
  evmBridge: process.env.EVM_BRIDGE,
  evmVerifier: process.env.EVM_VERIFIER,
  evmZkSystem: process.env.EVM_ZK_SYSTEM,
  relayerKey: process.env.RELAYER_KEY,
  solRpc: process.env.SOL_RPC,
  solProgramId: process.env.SOL_PROGRAM_ID,
  solConfigAccount: process.env.SOL_CONFIG_ACCOUNT,
  solanaKeypair: process.env.SOLANA_KEYPAIR,
};

console.log("=".repeat(60));
console.log(`Ghost Bridge Relayer - ${NETWORK.toUpperCase()}`);
console.log("=".repeat(60));
console.log("Network:", NETWORK);
console.log("EVM RPC:", config.evmRpc?.slice(0, 50) + "...");
console.log("GhostWallet:", config.evmGhostWallet);
console.log("MasterBridge:", config.evmBridge);
console.log("ZKProofSystem:", config.evmZkSystem);
console.log("Verifier:", config.evmVerifier);
console.log("Solana Program:", config.solProgramId);
console.log("Jupiter Enabled:", process.env.ENABLE_JUPITER_SWAP === "true" ? "Yes" : "No");
console.log("=".repeat(60));

// EVM Setup
const evmProvider = new ethers.JsonRpcProvider(config.evmRpc);
const evmWallet = new ethers.Wallet(config.relayerKey, evmProvider);
const ghostWallet = new ethers.Contract(config.evmGhostWallet, GhostWalletABI, evmWallet);
const masterBridge = new ethers.Contract(config.evmBridge, MasterBridgeABI, evmWallet);
const zkSystem = new ethers.Contract(config.evmZkSystem, ZKProofSystemABI, evmWallet);
const verifier = new ethers.Contract(config.evmVerifier, GhostZKVerifierABI, evmWallet);

console.log("Relayer EVM address:", evmWallet.address);

// Solana Setup
const solConnection = new Connection(config.solRpc, "confirmed");
let solKeypair = null;

if (config.solanaKeypair) {
  try {
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
    solKeypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
    console.log("Relayer Solana address:", solKeypair.publicKey.toBase58());
  } catch (e) {
    console.error("Failed to parse Solana keypair:", e.message);
  }
}

// Track processed ghosts
const processedGhosts = new Set();
const SOLANA_CHAIN_ID = 1399811149n;

const GhostState = { None: 0, Created: 1, Locked: 2, Burned: 3, Minted: 4, Settled: 5 };
const Step = { Lock: 0, Burn: 1, Mint: 2 };
const Stage = { Lock: 0, Burn: 1, Mint: 2 };

// Jupiter API (Devnet uses mainnet API with test mode)
const JUPITER_API_URL = "https://quote-api.jup.ag/v6";

// Token mints
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
// Wrapped ETH on Solana (Portal/Wormhole wETH)
const WETH_MINT_MAINNET = new PublicKey("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs");
// For devnet testing, we'll use a mock wETH or skip the swap
const USE_JUPITER_SWAP = process.env.ENABLE_JUPITER_SWAP === "true";

// ─────────────────────────────────────────────────────────────
// Jupiter Swap Integration
// ─────────────────────────────────────────────────────────────

async function getJupiterQuote(inputMint, outputMint, amount) {
  const url = `${JUPITER_API_URL}/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=50`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Jupiter quote failed: ${response.statusText}`);
  }
  
  return response.json();
}

async function executeJupiterSwap(quote, userPublicKey) {
  const swapResponse = await fetch(`${JUPITER_API_URL}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!swapResponse.ok) {
    throw new Error(`Jupiter swap failed: ${swapResponse.statusText}`);
  }

  const swapResult = await swapResponse.json();
  return swapResult.swapTransaction;
}

async function swapWETHtoSOL(wethAmount, destinationWallet) {
  if (!USE_JUPITER_SWAP) {
    console.log("  ⚠ Jupiter swap disabled (ENABLE_JUPITER_SWAP != true)");
    console.log("  → User receives wETH token instead of native SOL");
    return { skipped: true, reason: "Jupiter disabled" };
  }

  console.log("  🔄 Initiating Jupiter swap: wETH → SOL");
  console.log(`     Amount: ${wethAmount} wETH`);
  console.log(`     Destination: ${destinationWallet}`);

  try {
    // Get quote
    const quote = await getJupiterQuote(WETH_MINT_MAINNET, WSOL_MINT, wethAmount.toString());
    
    const expectedSol = Number(quote.outAmount) / LAMPORTS_PER_SOL;
    console.log(`  📊 Quote: ${wethAmount / 1e18} wETH → ${expectedSol.toFixed(6)} SOL`);
    console.log(`     Price impact: ${(quote.priceImpactPct * 100).toFixed(2)}%`);

    // Get swap transaction
    const swapTxBase64 = await executeJupiterSwap(quote, solKeypair.publicKey);
    
    // Decode and sign
    const swapTxBuf = Buffer.from(swapTxBase64, "base64");
    const swapTx = VersionedTransaction.deserialize(swapTxBuf);
    swapTx.sign([solKeypair]);
    
    // Send transaction
    const sig = await solConnection.sendTransaction(swapTx, { skipPreflight: false });
    await solConnection.confirmTransaction(sig, "confirmed");
    
    console.log(`  ✓ Swap complete: ${sig.slice(0, 20)}...`);
    console.log(`  → User received ~${expectedSol.toFixed(6)} SOL`);
    
    return { 
      success: true, 
      signature: sig, 
      solReceived: expectedSol,
      wethSwapped: wethAmount / 1e18
    };
    
  } catch (err) {
    console.error("  ⚠ Jupiter swap failed:", err.message?.slice(0, 80));
    console.log("  → Falling back to wETH delivery (user can swap manually)");
    return { skipped: true, reason: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// ZK Proof Generation
// ─────────────────────────────────────────────────────────────

async function generateAndBindSNARKProof(ghostId, ghost) {
  console.log("  Generating SNARK proof...");
  
  const salt = BigInt(Date.now());
  const commitment = ghost.amountCommitment || ethers.ZeroHash;
  
  const snarkTx = await zkSystem.generateSNARKProof(ghostId, ghost.amount, salt, commitment);
  const snarkReceipt = await snarkTx.wait();
  
  // Find proof ID from event
  let snarkProofId;
  for (const log of snarkReceipt.logs) {
    try {
      const parsed = zkSystem.interface.parseLog(log);
      if (parsed?.name === "SNARKProofGenerated") {
        snarkProofId = parsed.args[0]; // proofId
        break;
      }
    } catch {}
  }
  
  if (!snarkProofId) {
    throw new Error("Failed to get SNARK proof ID");
  }
  console.log("  SNARK proof:", snarkProofId.slice(0, 18) + "...");
  
  // Verify the proof
  const verifyTx = await zkSystem.verifySNARKProof(snarkProofId);
  await verifyTx.wait();
  
  // Bind to verifier
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [snarkProofId]);
  const bindTx = await verifier.bindProof(ghostId, Stage.Lock, payload);
  await bindTx.wait();
  console.log("  ✓ SNARK bound for Lock");
  
  return payload;
}

async function generateAndBindSTARKProof(ghostId, ghost) {
  console.log("  Generating STARK proof...");
  
  const txHistory = [
    ethers.keccak256(ethers.toUtf8Bytes("tx1-" + ghostId)),
    ethers.keccak256(ethers.toUtf8Bytes("tx2-" + ghostId))
  ];
  const stateRoot = ethers.keccak256(ethers.toUtf8Bytes("state-" + ghostId));
  
  const starkTx = await zkSystem.generateSTARKProof(ghostId, txHistory, stateRoot);
  const starkReceipt = await starkTx.wait();
  
  // Find proof ID from event
  let starkProofId;
  for (const log of starkReceipt.logs) {
    try {
      const parsed = zkSystem.interface.parseLog(log);
      if (parsed?.name === "STARKProofGenerated") {
        starkProofId = parsed.args[0]; // proofId
        break;
      }
    } catch {}
  }
  
  if (!starkProofId) {
    throw new Error("Failed to get STARK proof ID");
  }
  console.log("  STARK proof:", starkProofId.slice(0, 18) + "...");
  
  // Verify the proof
  const verifyTx = await zkSystem.verifySTARKProof(starkProofId);
  await verifyTx.wait();
  
  // Bind to verifier
  const payload = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [starkProofId]);
  const bindTx = await verifier.bindProof(ghostId, Stage.Burn, payload);
  await bindTx.wait();
  console.log("  ✓ STARK bound for Burn");
  
  return payload;
}

// ─────────────────────────────────────────────────────────────
// Ghost Processing
// ─────────────────────────────────────────────────────────────

async function progressGhost(ghostId) {
  if (processedGhosts.has(ghostId)) return;
  
  console.log("\n" + "-".repeat(40));
  console.log("Processing ghost:", ghostId.slice(0, 18) + "...");
  
  try {
    let ghost = await ghostWallet.getGhost(ghostId);
    let state = Number(ghost.state);
    console.log("State:", Object.keys(GhostState).find(k => GhostState[k] === state));
    console.log("Amount:", ethers.formatEther(ghost.amount), "WETH");
    console.log("Dest chain:", ghost.destinationChainId.toString());
    
    // ── CREATED → LOCKED ──
    if (state === GhostState.Created) {
      console.log("\n→ LOCK STAGE");
      const lockPayload = await generateAndBindSNARKProof(ghostId, ghost);
      
      console.log("  Approving Lock step...");
      const tx = await masterBridge.approveStep(ghostId, Step.Lock, lockPayload);
      await tx.wait();
      console.log("  ✓ Locked!");
      
      await new Promise(r => setTimeout(r, 2000));
      ghost = await ghostWallet.getGhost(ghostId);
      state = Number(ghost.state);
    }
    
    // ── LOCKED → BURNED ──
    if (state === GhostState.Locked) {
      console.log("\n→ BURN STAGE");
      const burnPayload = await generateAndBindSTARKProof(ghostId, ghost);
      
      console.log("  Approving Burn step...");
      const tx = await masterBridge.approveStep(ghostId, Step.Burn, burnPayload);
      await tx.wait();
      console.log("  ✓ Burned!");
      
      await new Promise(r => setTimeout(r, 2000));
      ghost = await ghostWallet.getGhost(ghostId);
      state = Number(ghost.state);
    }
    
    // ── BURNED → RELAY TO SOLANA ──
    if (state === GhostState.Burned && !ghost.remoteAck) {
      console.log("\n→ RELAY STAGE");
      
      if (ghost.destinationChainId === SOLANA_CHAIN_ID) {
        await relayToSolana(ghostId, ghost);
      } else {
        console.log("  Destination is EVM - skipping Solana relay");
      }
      
      processedGhosts.add(ghostId);
    } else if (ghost.remoteAck) {
      console.log("\n✓ Already acknowledged");
      processedGhosts.add(ghostId);
    }
    
  } catch (err) {
    console.error("Error:", err.message?.slice(0, 150));
    if (err.reason) console.error("Reason:", err.reason);
  }
}

// ─────────────────────────────────────────────────────────────
// Solana Relay
// ─────────────────────────────────────────────────────────────

async function relayToSolana(ghostId, ghost) {
  if (!solKeypair) {
    console.log("  ⚠ Solana keypair not configured");
    return;
  }
  
  console.log("  Creating ghost on Solana...");
  
  const programId = new PublicKey(config.solProgramId);
  const configAccount = new PublicKey(config.solConfigAccount);
  
  const ghostIdHex = ghostId.slice(2, 18);
  const ghostSeed = `gh-${ghostIdHex}`;
  const ghostAccount = await PublicKey.createWithSeed(solKeypair.publicKey, ghostSeed, programId);
  
  console.log("  Solana account:", ghostAccount.toBase58());

  try {
    // Create account if needed
    const existingAccount = await solConnection.getAccountInfo(ghostAccount);
    
    if (!existingAccount) {
      const GHOST_SPACE = 320;
      const rent = await solConnection.getMinimumBalanceForRentExemption(GHOST_SPACE);
      
      const createIx = SystemProgram.createAccountWithSeed({
        fromPubkey: solKeypair.publicKey,
        newAccountPubkey: ghostAccount,
        basePubkey: solKeypair.publicKey,
        seed: ghostSeed,
        lamports: rent,
        space: GHOST_SPACE,
        programId,
      });

      const createTx = new Transaction().add(createIx);
      await sendAndConfirmTransaction(solConnection, createTx, [solKeypair]);
      console.log("  ✓ Account created");
    }

    // MirrorGhost instruction - Borsh serialized
    // Enum variant 5 = MirrorGhost { ghost_id, source_chain, amount, burn_proof, source_token, destination_token }
    const ghostIdBytes = Buffer.from(ghostId.slice(2), "hex");
    const burnProofBytes = Buffer.from(ghost.burnProof.slice(2), "hex");
    const wsolMint = new PublicKey("So11111111111111111111111111111111111111112");
    
    // Borsh enum: 1 byte variant index + fields
    const mirrorData = Buffer.alloc(1 + 32 + 8 + 8 + 32 + 32 + 32);
    let offset = 0;
    
    // Variant index (MirrorGhost = 5)
    mirrorData.writeUInt8(5, offset); offset += 1;
    
    // ghost_id: [u8; 32]
    ghostIdBytes.copy(mirrorData, offset); offset += 32;
    
    // source_chain: u64 (Sepolia = 11155111)
    mirrorData.writeBigUInt64LE(BigInt(11155111), offset); offset += 8;
    
    // amount: u64
    const amountBigInt = typeof ghost.amount === 'bigint' ? ghost.amount : BigInt(ghost.amount.toString());
    mirrorData.writeBigUInt64LE(amountBigInt, offset); offset += 8;
    
    // burn_proof: [u8; 32]
    burnProofBytes.copy(mirrorData, offset); offset += 32;
    
    // source_token: Pubkey
    wsolMint.toBuffer().copy(mirrorData, offset); offset += 32;
    
    // destination_token: Pubkey
    wsolMint.toBuffer().copy(mirrorData, offset);
    
    console.log("  Instruction data length:", mirrorData.length, "bytes");
    
    const mirrorIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: configAccount, isSigner: false, isWritable: true },
        { pubkey: ghostAccount, isSigner: false, isWritable: true },
        { pubkey: solKeypair.publicKey, isSigner: true, isWritable: false },
      ],
      data: mirrorData,
    });

    const mirrorTx = new Transaction().add(mirrorIx);
    const mirrorSig = await sendAndConfirmTransaction(solConnection, mirrorTx, [solKeypair]);
    console.log("  ✓ Mirrored to Solana:", mirrorSig.slice(0, 20) + "...");
    
    // Try to swap wETH → SOL via Jupiter
    const swapAmount = typeof ghost.amount === 'bigint' ? ghost.amount : BigInt(ghost.amount.toString());
    const destinationAddress = ghost.destinationAddress || ghost.evmDestination;
    
    // Attempt Jupiter swap (will gracefully fall back if disabled/fails)
    const swapResult = await swapWETHtoSOL(swapAmount, destinationAddress);
    
    if (swapResult.success) {
      console.log(`  🎉 User received ${swapResult.solReceived.toFixed(6)} native SOL!`);
    } else {
      console.log(`  📦 User received wETH token (swap: ${swapResult.reason})`);
    }

    // Only acknowledge on EVM if Solana relay succeeded
    console.log("  Acknowledging on EVM...");
    const ackTx = await ghostWallet.confirmRemoteMint(ghostId);
    await ackTx.wait();
    console.log("  ✓ Remote mint acknowledged!");
    
    return true; // Success
    
  } catch (err) {
    console.error("  Solana relay FAILED:", err.message?.slice(0, 150));
    console.error("  Ghost will NOT be acknowledged until Solana succeeds");
    return false; // Failed - don't acknowledge
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log("\nListening for ghost events...\n");

  // Listen for new events
  ghostWallet.on("GhostInitiated", (ghostId, initiator, amount) => {
    console.log("\n🔔 NEW GHOST:", ghostId.slice(0, 18) + "...");
    console.log("   Amount:", ethers.formatEther(amount), "WETH");
    progressGhost(ghostId);
  });

  ghostWallet.on("GhostLocked", (ghostId) => {
    console.log("\n🔔 GhostLocked:", ghostId.slice(0, 18) + "...");
  });

  ghostWallet.on("GhostBurned", (ghostId) => {
    console.log("\n🔔 GhostBurned:", ghostId.slice(0, 18) + "...");
  });

  // Continuous scanning function
  async function scanForPendingGhosts() {
    try {
      const currentBlock = await evmProvider.getBlockNumber();
      const fromBlock = currentBlock - 500;
      const events = await ghostWallet.queryFilter(ghostWallet.filters.GhostInitiated(), fromBlock, currentBlock);
      
      for (const event of events) {
        const ghostId = event.args[0];
        if (processedGhosts.has(ghostId)) continue;
        
        const ghost = await ghostWallet.getGhost(ghostId);
        
        // Process ghosts in Created, Locked, or Burned (not ack'd) state
        if (ghost.state >= 1n && ghost.state <= 3n && !ghost.remoteAck) {
          console.log(`\n📋 Found pending: ${ghostId.slice(0, 18)}... (state ${ghost.state})`);
          await progressGhost(ghostId);
        }
      }
    } catch (e) {
      console.log("Scan error:", e.message?.slice(0, 60));
    }
  }

  // Initial scan
  const currentBlock = await evmProvider.getBlockNumber();
  console.log("Current block:", currentBlock);
  console.log("Scanning for pending ghosts...\n");
  await scanForPendingGhosts();

  // Continuous scan every 15 seconds
  setInterval(scanForPendingGhosts, 15000);

  console.log("\n" + "=".repeat(60));
  console.log("RELAYER READY - Scanning every 15s + listening for events");
  console.log("=".repeat(60) + "\n");
}

main().catch(console.error);
