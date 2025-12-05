import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const wallet = new ethers.Wallet(process.env.RELAYER_KEY, provider);

const GHOST_WALLET = "0x070e199940D103b95D0EDA03E248b2653E88b231";

const ghostWalletAbi = [
  "function getGhost(bytes32) view returns (tuple(address initiator, address sourceToken, address destinationToken, uint64 sourceChainId, uint64 destinationChainId, bytes destinationAddress, address evmDestination, uint256 amount, bytes32 amountCommitment, uint8 state, bool isRemote, bool remoteAck, uint64 createdAt, uint64 lockedAt, uint64 burnedAt, uint64 mintedAt, bytes32 lockProof, bytes32 burnProof, bytes32 mintProof))"
];

const ghostWallet = new ethers.Contract(GHOST_WALLET, ghostWalletAbi, provider);
const ghostId = "0x515e8a65c2e4ac89907e14d57bfddd45e58b1c983ca19903da07a1cd26523f44";
const states = ["None", "Created", "Locked", "Burned", "Minted", "Settled"];

const ghost = await ghostWallet.getGhost(ghostId);
console.log("Ghost ID:", ghostId);
console.log("Current state:", states[ghost.state], `(${ghost.state})`);
console.log("Amount:", ethers.formatEther(ghost.amount), "WETH");
console.log("Destination chain:", ghost.destinationChainId.toString());
console.log("Is Remote:", ghost.isRemote);
console.log("Remote Ack:", ghost.remoteAck);
console.log("Lock proof:", ghost.lockProof);
console.log("Burn proof:", ghost.burnProof);
