# Ghost Bridge - Multi-Network Deployment Guide

This guide covers running the Ghost Bridge on both testnet (for development/testing) and mainnet (for production).

## Network Overview

| Component | Testnet | Mainnet |
|-----------|---------|---------|
| EVM | Sepolia | Ethereum |
| Solana | Devnet | Mainnet |
| Jupiter | ❌ No liquidity | ✅ Full swap |
| Cost | Free | Real money |

---

## Directory Structure

```
ghost-mvp/
├── config/
│   ├── networks.testnet.json    # Testnet contract addresses
│   └── networks.mainnet.json    # Mainnet contract addresses
├── deployments/
│   ├── testnet-evm.json         # Testnet deployment info
│   └── mainnet-evm.json         # Mainnet deployment info
├── scripts/
│   ├── network-config.mjs       # Network loader utility
│   ├── deploy-mainnet-evm.mjs   # EVM mainnet deployment
│   └── deploy-mainnet-solana.mjs # Solana mainnet deployment
└── dashboard/
    └── src/                      # Dashboard with network toggle
```

---

## Part 1: Running Testnet (Current Setup)

### 1.1 Environment Variables

Create `.env` in project root:

```bash
NETWORK=testnet

# EVM (Sepolia)
EVM_RPC=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
EVM_CHAIN_ID=11155111
RELAYER_KEY=your_private_key

# Contracts (already deployed)
EVM_GHOST_WALLET=0x070e199940D103b95D0EDA03E248b2653E88b231
EVM_BRIDGE=0x0D8d2b19fd342e637Eac41B8302aeD60f11e7bC8
EVM_VERIFIER=0xa47deb4E56BAf5479E33a6AaD0F58F0F961B4e29
EVM_ZK_SYSTEM=0x30336f7Eb94ECD28E480a21a3Cc5E905015962cF
EVM_WETH=0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9

# Solana (Devnet)
SOL_RPC=https://solana-devnet.g.alchemy.com/v2/YOUR_KEY
SOLANA_KEYPAIR=your_base58_keypair

# Program (already deployed)
SOL_PROGRAM_ID=9gjTj718N5cbUkUXV6vYmovEeh6hcDm9HAGeXFMJmcjY
SOL_CONFIG_ACCOUNT=FtSUvdm9bfPvHirkaXGZn7ggH91SjMvWy3u5N14bsngE

# Jupiter disabled on testnet
ENABLE_JUPITER_SWAP=false
```

### 1.2 Start Services

```bash
# Terminal 1: Relayer
cd ghost-mvp
NETWORK=testnet node scripts/relayer.mjs

# Terminal 2: Dashboard
cd ghost-mvp/dashboard
npm run dev
```

---

## Part 2: Deploying to Mainnet

### 2.1 Prerequisites

- [ ] Ethereum wallet with ~0.1 ETH (for contract deployment)
- [ ] Solana wallet with ~3 SOL (for program deployment)
- [ ] Alchemy account with mainnet access
- [ ] Thoroughly audited contracts (⚠️ CRITICAL)

### 2.2 Deploy EVM Contracts

```bash
# Set mainnet environment
export NETWORK=mainnet
export EVM_RPC=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
export RELAYER_KEY=your_mainnet_private_key

# Run deployment (will prompt for confirmation)
node scripts/deploy-mainnet-evm.mjs
```

**Output:**
```
⚠️  MAINNET DEPLOYMENT WARNING
Network: Ethereum Mainnet (Chain ID: 1)
Deployer: 0x...
Balance: 0.15 ETH
Estimated Cost: ~0.05-0.1 ETH

🔐 Type "DEPLOY MAINNET" to confirm: DEPLOY MAINNET

1️⃣  Deploying ZKProofSystem...
   ✅ ZKProofSystem: 0x...

2️⃣  Deploying GhostZKVerifier...
   ✅ GhostZKVerifier: 0x...

3️⃣  Deploying GhostWallet...
   ✅ GhostWallet: 0x...

4️⃣  Deploying MasterBridge...
   ✅ MasterBridge: 0x...

✅ MAINNET DEPLOYMENT COMPLETE
📁 Saved to: deployments/mainnet-evm.json
```

### 2.3 Deploy Solana Program

```bash
# Build the program
cd solana-program
cargo build-sbf

# Configure Solana CLI
solana config set --url mainnet-beta
solana config set --keypair ~/.config/solana/mainnet-deployer.json

# Deploy (costs ~2-3 SOL)
solana program deploy target/deploy/ghost_bridge.so

# Note the Program ID from output
```

### 2.4 Initialize Solana Program

```bash
# After deployment
export SOL_PROGRAM_ID=<deployed_program_id>
export SOL_RPC=https://solana-mainnet.g.alchemy.com/v2/YOUR_KEY

node scripts/init-solana.mjs
```

### 2.5 Update Mainnet Config

Edit `config/networks.mainnet.json` with deployed addresses:

```json
{
  "evm": {
    "contracts": {
      "ghostWallet": "0x...",
      "bridge": "0x...",
      "verifier": "0x...",
      "zkSystem": "0x..."
    }
  },
  "solana": {
    "program": {
      "id": "...",
      "configAccount": "..."
    }
  }
}
```

---

## Part 3: Running Both Networks Simultaneously

### 3.1 Separate Environment Files

```bash
# .env.testnet
NETWORK=testnet
EVM_RPC=https://eth-sepolia.g.alchemy.com/v2/KEY
SOL_RPC=https://solana-devnet.g.alchemy.com/v2/KEY
# ... testnet contracts

# .env.mainnet
NETWORK=mainnet
EVM_RPC=https://eth-mainnet.g.alchemy.com/v2/KEY
SOL_RPC=https://solana-mainnet.g.alchemy.com/v2/KEY
# ... mainnet contracts
```

### 3.2 Run Separate Instances

```bash
# Terminal 1: Testnet Relayer (port 3001)
source .env.testnet
NETWORK=testnet PORT=3001 node scripts/relayer.mjs

# Terminal 2: Mainnet Relayer (port 3002)
source .env.mainnet
NETWORK=mainnet PORT=3002 node scripts/relayer.mjs

# Terminal 3: Testnet Dashboard (port 5173)
cd dashboard
VITE_NETWORK=testnet npm run dev -- --port 5173

# Terminal 4: Mainnet Dashboard (port 5174)
cd dashboard
VITE_NETWORK=mainnet npm run dev -- --port 5174
```

---

## Part 4: Remote Access with ngrok

### 4.1 Install ngrok

```bash
# macOS
brew install ngrok

# Or download from https://ngrok.com/download
```

### 4.2 Create ngrok Account

1. Sign up at https://ngrok.com
2. Get your auth token from dashboard
3. Configure: `ngrok config add-authtoken YOUR_TOKEN`

### 4.3 Expose Dashboard

```bash
# Expose testnet dashboard
ngrok http 5173

# Output:
# Forwarding: https://abc123.ngrok.io -> http://localhost:5173
```

### 4.4 Expose Both Networks

Create `ngrok.yml`:

```yaml
version: "2"
authtoken: YOUR_AUTH_TOKEN
tunnels:
  testnet-dashboard:
    proto: http
    addr: 5173
    subdomain: ghost-testnet  # requires paid plan
  mainnet-dashboard:
    proto: http
    addr: 5174
    subdomain: ghost-mainnet  # requires paid plan
```

Run both tunnels:

```bash
ngrok start --all
```

### 4.5 Share Links

- **Testnet**: `https://ghost-testnet.ngrok.io`
- **Mainnet**: `https://ghost-mainnet.ngrok.io`

---

## Part 5: Dashboard Network Toggle

The dashboard can switch between networks:

```typescript
// dashboard/src/config.ts
export const networks = {
  testnet: {
    name: 'Testnet',
    evmRpc: 'https://eth-sepolia.g.alchemy.com/v2/...',
    evmChainId: 11155111,
    solRpc: 'https://solana-devnet.g.alchemy.com/v2/...',
    contracts: { ... }
  },
  mainnet: {
    name: 'Mainnet',
    evmRpc: 'https://eth-mainnet.g.alchemy.com/v2/...',
    evmChainId: 1,
    solRpc: 'https://solana-mainnet.g.alchemy.com/v2/...',
    contracts: { ... }
  }
};
```

UI Component:

```tsx
<select value={network} onChange={(e) => setNetwork(e.target.value)}>
  <option value="testnet">🧪 Testnet</option>
  <option value="mainnet">🌐 Mainnet</option>
</select>
```

---

## Security Checklist for Mainnet

### Before Deployment

- [ ] Smart contracts professionally audited
- [ ] All private keys secured (hardware wallet recommended)
- [ ] Rate limiting configured
- [ ] Emergency pause functionality tested
- [ ] Withdrawal limits set
- [ ] Multi-sig for admin functions
- [ ] Insurance/slashing parameters tuned

### After Deployment

- [ ] Verify contracts on Etherscan
- [ ] Monitor for unusual activity
- [ ] Set up alerts (PagerDuty, etc.)
- [ ] Document all contract addresses
- [ ] Secure backup of deployment keys

---

## Cost Summary

| Action | Testnet | Mainnet |
|--------|---------|---------|
| EVM Deploy | Free | ~$150-300 |
| Solana Deploy | Free | ~$400-600 |
| Bridge 0.1 ETH | Free | ~$5-20 gas |
| Relayer ops | Free | ~$10-50/day |

---

## Troubleshooting

### "Insufficient funds"
- Testnet: Get from faucets
- Mainnet: Add real funds

### "Network mismatch"
- Check NETWORK env var matches your .env file
- Verify RPC endpoints are correct network

### "Contract not found"
- Update `config/networks.*.json` with deployed addresses
- Re-run initialization scripts

### ngrok connection refused
- Ensure dashboard is running on expected port
- Check firewall settings
- Verify ngrok auth token is configured

