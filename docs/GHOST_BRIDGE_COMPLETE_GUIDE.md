# Ghost Bridge - Complete Technical Guide

## Table of Contents
1. [Overview](#overview)
2. [Complete Transfer Flow](#complete-transfer-flow)
3. [Dashboard Guide](#dashboard-guide)
4. [Block Explorer Verification](#block-explorer-verification)
5. [NFT Cross-Chain Flow](#nft-cross-chain-flow)
6. [Bitcoin Integration](#bitcoin-integration)
7. [Contract Addresses](#contract-addresses)

---

## Overview

Ghost Bridge is a **trustless atomic cross-chain transfer protocol** that enables assets to move between EVM chains (Ethereum, Sepolia) and Solana without relying on centralized custodians or liquidity pools.

### Core Innovation: "Ghosts"

A **Ghost** is a cryptographic proof that an asset was destroyed on one chain. This proof is then used to create an equivalent asset on the destination chain. The key properties:

- **Atomic**: Either the full transfer completes, or nothing happens
- **Trustless**: No central party holds your funds
- **Verifiable**: All state transitions are provable on-chain
- **Self-Destructing**: Evidence is cleaned up after completion

### Ghost States

```
Created → Locked → Burned → [Mirrored on Dest] → Minted → Settled → Destroyed
```

| State | Description |
|-------|-------------|
| **Created** | User initiated transfer, ghost ID generated |
| **Locked** | Assets locked in contract, SNARK proof bound |
| **Burned** | Assets sent to dead address, STARK proof bound |
| **Mirrored** | Ghost replicated on destination chain (remote) |
| **Minted** | New assets created on destination |
| **Settled** | Transfer complete, acknowledgment received |
| **Destroyed** | Ghost data wiped (optional cleanup) |

---

## Complete Transfer Flow

### Step-by-Step: EVM (Sepolia) → Solana (Devnet)

#### 1. User Initiates Bridge (Dashboard)

```
User Action: Connect wallet, enter amount (0.001 ETH), enter Solana address, click "Bridge Tokens"
```

**What happens:**
1. Dashboard calls `MasterBridge.bridgeETH()` with native ETH
2. MasterBridge auto-wraps ETH → WETH
3. MasterBridge calls `GhostWallet.initiateGhost()`
4. Ghost created with unique ID (keccak256 hash of params + timestamp)
5. Event emitted: `GhostInitiated(ghostId, initiator, amount)`

**On-chain state:**
```solidity
ghosts[ghostId] = GhostTransaction({
    initiator: userAddress,
    sourceToken: WETH,
    destinationToken: wSOL,
    sourceChainId: 11155111,      // Sepolia
    destinationChainId: 1399811149, // Solana
    amount: 1000000000000000,     // 0.001 ETH in wei
    state: Created,
    isRemote: false,
    remoteAck: false,
    ...
});
```

#### 2. Relayer Detects Ghost

The relayer (`scripts/relayer.mjs`) listens for `GhostInitiated` events:

```javascript
ghostWallet.on("GhostInitiated", (ghostId, initiator, amount) => {
    progressGhost(ghostId);
});
```

#### 3. Lock Stage (SNARK Proof)

**Relayer actions:**
1. Generate SNARK proof via `ZKProofSystem.generateSNARKProof()`
2. Verify proof: `ZKProofSystem.verifySNARKProof()`
3. Bind proof to ghost: `GhostZKVerifier.bindProof(ghostId, Stage.Lock, proof)`
4. Approve lock: `MasterBridge.approveStep(ghostId, Step.Lock, payload)`

**What SNARK proves:**
- The amount commitment is valid
- The initiator owns the assets
- No double-spend occurred

**On-chain state change:**
```
state: Created → Locked
lockProof: <snark_proof_hash>
lockedAt: <timestamp>
```

#### 4. Burn Stage (STARK Proof)

**Relayer actions:**
1. Generate STARK proof via `ZKProofSystem.generateSTARKProof()`
2. Verify proof: `ZKProofSystem.verifySTARKProof()`
3. Bind proof to ghost: `GhostZKVerifier.bindProof(ghostId, Stage.Burn, proof)`
4. Approve burn: `MasterBridge.approveStep(ghostId, Step.Burn, payload)`

**What STARK proves:**
- Transaction history integrity
- State root validity
- No manipulation of prior states

**What happens to assets:**
```solidity
// Assets sent to dead address (0x000...dead)
IERC20(sourceToken).safeTransfer(DEAD_ADDRESS, amount);
```

**On-chain state change:**
```
state: Locked → Burned
burnProof: <stark_proof_hash>
burnedAt: <timestamp>
```

#### 5. Cross-Chain Relay to Solana

**Relayer actions:**
1. Create Solana account for ghost (PDA with seed `gh-<ghostId>`)
2. Build `MirrorGhost` instruction with Borsh-serialized data
3. Send transaction to Solana program

**Solana instruction data:**
```rust
MirrorGhost {
    ghost_id: [u8; 32],
    source_chain: 11155111,  // Sepolia
    amount: 1000000000000000,
    burn_proof: [u8; 32],
    source_token: WETH_pubkey,
    destination_token: wSOL_pubkey,
}
```

**Solana program state:**
```rust
GhostAccount {
    ghost_id: <same_id>,
    state: Burned,  // Starts as Burned (mirrored)
    is_remote: true,
    amount: 1000000000000000,
    destination_chain: 11155111,  // Points back to source
    ...
}
```

#### 6. Acknowledge on EVM

After successful Solana relay:
```javascript
await ghostWallet.confirmRemoteMint(ghostId);
```

**On-chain state change:**
```
remoteAck: false → true
```

This marks the EVM side as complete - the destination chain has received the ghost.

#### 7. Final State

**EVM (Sepolia):**
- Ghost state: `Burned`
- `remoteAck: true` (acknowledged)
- Assets: Sent to dead address (destroyed)

**Solana (Devnet):**
- Ghost state: `Burned`
- `is_remote: true` (mirrored from remote)
- Ready for minting when recipient claims

---

## Dashboard Guide

### Header Section
```
┌─────────────────────────────────────────────────────────┐
│ Ghost Bridge | Trustless Atomic Cross-Chain Transfers   │
│                                      [Connect Wallet]   │
├─────────────────────────────────────────────────────────┤
│ ● EVM: Sepolia  ● Solana: Devnet  ● Contracts Configured│
└─────────────────────────────────────────────────────────┘
```

- **Status indicators**: Green = connected/configured, Yellow = partial, Red = error
- **Connect Wallet**: Links MetaMask for EVM transactions

### Tab: Bridge

**Purpose**: Initiate new cross-chain transfers

| Field | Description |
|-------|-------------|
| Asset to Bridge | ETH (Native) or Token (ERC20) |
| To | Destination chain (Solana or EVM) |
| Amount | How much to transfer |
| Destination Address | Recipient's address on destination chain |

**Flow:**
1. Connect wallet
2. Select asset type
3. Enter amount
4. Enter destination address
5. Click "Bridge Tokens"
6. Approve MetaMask transaction
7. Wait for confirmation

### Tab: Ghosts (8)

**Purpose**: View all ghost transactions across both chains

**EVM Ghosts Table:**
| Column | Description |
|--------|-------------|
| Ghost ID | Unique identifier (truncated) |
| Status | Current state (Created/Locked/Burned/Minted/Settled) |
| Amount | Transfer amount |
| Route | Source → Destination chain |
| Flags | Remote (mirrored), Ack'd (acknowledged) |
| Created | Timestamp |

**Solana Ghosts Table:**
Same structure, shows ghosts that were mirrored TO Solana.

**Flag meanings:**
- **Remote**: This ghost was created on another chain and mirrored here
- **Ack'd**: The destination chain acknowledged receipt

### Tab: Validators (0)

**Purpose**: View validator set for multi-sig approvals

Shows validators who can approve lifecycle steps. In the MVP, the relayer acts as the sole validator.

### Tab: Events (0)

**Purpose**: Activity log of bridge operations

Shows chronological list of:
- Ghost initiations
- Lock/Burn/Mint steps
- Acknowledgments
- Errors

### Tab: Config

**Purpose**: Display current configuration

Shows all contract addresses and their purposes:
- GhostWallet address
- MasterBridge address
- Validator contract
- WETH address
- Solana program ID

---

## Block Explorer Verification

### Sepolia (EVM) - Etherscan

**Base URL**: `https://sepolia.etherscan.io`

#### Verify Ghost Creation

1. Go to GhostWallet contract: `https://sepolia.etherscan.io/address/0x070e199940D103b95D0EDA03E248b2653E88b231`
2. Click "Events" tab
3. Look for `GhostInitiated` event:
   ```
   Topic 0: 0xd85620fefbca73b1a46ce364c51d0fd092306a72b9a17a4d67d022021f3d66c6
   Topic 1: <ghostId>
   Topic 2: <initiator>
   Data: <amount>
   ```

#### Verify Lock Step

Look for `GhostLocked` event:
```
Topic 0: 0x4780e31459709d99...
Topic 1: <ghostId>
```

#### Verify Burn Step

Look for `GhostBurned` event:
```
Topic 0: 0xf6e5ac22997b1a9a...
Topic 1: <ghostId>
```

#### Verify WETH Transfer to Dead Address

1. Go to transaction hash
2. Check "Internal Txns" or "ERC-20 Token Txns"
3. Should see transfer to `0x000000000000000000000000000000000000dEaD`

#### Verify Acknowledgment

Look for `RemoteMintAcknowledged` event:
```
Topic 0: 0x9464252ce5598190...
Topic 1: <ghostId>
```

#### Query Ghost State Directly

1. Go to GhostWallet contract
2. Click "Read Contract"
3. Find `getGhost` function
4. Enter ghost ID (full 32 bytes, 0x-prefixed)
5. Returns tuple with all ghost fields

### Solana (Devnet) - Solscan/Explorer

**Base URL**: `https://explorer.solana.com/?cluster=devnet`

#### Find Ghost Account

1. Get ghost account address from relayer logs or calculate:
   ```
   Seed: "gh-" + ghostId.slice(2, 18)
   Base: Relayer pubkey (2XpZF7UTgSrABdUX7DEjWYXW9wEKs6httF8ekMsqgFPT)
   Program: 9gjTj718N5cbUkUXV6vYmovEeh6hcDm9HAGeXFMJmcjY
   ```

2. Search for account on explorer

#### Verify Transaction

1. Find transaction signature from relayer logs
2. Search on explorer: `https://explorer.solana.com/tx/<signature>?cluster=devnet`
3. Check program logs:
   ```
   Program log: Ghost mirrored from remote chain
   Program 9gjTj718N5cbUkUXV6vYmovEeh6hcDm9HAGeXFMJmcjY success
   ```

#### Decode Account Data

Account data is Borsh-serialized. Structure:
```
Offset 0-31:   ghost_id ([u8; 32])
Offset 32-63:  initiator (Pubkey)
Offset 64-95:  source_token (Pubkey)
Offset 96-127: destination_token (Pubkey)
Offset 128-135: destination_chain (u64)
Offset 136-199: destination_address ([u8; 64])
Offset 200:    state (u8) - 0=None, 1=Created, 2=Locked, 3=Burned, 4=Minted, 5=Settled
Offset 201-208: amount (u64)
...
```

### Verification Checklist

| Step | EVM Check | Solana Check |
|------|-----------|--------------|
| 1. Initiation | `GhostInitiated` event | - |
| 2. Lock | `GhostLocked` event | - |
| 3. Burn | `GhostBurned` event, WETH to dead addr | - |
| 4. Mirror | - | Account created, `state=3` |
| 5. Ack | `RemoteMintAcknowledged` event | - |

---

## NFT Cross-Chain Flow

### Concept

NFTs require special handling because they're non-fungible - each token is unique with metadata.

### Proposed Flow: EVM → Solana

#### 1. Lock NFT on Source

```solidity
// User approves NFT to GhostWallet
IERC721(nftContract).approve(ghostWallet, tokenId);

// Initiate NFT ghost
ghostWallet.initiateNFTGhost(
    nftContract,
    tokenId,
    destinationChain,
    destinationAddress
);
```

**What happens:**
- NFT transferred to GhostWallet (locked, not burned)
- Metadata URI stored in ghost
- Ghost ID generated

#### 2. Generate Metadata Proof

```solidity
struct NFTGhost {
    address nftContract;
    uint256 tokenId;
    string tokenURI;
    bytes32 metadataHash;  // Hash of full metadata JSON
    // ... standard ghost fields
}
```

**SNARK proves:**
- Ownership at time of lock
- Metadata integrity

#### 3. Burn/Escrow Decision

**Option A: True Burn**
- NFT sent to dead address
- Cannot be recovered
- 1:1 representation on destination

**Option B: Escrow Lock**
- NFT held in contract
- Can be unlocked if destination fails
- Requires timeout mechanism

#### 4. Mirror to Solana

Create Metaplex NFT on Solana:
```rust
CreateMetadataAccountV3 {
    metadata: <pda>,
    mint: <new_mint>,
    mint_authority: program,
    payer: relayer,
    update_authority: program,
    name: <from_evm_metadata>,
    symbol: <from_evm_metadata>,
    uri: <original_uri_or_ipfs>,
}
```

#### 5. Mint to Recipient

```rust
MintTo {
    mint: <nft_mint>,
    destination: <recipient_ata>,
    authority: program,
    amount: 1,
}
```

### Required Changes

| Component | Changes Needed |
|-----------|----------------|
| GhostWallet.sol | Add `initiateNFTGhost()`, `NFTGhost` struct |
| MasterBridge.sol | Add `bridgeNFT()` function |
| Solana Program | Add Metaplex CPI, NFT account structure |
| Relayer | Add NFT detection, metadata fetching |
| Dashboard | Add NFT selection UI, preview |

### Challenges

1. **Metadata Storage**: Where to store full metadata (IPFS, Arweave)?
2. **Royalties**: How to preserve creator royalties cross-chain?
3. **Collections**: How to maintain collection relationships?
4. **Editions**: Handle 1/1 vs editions differently?

---

## Bitcoin Integration

### Challenge

Bitcoin doesn't have smart contracts, so we can't deploy GhostWallet there. We need alternative approaches.

### Approach 1: HTLC (Hash Time-Locked Contracts)

**How it works:**

1. **User locks BTC in HTLC:**
   ```
   OP_IF
       OP_SHA256 <hash> OP_EQUALVERIFY
       <relayer_pubkey> OP_CHECKSIG
   OP_ELSE
       <timeout> OP_CHECKLOCKTIMEVERIFY OP_DROP
       <user_pubkey> OP_CHECKSIG
   OP_ENDIF
   ```

2. **Relayer reveals preimage on EVM:**
   ```solidity
   function claimWithPreimage(bytes32 preimage) {
       require(sha256(preimage) == hash);
       // Mint wrapped BTC
   }
   ```

3. **Relayer claims BTC with preimage:**
   - Spends HTLC using revealed preimage
   - User gets wrapped BTC on EVM/Solana

### Approach 2: Threshold Signatures (MPC)

**How it works:**

1. **Multi-party custody:**
   - N validators each hold key share
   - M-of-N required to sign BTC transactions

2. **User deposits to MPC address:**
   ```
   User → 3-of-5 multisig address
   ```

3. **Validators observe and mint:**
   ```solidity
   function mintWrappedBTC(
       bytes32 btcTxHash,
       uint256 amount,
       bytes[] signatures  // From M validators
   ) {
       require(signatures.length >= threshold);
       // Verify signatures
       // Mint wBTC
   }
   ```

4. **Redemption:**
   - User burns wBTC on EVM
   - Validators sign BTC transaction to user

### Approach 3: Light Client Verification

**How it works:**

1. **Deploy BTC light client on EVM:**
   ```solidity
   contract BTCRelay {
       mapping(bytes32 => BlockHeader) headers;
       
       function submitHeader(bytes header) {
           // Verify PoW
           // Store header
       }
       
       function verifyTx(
           bytes32 txHash,
           bytes merkleProof,
           uint256 blockHeight
       ) returns (bool) {
           // Verify tx in block
       }
   }
   ```

2. **User locks BTC to specific address**

3. **Submit proof to EVM:**
   ```solidity
   function claimWrappedBTC(
       bytes btcTx,
       bytes merkleProof,
       uint256 blockHeight
   ) {
       require(btcRelay.verifyTx(hash(btcTx), merkleProof, blockHeight));
       // Parse btcTx, extract amount and recipient
       // Mint wrapped BTC
   }
   ```

### Required Components for Bitcoin

| Component | Purpose |
|-----------|---------|
| BTC Light Client | Verify Bitcoin transactions on EVM |
| HTLC Scripts | Time-locked Bitcoin scripts |
| MPC Network | Threshold signature validators |
| wBTC Token | ERC20 representation of BTC |
| SPL wBTC | Solana representation of BTC |
| Relayer Updates | Monitor Bitcoin mempool/blocks |

### Recommended Approach

**Phase 1**: HTLC-based (simplest, trustless)
- Works today with existing Bitcoin
- No protocol changes needed
- Limited to atomic swaps

**Phase 2**: Light Client + MPC hybrid
- Better UX (no interactive protocol)
- Requires validator network
- More complex implementation

---

## Contract Addresses

### EVM (Sepolia - Chain ID: 11155111)

| Contract | Address | Purpose |
|----------|---------|---------|
| GhostWallet | `0x070e199940D103b95D0EDA03E248b2653E88b231` | Core ghost lifecycle |
| MasterBridge | `0x0D8d2b19fd342e637Eac41B8302aeD60f11e7bC8` | User entry point |
| GhostZKVerifier | `0xa47deb4E56BAf5479E33a6AaD0F58F0F961B4e29` | ZK proof verification |
| ZKProofSystem | `0x30336f7Eb94ECD28E480a21a3Cc5E905015962cF` | Proof generation |
| ValidatorSlashing | `0x6d698e5be8b77Ca560dAfA72C4d4D3d97DA3D0aF` | Validator registry |
| WETH | `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9` | Wrapped ETH (Sepolia) |

### Solana (Devnet - Chain ID: 1399811149)

| Account | Address | Purpose |
|---------|---------|---------|
| Program ID | `9gjTj718N5cbUkUXV6vYmovEeh6hcDm9HAGeXFMJmcjY` | Ghost Wallet program |
| Config Account | `FtSUvdm9bfPvHirkaXGZn7ggH91SjMvWy3u5N14bsngE` | Program configuration |
| wSOL Mint | `So11111111111111111111111111111111111111112` | Wrapped SOL |

### Relayer

| Key | Address |
|-----|---------|
| EVM Address | `0x12A6e0DC453c870DCC0C8ae6A3150A1494F5d37F` |
| Solana Address | `2XpZF7UTgSrABdUX7DEjWYXW9wEKs6httF8ekMsqgFPT` |

---

## Quick Reference Commands

### Check Ghost State (EVM)

```bash
cd ghost-mvp && node -e "
const { ethers } = require('ethers');
require('dotenv').config();
const fs = require('fs');

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC);
  const abi = JSON.parse(fs.readFileSync('./artifacts/contracts/GhostWallet.sol/GhostWallet.json')).abi;
  const contract = new ethers.Contract(process.env.EVM_GHOST_WALLET, abi, provider);
  
  const ghostId = '0x<YOUR_GHOST_ID>';
  const ghost = await contract.getGhost(ghostId);
  console.log('State:', ghost.state);
  console.log('Ack:', ghost.remoteAck);
}
main();
"
```

### Check Ghost State (Solana)

```bash
cd ghost-mvp && node -e "
const { Connection, PublicKey } = require('@solana/web3.js');
require('dotenv').config();

async function main() {
  const conn = new Connection(process.env.SOL_RPC);
  const account = new PublicKey('<GHOST_ACCOUNT_ADDRESS>');
  const info = await conn.getAccountInfo(account);
  console.log('State byte:', info.data[200]);
}
main();
"
```

### Run Relayer

```bash
cd ghost-mvp && node scripts/relayer.mjs
```

### Run Dashboard

```bash
cd ghost-mvp/dashboard && npm run dev
```

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Ghost stuck at "Created" | Relayer not running | Start relayer |
| "Not validator" error | Relayer not registered | Run `set-evm-validator.mjs` |
| Solana relay fails | Insufficient SOL | Airdrop SOL to relayer |
| Dashboard shows 0 balance | Wrong network in MetaMask | Switch to Sepolia |
| "Invalid destination token" | WETH not set | Check MasterBridge.WETH() |

---

*Last updated: November 29, 2025*
















