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
import { serialize, deserializeUnchecked } from "borsh";
import bs58 from "bs58";
import BN from "bn.js";
import GhostWalletArtifact from "../artifacts/contracts/GhostWallet.sol/GhostWallet.json";
import GhostVerifierArtifact from "../artifacts/contracts/verifiers/GhostZKVerifier.sol/GhostZKVerifier.json";
import ZKArtifact from "../artifacts/contracts/zk/ZKProofSystem.sol/ZKProofSystem.json";

const GHOST_SEED_PREFIX = "ghost";
const GHOST_ACCOUNT_SPACE = 320; // padded for safety
const HARDHAT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const Stage = {
  Lock: 0,
  Burn: 1,
  Mint: 2,
} as const;

type CrossRelayConfig = {
  evmRpc: string;
  solRpc: string;
  relayerEvmKey: string;
  relayerSolKey: string;
  evmGhostWallet: string;
  evmVerifier: string;
  evmZkSystem: string;
  evmChainId: bigint;
  solChainId: bigint;
  solProgramId: PublicKey;
  solConfigAccount: PublicKey;
  solMint: PublicKey;
};

class MirrorPayload {
  constructor(fields: Partial<MirrorPayload>) {
    Object.assign(this, fields);
  }
  ghost_id!: Uint8Array;
  source_chain!: BN;
  amount!: BN;
  burn_proof!: Uint8Array;
  source_token!: Uint8Array;
  destination_token!: Uint8Array;
}

class MintPayload {
  constructor(fields: Partial<MintPayload>) {
    Object.assign(this, fields);
  }
  ghost_id!: Uint8Array;
  mint_proof!: Uint8Array;
  recipient!: Uint8Array;
}

class AckPayload {
  constructor(fields: Partial<AckPayload>) {
    Object.assign(this, fields);
  }
  ghost_id!: Uint8Array;
}

class GhostAccountData {
  constructor(fields: Partial<GhostAccountData>) {
    Object.assign(this, fields);
  }
  ghost_id!: Uint8Array;
  initiator!: Uint8Array;
  source_token!: Uint8Array;
  destination_token!: Uint8Array;
  destination_chain!: BN;
  destination_address!: Uint8Array;
  state!: number;
  amount!: BN;
  lock_ts!: BN;
  burn_ts!: BN;
  mint_ts!: BN;
  burn_proof!: Uint8Array;
  mint_proof!: Uint8Array;
  is_remote!: number;
  remote_ack!: number;
}

const MirrorSchema = new Map([
  [
    MirrorPayload,
    {
      kind: "struct",
      fields: [
        ["ghost_id", [32]],
        ["source_chain", "u64"],
        ["amount", "u64"],
        ["burn_proof", [32]],
        ["source_token", [32]],
        ["destination_token", [32]],
      ],
    },
  ],
]);

const MintSchema = new Map([
  [
    MintPayload,
    {
      kind: "struct",
      fields: [
        ["ghost_id", [32]],
        ["mint_proof", [32]],
        ["recipient", [32]],
      ],
    },
  ],
]);

const AckSchema = new Map([
  [
    AckPayload,
    {
      kind: "struct",
      fields: [["ghost_id", [32]]],
    },
  ],
]);

const GhostAccountSchema = new Map([
  [
    GhostAccountData,
    {
      kind: "struct",
      fields: [
        ["ghost_id", [32]],
        ["initiator", [32]],
        ["source_token", [32]],
        ["destination_token", [32]],
        ["destination_chain", "u64"],
        ["destination_address", [64]],
        ["state", "u8"],
        ["amount", "u64"],
        ["lock_ts", "i64"],
        ["burn_ts", "i64"],
        ["mint_ts", "i64"],
        ["burn_proof", [32]],
        ["mint_proof", [32]],
        ["is_remote", "u8"],
        ["remote_ack", "u8"],
      ],
    },
  ],
]);

async function main() {
  const config = loadConfig();

  const evmProvider = new ethers.JsonRpcProvider(config.evmRpc);
  const evmWallet = new ethers.Wallet(config.relayerEvmKey, evmProvider);
  const evmGhost = new ethers.Contract(
    config.evmGhostWallet,
    GhostWalletArtifact.abi,
    evmWallet
  );
  const evmVerifier = new ethers.Contract(
    config.evmVerifier,
    GhostVerifierArtifact.abi,
    evmWallet
  );
  const evmZk = new ethers.Contract(config.evmZkSystem, ZKArtifact.abi, evmWallet);

  const solConnection = new Connection(config.solRpc, "confirmed");
  const solKeypair = Keypair.fromSecretKey(bs58.decode(config.relayerSolKey));
  const processedEvm = new Set<string>();
  const processedSol = new Set<string>();

  evmGhost.on("GhostBurned", async (ghostId: string) => {
    if (processedEvm.has(ghostId)) return;
    processedEvm.add(ghostId);
    try {
      await handleEvmBurn({
        ghostId,
        config,
        evmGhost,
        evmVerifier,
        evmZk,
        solConnection,
        solKeypair,
      });
    } catch (err) {
      processedEvm.delete(ghostId);
      console.error("[relay] failed to handle EVM burn", err);
    }
  });

  solConnection.onLogs(config.solProgramId, async (logInfo) => {
    for (const line of logInfo.logs) {
      const parsed = parseProgramLog(line);
      if (!parsed || parsed.event !== "ghost_burned") continue;
      const ghostId = Buffer.from(parsed.payload, "hex");
      const ghostHex = `0x${parsed.payload}`;
      if (processedSol.has(ghostHex)) continue;
      processedSol.add(ghostHex);
      try {
        await handleSolanaBurn({
          ghostIdBytes: ghostId,
          ghostHex,
          config,
          evmGhost,
          evmVerifier,
          evmZk,
          solConnection,
          solBasePubkey: solKeypair.publicKey,
        });
      } catch (err) {
        processedSol.delete(ghostHex);
        console.error("[relay] failed to handle Solana burn", err);
      }
    }
  });

  console.log("[relay] listening for EVM/Solana burns");
}

async function handleEvmBurn(args: {
  ghostId: string;
  config: CrossRelayConfig;
  evmGhost: ethers.Contract;
  evmVerifier: ethers.Contract;
  evmZk: ethers.Contract;
  solConnection: Connection;
  solKeypair: Keypair;
}) {
  const { ghostId, config, evmGhost, evmVerifier, evmZk, solConnection, solKeypair } = args;
  const ghost = await evmGhost.getGhost(ghostId);
  if (!ghost || ghost.state !== 2n) {
    return;
  }
  if (ghost.destinationChainId !== config.solChainId) {
    return;
  }

  const ghostBytes = ethers.getBytes(ghostId);
  const seed = ghostSeedFromId(ghostBytes);
  const ghostAccount = await ensureGhostAccount(
    solConnection,
    solKeypair,
    config.solProgramId,
    seed
  );

  const mirrorIx = new TransactionInstruction({
    programId: config.solProgramId,
    keys: [
      { pubkey: config.solConfigAccount, isSigner: false, isWritable: true },
      { pubkey: ghostAccount, isSigner: false, isWritable: true },
      { pubkey: solKeypair.publicKey, isSigner: true, isWritable: false },
    ],
    data: encodeMirrorIx({
      ghostId: ghostBytes,
      sourceChain: config.evmChainId,
      amount: ghost.amount,
      burnProof: ghost.burnProof,
      sourceToken: ghost.sourceToken,
      destinationToken: config.solMint.toBase58(),
    }),
  });

  const snarkProofId = await generateSnarkOnDest(
    evmZk,
    ghostId,
    ghost.amount,
    "relay-sol-mint"
  );
  const starkProofId = await generateStarkOnDest(evmZk, ghostId);

  const mintPayload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32"],
    [snarkProofId, starkProofId]
  );
  await evmVerifier.bindProof(ghostId, Stage.Mint, mintPayload);

  const mintIx = new TransactionInstruction({
    programId: config.solProgramId,
    keys: [
      { pubkey: config.solConfigAccount, isSigner: false, isWritable: true },
      { pubkey: ghostAccount, isSigner: false, isWritable: true },
      { pubkey: solKeypair.publicKey, isSigner: true, isWritable: false },
    ],
    data: encodeMintIx({
      ghostId: ghostBytes,
      mintProof: starkProofId,
      recipient: solKeypair.publicKey,
    }),
  });

  const tx = new Transaction().add(mirrorIx, mintIx);
  await sendAndConfirmTransaction(solConnection, tx, [solKeypair]);

  const ackIx = new TransactionInstruction({
    programId: config.solProgramId,
    keys: [
      { pubkey: config.solConfigAccount, isSigner: false, isWritable: false },
      { pubkey: ghostAccount, isSigner: false, isWritable: true },
      { pubkey: solKeypair.publicKey, isSigner: true, isWritable: false },
    ],
    data: encodeAckIx(ghostBytes),
  });
  await sendAndConfirmTransaction(solConnection, new Transaction().add(ackIx), [solKeypair]);

  const mintTx = await evmGhost.mintGhost(ghostId, mintPayload, ghost.evmDestination);
  await mintTx.wait();
  const ackTx = await evmGhost.confirmRemoteMint(ghostId);
  await ackTx.wait();
  console.log(`[relay] bridged EVM -> Solana ghost ${ghostId}`);
}

async function handleSolanaBurn(args: {
  ghostIdBytes: Buffer;
  ghostHex: string;
  config: CrossRelayConfig;
  evmGhost: ethers.Contract;
  evmVerifier: ethers.Contract;
  evmZk: ethers.Contract;
  solConnection: Connection;
  solBasePubkey: PublicKey;
}) {
  const { ghostIdBytes, ghostHex, config, evmGhost, evmVerifier, evmZk, solConnection, solBasePubkey } =
    args;
  const seed = ghostSeedFromId(ghostIdBytes);
  const ghostAccount = await PublicKey.createWithSeed(
    solBasePubkey,
    seed,
    config.solProgramId
  );
  const accountInfo = await solConnection.getAccountInfo(ghostAccount);
  if (!accountInfo) return;
  const ghost = deserializeUnchecked(
    GhostAccountSchema,
    GhostAccountData,
    accountInfo.data
  ) as GhostAccountData;

  const destinationChain = BigInt(ghost.destination_chain.toString());
  if (destinationChain !== config.evmChainId) {
    return;
  }

  const ghostIdHex = ghostHex;
  const ghostStruct = await evmGhost.getGhost(ghostIdHex);
  if (ghostStruct && ghostStruct.state !== 0n) {
    return;
  }

  const burnProofHex = `0x${Buffer.from(ghost.burn_proof).toString("hex")}`;
  const amount = BigInt(ghost.amount.toString());
  const burnTimestamp = BigInt(ghost.burn_ts.toString());
  const sourceToken = decodeEvmAddress(ghost.source_token);
  const destinationToken = decodeEvmAddress(ghost.destination_token);
  const recipient = decodeEvmAddress(ghost.destination_address);
  const destinationPayload = `0x${Buffer.from(ghost.destination_address).toString("hex")}`;

  const snarkProofId = await generateSnarkOnDest(
    evmZk,
    ghostIdHex,
    amount,
    "relay-evm-mint"
  );
  const starkProofId = await generateStarkOnDest(evmZk, ghostIdHex);

  const mintPayload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32"],
    [snarkProofId, starkProofId]
  );
  await evmVerifier.bindProof(ghostIdHex, Stage.Mint, mintPayload);
  const mirrorTx = await evmGhost.mirrorGhost(
    ghostIdHex,
    sourceToken,
    destinationToken,
    config.solChainId,
    config.evmChainId,
    destinationPayload,
    recipient,
    amount,
    burnProofHex,
    burnTimestamp
  );
  await mirrorTx.wait();
  const mintTx = await evmGhost.mintGhost(ghostIdHex, mintPayload, recipient);
  await mintTx.wait();
  await evmGhost.confirmRemoteMint(ghostIdHex);
  console.log(`[relay] bridged Solana -> EVM ghost ${ghostHex}`);
}

function parseProgramLog(line: string):
  | { event: string; payload: string }
  | null {
  const prefix = "Program log: data:";
  if (!line.startsWith(prefix)) return null;
  const encoded = line.slice(prefix.length).trim().split(" ");
  if (encoded.length < 2) return null;
  const event = Buffer.from(encoded[0], "base64").toString();
  const payload = Buffer.from(encoded[1], "base64").toString("hex");
  return { event, payload };
}

async function ensureGhostAccount(
  connection: Connection,
  payer: Keypair,
  programId: PublicKey,
  seed: string
): Promise<PublicKey> {
  const ghostAccount = await PublicKey.createWithSeed(payer.publicKey, seed, programId);
  const info = await connection.getAccountInfo(ghostAccount);
  if (info) return ghostAccount;
  const rent = await connection.getMinimumBalanceForRentExemption(GHOST_ACCOUNT_SPACE);
  const ix = SystemProgram.createAccountWithSeed({
    fromPubkey: payer.publicKey,
    newAccountPubkey: ghostAccount,
    basePubkey: payer.publicKey,
    seed,
    lamports: rent,
    space: GHOST_ACCOUNT_SPACE,
    programId,
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
  return ghostAccount;
}

function encodeMirrorIx(args: {
  ghostId: Uint8Array;
  sourceChain: bigint;
  amount: bigint;
  burnProof: string;
  sourceToken: string;
  destinationToken: string;
}) {
  const payload = new MirrorPayload({
    ghost_id: args.ghostId,
    source_chain: new BN(args.sourceChain.toString()),
    amount: new BN(args.amount.toString()),
    burn_proof: ethers.getBytes(args.burnProof),
    source_token: ethers.getBytes(ethers.zeroPadValue(args.sourceToken, 32)),
    destination_token: new PublicKey(args.destinationToken).toBytes(),
  });
  const data = serialize(MirrorSchema, payload);
  return Buffer.concat([Buffer.from([5]), Buffer.from(data)]);
}

function encodeMintIx(args: {
  ghostId: Uint8Array;
  mintProof: string;
  recipient: PublicKey;
}) {
  const payload = new MintPayload({
    ghost_id: args.ghostId,
    mint_proof: ethers.getBytes(args.mintProof),
    recipient: args.recipient.toBytes(),
  });
  const data = serialize(MintSchema, payload);
  return Buffer.concat([Buffer.from([6]), Buffer.from(data)]);
}

function encodeAckIx(ghostId: Uint8Array) {
  const payload = new AckPayload({ ghost_id: ghostId });
  const data = serialize(AckSchema, payload);
  return Buffer.concat([Buffer.from([7]), Buffer.from(data)]);
}

function ghostSeedFromId(ghostId: Uint8Array) {
  const hex = Buffer.from(ghostId).toString("hex");
  return `${GHOST_SEED_PREFIX}-${hex.slice(0, 30)}`;
}

function decodeEvmAddress(bytes: Uint8Array) {
  const slice = Buffer.from(bytes).subarray(0, 20);
  return ethers.getAddress(ethers.hexlify(slice));
}

async function generateSnarkOnDest(
  zkSystem: ethers.Contract,
  ghostId: string,
  amount: bigint,
  label: string
) {
  const commitment = ethers.keccak256(ethers.toUtf8Bytes(label));
  const eventTopic = ethers.id("SNARKProofGenerated(bytes32,bytes32)");
  const zkAddress = await zkSystem.getAddress();
  for (let salt = 1; salt < 64; salt++) {
    const tx = await zkSystem.generateSNARKProof(ghostId, amount, salt, commitment);
    const receipt = await tx.wait();
    for (const log of receipt?.logs || []) {
      if (log.address === zkAddress && log.topics[0] === eventTopic) {
        const parsed = zkSystem.interface.parseLog(log);
        const proofId = parsed.args.proofId as string;
        const ok = await zkSystem.verifySNARKProof(proofId);
        if (ok) {
          return proofId;
        }
      }
    }
  }
  throw new Error("relayer failed to craft SNARK proof on destination");
}

async function generateStarkOnDest(zkSystem: ethers.Contract, ghostId: string) {
  const eventTopic = ethers.id("STARKProofGenerated(bytes32,bytes32)");
  const zkAddress = await zkSystem.getAddress();
  const tx = await zkSystem.generateSTARKProof(
    ghostId,
    [ethers.keccak256(ethers.toUtf8Bytes("relay")), ethers.keccak256(ethers.toUtf8Bytes("burn"))],
    ethers.keccak256(ethers.toUtf8Bytes("relay-state"))
  );
  const receipt = await tx.wait();
  for (const log of receipt?.logs || []) {
    if (log.address === zkAddress && log.topics[0] === eventTopic) {
      const parsed = zkSystem.interface.parseLog(log);
      const proofId = parsed.args.proofId as string;
      await zkSystem.verifySTARKProof(proofId);
      return proofId;
    }
  }
  throw new Error("relayer failed to craft STARK proof on destination");
}

function loadConfig(): CrossRelayConfig {
  const required = [
    "EVM_GHOST_WALLET",
    "EVM_VERIFIER",
    "EVM_ZK_SYSTEM",
    "SOL_PROGRAM_ID",
    "SOL_CONFIG_ACCOUNT",
    "SOL_MINT_ADDRESS",
    "SOLANA_KEYPAIR",
  ];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing env ${key}`);
    }
  }
  return {
    evmRpc: process.env.EVM_RPC || "http://127.0.0.1:8545",
    solRpc: process.env.SOL_RPC || "http://127.0.0.1:8899",
    relayerEvmKey: process.env.RELAYER_KEY || HARDHAT_KEY,
    relayerSolKey: process.env.SOLANA_KEYPAIR!,
    evmGhostWallet: process.env.EVM_GHOST_WALLET!,
    evmVerifier: process.env.EVM_VERIFIER!,
    evmZkSystem: process.env.EVM_ZK_SYSTEM!,
    evmChainId: BigInt(process.env.EVM_CHAIN_ID || "31337"),
    solChainId: BigInt(process.env.SOLANA_CHAIN_ID || "1399811149"),
    solProgramId: new PublicKey(process.env.SOL_PROGRAM_ID!),
    solConfigAccount: new PublicKey(process.env.SOL_CONFIG_ACCOUNT!),
    solMint: new PublicKey(process.env.SOL_MINT_ADDRESS!),
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

