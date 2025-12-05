import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Sepolia WETH address (official)
const SEPOLIA_WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  
  console.log("=".repeat(60));
  console.log("Ghost Bridge - Deployment Script");
  console.log("=".repeat(60));
  console.log(`Network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
  console.log("=".repeat(60));

  if (balance < ethers.parseEther("0.1")) {
    console.log("WARNING: Low balance. You may need more ETH for deployment.");
  }

  // Determine WETH address
  let wethAddress: string;
  if (network.chainId === 11155111n) {
    // Sepolia - use official WETH
    wethAddress = SEPOLIA_WETH;
    console.log(`Using Sepolia WETH: ${wethAddress}`);
  } else {
    // Local/other - deploy our own WETH
    console.log("Deploying WETH...");
    const WETH = await ethers.getContractFactory("WETH");
    const weth = await WETH.deploy();
    await weth.waitForDeployment();
    wethAddress = await weth.getAddress();
    console.log(`WETH deployed: ${wethAddress}`);
  }

  // 1. Deploy ZK Proof System (mock)
  console.log("\n1. Deploying ZKProofSystem...");
  const ZKProofSystem = await ethers.getContractFactory("ZKProofSystem");
  const zkSystem = await ZKProofSystem.deploy();
  await zkSystem.waitForDeployment();
  const zkAddress = await zkSystem.getAddress();
  console.log(`   ZKProofSystem: ${zkAddress}`);

  // 2. Deploy GhostZKVerifier
  console.log("\n2. Deploying GhostZKVerifier...");
  const GhostZKVerifier = await ethers.getContractFactory("GhostZKVerifier");
  const verifier = await GhostZKVerifier.deploy(deployer.address, zkAddress);
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log(`   GhostZKVerifier: ${verifierAddress}`);

  // 3. Deploy ValidatorSlashing (using WETH as staking token for simplicity)
  console.log("\n3. Deploying ValidatorSlashing...");
  const ValidatorSlashing = await ethers.getContractFactory("ValidatorSlashing");
  const validators = await ValidatorSlashing.deploy(wethAddress);
  await validators.waitForDeployment();
  const validatorsAddress = await validators.getAddress();
  console.log(`   ValidatorSlashing: ${validatorsAddress}`);

  // 4. Deploy GhostWallet
  console.log("\n4. Deploying GhostWallet...");
  const GhostWallet = await ethers.getContractFactory("GhostWallet");
  const ghostWallet = await GhostWallet.deploy(
    deployer.address,
    verifierAddress,
    validatorsAddress
  );
  await ghostWallet.waitForDeployment();
  const ghostWalletAddress = await ghostWallet.getAddress();
  console.log(`   GhostWallet: ${ghostWalletAddress}`);

  // 5. Deploy MasterBridge
  console.log("\n5. Deploying MasterBridge...");
  const MasterBridge = await ethers.getContractFactory("MasterBridge");
  const bridge = await MasterBridge.deploy(deployer.address, ghostWalletAddress, wethAddress);
  await bridge.waitForDeployment();
  const bridgeAddress = await bridge.getAddress();
  console.log(`   MasterBridge: ${bridgeAddress}`);

  // 6. Deploy test token (for ERC20 bridging demo)
  console.log("\n6. Deploying GhostERC20 (test token)...");
  const GhostERC20 = await ethers.getContractFactory("GhostERC20");
  const token = await GhostERC20.deploy("Ghost Test Token", "GTT", deployer.address);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`   GhostERC20: ${tokenAddress}`);

  // Configuration
  console.log("\n7. Configuring contracts...");

  // Set deployer as local validator on GhostWallet
  console.log("   - Setting deployer as validator on GhostWallet...");
  await (await ghostWallet.setLocalValidator(deployer.address, true)).wait();

  // Set deployer as local validator on MasterBridge
  console.log("   - Setting deployer as validator on MasterBridge...");
  await (await bridge.setLocalValidator(deployer.address, true)).wait();

  // Set deployer as local validator on Verifier
  console.log("   - Setting deployer as validator on Verifier...");
  await (await verifier.setLocalValidator(deployer.address, true)).wait();

  // Add supported tokens
  console.log("   - Adding WETH as supported token...");
  await (await bridge.setSupportedToken(wethAddress, true)).wait();
  
  console.log("   - Adding GTT as supported token...");
  await (await bridge.setSupportedToken(tokenAddress, true)).wait();

  // Mint test tokens to deployer
  console.log("   - Minting 10,000 GTT to deployer...");
  await (await token.mint(deployer.address, ethers.parseEther("10000"))).wait();

  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));

  const deployment = {
    network: network.name,
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    contracts: {
      WETH: wethAddress,
      ZKProofSystem: zkAddress,
      GhostZKVerifier: verifierAddress,
      ValidatorSlashing: validatorsAddress,
      GhostWallet: ghostWalletAddress,
      MasterBridge: bridgeAddress,
      GhostERC20: tokenAddress,
    },
    timestamp: new Date().toISOString(),
  };

  // Print summary
  console.log("\nContract Addresses:");
  console.log("-".repeat(60));
  Object.entries(deployment.contracts).forEach(([name, addr]) => {
    console.log(`${name.padEnd(20)} ${addr}`);
  });

  // Save deployment info
  const deploymentPath = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentPath)) {
    fs.mkdirSync(deploymentPath, { recursive: true });
  }
  
  const filename = `${network.name}-${Date.now()}.json`;
  fs.writeFileSync(
    path.join(deploymentPath, filename),
    JSON.stringify(deployment, null, 2)
  );
  console.log(`\nDeployment saved to: deployments/${filename}`);

  // Print .env values
  console.log("\n" + "=".repeat(60));
  console.log("Add these to your .env files:");
  console.log("=".repeat(60));
  
  console.log("\n# For ghost-mvp/.env (relayer):");
  console.log(`EVM_GHOST_WALLET=${ghostWalletAddress}`);
  console.log(`EVM_BRIDGE=${bridgeAddress}`);
  console.log(`EVM_VERIFIER=${verifierAddress}`);
  console.log(`EVM_ZK_SYSTEM=${zkAddress}`);
  console.log(`EVM_WETH=${wethAddress}`);
  
  console.log("\n# For ghost-mvp/dashboard/.env:");
  console.log(`VITE_EVM_GHOST_ADDRESS=${ghostWalletAddress}`);
  console.log(`VITE_EVM_BRIDGE_ADDRESS=${bridgeAddress}`);
  console.log(`VITE_EVM_VALIDATOR_ADDRESS=${validatorsAddress}`);
  console.log(`VITE_EVM_TOKEN_ADDRESS=${tokenAddress}`);

  console.log("\n" + "=".repeat(60));
  console.log("You now have 10,000 GTT tokens to test bridging!");
  console.log("You can also bridge native ETH using bridgeETH()");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

