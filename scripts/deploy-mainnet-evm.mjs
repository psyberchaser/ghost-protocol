/**
 * Deploy Ghost Bridge Contracts to Ethereum Mainnet
 * 
 * ⚠️  WARNING: This will spend REAL ETH!
 * 
 * Prerequisites:
 * 1. Set EVM_RPC to mainnet Alchemy endpoint
 * 2. Set RELAYER_KEY with funded wallet (needs ~0.1 ETH)
 * 3. Review contracts thoroughly before deployment
 * 
 * Usage:
 *   NETWORK=mainnet node scripts/deploy-mainnet-evm.mjs
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mainnet WETH address (canonical)
const MAINNET_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

async function confirmDeployment(provider, wallet) {
  const balance = await provider.getBalance(wallet.address);
  const gasPrice = (await provider.getFeeData()).gasPrice;
  
  console.log('\n' + '='.repeat(60));
  console.log('⚠️  MAINNET DEPLOYMENT WARNING');
  console.log('='.repeat(60));
  console.log(`Network: Ethereum Mainnet (Chain ID: 1)`);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
  console.log(`Gas Price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
  console.log(`Estimated Cost: ~0.05-0.1 ETH`);
  console.log('='.repeat(60));
  
  if (balance < ethers.parseEther('0.1')) {
    console.error('\n❌ Insufficient balance. Need at least 0.1 ETH for deployment.');
    process.exit(1);
  }
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question('\n🔐 Type "DEPLOY MAINNET" to confirm: ', (answer) => {
      rl.close();
      if (answer === 'DEPLOY MAINNET') {
        resolve(true);
      } else {
        console.log('Deployment cancelled.');
        process.exit(0);
      }
    });
  });
}

async function main() {
  console.log('\n🚀 Ghost Bridge - Mainnet EVM Deployment\n');
  
  // Validate environment
  if (!process.env.EVM_RPC || !process.env.EVM_RPC.includes('mainnet')) {
    console.error('❌ EVM_RPC must be a mainnet endpoint');
    console.error('   Expected: https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY');
    process.exit(1);
  }
  
  if (!process.env.RELAYER_KEY) {
    console.error('❌ RELAYER_KEY not set');
    process.exit(1);
  }
  
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
  const wallet = new ethers.Wallet(process.env.RELAYER_KEY, provider);
  
  // Verify we're on mainnet
  const network = await provider.getNetwork();
  if (network.chainId !== 1n) {
    console.error(`❌ Not connected to mainnet. Chain ID: ${network.chainId}`);
    process.exit(1);
  }
  
  await confirmDeployment(provider, wallet);
  
  console.log('\n📦 Loading contract artifacts...');
  
  // Load ABIs and bytecode from hardhat artifacts
  const artifactsDir = path.join(__dirname, '..', 'artifacts', 'contracts');
  
  const loadContract = (name) => {
    const artifactPath = path.join(artifactsDir, `${name}.sol`, `${name}.json`);
    if (!fs.existsSync(artifactPath)) {
      console.error(`❌ Artifact not found: ${artifactPath}`);
      console.error('   Run: npx hardhat compile');
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  };
  
  const ZKProofSystem = loadContract('ZKProofSystem');
  const GhostZKVerifier = loadContract('GhostZKVerifier');
  const GhostWallet = loadContract('GhostWallet');
  const MasterBridge = loadContract('MasterBridge');
  
  const deployed = {};
  
  // Deploy ZKProofSystem
  console.log('\n1️⃣  Deploying ZKProofSystem...');
  const zkFactory = new ethers.ContractFactory(ZKProofSystem.abi, ZKProofSystem.bytecode, wallet);
  const zkSystem = await zkFactory.deploy();
  await zkSystem.waitForDeployment();
  deployed.zkSystem = await zkSystem.getAddress();
  console.log(`   ✅ ZKProofSystem: ${deployed.zkSystem}`);
  
  // Deploy GhostZKVerifier
  console.log('\n2️⃣  Deploying GhostZKVerifier...');
  const verifierFactory = new ethers.ContractFactory(GhostZKVerifier.abi, GhostZKVerifier.bytecode, wallet);
  const verifier = await verifierFactory.deploy(deployed.zkSystem);
  await verifier.waitForDeployment();
  deployed.verifier = await verifier.getAddress();
  console.log(`   ✅ GhostZKVerifier: ${deployed.verifier}`);
  
  // Deploy GhostWallet
  console.log('\n3️⃣  Deploying GhostWallet...');
  const ghostFactory = new ethers.ContractFactory(GhostWallet.abi, GhostWallet.bytecode, wallet);
  const ghostWallet = await ghostFactory.deploy(deployed.verifier);
  await ghostWallet.waitForDeployment();
  deployed.ghostWallet = await ghostWallet.getAddress();
  console.log(`   ✅ GhostWallet: ${deployed.ghostWallet}`);
  
  // Deploy MasterBridge
  console.log('\n4️⃣  Deploying MasterBridge...');
  const bridgeFactory = new ethers.ContractFactory(MasterBridge.abi, MasterBridge.bytecode, wallet);
  const bridge = await bridgeFactory.deploy(deployed.ghostWallet, MAINNET_WETH);
  await bridge.waitForDeployment();
  deployed.bridge = await bridge.getAddress();
  console.log(`   ✅ MasterBridge: ${deployed.bridge}`);
  
  // Configure contracts
  console.log('\n5️⃣  Configuring contracts...');
  
  // Add relayer as validator
  const ghostWalletContract = new ethers.Contract(deployed.ghostWallet, GhostWallet.abi, wallet);
  await (await ghostWalletContract.addValidator(wallet.address)).wait();
  console.log(`   ✅ Added relayer as validator`);
  
  // Add bridge as validator
  await (await ghostWalletContract.addValidator(deployed.bridge)).wait();
  console.log(`   ✅ Added bridge as validator`);
  
  // Save deployment info
  const deploymentInfo = {
    network: 'mainnet',
    chainId: 1,
    deployedAt: new Date().toISOString(),
    deployer: wallet.address,
    contracts: {
      zkSystem: deployed.zkSystem,
      verifier: deployed.verifier,
      ghostWallet: deployed.ghostWallet,
      bridge: deployed.bridge,
      weth: MAINNET_WETH
    }
  };
  
  const deploymentPath = path.join(__dirname, '..', 'deployments', 'mainnet-evm.json');
  fs.mkdirSync(path.dirname(deploymentPath), { recursive: true });
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ MAINNET DEPLOYMENT COMPLETE');
  console.log('='.repeat(60));
  console.log('\nContract Addresses:');
  console.log(`  ZKProofSystem:   ${deployed.zkSystem}`);
  console.log(`  GhostZKVerifier: ${deployed.verifier}`);
  console.log(`  GhostWallet:     ${deployed.ghostWallet}`);
  console.log(`  MasterBridge:    ${deployed.bridge}`);
  console.log(`  WETH (existing): ${MAINNET_WETH}`);
  console.log('\n📁 Saved to: deployments/mainnet-evm.json');
  console.log('\n⚠️  Update config/networks.mainnet.json with these addresses!');
}

main().catch(console.error);

