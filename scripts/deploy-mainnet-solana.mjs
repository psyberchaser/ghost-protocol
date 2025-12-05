/**
 * Deploy Ghost Bridge Program to Solana Mainnet
 * 
 * ⚠️  WARNING: This will spend REAL SOL!
 * 
 * Prerequisites:
 * 1. Build program: cd solana-program && cargo build-sbf
 * 2. Set SOL_RPC to mainnet Alchemy endpoint
 * 3. Set SOLANA_KEYPAIR with funded wallet (needs ~3 SOL)
 * 
 * Usage:
 *   NETWORK=mainnet node scripts/deploy-mainnet-solana.mjs
 */

import { 
  Connection, 
  Keypair, 
  PublicKey,
  BpfLoader,
  BPF_LOADER_PROGRAM_ID,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import { serialize } from 'borsh';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import bs58 from 'bs58';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Borsh schema for initialization
class InitializeInstruction {
  constructor(props) {
    this.variant = 0;
    this.admin = props.admin;
    this.solana_chain_id = props.solana_chain_id;
  }
}

const InitializeSchema = {
  struct: {
    variant: 'u8',
    admin: { array: { type: 'u8', len: 32 } },
    solana_chain_id: 'u64'
  }
};

async function confirmDeployment(connection, wallet) {
  const balance = await connection.getBalance(wallet.publicKey);
  
  console.log('\n' + '='.repeat(60));
  console.log('⚠️  SOLANA MAINNET DEPLOYMENT WARNING');
  console.log('='.repeat(60));
  console.log(`Network: Solana Mainnet`);
  console.log(`Deployer: ${wallet.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  console.log(`Estimated Cost: ~2-3 SOL`);
  console.log('='.repeat(60));
  
  if (balance < 3 * 1e9) {
    console.error('\n❌ Insufficient balance. Need at least 3 SOL for deployment.');
    process.exit(1);
  }
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question('\n🔐 Type "DEPLOY SOLANA MAINNET" to confirm: ', (answer) => {
      rl.close();
      if (answer === 'DEPLOY SOLANA MAINNET') {
        resolve(true);
      } else {
        console.log('Deployment cancelled.');
        process.exit(0);
      }
    });
  });
}

async function main() {
  console.log('\n🚀 Ghost Bridge - Mainnet Solana Deployment\n');
  
  // Validate environment
  if (!process.env.SOL_RPC || !process.env.SOL_RPC.includes('mainnet')) {
    console.error('❌ SOL_RPC must be a mainnet endpoint');
    console.error('   Expected: https://solana-mainnet.g.alchemy.com/v2/YOUR_KEY');
    process.exit(1);
  }
  
  if (!process.env.SOLANA_KEYPAIR) {
    console.error('❌ SOLANA_KEYPAIR not set');
    process.exit(1);
  }
  
  // Load keypair
  const secretKey = bs58.decode(process.env.SOLANA_KEYPAIR);
  const wallet = Keypair.fromSecretKey(secretKey);
  
  const connection = new Connection(process.env.SOL_RPC, 'confirmed');
  
  // Verify we're on mainnet
  const genesisHash = await connection.getGenesisHash();
  const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  
  if (genesisHash !== MAINNET_GENESIS) {
    console.error('❌ Not connected to Solana mainnet');
    console.error(`   Genesis hash: ${genesisHash}`);
    process.exit(1);
  }
  
  await confirmDeployment(connection, wallet);
  
  // Check for compiled program
  const programPath = path.join(__dirname, '..', 'solana-program', 'target', 'deploy', 'ghost_bridge.so');
  
  if (!fs.existsSync(programPath)) {
    console.error('❌ Program not compiled');
    console.error('   Run: cd solana-program && cargo build-sbf');
    process.exit(1);
  }
  
  console.log('\n📦 Loading compiled program...');
  const programData = fs.readFileSync(programPath);
  console.log(`   Size: ${(programData.length / 1024).toFixed(2)} KB`);
  
  // Generate program keypair (or load existing)
  const programKeypairPath = path.join(__dirname, '..', 'solana-program', 'target', 'deploy', 'ghost_bridge-keypair.json');
  let programKeypair;
  
  if (fs.existsSync(programKeypairPath)) {
    const keypairData = JSON.parse(fs.readFileSync(programKeypairPath, 'utf8'));
    programKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
    console.log(`   Using existing program ID: ${programKeypair.publicKey.toBase58()}`);
  } else {
    programKeypair = Keypair.generate();
    console.log(`   Generated new program ID: ${programKeypair.publicKey.toBase58()}`);
  }
  
  console.log('\n1️⃣  Deploying program to Solana mainnet...');
  console.log('   This may take several minutes...');
  
  try {
    // Use solana program deploy under the hood
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // Set up Solana CLI config for mainnet
    const deployCmd = `solana program deploy ${programPath} --url ${process.env.SOL_RPC} --keypair /dev/stdin --program-id ${programKeypairPath}`;
    
    console.log('   Using Solana CLI for deployment...');
    console.log('   Run manually:');
    console.log(`   solana config set --url ${process.env.SOL_RPC}`);
    console.log(`   solana program deploy ${programPath}`);
    
    // For security, we'll require manual CLI deployment
    console.log('\n⚠️  For mainnet, deploy manually via Solana CLI for safety:');
    console.log('\n   1. Configure CLI:');
    console.log(`      solana config set --url mainnet-beta`);
    console.log(`      solana config set --keypair <YOUR_KEYPAIR_FILE>`);
    console.log('\n   2. Deploy:');
    console.log(`      solana program deploy ${programPath}`);
    console.log('\n   3. After deployment, run initialization:');
    console.log(`      NETWORK=mainnet SOL_PROGRAM_ID=<DEPLOYED_ID> node scripts/init-solana.mjs`);
    
    process.exit(0);
    
  } catch (error) {
    console.error('Deployment error:', error);
    process.exit(1);
  }
}

main().catch(console.error);

