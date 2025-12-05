# Ghost Bridge - Mainnet Deployment Guide

## Overview

This guide walks through deploying the Ghost Bridge to mainnet (Ethereum + Solana).

## Prerequisites

### Wallets & Funds

You'll need:

| Asset | Amount | Purpose |
|-------|--------|---------|
| ETH (Mainnet) | ~0.1-0.2 ETH | Deploy 5 EVM contracts |
| SOL (Mainnet) | ~3-5 SOL | Deploy Solana program + init accounts |
| ETH (Relayer) | ~0.01 ETH | Gas for relayer operations |
| SOL (Relayer) | ~0.1 SOL | Transaction fees + rent |

### RPC Endpoints

Get mainnet RPC endpoints from [Alchemy](https://alchemy.com) or [Infura](https://infura.io):

- Ethereum Mainnet RPC: `https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY`
- Solana Mainnet RPC: `https://solana-mainnet.g.alchemy.com/v2/YOUR_KEY`

## Setup

### 1. Create Mainnet Environment File

```bash
# Copy template
cp config/mainnet.env.example .env.mainnet

# Edit with your values
nano .env.mainnet
```

Required values in `.env.mainnet`:

```env
NETWORK=mainnet

# Ethereum Mainnet
EVM_RPC=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
EVM_CHAIN_ID=1
RELAYER_KEY=your_deployer_private_key

# Solana Mainnet
SOL_RPC=https://solana-mainnet.g.alchemy.com/v2/YOUR_KEY
SOLANA_KEYPAIR=your_solana_keypair_base58

# Jupiter (enabled on mainnet)
ENABLE_JUPITER_SWAP=true
```

### 2. Verify Wallet Balances

```bash
# Check EVM balance
cast balance YOUR_ETH_ADDRESS --rpc-url https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# Check Solana balance
solana balance YOUR_SOL_ADDRESS --url https://api.mainnet-beta.solana.com
```

## Deployment Steps

### Step 1: Dry Run (Estimate Costs)

```bash
node scripts/deploy-mainnet.mjs --dry-run
```

This shows estimated gas costs without deploying anything.

### Step 2: Deploy EVM Contracts

```bash
node scripts/deploy-mainnet.mjs --evm
```

This deploys:
1. ZKProofSystem
2. GhostZKVerifier
3. ValidatorSlashing  
4. GhostWallet
5. MasterBridge

**Save the output addresses!** You'll need them for the `.env.mainnet` file.

### Step 3: Deploy Solana Program

```bash
# Build the program first
cd solana-program
cargo build-sbf

# Configure Solana CLI for mainnet
solana config set --url https://solana-mainnet.g.alchemy.com/v2/YOUR_KEY
solana config set --keypair ~/.config/solana/mainnet-deployer.json

# Deploy
solana program deploy target/deploy/ghost_solana.so

# Note the Program ID from output
```

### Step 4: Initialize Solana Program

```bash
# After deployment, initialize config
node scripts/init-solana.mjs --network=mainnet
```

### Step 5: Update Environment Files

Add deployed addresses to `.env.mainnet`:

```env
# EVM Contracts (deployed)
EVM_GHOST_WALLET=0x...
EVM_BRIDGE=0x...
EVM_VERIFIER=0x...
EVM_ZK_SYSTEM=0x...

# Solana Program (deployed)
SOL_PROGRAM_ID=...
SOL_CONFIG_ACCOUNT=...
```

### Step 6: Start Mainnet Relayer

```bash
node scripts/relayer.mjs --network=mainnet
```

## Using the Dashboard

The dashboard supports network switching:

1. Open the dashboard at `http://localhost:5173`
2. Click the network dropdown in the header
3. Select "Mainnet"
4. The dashboard will reload with mainnet config

## Jupiter Integration

On mainnet, Jupiter auto-swap is **enabled by default**:

- When users select "Receive as Native SOL", the relayer will:
  1. Mint wETH tokens on Solana
  2. Swap wETH → SOL via Jupiter
  3. User receives native SOL

The swap uses:
- Slippage: 0.5% (configurable via `JUPITER_SLIPPAGE_BPS`)
- Routes: Jupiter's optimized routing

## Security Checklist

Before going live:

- [ ] Use hardware wallet for deployer
- [ ] Store private keys securely (not in plaintext files)
- [ ] Test with small amounts first
- [ ] Set up monitoring for relayer
- [ ] Configure alerts for failed transactions
- [ ] Back up all keypairs
- [ ] Document all deployed addresses

## Estimated Costs

| Operation | Estimated Cost |
|-----------|---------------|
| EVM Deployment (5 contracts) | ~0.1-0.15 ETH |
| Solana Program Deployment | ~2-3 SOL |
| Solana Config Init | ~0.01 SOL |
| Per-bridge transaction (EVM) | ~0.001-0.005 ETH |
| Per-bridge transaction (Solana) | ~0.0001 SOL |

*Costs vary based on network congestion.*

## Troubleshooting

### "Insufficient funds"

Fund your deployer wallet with more ETH/SOL.

### "Transaction underpriced"

Increase gas price or wait for lower network congestion.

### "Program failed to deploy"

- Check Solana program was built correctly
- Verify keypair has enough SOL
- Try with a fresh program keypair

### "Jupiter swap failed"

- Check wETH token account exists
- Verify slippage settings
- May need more SOL for transaction fees

## Testnet Fallback

To switch back to testnet:

```bash
# Use testnet env
cp .env.testnet .env

# Run relayer with testnet
node scripts/relayer.mjs --network=testnet
```

Or switch in the dashboard using the network dropdown.

## Support

For issues, check:
- `/docs/GHOST_BRIDGE_COMPLETE_GUIDE.md` - Full system documentation
- Contract event logs on Etherscan/Solana Explorer
- Relayer console output



