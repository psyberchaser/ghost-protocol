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
console.log("Finding ALL ghosts in last 200 blocks...\n");

let found = [];
for (let start = latest - 200; start < latest; start += 10) {
  try {
    const events = await contract.queryFilter(contract.filters.GhostInitiated(), start, start + 9);
    for (const e of events) {
      found.push({ id: e.args.ghostId, block: e.blockNumber });
    }
  } catch {}
}

console.log("Found", found.length, "ghosts:\n");

for (const f of found) {
  const ghost = await contract.getGhost(f.id);
  console.log(f.id.slice(0, 18) + "...");
  console.log("  State:", states[ghost.state], "| Ack:", ghost.remoteAck);
}

if (found.length === 0) {
  console.log("No ghosts found. They may be older than 200 blocks.");
  console.log("The dashboard shows them from localStorage persistence.");
}
