#!/usr/bin/env node
// Usage: node scripts/check-ghost.mjs 0x03780d39
// Shows status of a ghost on both EVM and Solana

import { ethers } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const prefix = process.argv[2];
if (!prefix) {
  console.log("Usage: node scripts/check-ghost.mjs <ghost_id_prefix>");
  console.log("Example: node scripts/check-ghost.mjs 0x03780d39");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/GhostWallet.sol/GhostWallet.json"))).abi;
const contract = new ethers.Contract(process.env.EVM_GHOST_WALLET, abi, provider);

const latest = await provider.getBlockNumber();
const logs = await provider.getLogs({
  address: process.env.EVM_GHOST_WALLET,
  fromBlock: latest - 1000,
  toBlock: latest,
  topics: ["0xd85620fefbca73b1a46ce364c51d0fd092306a72b9a17a4d67d022021f3d66c6"]
});

let found = false;
for (const log of logs) {
  if (log.topics[1].toLowerCase().startsWith(prefix.toLowerCase())) {
    found = true;
    const ghostId = log.topics[1];
    const ghost = await contract.getGhost(ghostId);
    
    console.log("\n=== GHOST STATUS ===");
    console.log("Full ID:", ghostId);
    console.log("");
    console.log("EVM (Sepolia):");
    console.log("  State:", ghost.state.toString(), "(3=Burned)");
    console.log("  Ack:", ghost.remoteAck);
    console.log("  Amount:", ethers.formatEther(ghost.amount), "ETH");
    
    const conn = new Connection(process.env.SOL_RPC, "confirmed");
    const programId = new PublicKey(process.env.SOL_PROGRAM_ID);
    const relayer = new PublicKey("2XpZF7UTgSrABdUX7DEjWYXW9wEKs6httF8ekMsqgFPT");
    const seed = "gh-" + ghostId.slice(2, 18);
    const solAcc = await PublicKey.createWithSeed(relayer, seed, programId);
    
    console.log("");
    console.log("Solana (Devnet):");
    console.log("  Account:", solAcc.toBase58());
    
    const info = await conn.getAccountInfo(solAcc);
    if (info) {
      const solGhostId = Buffer.from(info.data.slice(0, 32)).toString("hex");
      const state = info.data[200];
      console.log("  State:", state, "(0=Empty, 3=Burned)");
      console.log("  Data:", solGhostId.startsWith("00000000") ? "EMPTY" : "OK");
    } else {
      console.log("  Account: NOT CREATED");
    }
    
    console.log("");
    if (ghost.state === 3n && ghost.remoteAck) {
      console.log("✅ COMPLETE - Ghost fully bridged");
    } else if (ghost.state === 3n && !ghost.remoteAck) {
      if (info && info.data[200] === 3) {
        console.log("⚠️  NEEDS ACK - Run: node scripts/ack-ghost.mjs " + ghostId);
      } else {
        console.log("⚠️  NEEDS MIRROR - Run: node scripts/mirror-ghost.mjs " + ghostId);
      }
    }
  }
}

if (!found) {
  console.log("No ghost found with prefix:", prefix);
}
