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

const latest = await provider.getBlockNumber();
console.log("Latest block:", latest);

// Check last 50 blocks one at a time (Alchemy limit workaround)
let found = [];
for (let b = latest; b > latest - 50 && found.length < 10; b--) {
  try {
    const events = await contract.queryFilter(contract.filters.GhostInitiated(), b, b);
    for (const e of events) {
      found.push({ ghostId: e.args.ghostId, block: b });
    }
  } catch {}
}

console.log("\nFound", found.length, "recent ghosts:");
for (const f of found) {
  const ghost = await contract.getGhost(f.ghostId);
  console.log(`\n${f.ghostId.slice(0,18)}... (block ${f.block})`);
  console.log(`  State: ${states[ghost.state]} | Ack: ${ghost.remoteAck}`);
}
