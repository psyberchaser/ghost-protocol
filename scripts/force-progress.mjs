#!/usr/bin/env node
// Usage: node scripts/force-progress.mjs <full_ghost_id>
// Forces a ghost through Lock → Burn stages with retries for ZK proof generation

import { ethers } from "ethers";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const GHOST_ID = process.argv[2];
if (!GHOST_ID || GHOST_ID.length !== 66) {
  console.log("Usage: node scripts/force-progress.mjs <full_ghost_id>");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const wallet = new ethers.Wallet(process.env.RELAYER_KEY, provider);

const ghostAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/GhostWallet.sol/GhostWallet.json"))).abi;
const bridgeAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/MasterBridge.sol/MasterBridge.json"))).abi;
const zkAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/zk/ZKProofSystem.sol/ZKProofSystem.json"))).abi;
const verifierAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/verifiers/GhostZKVerifier.sol/GhostZKVerifier.json"))).abi;

const ghostWallet = new ethers.Contract(process.env.EVM_GHOST_WALLET, ghostAbi, wallet);
const masterBridge = new ethers.Contract(process.env.EVM_BRIDGE, bridgeAbi, wallet);
const zkSystem = new ethers.Contract(process.env.EVM_ZK_SYSTEM, zkAbi, wallet);
const verifier = new ethers.Contract(process.env.EVM_VERIFIER, verifierAbi, wallet);

async function generateValidSnark(ghostId, amount, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const salt = BigInt(Date.now() + i * 1000);
      const commitment = ethers.ZeroHash;
      
      console.log(`  Attempt ${i + 1}/${maxRetries}...`);
      const tx = await zkSystem.generateSNARKProof(ghostId, amount, salt, commitment);
      const receipt = await tx.wait();
      
      let proofId;
      for (const log of receipt.logs) {
        try {
          const parsed = zkSystem.interface.parseLog(log);
          if (parsed?.name === "SNARKProofGenerated") {
            proofId = parsed.args[0];
            break;
          }
        } catch {}
      }
      
      // Try to verify
      await (await zkSystem.verifySNARKProof(proofId)).wait();
      
      // Try to bind
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [proofId]);
      await (await verifier.bindProof(ghostId, 0, payload)).wait();
      
      return payload;
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      console.log(`  Failed, retrying...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function generateValidStark(ghostId, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const txHistory = [
        ethers.keccak256(ethers.toUtf8Bytes(`tx1-${ghostId}-${Date.now()}`)),
        ethers.keccak256(ethers.toUtf8Bytes(`tx2-${ghostId}-${Date.now()}`))
      ];
      const stateRoot = ethers.keccak256(ethers.toUtf8Bytes(`state-${ghostId}-${Date.now()}`));
      
      console.log(`  Attempt ${i + 1}/${maxRetries}...`);
      const tx = await zkSystem.generateSTARKProof(ghostId, txHistory, stateRoot);
      const receipt = await tx.wait();
      
      let proofId;
      for (const log of receipt.logs) {
        try {
          const parsed = zkSystem.interface.parseLog(log);
          if (parsed?.name === "STARKProofGenerated") {
            proofId = parsed.args[0];
            break;
          }
        } catch {}
      }
      
      // Try to verify
      await (await zkSystem.verifySTARKProof(proofId)).wait();
      
      // Try to bind
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [proofId]);
      await (await verifier.bindProof(ghostId, 1, payload)).wait();
      
      return payload;
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      console.log(`  Failed, retrying...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function main() {
  let ghost = await ghostWallet.getGhost(GHOST_ID);
  console.log("Ghost:", GHOST_ID.slice(0, 18) + "...");
  console.log("Current state:", ghost.state.toString(), "(1=Created, 2=Locked, 3=Burned)");
  console.log("Amount:", ethers.formatEther(ghost.amount), "ETH");
  
  // Lock stage
  if (ghost.state === 1n) {
    console.log("\n=== LOCK STAGE ===");
    console.log("Generating valid SNARK proof (may take several attempts)...");
    
    const lockPayload = await generateValidSnark(GHOST_ID, ghost.amount);
    console.log("  ✓ SNARK valid and bound");
    
    console.log("Approving lock step...");
    const lockTx = await masterBridge.approveStep(GHOST_ID, 0, lockPayload);
    await lockTx.wait();
    console.log("  ✓ Locked!");
    
    ghost = await ghostWallet.getGhost(GHOST_ID);
    await new Promise(r => setTimeout(r, 3000));
  }
  
  // Burn stage
  if (ghost.state === 2n) {
    console.log("\n=== BURN STAGE ===");
    console.log("Generating valid STARK proof (may take several attempts)...");
    
    const burnPayload = await generateValidStark(GHOST_ID);
    console.log("  ✓ STARK valid and bound");
    
    console.log("Approving burn step...");
    const burnTx = await masterBridge.approveStep(GHOST_ID, 1, burnPayload);
    await burnTx.wait();
    console.log("  ✓ Burned!");
    
    ghost = await ghostWallet.getGhost(GHOST_ID);
  }
  
  console.log("\n=== RESULT ===");
  console.log("Final state:", ghost.state.toString());
  
  if (ghost.state === 3n) {
    console.log("\n✅ Ghost is now Burned!");
    console.log("Next: node scripts/mirror-ghost.mjs " + GHOST_ID);
  }
}

main().catch(console.error);















