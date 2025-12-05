# Ghost Wallet MVP

Burn-before-mint demo that mirrors the Ghost Wallet architecture with real validator governance, SNARK/STARK proof enforcement, and a cross-chain relay flow.

## Components

- `contracts/GhostWallet.sol` – lifecycle orchestrator with local + mirrored ghosts, exported acknowledgements, and validator-registry gating.
- `contracts/MasterBridge.sol` – user entrypoint that escrows ERC20s, then triggers lifecycle steps once a validator quorum approves proofs.
- `contracts/verifiers/GhostZKVerifier.sol` + `contracts/zk/ZKProofSystem.sol` – hybrid verifier that requires SNARK + STARK payloads and can be swapped for a production prover.
- `contracts/validators/ValidatorSlashing.sol` – GrailX validator registry with staking, slashing, and AccessControl integration.
- `contracts/tokens/GhostERC20.sol` – mintable token used for local testing (can be replaced with any ERC20 supporting `mint`/`burn` hooks).
- `scripts/relay-demo.ts` – watches a source chain for burns and mirrors them onto a destination chain, reproducing proofs on the fly.
- `test/ghostWallet.test.ts` – end-to-end tests that cover multi-sig approvals plus remote mirroring/settlement.

## Install & Test

```bash
cd ghost-mvp
npm install
npx hardhat test
```

The test suite deploys the full stack, onboards a validator through `ValidatorSlashing`, and exercises:
1. `MasterBridge` multi-sig flow (validators approve Lock/Burn/Mint proofs before lifecycle calls execute).
2. Remote bridging (burn on chain A, mirror + mint on chain B, source chain receives an acknowledgement).

## Dual-Chain Relay Demo

1. Run two Hardhat nodes (or any two RPC endpoints):
   ```bash
   npx hardhat node --port 8545 --chain-id 31337
   npx hardhat node --port 9545 --chain-id 31338
   ```
2. Deploy the contracts (wallet, verifier, zk system, validator set, master bridge) to both networks. The deployments in `test/ghostWallet.test.ts` show the exact order/configuration.
3. Grant the relayer key (default Hardhat #0) `VALIDATOR_ROLE`/local validator permissions on both the wallet and verifier contracts.
4. Export the following env vars before running the relay script:
   - `CHAIN_A_RPC`, `CHAIN_B_RPC` – RPC URLs for the source/destination networks.
   - `RELAYER_KEY` – private key for the validator/relayer (defaults to Hardhat dev key).
   - `SOURCE_GHOST_WALLET`, `DEST_GHOST_WALLET` – deployed wallet addresses.
   - `SOURCE_VERIFIER`, `DEST_VERIFIER` – deployed `GhostZKVerifier` addresses.
   - `DEST_ZK_SYSTEM` – destination `ZKProofSystem` address used to recreate proofs.

5. Start the relay:
   ```bash
   npx ts-node scripts/relay-demo.ts
   ```

Whenever a `GhostBurned` event fires on the source chain, the script:
1. Fetches the ghost metadata.
2. Calls `mirrorGhost` on the destination chain.
3. Regenerates SNARK/STARK proofs on the destination `ZKProofSystem` and registers them with the destination verifier.
4. Calls `mintGhost` on the destination wallet and `confirmRemoteMint` back on the source chain for cleanup.

## Solana Program

- `ghost-mvp/solana-program` contains a no_std Rust program implementing the same lifecycle on Solana (validator-gated instructions, mirrored ghosts, burn/mint proofs, and acknowledgement cleanup).  
- Build with the Solana toolchain (or Anchor CLI):  
  ```bash
  cd ghost-mvp/solana-program
  cargo build-bpf
  ```
- The program expects a `ProgramConfig` account plus per-ghost accounts created with a deterministic seed (the relay derives `ghost-${ghostId}` off the validator's base key). Validators sign every instruction, mirroring the GrailX governance model.

## Solana ↔ EVM Relay

For EVM burn → Solana mint and the reverse direction, use the dedicated relay:

```bash
cd ghost-mvp
npm run relayer:sol
```

Required env vars:

- `EVM_RPC`, `EVM_GHOST_WALLET`, `EVM_VERIFIER`, `EVM_ZK_SYSTEM`, `EVM_CHAIN_ID`
- `SOL_RPC`, `SOL_PROGRAM_ID`, `SOL_CONFIG_ACCOUNT`, `SOL_MINT_ADDRESS`, `SOLANA_CHAIN_ID`
- `RELAYER_KEY` (EVM validator key) and `SOLANA_KEYPAIR` (base58 secret for the Solana validator)

The relay watches `GhostBurned` events on both chains, recreates SNARK/STARK payloads, calls `mirror`/`mint` on the destination, and confirms completion on the source so data can be wiped.

## Dashboard

A lightweight Vite/React dashboard streams both networks so you can observe lifecycle state in real time.

```bash
cd ghost-mvp/dashboard
npm install
npm run dev
```

Optional env vars (prefixed with `VITE_`) let you pre-fill RPC endpoints and addresses, e.g. `VITE_EVM_RPC`, `VITE_EVM_GHOST_ADDRESS`, `VITE_SOL_RPC`, `VITE_SOL_PROGRAM_ID`.

## Validator & Proof Plumbing

- Validators stake inside `ValidatorSlashing` and obtain `VALIDATOR_ROLE`. Both `GhostWallet` and `MasterBridge` accept that registry (or explicit `setLocalValidator`) for access control.
- `MasterBridge` accepts approvals via `approveStep(ghostId, step, payload)`; once the validator threshold is met, it executes the lifecycle call on `GhostWallet`.
- Proof data lives in `GhostZKVerifier.ghostProofPayload(ghostId, stage)` so off-chain agents can inspect/relay the SNARK/STARK payloads.
- `GhostWallet` supports `mirrorGhost` + `confirmRemoteMint`, enabling the two-phase export flow needed for multi-chain settlement.

## Tips

- Use the tests as a blueprint for deploying/initializing the contracts on live networks (order of operations, role assignments, and helper functions mirror the real setup).
- The mock prover (`ZKProofSystem`) is deterministic but not production-grade. Swap it with a real verifier by implementing `IZKProofSystem` and pointing `GhostZKVerifier` + `GhostWallet` at the new address.
- Keep validators synchronized across chains—`MasterBridge` only trusts whichever registry address you configure via `setValidatorRegistry`.

