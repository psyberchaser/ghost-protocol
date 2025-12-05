import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const GHOST_WALLET = process.env.EVM_GHOST_WALLET;

const abi = [
  "function getGhost(bytes32) view returns (tuple(address initiator, address sourceToken, address destinationToken, uint64 sourceChainId, uint64 destinationChainId, bytes destinationAddress, address evmDestination, uint256 amount, bytes32 amountCommitment, uint8 state, bool isRemote, bool remoteAck, uint64 createdAt, uint64 lockedAt, uint64 burnedAt, uint64 mintedAt, bytes32 lockProof, bytes32 burnProof, bytes32 mintProof))",
  "event GhostInitiated(bytes32 indexed ghostId, address indexed initiator, uint256 amount)"
];

const contract = new ethers.Contract(GHOST_WALLET, abi, provider);
const states = ["None", "Created", "Locked", "Burned", "Minted", "Settled"];

const latest = await provider.getBlockNumber();
console.log("Latest block:", latest);
console.log("Scanning for ghost 0xa48a10d2...\n");

// Scan 100 blocks, 10 at a time
for (let start = latest - 100; start < latest; start += 10) {
  try {
    const events = await contract.queryFilter(contract.filters.GhostInitiated(), start, start + 9);
    for (const e of events) {
      if (e.args.ghostId.toLowerCase().startsWith("0xa48a10d2")) {
        console.log("FOUND!");
        console.log("Ghost ID:", e.args.ghostId);
        
        const ghost = await contract.getGhost(e.args.ghostId);
        console.log("\nEVM Status:");
        console.log("  State:", states[ghost.state]);
        console.log("  Remote Ack:", ghost.remoteAck);
        console.log("  Lock Proof:", ghost.lockProof !== ethers.ZeroHash ? "SET" : "None");
        console.log("  Burn Proof:", ghost.burnProof !== ethers.ZeroHash ? "SET" : "None");
        
        if (ghost.state === 3n && !ghost.remoteAck) {
          console.log("\n→ Ghost is BURNED but needs Solana relay + EVM ack");
        } else if (ghost.remoteAck) {
          console.log("\n→ Fully complete!");
        }
        process.exit(0);
      }
    }
  } catch {}
}

console.log("Not found in last 100 blocks");
