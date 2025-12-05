import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const wallet = new ethers.Wallet(process.env.RELAYER_KEY, provider);

const GHOST_WALLET = "0x070e199940D103b95D0EDA03E248b2653E88b231";
const MASTER_BRIDGE = "0x0D8d2b19fd342e637Eac41B8302aeD60f11e7bC8";

const ghostWalletAbi = [
  "function setLocalValidator(address validator, bool allowed) external",
  "function localValidators(address) view returns (bool)"
];

const ghostWallet = new ethers.Contract(GHOST_WALLET, ghostWalletAbi, wallet);

// Check if MasterBridge is validator
const isBridgeValidator = await ghostWallet.localValidators(MASTER_BRIDGE);
console.log("MasterBridge is GhostWallet validator:", isBridgeValidator);

if (!isBridgeValidator) {
  console.log("\nAdding MasterBridge as GhostWallet validator...");
  const tx = await ghostWallet.setLocalValidator(MASTER_BRIDGE, true);
  await tx.wait();
  console.log("✓ MasterBridge added as validator on GhostWallet");
} else {
  console.log("Already a validator");
}
