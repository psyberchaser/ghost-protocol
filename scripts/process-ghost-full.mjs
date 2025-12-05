import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const wallet = new ethers.Wallet(process.env.RELAYER_KEY, provider);

const MASTER_BRIDGE = "0x0D8d2b19fd342e637Eac41B8302aeD60f11e7bC8";
const GHOST_WALLET = "0x070e199940D103b95D0EDA03E248b2653E88b231";
const ZK_SYSTEM = "0x30336f7Eb94ECD28E480a21a3Cc5E905015962cF";
const VERIFIER = "0xa47deb4E56BAf5479E33a6AaD0F58F0F961B4e29";

// ABIs
const masterBridgeAbi = [
  "function approveStep(bytes32 ghostId, uint8 step, bytes payload) external"
];

const ghostWalletAbi = [
  "function getGhost(bytes32) view returns (tuple(address initiator, address sourceToken, address destinationToken, uint64 sourceChainId, uint64 destinationChainId, bytes destinationAddress, address evmDestination, uint256 amount, bytes32 amountCommitment, uint8 state, bool isRemote, bool remoteAck, uint64 createdAt, uint64 lockedAt, uint64 burnedAt, uint64 mintedAt, bytes32 lockProof, bytes32 burnProof, bytes32 mintProof))",
  "function verifier() view returns (address)"
];

// Full ZKProofSystem ABI with correct signature
const zkSystemAbi = [
  "function generateSNARKProof(bytes32 ghostId, uint256 hiddenAmount, uint256 salt, bytes32 commitment) external returns (bytes32)",
  "function generateSTARKProof(bytes32 ghostId, bytes32[] transactionHistory, bytes32 stateRoot) external returns (bytes32)",
  "function verifySNARKProof(bytes32 proofId) external returns (bool)",
  "function verifySTARKProof(bytes32 proofId) external returns (bool)",
  "function isSNARKVerified(bytes32 proofId) external view returns (bool)",
  "function isSTARKVerified(bytes32 proofId) external view returns (bool)",
  "event SNARKProofGenerated(bytes32 indexed proofId, bytes32 commitment)",
  "event STARKProofGenerated(bytes32 indexed proofId, bytes32 merkleRoot)"
];

const verifierAbi = [
  "function bindProof(bytes32 ghostId, uint8 stage, bytes payload) external",
  "function localValidators(address) view returns (bool)",
  "function setLocalValidator(address validator, bool allowed) external"
];

const masterBridge = new ethers.Contract(MASTER_BRIDGE, masterBridgeAbi, wallet);
const ghostWallet = new ethers.Contract(GHOST_WALLET, ghostWalletAbi, provider);
const zkSystem = new ethers.Contract(ZK_SYSTEM, zkSystemAbi, wallet);
const verifier = new ethers.Contract(VERIFIER, verifierAbi, wallet);

const ghostId = "0x515e8a65c2e4ac89907e14d57bfddd45e58b1c983ca19903da07a1cd26523f44";
const states = ["None", "Created", "Locked", "Burned", "Minted", "Settled"];
const Stage = { Lock: 0, Burn: 1, Mint: 2 };
const Step = { Lock: 0, Burn: 1, Mint: 2 };

async function main() {
  // Check current state
  let ghost = await ghostWallet.getGhost(ghostId);
  console.log("Ghost ID:", ghostId);
  console.log("Current state:", states[ghost.state], `(${ghost.state})`);
  console.log("Amount:", ethers.formatEther(ghost.amount), "WETH");
  console.log("Wallet:", wallet.address);

  // Check if we're a validator on the verifier
  const isVerifierValidator = await verifier.localValidators(wallet.address);
  console.log("\nVerifier validator status:", isVerifierValidator);
  
  if (!isVerifierValidator) {
    console.log("Adding wallet as verifier validator...");
    const tx = await verifier.setLocalValidator(wallet.address, true);
    await tx.wait();
    console.log("✓ Added as validator");
  }

  // Process LOCK stage
  if (ghost.state === 1n) {
    console.log("\n========== LOCK STAGE ==========");
    
    // Generate SNARK proof
    const salt = BigInt(Date.now());
    const commitment = ghost.amountCommitment || ethers.ZeroHash;
    
    console.log("Generating SNARK proof...");
    console.log("  ghostId:", ghostId);
    console.log("  amount:", ghost.amount.toString());
    console.log("  salt:", salt.toString());
    console.log("  commitment:", commitment);
    
    const snarkTx = await zkSystem.generateSNARKProof(
      ghostId,
      ghost.amount,
      salt,
      commitment
    );
    const snarkReceipt = await snarkTx.wait();
    console.log("SNARK tx:", snarkTx.hash);
    
    // Find proof ID from event
    let snarkProofId;
    for (const log of snarkReceipt.logs) {
      try {
        const parsed = zkSystem.interface.parseLog(log);
        if (parsed?.name === "SNARKProofGenerated") {
          snarkProofId = parsed.args.proofId;
          console.log("✓ SNARK proof generated:", snarkProofId);
          break;
        }
      } catch {}
    }
    
    if (!snarkProofId) {
      throw new Error("Failed to get SNARK proof ID from event");
    }
    
    // Verify SNARK
    console.log("\nVerifying SNARK proof...");
    const verifyTx = await zkSystem.verifySNARKProof(snarkProofId);
    await verifyTx.wait();
    
    const isVerified = await zkSystem.isSNARKVerified(snarkProofId);
    console.log("SNARK verified:", isVerified);
    
    if (!isVerified) {
      throw new Error("SNARK verification failed");
    }
    
    // Bind proof to verifier
    console.log("\nBinding proof to verifier...");
    const lockPayload = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [snarkProofId]);
    const bindTx = await verifier.bindProof(ghostId, Stage.Lock, lockPayload);
    await bindTx.wait();
    console.log("✓ Proof bound for Lock stage");
    
    // Approve lock step on MasterBridge
    console.log("\nApproving LOCK step on MasterBridge...");
    const approveTx = await masterBridge.approveStep(ghostId, Step.Lock, lockPayload);
    await approveTx.wait();
    console.log("✓ Lock step approved!");
    
    // Refresh state
    ghost = await ghostWallet.getGhost(ghostId);
    console.log("\nNew state:", states[ghost.state]);
  }

  // Process BURN stage
  if (ghost.state === 2n) {
    console.log("\n========== BURN STAGE ==========");
    
    // Generate STARK proof
    const txHistory = [
      ethers.keccak256(ethers.toUtf8Bytes("tx1-" + ghostId)),
      ethers.keccak256(ethers.toUtf8Bytes("tx2-" + ghostId))
    ];
    const stateRoot = ethers.keccak256(ethers.toUtf8Bytes("state-" + ghostId));
    
    console.log("Generating STARK proof...");
    const starkTx = await zkSystem.generateSTARKProof(ghostId, txHistory, stateRoot);
    const starkReceipt = await starkTx.wait();
    console.log("STARK tx:", starkTx.hash);
    
    // Find proof ID
    let starkProofId;
    for (const log of starkReceipt.logs) {
      try {
        const parsed = zkSystem.interface.parseLog(log);
        if (parsed?.name === "STARKProofGenerated") {
          starkProofId = parsed.args.proofId;
          console.log("✓ STARK proof generated:", starkProofId);
          break;
        }
      } catch {}
    }
    
    if (!starkProofId) {
      throw new Error("Failed to get STARK proof ID");
    }
    
    // Verify STARK
    console.log("\nVerifying STARK proof...");
    const verifyTx = await zkSystem.verifySTARKProof(starkProofId);
    await verifyTx.wait();
    
    const isVerified = await zkSystem.isSTARKVerified(starkProofId);
    console.log("STARK verified:", isVerified);
    
    if (!isVerified) {
      throw new Error("STARK verification failed");
    }
    
    // Bind proof
    console.log("\nBinding proof to verifier...");
    const burnPayload = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [starkProofId]);
    const bindTx = await verifier.bindProof(ghostId, Stage.Burn, burnPayload);
    await bindTx.wait();
    console.log("✓ Proof bound for Burn stage");
    
    // Approve burn step
    console.log("\nApproving BURN step...");
    const approveTx = await masterBridge.approveStep(ghostId, Step.Burn, burnPayload);
    await approveTx.wait();
    console.log("✓ Burn step approved!");
    
    ghost = await ghostWallet.getGhost(ghostId);
    console.log("\nNew state:", states[ghost.state]);
  }

  // Final status
  console.log("\n========== FINAL STATUS ==========");
  ghost = await ghostWallet.getGhost(ghostId);
  console.log("State:", states[ghost.state]);
  
  if (ghost.state === 3n) {
    console.log("\n✓ Ghost is BURNED and ready for cross-chain relay to Solana!");
    console.log("Destination chain:", ghost.destinationChainId.toString());
  }
}

main().catch(console.error);
