import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROGRAM_ID = new PublicKey("9gjTj718N5cbUkUXV6vYmovEeh6hcDm9HAGeXFMJmcjY");
const CONFIG_SEED = "ghost-config";
const CONFIG_SPACE = 32 + 1 + 1 + 4 + (10 * 32);

function serializeInitialize(admin, validatorThreshold, maxValidators) {
  const buf = Buffer.alloc(32 + 1 + 1);
  buf.set(admin, 0);
  buf.writeUInt8(validatorThreshold, 32);
  buf.writeUInt8(maxValidators, 33);
  return buf;
}

function serializeSetValidator(validator, enabled) {
  const buf = Buffer.alloc(32 + 1);
  buf.set(validator, 0);
  buf.writeUInt8(enabled ? 1 : 0, 32);
  return buf;
}

async function main() {
  const rpc = process.env.SOL_RPC || "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const keypairPath = process.env.SOLANA_KEYPAIR_PATH || 
    path.join(process.env.HOME || "", ".config/solana/id.json");
  
  console.log("Loading keypair from:", keypairPath);
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));

  console.log("=".repeat(60));
  console.log("Ghost Wallet Solana - Initialization");
  console.log("=".repeat(60));
  console.log("Program ID:", PROGRAM_ID.toBase58());
  console.log("Admin/Payer:", payer.publicKey.toBase58());
  
  const balance = await connection.getBalance(payer.publicKey);
  console.log("Balance:", balance / 1e9, "SOL");
  console.log("=".repeat(60));

  // Create config account with seed
  const configAccount = await PublicKey.createWithSeed(
    payer.publicKey,
    CONFIG_SEED,
    PROGRAM_ID
  );
  
  console.log("\nConfig Account:", configAccount.toBase58());

  const existingConfig = await connection.getAccountInfo(configAccount);
  
  if (!existingConfig) {
    console.log("\nCreating config account...");
    const rent = await connection.getMinimumBalanceForRentExemption(CONFIG_SPACE);
    console.log("Rent required:", rent / 1e9, "SOL");
    
    const createAccountIx = SystemProgram.createAccountWithSeed({
      fromPubkey: payer.publicKey,
      newAccountPubkey: configAccount,
      basePubkey: payer.publicKey,
      seed: CONFIG_SEED,
      lamports: rent,
      space: CONFIG_SPACE,
      programId: PROGRAM_ID,
    });

    const createTx = new Transaction().add(createAccountIx);
    const createSig = await sendAndConfirmTransaction(connection, createTx, [payer]);
    console.log("Config account created:", createSig);

    // Initialize the program
    console.log("\nInitializing program...");
    
    const initPayload = Buffer.concat([
      Buffer.from([0]),
      serializeInitialize(payer.publicKey.toBytes(), 1, 10),
    ]);

    const initIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: configAccount, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: initPayload,
    });

    const initTx = new Transaction().add(initIx);
    const initSig = await sendAndConfirmTransaction(connection, initTx, [payer]);
    console.log("Program initialized:", initSig);
  } else {
    console.log("Config account already exists. Skipping creation.");
  }

  // Add validator
  console.log("\nAdding validator...");
  
  const setValidatorPayload = Buffer.concat([
    Buffer.from([1]),
    serializeSetValidator(payer.publicKey.toBytes(), true),
  ]);

  const setValidatorIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configAccount, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    data: setValidatorPayload,
  });

  try {
    const setValidatorTx = new Transaction().add(setValidatorIx);
    const setValidatorSig = await sendAndConfirmTransaction(connection, setValidatorTx, [payer]);
    console.log("Validator added:", setValidatorSig);
  } catch (err) {
    console.log("Note:", err.message?.slice(0, 100) || "Validator may already be added");
  }

  console.log("\n" + "=".repeat(60));
  console.log("INITIALIZATION COMPLETE");
  console.log("=".repeat(60));
  console.log("\nAdd these to your .env:");
  console.log(`SOL_PROGRAM_ID=${PROGRAM_ID.toBase58()}`);
  console.log(`SOL_CONFIG_ACCOUNT=${configAccount.toBase58()}`);
}

main().catch(console.error);















