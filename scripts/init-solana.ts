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

const PROGRAM_ID = new PublicKey("9gjTj718N5cbUkUXV6vYmovEeh6hcDm9HAGeXFMJmcjY");
const CONFIG_SEED = "ghost-config";
const CONFIG_SPACE = 32 + 1 + 1 + 4 + (10 * 32); // admin + threshold + max + vec header + 10 validators

// Manual serialization for Borsh compatibility
function serializeInitialize(admin: Uint8Array, validatorThreshold: number, maxValidators: number): Buffer {
  const buf = Buffer.alloc(32 + 1 + 1);
  buf.set(admin, 0);
  buf.writeUInt8(validatorThreshold, 32);
  buf.writeUInt8(maxValidators, 33);
  return buf;
}

function serializeSetValidator(validator: Uint8Array, enabled: boolean): Buffer {
  const buf = Buffer.alloc(32 + 1);
  buf.set(validator, 0);
  buf.writeUInt8(enabled ? 1 : 0, 32);
  return buf;
}

async function main() {
  const rpc = process.env.SOL_RPC || "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");

  // Load keypair
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

  // Derive config PDA
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(CONFIG_SEED)],
    PROGRAM_ID
  );
  console.log("\nConfig PDA:", configPda.toBase58());

  // Check if config already exists
  const configInfo = await connection.getAccountInfo(configPda);
  
  if (configInfo) {
    console.log("Config account already exists. Skipping initialization.");
  } else {
    console.log("\nCreating config account...");
    
    // We need to create the account first since PDAs can't be created by the program directly
    // without using invoke_signed. Let's use a regular account with a seed instead.
    const configAccount = await PublicKey.createWithSeed(
      payer.publicKey,
      CONFIG_SEED,
      PROGRAM_ID
    );
    
    console.log("Config Account (with seed):", configAccount.toBase58());
    
    const existingConfig = await connection.getAccountInfo(configAccount);
    
    if (!existingConfig) {
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
    } else {
      console.log("Config account already exists");
    }

    // Initialize the program
    console.log("\nInitializing program...");
    
    const initPayload = Buffer.concat([
      Buffer.from([0]), // Instruction index for Initialize
      serializeInitialize(payer.publicKey.toBytes(), 1, 10),
    ]);

    const configAccountFinal = await PublicKey.createWithSeed(
      payer.publicKey,
      CONFIG_SEED,
      PROGRAM_ID
    );

    const initIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: configAccountFinal, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: initPayload,
    });

    const initTx = new Transaction().add(initIx);
    const initSig = await sendAndConfirmTransaction(connection, initTx, [payer]);
    console.log("Program initialized:", initSig);
  }

  // Add validator
  console.log("\nAdding validator...");
  
  const configAccountForValidator = await PublicKey.createWithSeed(
    payer.publicKey,
    CONFIG_SEED,
    PROGRAM_ID
  );

  const setValidatorPayload = Buffer.concat([
    Buffer.from([1]), // Instruction index for SetValidator
    serializeSetValidator(payer.publicKey.toBytes(), true),
  ]);

  const setValidatorIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configAccountForValidator, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    data: setValidatorPayload,
  });

  try {
    const setValidatorTx = new Transaction().add(setValidatorIx);
    const setValidatorSig = await sendAndConfirmTransaction(connection, setValidatorTx, [payer]);
    console.log("Validator added:", setValidatorSig);
  } catch (err: any) {
    if (err.message?.includes("already")) {
      console.log("Validator already added");
    } else {
      console.log("Note: Validator may already be added or error occurred:", err.message);
    }
  }

  // Print summary
  const finalConfigAccount = await PublicKey.createWithSeed(
    payer.publicKey,
    CONFIG_SEED,
    PROGRAM_ID
  );

  console.log("\n" + "=".repeat(60));
  console.log("INITIALIZATION COMPLETE");
  console.log("=".repeat(60));
  console.log("\nAdd these to your .env:");
  console.log(`SOL_PROGRAM_ID=${PROGRAM_ID.toBase58()}`);
  console.log(`SOL_CONFIG_ACCOUNT=${finalConfigAccount.toBase58()}`);
  console.log(`SOLANA_KEYPAIR=<base58_secret_key>`);
  console.log("\nValidator address:", payer.publicKey.toBase58());
}

main().catch(console.error);

