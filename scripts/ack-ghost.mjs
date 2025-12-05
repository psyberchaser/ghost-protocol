#!/usr/bin/env node
// Usage: node scripts/ack-ghost.mjs 0x03780d39...full_id
// Forces acknowledgment on EVM for a ghost that's already mirrored to Solana

import { ethers } from "ethers";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const ghostId = process.argv[2];
if (!ghostId || ghostId.length !== 66) {
  console.log("Usage: node scripts/ack-ghost.mjs <full_ghost_id>");
  console.log("Example: node scripts/ack-ghost.mjs 0x03780d3991f4eb39f3fa913334ef7858ffb73a959bfafdbcee8f64b9a97bcf27");
  console.log("\nRun 'node scripts/check-ghost.mjs <prefix>' first to get the full ID");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const wallet = new ethers.Wallet(process.env.RELAYER_KEY, provider);
const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/GhostWallet.sol/GhostWallet.json"))).abi;
const contract = new ethers.Contract(process.env.EVM_GHOST_WALLET, abi, wallet);

// Check current state
const ghost = await contract.getGhost(ghostId);
console.log("Ghost:", ghostId.slice(0, 18) + "...");
console.log("State:", ghost.state.toString());
console.log("Ack:", ghost.remoteAck);

if (ghost.remoteAck) {
  console.log("\n✅ Already acknowledged!");
  process.exit(0);
}

if (ghost.state !== 3n) {
  console.log("\n❌ Ghost not in Burned state, cannot acknowledge");
  process.exit(1);
}

console.log("\nSending acknowledgment...");
const tx = await contract.confirmRemoteMint(ghostId);
console.log("Tx:", tx.hash);
await tx.wait();
console.log("✅ Acknowledged!");















