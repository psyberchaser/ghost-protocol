import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as dotenv from "dotenv";
dotenv.config();

const connection = new Connection(process.env.SOL_RPC, "confirmed");

// Load keypair
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let n = 0n;
for (const char of process.env.SOLANA_KEYPAIR) {
  n = n * 58n + BigInt(ALPHABET.indexOf(char));
}
const bytes = [];
while (n > 0n) {
  bytes.unshift(Number(n & 0xffn));
  n = n >> 8n;
}
while (bytes.length < 64) bytes.unshift(0);
const keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));

const programId = new PublicKey(process.env.SOL_PROGRAM_ID);
const configAccount = new PublicKey(process.env.SOL_CONFIG_ACCOUNT);
const ghostAccount = new PublicKey("CU9mciBxmuXZk8RkJzAohcv569xhWhBo4Qq6f2JNwcyW");

console.log("Program:", programId.toBase58());
console.log("Config:", configAccount.toBase58());
console.log("Ghost account:", ghostAccount.toBase58());
console.log("Signer:", keypair.publicKey.toBase58());

// Serialize MirrorGhost instruction
// enum index 5 = MirrorGhost
const ghostId = Buffer.from("515e8a65c2e4ac89907e14d57bfddd45e58b1c983ca19903da07a1cd26523f44", "hex");
const burnProof = Buffer.from("9e0208be05a99b52e9755eba51ccf7544874c987b9cf9d1af371876d8c8f3df3", "hex");
const sourceChain = 11155111n; // Sepolia
const amount = 1000000000000000n; // 0.001 ETH in wei

// Build instruction data
const data = Buffer.alloc(1 + 32 + 8 + 8 + 32 + 32 + 32);
let offset = 0;

// Instruction index (MirrorGhost = 5)
data.writeUInt8(5, offset);
offset += 1;

// ghost_id [u8; 32]
ghostId.copy(data, offset);
offset += 32;

// source_chain u64
data.writeBigUInt64LE(sourceChain, offset);
offset += 8;

// amount u64
data.writeBigUInt64LE(amount, offset);
offset += 8;

// burn_proof [u8; 32]
burnProof.copy(data, offset);
offset += 32;

// source_token (wSOL mint)
new PublicKey("So11111111111111111111111111111111111111112").toBuffer().copy(data, offset);
offset += 32;

// destination_token (wSOL mint)
new PublicKey("So11111111111111111111111111111111111111112").toBuffer().copy(data, offset);

console.log("\nInstruction data length:", data.length);
console.log("Data hex:", data.toString("hex").slice(0, 100) + "...");

const ix = new TransactionInstruction({
  programId,
  keys: [
    { pubkey: configAccount, isSigner: false, isWritable: true },
    { pubkey: ghostAccount, isSigner: false, isWritable: true },
    { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
  ],
  data,
});

console.log("\nSending MirrorGhost instruction...");

try {
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
  console.log("✓ Success:", sig);
} catch (err) {
  console.error("Error:", err.message);
  if (err.logs) {
    console.error("\nProgram logs:");
    err.logs.forEach(log => console.error("  ", log));
  }
}
