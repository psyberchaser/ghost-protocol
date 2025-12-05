import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
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

console.log("Config:", configAccount.toBase58());
console.log("Admin:", keypair.publicKey.toBase58());

// Initialize instruction
const initData = Buffer.alloc(1 + 32 + 1 + 1);
initData.writeUInt8(0, 0); // Initialize = 0
keypair.publicKey.toBuffer().copy(initData, 1);
initData.writeUInt8(1, 33); // threshold
initData.writeUInt8(10, 34); // max validators

console.log("\n1. Initializing config...");
const initIx = new TransactionInstruction({
  programId,
  keys: [
    { pubkey: configAccount, isSigner: false, isWritable: true },
    { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
  ],
  data: initData,
});

try {
  const tx = new Transaction().add(initIx);
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = keypair.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: "confirmed" });
  console.log("✓ Initialized:", sig);
} catch (err) {
  console.log("Init result:", err.message?.slice(0, 100));
  if (err.logs) console.log("Logs:", err.logs.slice(-3));
}

// SetValidator instruction
const setData = Buffer.alloc(1 + 32 + 1);
setData.writeUInt8(1, 0); // SetValidator = 1
keypair.publicKey.toBuffer().copy(setData, 1);
setData.writeUInt8(1, 33); // enabled = true

console.log("\n2. Adding validator...");
const setIx = new TransactionInstruction({
  programId,
  keys: [
    { pubkey: configAccount, isSigner: false, isWritable: true },
    { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
  ],
  data: setData,
});

try {
  const tx = new Transaction().add(setIx);
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = keypair.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: "confirmed" });
  console.log("✓ Validator added:", sig);
} catch (err) {
  console.log("SetValidator result:", err.message?.slice(0, 100));
  if (err.logs) console.log("Logs:", err.logs.slice(-3));
}

console.log("\nDone!");
