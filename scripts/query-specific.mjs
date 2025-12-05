import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const wallet = new ethers.Wallet(process.env.RELAYER_KEY, provider);
const GHOST_WALLET = process.env.EVM_GHOST_WALLET;

const ghostWalletAbi = [
  "function getGhost(bytes32) view returns (tuple(address initiator, address sourceToken, address destinationToken, uint64 sourceChainId, uint64 destinationChainId, bytes destinationAddress, address evmDestination, uint256 amount, bytes32 amountCommitment, uint8 state, bool isRemote, bool remoteAck, uint64 createdAt, uint64 lockedAt, uint64 burnedAt, uint64 mintedAt, bytes32 lockProof, bytes32 burnProof, bytes32 mintProof))",
  "function confirmRemoteMint(bytes32 ghostId) external"
];

const ghostWallet = new ethers.Contract(GHOST_WALLET, ghostWalletAbi, wallet);
const states = ["None", "Created", "Locked", "Burned", "Minted", "Settled"];

// The IDs from dashboard (need full 32 bytes - pad with zeros for now to test)
// These are the partial IDs shown: 0x515e8a65, 0x6f3b11bd, 0x7caa8029

// First one we know:
const knownId = "0x515e8a65c2e4ac89907e14d57bfddd45e58b1c983ca19903da07a1cd26523f44";

console.log("Querying known ghost:", knownId.slice(0, 18) + "...");
const ghost1 = await ghostWallet.getGhost(knownId);
console.log("  State:", states[ghost1.state], "| Ack:", ghost1.remoteAck);

// The dashboard shows ghosts from localStorage
// The "Processing..." status is likely from the UI waiting for state updates
// Let's check if there are newer ghosts by scanning more blocks

const latest = await provider.getBlockNumber();
console.log("\nLatest block:", latest);
console.log("Scanning for any GhostInitiated events in recent blocks...\n");

// Scan 10 blocks at a time (within Alchemy limit)
for (let start = latest - 100; start < latest; start += 10) {
  try {
    const filter = ghostWallet.filters.GhostInitiated();
    const events = await ghostWallet.queryFilter(filter, start, Math.min(start + 9, latest));
    if (events.length > 0) {
      console.log(`Blocks ${start}-${start+9}: Found ${events.length} events`);
      for (const e of events) {
        console.log("  Ghost:", e.args.ghostId);
      }
    }
  } catch (e) {
    // Skip errors
  }
}

console.log("\nDone scanning.");
