import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const wallet = new ethers.Wallet(process.env.RELAYER_KEY, provider);

const GHOST_WALLET = "0x070e199940D103b95D0EDA03E248b2653E88b231";
const MASTER_BRIDGE = "0x0D8d2b19fd342e637Eac41B8302aeD60f11e7bC8";

const ghostWalletAbi = [
  "function setLocalValidator(address validator, bool allowed) external",
  "function localValidators(address) view returns (bool)",
  "function owner() view returns (address)"
];

const masterBridgeAbi = [
  "function setLocalValidator(address validator, bool allowed) external",
  "function localValidators(address) view returns (bool)",
  "function owner() view returns (address)"
];

const ghostWallet = new ethers.Contract(GHOST_WALLET, ghostWalletAbi, wallet);
const masterBridge = new ethers.Contract(MASTER_BRIDGE, masterBridgeAbi, wallet);

console.log("Relayer address:", wallet.address);

// Check ownership
const gwOwner = await ghostWallet.owner();
const mbOwner = await masterBridge.owner();
console.log("GhostWallet owner:", gwOwner);
console.log("MasterBridge owner:", mbOwner);
console.log("Are we owner?", gwOwner.toLowerCase() === wallet.address.toLowerCase());

// Check if already validator
const isGwValidator = await ghostWallet.localValidators(wallet.address);
const isMbValidator = await masterBridge.localValidators(wallet.address);
console.log("\nCurrent validator status:");
console.log("- GhostWallet:", isGwValidator);
console.log("- MasterBridge:", isMbValidator);

if (!isGwValidator) {
  console.log("\nAdding as GhostWallet validator...");
  const tx1 = await ghostWallet.setLocalValidator(wallet.address, true);
  await tx1.wait();
  console.log("✓ Added to GhostWallet");
}

if (!isMbValidator) {
  console.log("\nAdding as MasterBridge validator...");
  const tx2 = await masterBridge.setLocalValidator(wallet.address, true);
  await tx2.wait();
  console.log("✓ Added to MasterBridge");
}

console.log("\nDone! Relayer is now a validator.");
