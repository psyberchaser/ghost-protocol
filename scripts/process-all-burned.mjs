import { ethers } from "ethers";
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

const evmProvider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const evmWallet = new ethers.Wallet(process.env.RELAYER_KEY, evmProvider);
const solConnection = new Connection(process.env.SOL_RPC, "confirmed");

// Load Solana keypair
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
const solKeypair = Keypair.fromSecretKey(Uint8Array.from(bytes));

const GHOST_WALLET = process.env.EVM_GHOST_WALLET;
const programId = new PublicKey(process.env.SOL_PROGRAM_ID);
const configAccount = new PublicKey(process.env.SOL_CONFIG_ACCOUNT);

const ghostWalletAbi = [
  "function getGhost(bytes32) view returns (tuple(address initiator, address sourceToken, address destinationToken, uint64 sourceChainId, uint64 destinationChainId, bytes destinationAddress, address evmDestination, uint256 amount, bytes32 amountCommitment, uint8 state, bool isRemote, bool remoteAck, uint64 createdAt, uint64 lockedAt, uint64 burnedAt, uint64 mintedAt, bytes32 lockProof, bytes32 burnProof, bytes32 mintProof))",
  "function confirmRemoteMint(bytes32 ghostId) external",
  "event GhostInitiated(bytes32 indexed ghostId, address indexed initiator, uint256 amount)"
];

const ghostWallet = new ethers.Contract(GHOST_WALLET, ghostWalletAbi, evmWallet);

// Known ghost IDs that need processing
const ghostIds = [
  "0x6f3b11bdf5e5dc8c0f5d8e2a4c1b3a9e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a",
  "0x7caa80297e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b"
];

// First, find actual ghost IDs from events
console.log("Searching for ghost IDs...");
const latest = await evmProvider.getBlockNumber();

// Scan blocks one at a time
let foundGhosts = [];
for (let b = latest; b > latest - 200 && foundGhosts.length < 10; b--) {
  try {
    const events = await ghostWallet.queryFilter(ghostWallet.filters.GhostInitiated(), b, b);
    for (const e of events) {
      foundGhosts.push(e.args.ghostId);
    }
  } catch {}
}

console.log("Found", foundGhosts.length, "ghosts\n");

for (const ghostId of foundGhosts) {
  const ghost = await ghostWallet.getGhost(ghostId);
  const states = ["None", "Created", "Locked", "Burned", "Minted", "Settled"];
  
  console.log("Ghost:", ghostId.slice(0, 18) + "...");
  console.log("  State:", states[ghost.state]);
  console.log("  Remote Ack:", ghost.remoteAck);
  
  // Only process Burned ghosts that aren't acknowledged
  if (ghost.state === 3n && !ghost.remoteAck) {
    console.log("  → Needs relay + ack!");
    
    // Create Solana ghost account
    const ghostIdHex = ghostId.slice(2, 18);
    const ghostSeed = `gh-${ghostIdHex}`;
    const ghostAccount = await PublicKey.createWithSeed(solKeypair.publicKey, ghostSeed, programId);
    
    console.log("  Solana account:", ghostAccount.toBase58());
    
    // Check if account exists
    const existingAccount = await solConnection.getAccountInfo(ghostAccount);
    
    if (!existingAccount) {
      console.log("  Creating Solana ghost account...");
      const GHOST_SPACE = 320;
      const rent = await solConnection.getMinimumBalanceForRentExemption(GHOST_SPACE);
      
      const createIx = SystemProgram.createAccountWithSeed({
        fromPubkey: solKeypair.publicKey,
        newAccountPubkey: ghostAccount,
        basePubkey: solKeypair.publicKey,
        seed: ghostSeed,
        lamports: rent,
        space: GHOST_SPACE,
        programId,
      });

      try {
        const createTx = new Transaction().add(createIx);
        await sendAndConfirmTransaction(solConnection, createTx, [solKeypair]);
        console.log("  ✓ Account created");
      } catch (e) {
        console.log("  Account creation:", e.message?.slice(0, 50));
      }
    }
    
    // Send MirrorGhost instruction
    const ghostIdBytes = Buffer.from(ghostId.slice(2), "hex");
    const burnProofBytes = Buffer.from(ghost.burnProof.slice(2), "hex");
    
    const mirrorData = Buffer.alloc(1 + 32 + 8 + 8 + 32 + 32 + 32);
    let offset = 0;
    mirrorData.writeUInt8(5, offset); offset += 1;
    ghostIdBytes.copy(mirrorData, offset); offset += 32;
    mirrorData.writeBigUInt64LE(11155111n, offset); offset += 8;
    mirrorData.writeBigUInt64LE(ghost.amount, offset); offset += 8;
    burnProofBytes.copy(mirrorData, offset); offset += 32;
    new PublicKey("So11111111111111111111111111111111111111112").toBuffer().copy(mirrorData, offset); offset += 32;
    new PublicKey("So11111111111111111111111111111111111111112").toBuffer().copy(mirrorData, offset);
    
    const mirrorIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: configAccount, isSigner: false, isWritable: true },
        { pubkey: ghostAccount, isSigner: false, isWritable: true },
        { pubkey: solKeypair.publicKey, isSigner: true, isWritable: false },
      ],
      data: mirrorData,
    });

    try {
      const mirrorTx = new Transaction().add(mirrorIx);
      await sendAndConfirmTransaction(solConnection, mirrorTx, [solKeypair]);
      console.log("  ✓ Mirrored to Solana");
    } catch (e) {
      console.log("  Mirror:", e.message?.slice(0, 80));
    }
    
    // Acknowledge on EVM
    try {
      console.log("  Acknowledging on EVM...");
      const ackTx = await ghostWallet.confirmRemoteMint(ghostId);
      await ackTx.wait();
      console.log("  ✓ Acknowledged!");
    } catch (e) {
      console.log("  Ack:", e.message?.slice(0, 50));
    }
  } else if (ghost.remoteAck) {
    console.log("  Already acknowledged");
  }
  
  console.log("");
}

console.log("Done!");
