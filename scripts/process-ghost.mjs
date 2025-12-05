import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const wallet = new ethers.Wallet(process.env.RELAYER_KEY, provider);

const MASTER_BRIDGE = "0x0D8d2b19fd342e637Eac41B8302aeD60f11e7bC8";
const GHOST_WALLET = "0x070e199940D103b95D0EDA03E248b2653E88b231";
const ZK_SYSTEM = "0x30336f7Eb94ECD28E480a21a3Cc5E905015962cF";
const VERIFIER = "0xa47deb4E56BAf5479E33a6AaD0F58F0F961B4e29";

const masterBridgeAbi = [
  "function approveStep(bytes32 ghostId, uint8 step, bytes payload) external"
];

const ghostWalletAbi = [
  "function getGhost(bytes32) view returns (tuple(address initiator, address sourceToken, address destinationToken, uint64 sourceChainId, uint64 destinationChainId, bytes destinationAddress, address evmDestination, uint256 amount, bytes32 amountCommitment, uint8 state, bool isRemote, bool remoteAck, uint64 createdAt, uint64 lockedAt, uint64 burnedAt, uint64 mintedAt, bytes32 lockProof, bytes32 burnProof, bytes32 mintProof))",
  "function verifier() view returns (address)"
];

const zkSystemAbi = [
  "function generateSNARKProof(bytes32 ghostId, uint256 amount, bytes32 commitment) external returns (bytes32)",
  "event SNARKProofGenerated(bytes32 indexed ghostId, bytes32 proofHash)"
];

const verifierAbi = [
  "function bindProof(bytes32 ghostId, uint8 stage, bytes32 snarkProof, bytes32 starkProof) external",
  "function verifyLockProof(bytes32 ghostId, bytes proof) view returns (bool)"
];

const masterBridge = new ethers.Contract(MASTER_BRIDGE, masterBridgeAbi, wallet);
const ghostWallet = new ethers.Contract(GHOST_WALLET, ghostWalletAbi, provider);
const zkSystem = new ethers.Contract(ZK_SYSTEM, zkSystemAbi, wallet);
const verifier = new ethers.Contract(VERIFIER, verifierAbi, wallet);

const ghostId = "0x515e8a65c2e4ac89907e14d57bfddd45e58b1c983ca19903da07a1cd26523f44";
const states = ["None", "Created", "Locked", "Burned", "Minted", "Settled"];

// Check current state
let ghost = await ghostWallet.getGhost(ghostId);
console.log("Ghost ID:", ghostId);
console.log("Current state:", states[ghost.state], `(${ghost.state})`);
console.log("Amount:", ethers.formatEther(ghost.amount), "WETH");

// Check if verifier is set
const verifierAddr = await ghostWallet.verifier();
console.log("Verifier address:", verifierAddr);

if (verifierAddr !== ethers.ZeroAddress) {
  console.log("\nVerifier is set - need to generate ZK proofs first");
  
  // Stage enum: Lock=0, Burn=1, Mint=2
  const Stage = { Lock: 0, Burn: 1, Mint: 2 };
  
  if (ghost.state === 1n) { // Created - need Lock proof
    console.log("\n→ Generating SNARK proof for Lock...");
    
    // Generate SNARK proof
    const tx1 = await zkSystem.generateSNARKProof(
      ghostId, 
      ghost.amount, 
      ghost.amountCommitment || ethers.ZeroHash
    );
    const receipt = await tx1.wait();
    
    // Get proof hash from event
    const proofEvent = receipt.logs.find(log => {
      try {
        const parsed = zkSystem.interface.parseLog(log);
        return parsed?.name === "SNARKProofGenerated";
      } catch { return false; }
    });
    
    let snarkProof;
    if (proofEvent) {
      const parsed = zkSystem.interface.parseLog(proofEvent);
      snarkProof = parsed.args.proofHash;
      console.log("SNARK proof generated:", snarkProof);
    } else {
      // Fallback - compute expected proof hash
      snarkProof = ethers.keccak256(ethers.solidityPacked(
        ["bytes32", "uint256", "bytes32"],
        [ghostId, ghost.amount, ghost.amountCommitment || ethers.ZeroHash]
      ));
      console.log("SNARK proof (computed):", snarkProof);
    }
    
    // Generate STARK proof (just use a hash for mock)
    const starkProof = ethers.keccak256(ethers.toUtf8Bytes("stark-lock-" + ghostId));
    console.log("STARK proof:", starkProof);
    
    // Bind proofs to verifier
    console.log("\n→ Binding proofs to verifier...");
    const tx2 = await verifier.bindProof(ghostId, Stage.Lock, snarkProof, starkProof);
    await tx2.wait();
    console.log("✓ Proofs bound for Lock stage");
    
    // Now approve the lock step
    console.log("\n→ Approving LOCK step...");
    const lockPayload = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [snarkProof, starkProof]
    );
    const tx3 = await masterBridge.approveStep(ghostId, 0, lockPayload);
    console.log("Tx sent:", tx3.hash);
    await tx3.wait();
    console.log("✓ Lock approved!");
    
    ghost = await ghostWallet.getGhost(ghostId);
    console.log("New state:", states[ghost.state]);
  }
}

console.log("\nFinal state:", states[Number(ghost.state)]);
