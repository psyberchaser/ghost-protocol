import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const wallet = new ethers.Wallet(process.env.RELAYER_KEY, provider);

const GHOST_WALLET = "0x070e199940D103b95D0EDA03E248b2653E88b231";
const ghostWalletAbi = [
  "function confirmRemoteMint(bytes32 ghostId) external",
  "function getGhost(bytes32) view returns (tuple(address initiator, address sourceToken, address destinationToken, uint64 sourceChainId, uint64 destinationChainId, bytes destinationAddress, address evmDestination, uint256 amount, bytes32 amountCommitment, uint8 state, bool isRemote, bool remoteAck, uint64 createdAt, uint64 lockedAt, uint64 burnedAt, uint64 mintedAt, bytes32 lockProof, bytes32 burnProof, bytes32 mintProof))"
];

const ghostWallet = new ethers.Contract(GHOST_WALLET, ghostWalletAbi, wallet);
const ghostId = "0x515e8a65c2e4ac89907e14d57bfddd45e58b1c983ca19903da07a1cd26523f44";

console.log("Acknowledging remote mint on EVM...");
const tx = await ghostWallet.confirmRemoteMint(ghostId);
console.log("Tx:", tx.hash);
await tx.wait();
console.log("✓ Remote mint acknowledged!");

const ghost = await ghostWallet.getGhost(ghostId);
const states = ["None", "Created", "Locked", "Burned", "Minted", "Settled"];
console.log("\nFinal state:", states[ghost.state]);
console.log("Remote Ack:", ghost.remoteAck);
