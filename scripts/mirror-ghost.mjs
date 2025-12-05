#!/usr/bin/env node
// Usage: node scripts/mirror-ghost.mjs 0x03780d39...full_id
// Forces mirror to Solana for a ghost that's burned on EVM but not yet on Solana

import { ethers } from "ethers";
import { Connection, PublicKey, Transaction, TransactionInstruction, Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const ghostId = process.argv[2];
if (!ghostId || ghostId.length !== 66) {
  console.log("Usage: node scripts/mirror-ghost.mjs <full_ghost_id>");
  console.log("Example: node scripts/mirror-ghost.mjs 0x03780d3991f4eb39f3fa913334ef7858ffb73a959bfafdbcee8f64b9a97bcf27");
  console.log("\nRun 'node scripts/check-ghost.mjs <prefix>' first to get the full ID");
  process.exit(1);
}

// Get ghost from EVM
const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts/contracts/GhostWallet.sol/GhostWallet.json"))).abi;
const contract = new ethers.Contract(process.env.EVM_GHOST_WALLET, abi, provider);
const ghost = await contract.getGhost(ghostId);

console.log("Ghost:", ghostId.slice(0, 18) + "...");
console.log("Amount:", ethers.formatEther(ghost.amount), "ETH");
console.log("State:", ghost.state.toString());

if (ghost.state !== 3n) {
  console.log("\n❌ Ghost not in Burned state");
  process.exit(1);
}

// Setup Solana
const conn = new Connection(process.env.SOL_RPC, "confirmed");
const programId = new PublicKey(process.env.SOL_PROGRAM_ID);
const configAccount = new PublicKey(process.env.SOL_CONFIG_ACCOUNT);

// Parse keypair
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let n = 0n;
for (const c of process.env.SOLANA_KEYPAIR) n = n * 58n + BigInt(ALPHABET.indexOf(c));
const bytes = [];
while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n = n >> 8n; }
while (bytes.length < 64) bytes.unshift(0);
const keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));

const seed = "gh-" + ghostId.slice(2, 18);
const ghostAccount = await PublicKey.createWithSeed(keypair.publicKey, seed, programId);

console.log("\nSolana account:", ghostAccount.toBase58());

// Check if account exists
let accountInfo = await conn.getAccountInfo(ghostAccount);

if (!accountInfo) {
  console.log("Creating Solana account...");
  const GHOST_SPACE = 320;
  const rent = await conn.getMinimumBalanceForRentExemption(GHOST_SPACE);
  
  const createIx = SystemProgram.createAccountWithSeed({
    fromPubkey: keypair.publicKey,
    newAccountPubkey: ghostAccount,
    basePubkey: keypair.publicKey,
    seed: seed,
    lamports: rent,
    space: GHOST_SPACE,
    programId,
  });
  
  const createTx = new Transaction().add(createIx);
  const createSig = await conn.sendTransaction(createTx, [keypair]);
  console.log("Create tx:", createSig);
  await new Promise(r => setTimeout(r, 5000));
}

// Build mirror instruction
const data = Buffer.alloc(145);
let o = 0;
data.writeUInt8(5, o); o += 1;
Buffer.from(ghostId.slice(2), "hex").copy(data, o); o += 32;
data.writeBigUInt64LE(11155111n, o); o += 8;
data.writeBigUInt64LE(BigInt(ghost.amount.toString()), o); o += 8;
Buffer.from(ghost.burnProof.slice(2), "hex").copy(data, o); o += 32;
new PublicKey("So11111111111111111111111111111111111111112").toBuffer().copy(data, o); o += 32;
new PublicKey("So11111111111111111111111111111111111111112").toBuffer().copy(data, o);

const mirrorIx = new TransactionInstruction({
  programId,
  keys: [
    { pubkey: configAccount, isSigner: false, isWritable: true },
    { pubkey: ghostAccount, isSigner: false, isWritable: true },
    { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
  ],
  data,
});

console.log("Sending mirror instruction...");
const tx = new Transaction().add(mirrorIx);
const sig = await conn.sendTransaction(tx, [keypair]);
console.log("Mirror tx:", sig);

console.log("Waiting 10s for confirmation...");
await new Promise(r => setTimeout(r, 10000));

// Verify
accountInfo = await conn.getAccountInfo(ghostAccount);
const state = accountInfo.data[200];
console.log("\nSolana state:", state, "(should be 3)");

if (state === 3) {
  console.log("✅ Mirror successful!");
  console.log("\nNow run: node scripts/ack-ghost.mjs " + ghostId);
} else {
  console.log("❌ Mirror may have failed, check Solana explorer");
}















