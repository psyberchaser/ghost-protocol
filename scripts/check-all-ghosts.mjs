import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const GHOST_WALLET = "0x070e199940D103b95D0EDA03E248b2653E88b231";

const abi = [
  "function getGhost(bytes32) view returns (tuple(address initiator, address sourceToken, address destinationToken, uint64 sourceChainId, uint64 destinationChainId, bytes destinationAddress, address evmDestination, uint256 amount, bytes32 amountCommitment, uint8 state, bool isRemote, bool remoteAck, uint64 createdAt, uint64 lockedAt, uint64 burnedAt, uint64 mintedAt, bytes32 lockProof, bytes32 burnProof, bytes32 mintProof))",
  "event GhostInitiated(bytes32 indexed ghostId, address indexed initiator, uint256 amount)"
];

const contract = new ethers.Contract(GHOST_WALLET, abi, provider);
const states = ["None", "Created", "Locked", "Burned", "Minted", "Settled"];

// Known ghost IDs from dashboard
const ghostIds = [
  "0x515e8a65c2e4ac89907e14d57bfddd45e58b1c983ca19903da07a1cd26523f44",
  "0x6f3b11bd", // partial - need full ID
  "0x7caa8029"  // partial - need full ID
];

// Get full IDs from recent events
const latest = await provider.getBlockNumber();
const events = await contract.queryFilter(contract.filters.GhostInitiated(), latest - 500, latest);

console.log("Found", events.length, "ghost events\n");

for (const e of events) {
  const ghostId = e.args.ghostId;
  const ghost = await contract.getGhost(ghostId);
  
  console.log("Ghost:", ghostId.slice(0, 18) + "...");
  console.log("  State:", states[ghost.state], `(${ghost.state})`);
  console.log("  Amount:", ethers.formatEther(ghost.amount), "WETH");
  console.log("  Remote Ack:", ghost.remoteAck);
  console.log("  Lock Proof:", ghost.lockProof === ethers.ZeroHash ? "None" : "Set");
  console.log("  Burn Proof:", ghost.burnProof === ethers.ZeroHash ? "None" : "Set");
  console.log("");
}
