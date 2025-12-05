import { ethers } from "ethers";
import GhostWalletArtifact from "../artifacts/contracts/GhostWallet.sol/GhostWallet.json";
import GhostVerifierArtifact from "../artifacts/contracts/verifiers/GhostZKVerifier.sol/GhostZKVerifier.json";
import ZKArtifact from "../artifacts/contracts/zk/ZKProofSystem.sol/ZKProofSystem.json";

const HARDHAT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const Stage = {
  Lock: 0,
  Burn: 1,
  Mint: 2,
} as const;

type RelayConfig = {
  sourceRpc: string;
  destRpc: string;
  relayerKey: string;
  sourceGhostWallet: string;
  destGhostWallet: string;
  sourceVerifier: string;
  destVerifier: string;
  destZkSystem: string;
};

async function main() {
  const config = loadConfig();

  const sourceProvider = new ethers.JsonRpcProvider(config.sourceRpc);
  const destProvider = new ethers.JsonRpcProvider(config.destRpc);
  const relayerSource = new ethers.Wallet(config.relayerKey, sourceProvider);
  const relayerDest = new ethers.Wallet(config.relayerKey, destProvider);

  const sourceWallet = new ethers.Contract(
    config.sourceGhostWallet,
    GhostWalletArtifact.abi,
    relayerSource
  );
  const destWallet = new ethers.Contract(
    config.destGhostWallet,
    GhostWalletArtifact.abi,
    relayerDest
  );
  const sourceVerifier = new ethers.Contract(
    config.sourceVerifier,
    GhostVerifierArtifact.abi,
    relayerSource
  );
  const destVerifier = new ethers.Contract(
    config.destVerifier,
    GhostVerifierArtifact.abi,
    relayerDest
  );
  const destZkSystem = new ethers.Contract(
    config.destZkSystem,
    ZKArtifact.abi,
    relayerDest
  );

  console.log("[relayer] listening for GhostBurned events on", config.sourceGhostWallet);

  sourceWallet.on("GhostBurned", async (ghostId: string) => {
    try {
      console.log(`[relayer] detected burn ${ghostId}`);
      await relayGhost({
        ghostId,
        sourceWallet,
        destWallet,
        sourceVerifier,
        destVerifier,
        destZkSystem,
        relayerDest,
      });
    } catch (err) {
      console.error(`[relayer] failed to relay ghost ${ghostId}`, err);
    }
  });
}

async function relayGhost(args: {
  ghostId: string;
  sourceWallet: ethers.Contract;
  destWallet: ethers.Contract;
  sourceVerifier: ethers.Contract;
  destVerifier: ethers.Contract;
  destZkSystem: ethers.Contract;
  relayerDest: ethers.Wallet;
}) {
  const { ghostId, sourceWallet, destWallet, sourceVerifier, destVerifier, destZkSystem } = args;
  const ghost = await sourceWallet.getGhost(ghostId);
  if (!ghost || ghost.state !== 2) {
    throw new Error("ghost not in burned state");
  }

  const burnProofHash: string = ghost.burnProof;
  const burnTimestamp: bigint = ghost.burnedAt;

  const mirrorTx = await destWallet.mirrorGhost(
    ghostId,
    ghost.sourceToken,
    ghost.destinationToken,
    ghost.sourceChainId,
    ghost.destinationChainId,
    ghost.destinationAddress,
    ghost.evmDestination,
    ghost.amount,
    burnProofHash,
    burnTimestamp
  );
  await mirrorTx.wait();
  console.log(`[relayer] mirrored ghost ${ghostId} onto destination chain`);

  const snarkProofId = await generateSnarkOnDest(destZkSystem, ghostId, ghost.amount, "relay-mint");
  const starkProofId = await generateStarkOnDest(destZkSystem, ghostId);

  const mintPayload = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32"],
    [snarkProofId, starkProofId]
  );
  await destVerifier.bindProof(ghostId, Stage.Mint, mintPayload);
  console.log(`[relayer] registered mint proofs for ${ghostId}`);

  const mintTx = await destWallet.mintGhost(ghostId, mintPayload, ghost.evmDestination);
  await mintTx.wait();
  console.log(`[relayer] minted ghost ${ghostId} on destination wallet`);

  const ackTx = await sourceWallet.confirmRemoteMint(ghostId);
  await ackTx.wait();
  console.log(`[relayer] acknowledged remote mint for ${ghostId}`);
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

function loadConfig(): RelayConfig {
  const required = [
    "SOURCE_GHOST_WALLET",
    "DEST_GHOST_WALLET",
    "SOURCE_VERIFIER",
    "DEST_VERIFIER",
    "DEST_ZK_SYSTEM",
  ];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var ${key}`);
    }
  }
  return {
    sourceRpc: process.env.CHAIN_A_RPC || "http://127.0.0.1:8545",
    destRpc: process.env.CHAIN_B_RPC || "http://127.0.0.1:9545",
    relayerKey: process.env.RELAYER_KEY || HARDHAT_KEY,
    sourceGhostWallet: process.env.SOURCE_GHOST_WALLET!,
    destGhostWallet: process.env.DEST_GHOST_WALLET!,
    sourceVerifier: process.env.SOURCE_VERIFIER!,
    destVerifier: process.env.DEST_VERIFIER!,
    destZkSystem: process.env.DEST_ZK_SYSTEM!,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

