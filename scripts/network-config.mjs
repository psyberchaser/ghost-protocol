/**
 * Network Configuration Loader
 * 
 * Usage:
 *   NETWORK=testnet node scripts/relayer.mjs
 *   NETWORK=mainnet node scripts/relayer.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadNetworkConfig() {
  const network = process.env.NETWORK || 'testnet';
  const configPath = path.join(__dirname, '..', 'config', `networks.${network}.json`);
  
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Network config not found: ${configPath}`);
    console.error(`   Available networks: testnet, mainnet`);
    process.exit(1);
  }
  
  const networkConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  console.log(`\n🌐 Network: ${networkConfig.displayName}`);
  console.log(`   EVM: ${networkConfig.evm.name} (Chain ID: ${networkConfig.evm.chainId})`);
  console.log(`   Solana: ${networkConfig.solana.name}`);
  
  if (networkConfig.features.jupiterSwap) {
    console.log(`   Jupiter: ✅ Enabled`);
  } else {
    console.log(`   Jupiter: ❌ Disabled (${networkConfig.features.jupiterNote})`);
  }
  
  return networkConfig;
}

export function getEvmConfig(networkConfig) {
  return {
    rpc: process.env.EVM_RPC,
    chainId: networkConfig.evm.chainId,
    explorer: networkConfig.evm.explorer,
    contracts: networkConfig.evm.contracts
  };
}

export function getSolanaConfig(networkConfig) {
  return {
    rpc: process.env.SOL_RPC,
    chainId: networkConfig.solana.chainId,
    explorer: networkConfig.solana.explorer,
    program: networkConfig.solana.program
  };
}

export function validateMainnetConfig(networkConfig) {
  if (networkConfig.network !== 'mainnet') return true;
  
  const errors = [];
  
  // Check EVM contracts are deployed
  if (!networkConfig.evm.contracts.ghostWallet) {
    errors.push('EVM GhostWallet not deployed');
  }
  if (!networkConfig.evm.contracts.bridge) {
    errors.push('EVM Bridge not deployed');
  }
  
  // Check Solana program is deployed
  if (!networkConfig.solana.program.id) {
    errors.push('Solana program not deployed');
  }
  
  if (errors.length > 0) {
    console.error('\n❌ Mainnet configuration incomplete:');
    errors.forEach(e => console.error(`   - ${e}`));
    console.error('\n   Run deployment scripts first:');
    console.error('   npm run deploy:evm:mainnet');
    console.error('   npm run deploy:solana:mainnet');
    return false;
  }
  
  return true;
}

