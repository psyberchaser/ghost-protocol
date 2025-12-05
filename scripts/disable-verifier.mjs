import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
const wallet = new ethers.Wallet(process.env.RELAYER_KEY, provider);

const GHOST_WALLET = "0x070e199940D103b95D0EDA03E248b2653E88b231";

const ghostWalletAbi = [
  "function setVerifier(address verifier_) external",
  "function verifier() view returns (address)"
];

const ghostWallet = new ethers.Contract(GHOST_WALLET, ghostWalletAbi, wallet);

const currentVerifier = await ghostWallet.verifier();
console.log("Current verifier:", currentVerifier);

if (currentVerifier !== ethers.ZeroAddress) {
  console.log("\nDisabling verifier for MVP demo...");
  const tx = await ghostWallet.setVerifier(ethers.ZeroAddress);
  await tx.wait();
  console.log("✓ Verifier disabled");
  
  const newVerifier = await ghostWallet.verifier();
  console.log("New verifier:", newVerifier);
} else {
  console.log("Verifier already disabled");
}
