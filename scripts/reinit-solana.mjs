import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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

console.log("Program:", programId.toBase58());
console.log("Admin:", keypair.publicKey.toBase58());

// Create new config account with different seed
const CONFIG_SEED = "ghost-config-v2";
const CONFIG_SPACE = 32 + 1 + 1 + 4 + (10 * 32); // admin + threshold + max + vec header + 10 validators

const configAccount = await PublicKey.createWithSeed(
  keypair.publicKey,
  CONFIG_SEED,
  programId
);

console.log("New Config Account:", configAccount.toBase58());

// Check if exists
const existing = await connection.getAccountInfo(configAccount);
if (existing) {
  console.log("Config already exists at this address");
} else {
  console.log("\nCreating config account...");
  const rent = await connection.getMinimumBalanceForRentExemption(CONFIG_SPACE);
  
  const createIx = SystemProgram.createAccountWithSeed({
    fromPubkey: keypair.publicKey,
    newAccountPubkey: configAccount,
    basePubkey: keypair.publicKey,
    seed: CONFIG_SEED,
    lamports: rent,
    space: CONFIG_SPACE,
    programId,
  });

  const createTx = new Transaction().add(createIx);
  const createSig = await sendAndConfirmTransaction(connection, createTx, [keypair]);
  console.log("✓ Config account created:", createSig);
}

// Initialize the config
// Borsh serialization for Initialize instruction
// enum index 0 = Initialize { admin: Pubkey, validator_threshold: u8, max_validators: u8 }
const initData = Buffer.alloc(1 + 32 + 1 + 1);
let offset = 0;

// Instruction index
initData.writeUInt8(0, offset);
offset += 1;

// admin pubkey
keypair.publicKey.toBuffer().copy(initData, offset);
offset += 32;

// validator_threshold
initData.writeUInt8(1, offset);
offset += 1;

// max_validators
initData.writeUInt8(10, offset);

console.log("\nInitializing config...");
console.log("Init data:", initData.toString("hex"));

const initIx = new TransactionInstruction({
  programId,
  keys: [
    { pubkey: configAccount, isSigner: false, isWritable: true },
    { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
  ],
  data: initData,
});

try {
  const initTx = new Transaction().add(initIx);
  const initSig = await sendAndConfirmTransaction(connection, initTx, [keypair]);
  console.log("✓ Config initialized:", initSig);
} catch (err) {
  console.log("Init error (may already be initialized):", err.message?.slice(0, 100));
}

// Add validator
console.log("\nAdding validator...");
const setValidatorData = Buffer.alloc(1 + 32 + 1);
offset = 0;

// Instruction index (SetValidator = 1)
setValidatorData.writeUInt8(1, offset);
offset += 1;

// validator pubkey
keypair.publicKey.toBuffer().copy(setValidatorData, offset);
offset += 32;

// enabled (bool as u8)
setValidatorData.writeUInt8(1, offset);

const setValidatorIx = new TransactionInstruction({
  programId,
  keys: [
    { pubkey: configAccount, isSigner: false, isWritable: true },
    { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
  ],
  data: setValidatorData,
});

try {
  const setTx = new Transaction().add(setValidatorIx);
  const setSig = await sendAndConfirmTransaction(connection, setTx, [keypair]);
  console.log("✓ Validator added:", setSig);
} catch (err) {
  console.log("SetValidator error:", err.message?.slice(0, 100));
  if (err.logs) {
    console.log("Logs:", err.logs.slice(0, 5));
  }
}

console.log("\n=== NEW CONFIG ===");
console.log("SOL_CONFIG_ACCOUNT=" + configAccount.toBase58());
console.log("\nUpdate your .env with this new config account!");
