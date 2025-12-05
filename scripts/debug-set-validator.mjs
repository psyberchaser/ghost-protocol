import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
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

console.log("Program:", programId.toBase58());
console.log("Config:", configAccount.toBase58());
console.log("Signer:", keypair.publicKey.toBase58());

// Read current config data
const accountInfo = await connection.getAccountInfo(configAccount);
console.log("\nConfig account data length:", accountInfo.data.length);
console.log("First 40 bytes:", Buffer.from(accountInfo.data.slice(0, 40)).toString('hex'));

// The problem might be that Borsh Vec serialization includes length
// Let's check: admin(32) + threshold(1) + max(1) + vec_len(4) + validators(0*32) = 38 bytes
// But account is 358 bytes - lots of zeros after

// Let's simulate what Borsh would read:
// It reads admin(32), threshold(1), max(1), then vec length (4 bytes)
// vec length at offset 34 should be a u32
const vecLen = accountInfo.data.readUInt32LE(34);
console.log("Vec length at offset 34:", vecLen);

// If vec_len is 0, Borsh should be happy. But maybe the trailing zeros are the problem?
// Borsh's try_from_slice reads exactly what it needs and ignores the rest.

// Let's try a simulation to see the exact error
const setData = Buffer.alloc(1 + 32 + 1);
setData.writeUInt8(1, 0); // SetValidator = 1
keypair.publicKey.toBuffer().copy(setData, 1);
setData.writeUInt8(1, 33); // enabled = true

console.log("\nInstruction data:", setData.toString('hex'));

const ix = new TransactionInstruction({
  programId,
  keys: [
    { pubkey: configAccount, isSigner: false, isWritable: true },
    { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
  ],
  data: setData,
});

const tx = new Transaction().add(ix);
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.feePayer = keypair.publicKey;

console.log("\nSimulating transaction...");
try {
  const sim = await connection.simulateTransaction(tx);
  console.log("Simulation result:", sim.value);
  if (sim.value.logs) {
    console.log("\nLogs:");
    sim.value.logs.forEach(l => console.log("  ", l));
  }
} catch (err) {
  console.log("Simulation error:", err.message);
}
