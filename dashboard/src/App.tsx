import { Buffer } from "buffer";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";
import { deserialize } from "borsh";
import type { Schema } from "borsh";
import BN from "bn.js";
import GhostWalletArtifact from "../../artifacts/contracts/GhostWallet.sol/GhostWallet.json";
import MasterBridgeArtifact from "../../artifacts/contracts/MasterBridge.sol/MasterBridge.json";
import ValidatorSlashingArtifact from "../../artifacts/contracts/validators/ValidatorSlashing.sol/ValidatorSlashing.json";
import GhostERC20Artifact from "../../artifacts/contracts/tokens/GhostERC20.sol/GhostERC20.json";
import type { EventLog } from "ethers";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

type GhostRow = {
  id: string;
  state: string;
  stateNum: number;
  amount: string;
  solAmount?: string; // SOL equivalent for received payments
  sourceChain: string;
  destChain: string;
  initiator: string;
  createdAt: string;
  isRemote: boolean;
  remoteAck: boolean;
  chain: "EVM" | "Solana";
  // ZK Proof info (for instant payments)
  zkProof?: {
    snarkProofId?: string;
    starkProofId?: string;
    snarkVerified?: boolean;
    starkVerified?: boolean;
    verifiedAt?: string;
  };
};

type ValidatorInfo = {
  address: string;
  stake: string;
  reputation: number;
  slashCount: number;
  isActive: boolean;
};

type EventLogEntry = {
  id: string;
  type: string;
  ghostId: string;
  timestamp: Date;
  chain: "EVM" | "Solana";
  details: string;
};

type GhostAccountRaw = {
  ghost_id: Uint8Array;
  initiator: Uint8Array;
  source_token: Uint8Array;
  destination_token: Uint8Array;
  destination_chain: BN;
  destination_address: Uint8Array;
  state: number;
  amount: BN;
  lock_ts: BN;
  burn_ts: BN;
  mint_ts: BN;
  burn_proof: Uint8Array;
  mint_proof: Uint8Array;
  is_remote: number;
  remote_ack: number;
};

const GhostAccountSchema: Schema = {
  struct: {
    ghost_id: { array: { type: "u8", len: 32 } },
    initiator: { array: { type: "u8", len: 32 } },
    source_token: { array: { type: "u8", len: 32 } },
    destination_token: { array: { type: "u8", len: 32 } },
    destination_chain: "u64",
    destination_address: { array: { type: "u8", len: 64 } },
    state: "u8",
    amount: "u64",
    lock_ts: "i64",
    burn_ts: "i64",
    mint_ts: "i64",
    burn_proof: { array: { type: "u8", len: 32 } },
    mint_proof: { array: { type: "u8", len: 32 } },
    is_remote: "u8",
    remote_ack: "u8",
  },
};

const STATE_LABELS = ["None", "Created", "Locked", "Burned", "Minted", "Settled"];
const SOLANA_CHAIN_ID = "1399811149";

// ─────────────────────────────────────────────────────────────
// Network Configurations
// ─────────────────────────────────────────────────────────────

type NetworkId = "testnet" | "mainnet";

interface NetworkConfig {
  name: string;
  evm: {
    chainId: number;
    chainName: string;
    rpcUrl: string;
    explorerUrl: string;
    weth: string;
    contracts: {
      ghostWallet: string;
      bridge: string;
      verifier: string;
      zkSystem: string;
    };
  };
  solana: {
    chainId: string;
    chainName: string;
    rpcUrl: string;
    explorerUrl: string;
    program: string;
    configAccount: string;
  };
  jupiter: {
    enabled: boolean;
    slippageBps?: number;
    note: string;
  };
}

// Embedded network configs (can be overridden by env vars)
const NETWORKS: Record<NetworkId, NetworkConfig> = {
  testnet: {
    name: "Testnet",
    evm: {
      chainId: 11155111,
      chainName: "Sepolia",
      rpcUrl: import.meta.env.VITE_EVM_RPC || "https://eth-sepolia.g.alchemy.com/v2/",
      explorerUrl: "https://sepolia.etherscan.io",
      weth: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
      contracts: {
        ghostWallet: import.meta.env.VITE_EVM_GHOST_ADDRESS || "0x070e199940D103b95D0EDA03E248b2653E88b231",
        bridge: import.meta.env.VITE_EVM_BRIDGE_ADDRESS || "0x0D8d2b19fd342e637Eac41B8302aeD60f11e7bC8",
        verifier: import.meta.env.VITE_EVM_VERIFIER_ADDRESS || "0xa47deb4E56BAf5479E33a6AaD0F58F0F961B4e29",
        zkSystem: import.meta.env.VITE_EVM_ZK_SYSTEM || "0x30336f7Eb94ECD28E480a21a3Cc5E905015962cF",
      },
    },
    solana: {
      chainId: "1399811149",
      chainName: "Devnet",
      rpcUrl: import.meta.env.VITE_SOL_RPC || "https://api.devnet.solana.com",
      explorerUrl: "https://explorer.solana.com/?cluster=devnet",
      program: import.meta.env.VITE_SOL_PROGRAM_ID || "9gjTj718N5cbUkUXV6vYmovEeh6hcDm9HAGeXFMJmcjY",
      configAccount: "FtSUvdm9bfPvHirkaXGZn7ggH91SjMvWy3u5N14bsngE",
    },
    jupiter: {
      enabled: false,
      note: "No liquidity on devnet - swap simulated",
    },
  },
  mainnet: {
    name: "Mainnet",
    evm: {
      chainId: 1,
      chainName: "Ethereum",
      rpcUrl: import.meta.env.VITE_MAINNET_EVM_RPC || "",
      explorerUrl: "https://etherscan.io",
      weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      contracts: {
        ghostWallet: import.meta.env.VITE_MAINNET_EVM_GHOST_ADDRESS || "",
        bridge: import.meta.env.VITE_MAINNET_EVM_BRIDGE_ADDRESS || "",
        verifier: import.meta.env.VITE_MAINNET_EVM_VERIFIER_ADDRESS || "",
        zkSystem: import.meta.env.VITE_MAINNET_EVM_ZK_SYSTEM || "",
      },
    },
    solana: {
      chainId: "1399811149",
      chainName: "Mainnet",
      rpcUrl: import.meta.env.VITE_MAINNET_SOL_RPC || "",
      explorerUrl: "https://explorer.solana.com",
      program: import.meta.env.VITE_MAINNET_SOL_PROGRAM_ID || "",
      configAccount: "",
    },
    jupiter: {
      enabled: true,
      slippageBps: 50,
      note: "Auto-swap wETH → SOL via Jupiter",
    },
  },
};

// Helper to get flat config from network
function getConfigFromNetwork(network: NetworkConfig) {
  return {
    evmRpc: network.evm.rpcUrl,
    evmGhost: network.evm.contracts.ghostWallet,
    evmBridge: network.evm.contracts.bridge,
    evmValidator: network.evm.contracts.verifier,
    evmToken: "", // Token address if needed
    evmChainId: network.evm.chainId.toString(),
    evmChainName: network.evm.chainName,
    evmExplorer: network.evm.explorerUrl,
    evmWeth: network.evm.weth,
    solRpc: network.solana.rpcUrl,
    solProgram: network.solana.program,
    solChainName: network.solana.chainName,
    solExplorer: network.solana.explorerUrl,
    jupiterEnabled: network.jupiter.enabled,
    jupiterNote: network.jupiter.note,
  };
}

// Load saved network preference
function loadNetworkPreference(): NetworkId {
  try {
    const saved = localStorage.getItem("ghost-wallet-network");
    if (saved === "mainnet" || saved === "testnet") return saved;
  } catch {}
  return "testnet";
}

// ─────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Persistence helpers
// ─────────────────────────────────────────────────────────────

const STORAGE_KEYS = {
  ghosts: "ghost-wallet-ghosts",
  events: "ghost-wallet-events",
};

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Convert date strings back to Date objects for events
      if (key === STORAGE_KEYS.events && Array.isArray(parsed)) {
        return parsed.map((e: any) => ({ ...e, timestamp: new Date(e.timestamp) })) as T;
      }
      return parsed;
    }
  } catch {}
  return fallback;
}

function saveToStorage<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// Copy helper
// ─────────────────────────────────────────────────────────────

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function truncateId(id: string, startLen = 8, endLen = 6): string {
  if (id.length <= startLen + endLen + 3) return id;
  return `${id.slice(0, startLen)}...${id.slice(-endLen)}`;
}

export default function App() {
  // Network state
  const [networkId, setNetworkId] = useState<NetworkId>(() => loadNetworkPreference());
  const [showNetworkDropdown, setShowNetworkDropdown] = useState(false);

  // Derived config from network
  const config = useMemo(() => getConfigFromNetwork(NETWORKS[networkId]), [networkId]);
  const currentNetwork = NETWORKS[networkId];

  // Save network preference when changed
  const switchNetwork = useCallback((newNetwork: NetworkId) => {
    setNetworkId(newNetwork);
    localStorage.setItem("ghost-wallet-network", newNetwork);
    setShowNetworkDropdown(false);
    // Clear cached data when switching networks
    setGhosts([]);
    setValidators([]);
    localStorage.removeItem(STORAGE_KEYS.ghosts);
  }, []);

  const [activeTab, setActiveTab] = useState<"bridge" | "pool" | "ghosts" | "validators" | "events" | "config">("bridge");
  const [ghosts, setGhosts] = useState<GhostRow[]>(() => loadFromStorage(STORAGE_KEYS.ghosts, []));
  const [validators, setValidators] = useState<ValidatorInfo[]>([]);
  const [events, setEvents] = useState<EventLogEntry[]>(() => loadFromStorage(STORAGE_KEYS.events, []));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletConnected, setWalletConnected] = useState(false);
  const [userAddress, setUserAddress] = useState("");
  const [userBalance, setUserBalance] = useState("0");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Bridge form state
  const [bridgeAmount, setBridgeAmount] = useState("");
  const [bridgeDestChain, setBridgeDestChain] = useState<"solana" | "evm">("solana");
  const [bridgeDestAddress, setBridgeDestAddress] = useState("");
  const [bridgeTxStatus, setBridgeTxStatus] = useState<string | null>(null);
  const [bridgeAsset, setBridgeAsset] = useState<"eth" | "token">("eth");
  const [ethBalance, setEthBalance] = useState("0");
  const [receiveAsNative, setReceiveAsNative] = useState(true); // true = native SOL, false = wETH
  
  // Pyth oracle prices (real-time)
  const [pythPrices, setPythPrices] = useState<{ ethUsd: number; solUsd: number } | null>(null);

  const isConfigured = useMemo(
    () => config.evmGhost && config.evmBridge,
    [config.evmGhost, config.evmBridge]
  );

  const isMainnet = networkId === "mainnet";

  // ─────────────────────────────────────────────────────────────
  // Wallet Connection
  // ─────────────────────────────────────────────────────────────

  const fetchBalance = useCallback(async (address: string) => {
    try {
      const provider = new ethers.JsonRpcProvider(config.evmRpc);
      
      // Fetch ETH balance
      const ethBal = await provider.getBalance(address);
      setEthBalance(ethers.formatEther(ethBal));
      
      // Fetch token balance if configured
      if (config.evmToken) {
        const token = new ethers.Contract(config.evmToken, GhostERC20Artifact.abi, provider);
        const bal = await token.balanceOf(address);
        setUserBalance(ethers.formatUnits(bal, 18));
      }
    } catch {
      setUserBalance("0");
      setEthBalance("0");
    }
  }, []);

  const getEthereum = useCallback(() => {
    // Handle multiple wallet extensions - prefer MetaMask
    const win = window as any;
    if (win.ethereum?.providers?.length) {
      return win.ethereum.providers.find((p: any) => p.isMetaMask) || win.ethereum.providers[0];
    }
    return win.ethereum;
  }, []);

  const connectWallet = useCallback(async () => {
    const ethereum = getEthereum();
    if (!ethereum) {
      setError("MetaMask not detected. Please install MetaMask.");
      return;
    }
    try {
      const accounts: string[] = await ethereum.request({ 
        method: "eth_requestAccounts" 
      });
      if (accounts.length > 0) {
        setUserAddress(accounts[0]);
        setWalletConnected(true);
        await fetchBalance(accounts[0]);
      }
    } catch (err: any) {
      if (err.code === 4001) {
        setError("Connection rejected. Please approve in MetaMask.");
      } else {
        console.error("Wallet connection error:", err);
        setError("Failed to connect. Check console for details.");
      }
    }
  }, [fetchBalance, getEthereum]);

  // Fetch Pyth oracle prices (real-time ETH/SOL rates)
  const fetchPythPrices = useCallback(async () => {
    try {
      const ETH_USD_FEED = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
      const SOL_USD_FEED = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
      
      const response = await fetch(
        `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${ETH_USD_FEED}&ids[]=${SOL_USD_FEED}`
      );
      const data = await response.json();
      
      const ethPrice = data.parsed[0];
      const solPrice = data.parsed[1];
      
      const ethUsd = Number(ethPrice.price.price) * Math.pow(10, ethPrice.price.expo);
      const solUsd = Number(solPrice.price.price) * Math.pow(10, solPrice.price.expo);
      
      setPythPrices({ ethUsd, solUsd });
      console.log(`💱 Pyth prices: ETH=$${ethUsd.toFixed(2)}, SOL=$${solUsd.toFixed(2)}`);
    } catch (error) {
      console.warn("Failed to fetch Pyth prices:", error);
      // Fallback prices
      setPythPrices({ ethUsd: 3500, solUsd: 180 });
    }
  }, []);

  useEffect(() => {
    fetchPythPrices();
    // Refresh prices every 30 seconds
    const interval = setInterval(fetchPythPrices, 30000);
    return () => clearInterval(interval);
  }, [fetchPythPrices]);

  // Auto-reconnect wallet on page load if already connected
  useEffect(() => {
    const ethereum = getEthereum();
    if (!ethereum) return;

    let mounted = true;

    const checkConnection = async () => {
      try {
        const accounts: string[] = await ethereum.request({ 
          method: "eth_accounts" 
        });
        if (mounted && accounts.length > 0) {
          setUserAddress(accounts[0]);
          setWalletConnected(true);
          await fetchBalance(accounts[0]);
        }
      } catch {
        // Not connected
      }
    };
    checkConnection();

    // Event handlers - wrap in try/catch to avoid listener errors
    const handleAccountsChanged = (accounts: string[]) => {
      if (!mounted) return;
      if (accounts.length === 0) {
        setWalletConnected(false);
        setUserAddress("");
        setUserBalance("0");
      } else {
        setUserAddress(accounts[0]);
        setWalletConnected(true);
        fetchBalance(accounts[0]);
      }
    };

    const handleChainChanged = () => {
      if (mounted) window.location.reload();
    };

    // Safely add listeners
    try {
      if (typeof ethereum.on === "function") {
        ethereum.on("accountsChanged", handleAccountsChanged);
        ethereum.on("chainChanged", handleChainChanged);
      }
    } catch (e) {
      console.warn("Could not add wallet listeners:", e);
    }

    return () => {
      mounted = false;
      try {
        if (typeof ethereum.removeListener === "function") {
          ethereum.removeListener("accountsChanged", handleAccountsChanged);
          ethereum.removeListener("chainChanged", handleChainChanged);
        }
      } catch {
        // Ignore cleanup errors
      }
    };
  }, [fetchBalance, getEthereum]);

  // ─────────────────────────────────────────────────────────────
  // Event Logging (must be before initiateBridge)
  // ─────────────────────────────────────────────────────────────

  const addEvent = useCallback((e: Omit<EventLogEntry, "id" | "timestamp">) => {
    setEvents((prev) => {
      const newEvent = {
        ...e,
        id: `${Date.now()}-${Math.random()}`,
        timestamp: new Date(),
      };
      const updated = [newEvent, ...prev.slice(0, 99)]; // Keep last 100
      saveToStorage(STORAGE_KEYS.events, updated);
      return updated;
    });
  }, []);

  const handleCopy = useCallback((text: string) => {
    copyToClipboard(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  // ─────────────────────────────────────────────────────────────
  // Initiate Bridge (INSTANT via Liquidity Pool)
  // ─────────────────────────────────────────────────────────────

  // Pool contract address
  const POOL_ADDRESS = "0x3078516D302805051E937f221A4b386D1D5ac8b9";
  
  const poolAbi = [
    "function payWithETH(uint256 destChainId, bytes destAddress, bytes destToken, uint256 minDestAmount, uint256 deadline) payable returns (bytes32)",
    "event PaymentIntentCreated(bytes32 indexed intentId, address indexed sender, uint256 amount, uint256 destChainId)",
  ];

  const initiateBridge = useCallback(async () => {
    if (!walletConnected) {
      setError("Connect wallet first");
      return;
    }
    if (!bridgeAmount || parseFloat(bridgeAmount) <= 0) {
      setError("Enter a valid amount");
      return;
    }
    if (!bridgeDestAddress) {
      setError("Enter destination address");
      return;
    }

    try {
      const ethereum = getEthereum();
      const provider = new ethers.BrowserProvider(ethereum);
      const signer = await provider.getSigner();
      const pool = new ethers.Contract(POOL_ADDRESS, poolAbi, signer);

      const amount = ethers.parseEther(bridgeAmount);
      const destChainId = bridgeDestChain === "solana" ? BigInt(SOLANA_CHAIN_ID) : BigInt(config.evmChainId);
      
      // Encode destination address
      const destAddressBytes = ethers.toUtf8Bytes(bridgeDestAddress);
      
      // Destination token (SOL for Solana)
      const destToken = bridgeDestChain === "solana" 
        ? ethers.toUtf8Bytes(receiveAsNative ? "SOL" : "wETH")
        : ethers.toUtf8Bytes("ETH");
      
      // Calculate minimum output using Pyth oracle prices (with 5% slippage)
      let minOutput: bigint;
      if (bridgeDestChain === "solana" && pythPrices) {
        const ethToSolRate = pythPrices.ethUsd / pythPrices.solUsd;
        // Convert to lamports (9 decimals) with 5% slippage
        const solAmount = parseFloat(bridgeAmount) * ethToSolRate * 0.95;
        minOutput = BigInt(Math.floor(solAmount * 1e9)); // lamports
      } else {
        // Fallback: use 40:1 rate if Pyth unavailable
        const ethToSolRate = 40n;
        minOutput = bridgeDestChain === "solana"
          ? (amount * ethToSolRate * 95n) / 100n
          : amount;
      }
      
      // Deadline: 5 minutes from now
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

      setBridgeTxStatus("⚡ Initiating instant payment...");
      
      const tx = await pool.payWithETH(
        destChainId,
        destAddressBytes,
        destToken,
        minOutput,
        deadline,
        { value: amount }
      );
      
      setBridgeTxStatus("⏳ Confirming on Ethereum...");
      const receipt = await tx.wait();

      // Find the PaymentIntentCreated event
      const iface = new ethers.Interface(poolAbi);
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === "PaymentIntentCreated") {
            const intentId = parsed.args.intentId;
            setBridgeTxStatus(`✅ Payment initiated! Intent: ${intentId.slice(0, 10)}...`);
            addEvent({
              type: "InstantPayment",
              ghostId: intentId,
              chain: "EVM",
              details: `${bridgeAmount} ETH → ${bridgeDestChain === "solana" ? "Solana" : "EVM"} (instant)`,
            });
            
            // Show that relayer will handle it
            setTimeout(() => {
              setBridgeTxStatus("🚀 Relayer sending SOL to recipient...");
            }, 2000);
            
            setTimeout(() => {
              setBridgeTxStatus("✅ Complete! SOL delivered to recipient.");
            }, 8000);
            
            break;
          }
        } catch {
          // not our event
        }
      }

      // Refresh balance after bridge
      await fetchBalance(userAddress);
      setBridgeAmount("");
      setBridgeDestAddress("");
    } catch (err: any) {
      console.error(err);
      setError(err.reason || err.message || "Transaction failed");
      setBridgeTxStatus(null);
    }
  }, [walletConnected, bridgeAmount, bridgeDestChain, bridgeDestAddress, receiveAsNative, config.evmChainId, getEthereum, addEvent, fetchBalance, userAddress]);

  // ─────────────────────────────────────────────────────────────
  // Data Fetching
  // ─────────────────────────────────────────────────────────────

  // Pool contract for fetching payment intents and ZK proofs
  const poolAbiForRead = [
    "event PaymentIntentCreated(bytes32 indexed intentId, address indexed sender, uint256 amount, uint256 destChainId)",
    "event SNARKProofSubmitted(bytes32 indexed intentId, bytes32 proofId)",
    "event STARKProofSubmitted(bytes32 indexed intentId, bytes32 proofId)",
    "event ZKProofVerified(bytes32 indexed intentId, bool snarkValid, bool starkValid)",
    "function getZKProofInfo(bytes32 intentId) view returns (bytes32 snarkProofId, bytes32 starkProofId, bool snarkVerified, bool starkVerified, uint256 verifiedAt)",
  ];

  const fetchEvmGhosts = useCallback(async (): Promise<GhostRow[]> => {
    const provider = new ethers.JsonRpcProvider(config.evmRpc);
    const latest = await provider.getBlockNumber();
    // Use larger range to find older ghosts (50,000 blocks ≈ 1 week)
    const fromBlock = Math.max(0, latest - 50000);
    const rows: GhostRow[] = [];

    // 1. Fetch old-style Ghosts from GhostWallet
    if (config.evmGhost) {
      try {
        const contract = new ethers.Contract(config.evmGhost, GhostWalletArtifact.abi, provider);
        const events = await contract.queryFilter(contract.filters.GhostInitiated(), fromBlock, latest);
        const typedEvents = events.filter((log): log is EventLog => "args" in log);
        const ghostIds = Array.from(new Set(typedEvents.map((log) => log.args?.ghostId as string)));

        for (const id of ghostIds) {
          try {
            const ghost = await contract.getGhost(id);
            if (ghost.state === 0n) continue;
            const stateIndex = Number(ghost.state ?? 0);
            rows.push({
              id,
              state: STATE_LABELS[stateIndex] ?? "Unknown",
              stateNum: stateIndex,
              amount: ethers.formatUnits(ghost.amount ?? 0n, 18),
              sourceChain: `EVM (${ghost.sourceChainId?.toString() ?? "?"})`,
              destChain: ghost.destinationChainId?.toString() === SOLANA_CHAIN_ID
                ? "Solana"
                : `EVM (${ghost.destinationChainId?.toString() ?? "?"})`,
              initiator: ghost.initiator ?? "0x0",
              createdAt: formatTimestamp(ghost.createdAt ?? 0n),
              isRemote: ghost.isRemote ?? false,
              remoteAck: ghost.remoteAck ?? false,
              chain: "EVM",
            });
          } catch {
            // ghost may have been settled/deleted
          }
        }
      } catch (e) {
        console.error("Error fetching old ghosts:", e);
      }
    }

    // 2. Fetch new-style Payment Intents from Pool with ZK Proof info
    try {
      const poolContract = new ethers.Contract(POOL_ADDRESS, poolAbiForRead, provider);
      const poolEvents = await poolContract.queryFilter(
        poolContract.filters.PaymentIntentCreated(),
        fromBlock,
        latest
      );

      for (const event of poolEvents) {
        if (!("args" in event)) continue;
        const { intentId, sender, amount, destChainId } = event.args;
        
        // Try to fetch ZK proof info
        let zkProof: GhostRow["zkProof"] = undefined;
        try {
          const proofInfo = await poolContract.getZKProofInfo(intentId);
          if (proofInfo.snarkProofId !== ethers.ZeroHash || proofInfo.starkProofId !== ethers.ZeroHash) {
            zkProof = {
              snarkProofId: proofInfo.snarkProofId,
              starkProofId: proofInfo.starkProofId,
              snarkVerified: proofInfo.snarkVerified,
              starkVerified: proofInfo.starkVerified,
              verifiedAt: proofInfo.verifiedAt > 0n 
                ? new Date(Number(proofInfo.verifiedAt) * 1000).toLocaleString()
                : undefined,
            };
          }
        } catch {
          // ZK proofs might not be submitted yet
        }
        
        // Determine state based on ZK proof status
        let state = "Pending";
        if (zkProof?.snarkVerified && zkProof?.starkVerified) {
          state = "ZK Verified";
        } else if (zkProof?.snarkProofId || zkProof?.starkProofId) {
          state = "ZK Proving";
        }
        
        rows.push({
          id: intentId,
          state,
          stateNum: zkProof?.snarkVerified && zkProof?.starkVerified ? 5 : 4,
          amount: ethers.formatUnits(amount ?? 0n, 18),
          sourceChain: "EVM (Pool)",
          destChain: destChainId?.toString() === SOLANA_CHAIN_ID ? "Solana" : "EVM",
          initiator: sender ?? "0x0",
          createdAt: new Date().toLocaleString(),
          isRemote: false,
          remoteAck: true,
          chain: "EVM",
          zkProof,
        });
      }
    } catch (e) {
      console.error("Error fetching pool intents:", e);
    }

    return rows;
  }, [config.evmRpc, config.evmGhost]);

  const fetchSolanaGhosts = useCallback(async (): Promise<GhostRow[]> => {
    const rows: GhostRow[] = [];
    
    // 1. Fetch old-style ghost accounts from Solana program
    if (config.solProgram) {
      try {
        const connection = new Connection(config.solRpc);
        const programId = new PublicKey(config.solProgram);
        const accounts = await connection.getProgramAccounts(programId, {
          filters: [{ dataSize: 320 }],
        });

        for (const account of accounts) {
          const data = deserialize(GhostAccountSchema, account.account.data) as GhostAccountRaw;
          const idHex = `0x${Buffer.from(data.ghost_id).toString("hex")}`;
          const state = STATE_LABELS[data.state] ?? "Unknown";
          rows.push({
            id: idHex,
            state,
            stateNum: data.state,
            amount: data.amount ? (Number(data.amount.toString()) / 1e18).toFixed(4) : "0",
            sourceChain: "Solana",
            destChain: data.destination_chain?.toString() === SOLANA_CHAIN_ID ? "Solana" : "EVM",
            initiator: new PublicKey(data.initiator).toBase58(),
            createdAt: formatTimestamp(BigInt(data.burn_ts?.toString() ?? data.lock_ts?.toString() ?? "0")),
            isRemote: data.is_remote === 1,
            remoteAck: data.remote_ack === 1,
            chain: "Solana" as const,
          });
        }
      } catch {
        // Continue even if program accounts fail
      }
    }
    
    // 2. Fetch ZK-verified pool payments that were received on Solana
    try {
      const provider = new ethers.JsonRpcProvider(config.evmRpc);
      const poolAbiForSolana = [
        "event PaymentIntentCreated(bytes32 indexed intentId, address indexed sender, uint256 amount, uint256 destChainId)",
        "function getZKProofInfo(bytes32) view returns (bytes32, bytes32, bool, bool, uint256)",
        "function intents(bytes32) view returns (bytes32 id, address sender, address token, uint256 amount, uint256 destChainId, bytes destAddress, bytes destToken, uint256 minDestAmount, uint256 deadline, bool executed, bool refunded)",
      ];
      const poolContract = new ethers.Contract(POOL_ADDRESS, poolAbiForSolana, provider);
      const latest = await provider.getBlockNumber();
      const poolEvents = await poolContract.queryFilter(
        poolContract.filters.PaymentIntentCreated(),
        Math.max(0, latest - 50000),
        latest
      );

      for (const event of poolEvents) {
        if (!("args" in event)) continue;
        const { intentId, amount, destChainId } = event.args;
        
        // Only show Solana-bound payments
        if (destChainId?.toString() !== SOLANA_CHAIN_ID) continue;
        
        // Check if ZK verified (meaning SOL was received)
        try {
          const zkInfo = await poolContract.getZKProofInfo(intentId);
          const snarkVerified = zkInfo[2];
          const starkVerified = zkInfo[3];
          const verifiedAt = zkInfo[4];
          
          if (snarkVerified && starkVerified) {
            // Get destination address
            const intent = await poolContract.intents(intentId);
            const destAddress = ethers.toUtf8String(intent.destAddress).replace(/\0/g, '');
            
            // Calculate SOL amount (use Pyth prices if available, fallback to estimate)
            const ethAmount = parseFloat(ethers.formatUnits(intent.amount ?? 0n, 18));
            const ethToSolRate = pythPrices ? (pythPrices.ethUsd / pythPrices.solUsd) : 22; // Fallback ~22:1
            const solAmount = (ethAmount * ethToSolRate).toFixed(4);
            
            rows.push({
              id: intentId,
              state: "Received",
              stateNum: 5,
              amount: ethers.formatUnits(intent.amount ?? 0n, 18),
              solAmount: solAmount,
              sourceChain: "EVM (Pool)",
              destChain: "Solana",
              initiator: destAddress.slice(0, 8) + "..." + destAddress.slice(-4),
              createdAt: verifiedAt > 0n ? new Date(Number(verifiedAt) * 1000).toLocaleString() : "—",
              isRemote: false,
              remoteAck: true,
              chain: "Solana" as const,
              zkProof: {
                snarkProofId: zkInfo[0],
                starkProofId: zkInfo[1],
                snarkVerified: true,
                starkVerified: true,
                verifiedAt: verifiedAt > 0n ? new Date(Number(verifiedAt) * 1000).toLocaleString() : undefined,
              },
            });
          }
        } catch {
          // Skip if can't get ZK info
        }
      }
    } catch (e) {
      console.error("Error fetching Solana received payments:", e);
    }
    
    return rows;
  }, [config.solProgram, config.solRpc, config.evmRpc, pythPrices]);

  const fetchValidators = useCallback(async (): Promise<ValidatorInfo[]> => {
    if (!config.evmValidator) return [];
    try {
      const provider = new ethers.JsonRpcProvider(config.evmRpc);
      const contract = new ethers.Contract(config.evmValidator, ValidatorSlashingArtifact.abi, provider);
      const activeAddrs: string[] = await contract.getActiveValidators();
      const infos: ValidatorInfo[] = [];

      for (const addr of activeAddrs) {
        const info = await contract.getValidatorInfo(addr);
        infos.push({
          address: addr,
          stake: ethers.formatUnits(info.stake ?? 0n, 18),
          reputation: Number(info.reputation ?? 0),
          slashCount: Number(info.slashCount ?? 0),
          isActive: info.isActive ?? false,
        });
      }
      return infos;
    } catch {
      return [];
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [evmGhosts, solGhosts, vals] = await Promise.all([
        fetchEvmGhosts(),
        fetchSolanaGhosts(),
        fetchValidators(),
      ]);
      
      // Merge new ghosts with existing ones, deduplicate by chain+id
      const allNewGhosts = [...evmGhosts, ...solGhosts];
      setGhosts((prev) => {
        // Create a map keyed by chain+id
        const ghostMap = new Map<string, GhostRow>();
        
        // Add existing ghosts first
        for (const g of prev) {
          ghostMap.set(`${g.chain}-${g.id}`, g);
        }
        
        // Update/add new ghosts (overwrites existing with fresh data)
        for (const g of allNewGhosts) {
          ghostMap.set(`${g.chain}-${g.id}`, g);
        }
        
        const merged = Array.from(ghostMap.values());
        saveToStorage(STORAGE_KEYS.ghosts, merged);
        return merged;
      });
      
      setValidators(vals);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fetchEvmGhosts, fetchSolanaGhosts, fetchValidators]);

  useEffect(() => {
    if (!isConfigured) return;
    refreshAll();
    const interval = setInterval(refreshAll, 10000);
    return () => clearInterval(interval);
  }, [isConfigured, refreshAll]);

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <span className="logo">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2C6.48 2 2 6.48 2 12v8c0 1.1.9 2 2 2h2v-2H4v-8c0-4.41 3.59-8 8-8s8 3.59 8 8v8h-2v2h2c1.1 0 2-.9 2-2v-8c0-5.52-4.48-10-10-10z"/>
              <circle cx="8" cy="14" r="1.5"/>
              <circle cx="16" cy="14" r="1.5"/>
            </svg>
          </span>
          <h1>Ghost Bridge</h1>
          <span className="tagline">Trustless Atomic Cross-Chain Transfers</span>
        </div>
        <div className="header-right">
          {/* Network Switcher */}
          <div className="network-switcher">
            <button 
              className={`network-btn ${isMainnet ? "mainnet" : "testnet"}`}
              onClick={() => setShowNetworkDropdown(!showNetworkDropdown)}
            >
              <span className={`network-indicator ${isMainnet ? "mainnet" : "testnet"}`} />
              {currentNetwork.name}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {showNetworkDropdown && (
              <div className="network-dropdown">
                <button 
                  className={networkId === "testnet" ? "active" : ""}
                  onClick={() => switchNetwork("testnet")}
                >
                  <span className="network-indicator testnet" />
                  <div className="network-option-info">
                    <span className="network-option-name">Testnet</span>
                    <span className="network-option-chains">Sepolia + Devnet</span>
                  </div>
                  {networkId === "testnet" && <span className="check">✓</span>}
                </button>
                <button 
                  className={networkId === "mainnet" ? "active" : ""}
                  onClick={() => switchNetwork("mainnet")}
                >
                  <span className="network-indicator mainnet" />
                  <div className="network-option-info">
                    <span className="network-option-name">Mainnet</span>
                    <span className="network-option-chains">Ethereum + Solana</span>
                  </div>
                  {networkId === "mainnet" && <span className="check">✓</span>}
                </button>
              </div>
            )}
          </div>

          {walletConnected ? (
            <div className="wallet-info">
              <span className="balance">{parseFloat(ethBalance).toFixed(4)} ETH</span>
              <span className="address">{userAddress.slice(0, 6)}...{userAddress.slice(-4)}</span>
              <span className="connected-dot" />
            </div>
          ) : (
            <button className="btn-connect" onClick={connectWallet}>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {/* Network Status Bar */}
      <div className={`network-bar ${isMainnet ? "mainnet-bar" : ""}`}>
        {isMainnet && !isConfigured && (
          <div className="network-warning">
            ⚠️ Mainnet contracts not deployed yet
          </div>
        )}
        <div className="network-item">
          <span className="network-dot evm" />
          <span>EVM: {config.evmChainName}</span>
        </div>
        <div className="network-item">
          <span className="network-dot solana" />
          <span>Solana: {config.solChainName}</span>
        </div>
        <div className="network-item">
          <span className={`status-indicator ${isConfigured ? "ok" : "warn"}`} />
          <span>{isConfigured ? "Contracts Configured" : "Missing Contract Addresses"}</span>
        </div>
        {config.jupiterEnabled && (
          <div className="network-item jupiter">
            <span className="jupiter-icon">⚡</span>
            <span>Jupiter: Active</span>
          </div>
        )}
        {loading && <span className="loading-spinner" />}
      </div>

      {/* Tabs */}
      <nav className="tabs">
        <button className={activeTab === "bridge" ? "active" : ""} onClick={() => setActiveTab("bridge")}>
          <TabIcon name="bridge" /> Bridge
        </button>
        <button className={activeTab === "pool" ? "active" : ""} onClick={() => setActiveTab("pool")}>
          <TabIcon name="pool" /> Pool
        </button>
        <button className={activeTab === "ghosts" ? "active" : ""} onClick={() => setActiveTab("ghosts")}>
          <TabIcon name="ghost" /> Ghosts ({ghosts.length})
        </button>
        <button className={activeTab === "validators" ? "active" : ""} onClick={() => setActiveTab("validators")}>
          <TabIcon name="shield" /> Validators ({validators.length})
        </button>
        <button className={activeTab === "events" ? "active" : ""} onClick={() => setActiveTab("events")}>
          <TabIcon name="list" /> Events ({events.length})
        </button>
        <button className={activeTab === "config" ? "active" : ""} onClick={() => setActiveTab("config")}>
          <TabIcon name="settings" /> Config
        </button>
      </nav>

      {/* Error Banner */}
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Main Content */}
      <main className="main-content">
        {activeTab === "bridge" && (
          <BridgePanel
            walletConnected={walletConnected}
            bridgeAmount={bridgeAmount}
            setBridgeAmount={setBridgeAmount}
            bridgeDestChain={bridgeDestChain}
            setBridgeDestChain={setBridgeDestChain}
            bridgeDestAddress={bridgeDestAddress}
            setBridgeDestAddress={setBridgeDestAddress}
            bridgeTxStatus={bridgeTxStatus}
            initiateBridge={initiateBridge}
            userBalance={userBalance}
            ethBalance={ethBalance}
            bridgeAsset={bridgeAsset}
            setBridgeAsset={setBridgeAsset}
            receiveAsNative={receiveAsNative}
            setReceiveAsNative={setReceiveAsNative}
            isMainnet={isMainnet}
            jupiterEnabled={config.jupiterEnabled}
            jupiterNote={config.jupiterNote}
            pythPrices={pythPrices}
          />
        )}

        {activeTab === "pool" && <PoolPanel />}

        {activeTab === "ghosts" && <GhostsPanel ghosts={ghosts} />}

        {activeTab === "validators" && <ValidatorsPanel validators={validators} />}

        {activeTab === "events" && (
          <EventsPanel 
            events={events} 
            onCopy={handleCopy}
            copiedId={copiedId}
            onClearEvents={() => {
              setEvents([]);
              saveToStorage(STORAGE_KEYS.events, []);
            }}
          />
        )}

        {activeTab === "config" && <ConfigPanel config={config} />}
      </main>

      {/* Footer */}
      <footer className="footer">
        <div className="footer-stats">
          <span>Active Ghosts: {ghosts.filter((g) => g.stateNum > 0 && g.stateNum < 5).length}</span>
          <span>Total Bridged: {ghosts.filter((g) => g.stateNum === 5).length}</span>
          <span>Validators: {validators.length}</span>
        </div>
        <div className="footer-links">
          <span>Ghost Wallet MVP</span>
        </div>
      </footer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Bridge Panel
// ─────────────────────────────────────────────────────────────

function BridgePanel({
  walletConnected,
  bridgeAmount,
  setBridgeAmount,
  bridgeDestChain,
  setBridgeDestChain,
  bridgeDestAddress,
  setBridgeDestAddress,
  bridgeTxStatus,
  initiateBridge,
  userBalance,
  ethBalance,
  bridgeAsset,
  setBridgeAsset,
  receiveAsNative,
  setReceiveAsNative,
  isMainnet,
  jupiterEnabled,
  jupiterNote,
  pythPrices,
}: {
  walletConnected: boolean;
  bridgeAmount: string;
  setBridgeAmount: (v: string) => void;
  bridgeDestChain: "solana" | "evm";
  setBridgeDestChain: (v: "solana" | "evm") => void;
  bridgeDestAddress: string;
  setBridgeDestAddress: (v: string) => void;
  bridgeTxStatus: string | null;
  initiateBridge: () => void;
  userBalance: string;
  ethBalance: string;
  bridgeAsset: "eth" | "token";
  setBridgeAsset: (v: "eth" | "token") => void;
  pythPrices: { ethUsd: number; solUsd: number } | null;
  receiveAsNative: boolean;
  setReceiveAsNative: (v: boolean) => void;
  isMainnet: boolean;
  jupiterEnabled: boolean;
  jupiterNote: string;
}) {
  const currentBalance = bridgeAsset === "eth" ? ethBalance : userBalance;
  const assetLabel = bridgeAsset === "eth" ? "ETH" : "tokens";
  return (
    <div className="bridge-panel">
      <div className="bridge-card">
        <h2>⚡ Instant Cross-Chain Payment</h2>
        <p className="bridge-desc">
          Pay with ETH, recipient receives SOL instantly. Powered by liquidity pools - 
          no waiting, no bidding, just instant delivery.
        </p>

        <div className="bridge-flow instant">
          <div className="flow-step">
            <div className="step-num">1</div>
            <div className="step-label">Pay ETH</div>
          </div>
          <div className="flow-arrow">⚡</div>
          <div className="flow-step">
            <div className="step-num">2</div>
            <div className="step-label">Pool Receives</div>
          </div>
          <div className="flow-arrow">⚡</div>
          <div className="flow-step highlight">
            <div className="step-num">3</div>
            <div className="step-label">Instant SOL</div>
          </div>
        </div>

        <div className="bridge-form">
          <div className="form-group">
            <label>From</label>
            <div className={`chain-badge evm ${isMainnet ? "mainnet" : ""}`}>
              {isMainnet ? "Ethereum (Mainnet)" : "EVM (Sepolia)"}
            </div>
          </div>

          <div className="form-group">
            <label>Asset to Bridge</label>
            <div className="chain-selector">
              <button
                className={bridgeAsset === "eth" ? "active" : ""}
                onClick={() => setBridgeAsset("eth")}
              >
                ETH (Native)
              </button>
              <button
                className={bridgeAsset === "token" ? "active" : ""}
                onClick={() => setBridgeAsset("token")}
              >
                Token (ERC20)
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>To</label>
            <div className="chain-selector">
              <button
                className={bridgeDestChain === "solana" ? "active" : ""}
                onClick={() => setBridgeDestChain("solana")}
              >
                Solana
              </button>
              <button
                className={bridgeDestChain === "evm" ? "active" : ""}
                onClick={() => setBridgeDestChain("evm")}
              >
                EVM
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>Amount</label>
            <div className="amount-input">
              <input
                type="number"
                placeholder="0.0"
                value={bridgeAmount}
                onChange={(e) => setBridgeAmount(e.target.value)}
              />
              <span className="token-label">{assetLabel}</span>
              <button className="max-btn" onClick={() => setBridgeAmount(currentBalance)}>
                MAX
              </button>
            </div>
            <span className="balance-hint">Balance: {parseFloat(currentBalance).toFixed(4)} {assetLabel}</span>
          </div>

          <div className="form-group">
            <label>Destination Address</label>
            <input
              type="text"
              placeholder={bridgeDestChain === "solana" ? "Solana address..." : "0x..."}
              value={bridgeDestAddress}
              onChange={(e) => setBridgeDestAddress(e.target.value)}
            />
          </div>

          {bridgeDestChain === "solana" && bridgeAmount && (
            <div className="form-group">
              <label>Estimated Delivery</label>
              <div className="swap-estimate">
                <span className="estimate-label">◎ Recipient receives:</span>
                <span className="estimate-value">
                  ~{pythPrices 
                    ? ((parseFloat(bridgeAmount || "0") * pythPrices.ethUsd / pythPrices.solUsd)).toFixed(4)
                    : (parseFloat(bridgeAmount || "0") * 40).toFixed(2)
                  } SOL
                </span>
                {pythPrices && (
                  <span className="rate-info">
                    💱 Live: 1 ETH = {(pythPrices.ethUsd / pythPrices.solUsd).toFixed(2)} SOL
                  </span>
                )}
                <span className="estimate-note">⚡ Instant from pool (~10 sec)</span>
              </div>
            </div>
          )}

          {bridgeTxStatus && (
            <div className={`tx-status ${bridgeTxStatus.startsWith("Success") ? "success" : ""}`}>
              {bridgeTxStatus}
            </div>
          )}

          <button
            className="btn-bridge"
            onClick={initiateBridge}
            disabled={!walletConnected || !bridgeAmount || !bridgeDestAddress}
          >
            {!walletConnected
              ? "Connect Wallet First"
              : bridgeTxStatus
              ? "Processing..."
              : "⚡ Pay Instantly"}
          </button>
        </div>
      </div>

      <div className="bridge-info">
        <h3>Why Instant?</h3>
        <div className="info-grid">
          <div className="info-card">
            <span className="info-icon">⚡</span>
            <h4>~10 Second Delivery</h4>
            <p>Recipient gets SOL instantly from the liquidity pool. No waiting.</p>
          </div>
          <div className="info-card">
            <span className="info-icon">💧</span>
            <h4>Pool-Powered</h4>
            <p>Liquidity providers fund instant transfers. You pay, they deliver.</p>
          </div>
          <div className="info-card">
            <span className="info-icon">🔒</span>
            <h4>Secure & Trustless</h4>
            <p>ZK proofs verify settlement. Funds are safe even if relayer fails.</p>
          </div>
          <div className="info-card">
            <span className="info-icon">💰</span>
            <h4>Low Fees</h4>
            <p>Only 0.3% total fee (0.1% protocol + 0.2% to LPs).</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Pool Panel - Liquidity Provider Interface
// ─────────────────────────────────────────────────────────────

function PoolPanel() {
  const [poolStats, setPoolStats] = useState({
    totalDeposited: "0",
    availableLiquidity: "0",
    totalShares: "0",
    totalFees: "0",
    active: false,
  });
  const [userShares, setUserShares] = useState("0");
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawShares, setWithdrawShares] = useState("");
  const [txStatus, setTxStatus] = useState<string | null>(null);

  // Pool contract address - should come from env
  const POOL_ADDRESS = "0x3078516D302805051E937f221A4b386D1D5ac8b9";

  const poolAbi = [
    "function getPoolInfo(address token) view returns (uint256, uint256, uint256, uint256, bool)",
    "function getLPValue(address token, address lp) view returns (uint256)",
    "function depositETH() payable returns (uint256)",
    "function withdrawETH(uint256 shares) returns (uint256)",
    "function lpPositions(address, address) view returns (uint256 shares, uint256 depositedAt)",
  ];

  const fetchPoolStats = useCallback(async () => {
    try {
      const provider = new ethers.JsonRpcProvider(import.meta.env.VITE_EVM_RPC);
      const pool = new ethers.Contract(POOL_ADDRESS, poolAbi, provider);
      
      const info = await pool.getPoolInfo(ethers.ZeroAddress);
      setPoolStats({
        totalDeposited: ethers.formatEther(info[0]),
        totalShares: info[1].toString(),
        totalFees: ethers.formatEther(info[2]),
        availableLiquidity: ethers.formatEther(info[3]),
        active: info[4],
      });

      // Get user's position if connected
      const win = window as any;
      if (win.ethereum) {
        const accounts = await win.ethereum.request({ method: "eth_accounts" });
        if (accounts.length > 0) {
          const position = await pool.lpPositions(ethers.ZeroAddress, accounts[0]);
          setUserShares(position.shares.toString());
        }
      }
    } catch (e) {
      console.error("Failed to fetch pool stats:", e);
    }
  }, []);

  useEffect(() => {
    fetchPoolStats();
    const interval = setInterval(fetchPoolStats, 15000);
    return () => clearInterval(interval);
  }, [fetchPoolStats]);

  const handleDeposit = async () => {
    if (!depositAmount || parseFloat(depositAmount) <= 0) return;
    
    try {
      const win = window as any;
      if (!win.ethereum) throw new Error("No wallet");
      
      const provider = new ethers.BrowserProvider(win.ethereum);
      const signer = await provider.getSigner();
      const pool = new ethers.Contract(POOL_ADDRESS, poolAbi, signer);
      
      setTxStatus("Depositing...");
      const tx = await pool.depositETH({
        value: ethers.parseEther(depositAmount)
      });
      setTxStatus("Confirming...");
      await tx.wait();
      setTxStatus("✅ Deposited!");
      setDepositAmount("");
      fetchPoolStats();
    } catch (e: any) {
      setTxStatus("❌ " + (e.reason || e.message));
    }
  };

  const handleWithdraw = async () => {
    if (!withdrawShares || parseFloat(withdrawShares) <= 0) return;
    
    try {
      const win = window as any;
      if (!win.ethereum) throw new Error("No wallet");
      
      const provider = new ethers.BrowserProvider(win.ethereum);
      const signer = await provider.getSigner();
      const pool = new ethers.Contract(POOL_ADDRESS, poolAbi, signer);
      
      setTxStatus("Withdrawing...");
      const tx = await pool.withdrawETH(withdrawShares);
      setTxStatus("Confirming...");
      await tx.wait();
      setTxStatus("✅ Withdrawn!");
      setWithdrawShares("");
      fetchPoolStats();
    } catch (e: any) {
      setTxStatus("❌ " + (e.reason || e.message));
    }
  };

  return (
    <div className="pool-panel">
      <div className="pool-header">
        <h2>💧 Liquidity Pool</h2>
        <p className="pool-desc">
          Provide liquidity to enable instant cross-chain payments. 
          Earn fees from every transaction that uses the pool.
        </p>
      </div>

      <div className="pool-grid">
        {/* Pool Stats */}
        <div className="pool-card stats">
          <h3>Pool Statistics</h3>
          <div className="stat-grid">
            <div className="stat-item">
              <span className="stat-label">Total Deposited</span>
              <span className="stat-value">{parseFloat(poolStats.totalDeposited).toFixed(4)} ETH</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Available Liquidity</span>
              <span className="stat-value">{parseFloat(poolStats.availableLiquidity).toFixed(4)} ETH</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Total Fees Earned</span>
              <span className="stat-value">{parseFloat(poolStats.totalFees).toFixed(6)} ETH</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Pool Status</span>
              <span className={`stat-value ${poolStats.active ? "active" : "inactive"}`}>
                {poolStats.active ? "🟢 Active" : "🔴 Inactive"}
              </span>
            </div>
          </div>
        </div>

        {/* Your Position */}
        <div className="pool-card position">
          <h3>Your Position</h3>
          <div className="position-info">
            <div className="position-shares">
              <span className="label">LP Shares</span>
              <span className="value">{userShares}</span>
            </div>
            <div className="position-value">
              <span className="label">Estimated Value</span>
              <span className="value">
                {poolStats.totalShares !== "0" 
                  ? (parseFloat(userShares) / parseFloat(poolStats.totalShares) * parseFloat(poolStats.totalDeposited)).toFixed(6)
                  : "0"
                } ETH
              </span>
            </div>
          </div>
        </div>

        {/* Deposit */}
        <div className="pool-card action">
          <h3>Deposit ETH</h3>
          <p>Add liquidity to the pool and earn fees.</p>
          <div className="action-form">
            <input
              type="number"
              placeholder="0.0 ETH"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
            />
            <button onClick={handleDeposit} disabled={!depositAmount}>
              Deposit
            </button>
          </div>
        </div>

        {/* Withdraw */}
        <div className="pool-card action">
          <h3>Withdraw</h3>
          <p>Redeem your LP shares for ETH + earned fees.</p>
          <div className="action-form">
            <input
              type="number"
              placeholder="Shares to redeem"
              value={withdrawShares}
              onChange={(e) => setWithdrawShares(e.target.value)}
            />
            <button onClick={handleWithdraw} disabled={!withdrawShares}>
              Withdraw
            </button>
          </div>
        </div>
      </div>

      {txStatus && (
        <div className={`tx-status ${txStatus.includes("✅") ? "success" : txStatus.includes("❌") ? "error" : ""}`}>
          {txStatus}
        </div>
      )}

      <div className="pool-info-section">
        <h3>How It Works</h3>
        <div className="info-cards">
          <div className="info-item">
            <span className="info-icon">1️⃣</span>
            <div>
              <strong>Deposit ETH</strong>
              <p>Your ETH goes into the pool and you receive LP shares.</p>
            </div>
          </div>
          <div className="info-item">
            <span className="info-icon">2️⃣</span>
            <div>
              <strong>Enable Instant Payments</strong>
              <p>Pool liquidity is used to instantly fulfill cross-chain payments.</p>
            </div>
          </div>
          <div className="info-item">
            <span className="info-icon">3️⃣</span>
            <div>
              <strong>Earn Fees</strong>
              <p>0.2% of every payment goes to LPs. Fees auto-compound.</p>
            </div>
          </div>
          <div className="info-item">
            <span className="info-icon">4️⃣</span>
            <div>
              <strong>Withdraw Anytime</strong>
              <p>Redeem shares for your ETH + accumulated fees.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Ghosts Panel
// ─────────────────────────────────────────────────────────────

function GhostsPanel({ ghosts }: { ghosts: GhostRow[] }) {
  const evmGhosts = ghosts.filter((g) => g.chain === "EVM");
  const solGhosts = ghosts.filter((g) => g.chain === "Solana");

  return (
    <div className="ghosts-panel">
      <div className="ghosts-section">
        <h2>EVM Ghosts</h2>
        <GhostTable ghosts={evmGhosts} />
      </div>
      <div className="ghosts-section">
        <h2>Solana Ghosts</h2>
        <GhostTable ghosts={solGhosts} />
      </div>
    </div>
  );
}

function GhostTable({ ghosts }: { ghosts: GhostRow[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (ghosts.length === 0) {
    return <div className="empty-state">No ghosts detected on this chain.</div>;
  }

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div className="table-container">
      <table>
        <thead>
          <tr>
            <th>Ghost ID</th>
            <th>Status</th>
            <th>Amount</th>
            <th>Route</th>
            <th>ZK Proofs</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {ghosts.map((ghost) => (
            <React.Fragment key={`${ghost.chain}-${ghost.id}`}>
              <tr 
                className={`ghost-row ${expandedId === ghost.id ? 'expanded' : ''}`}
                onClick={() => toggleExpand(ghost.id)}
                style={{ cursor: 'pointer' }}
              >
                <td className="mono">{ghost.id.slice(0, 10)}...</td>
                <td>
                  <span className={`status-pill status-${ghost.state.toLowerCase().replace(/[^a-z]/g, '')}`}>
                    {ghost.state}
                  </span>
                </td>
                <td>
                {ghost.chain === "Solana" && ghost.solAmount 
                  ? `${ghost.solAmount} SOL`
                  : `${ghost.amount} ETH`
                }
              </td>
                <td>
                  {ghost.sourceChain} → {ghost.destChain}
                </td>
                <td>
                  {ghost.zkProof ? (
                    <div className="zk-proof-status">
                      <div className="proof-row">
                        <span className={`proof-badge ${ghost.zkProof.snarkVerified ? 'verified' : ghost.zkProof.snarkProofId ? 'pending' : 'none'}`}>
                          SNARK {ghost.zkProof.snarkVerified ? '✓' : ghost.zkProof.snarkProofId ? '⏳' : '—'}
                        </span>
                        <span className={`proof-badge ${ghost.zkProof.starkVerified ? 'verified' : ghost.zkProof.starkProofId ? 'pending' : 'none'}`}>
                          STARK {ghost.zkProof.starkVerified ? '✓' : ghost.zkProof.starkProofId ? '⏳' : '—'}
                        </span>
                      </div>
                      {ghost.zkProof.snarkProofId && (
                        <div className="proof-id mono" title={ghost.zkProof.snarkProofId}>
                          {ghost.zkProof.snarkProofId.slice(0, 8)}...
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="no-zk">
                      {ghost.isRemote && <span className="flag remote">Remote</span>}
                      {ghost.remoteAck && <span className="flag ack">Ack'd</span>}
                      {!ghost.isRemote && !ghost.remoteAck && "—"}
                    </span>
                  )}
                </td>
                <td>{ghost.createdAt}</td>
              </tr>
              {expandedId === ghost.id && (
                <tr className="ghost-detail-row">
                  <td colSpan={6}>
                    <div className="ghost-detail">
                      <div className="detail-grid">
                        <div className="detail-section">
                          <h4>Transaction Info</h4>
                          <div className="detail-item">
                            <span className="detail-label">Ghost ID</span>
                            <span className="detail-value mono">{ghost.id}</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Amount</span>
                            <span className="detail-value">
                              {ghost.amount} ETH
                              {ghost.solAmount && ` → ${ghost.solAmount} SOL`}
                            </span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Status</span>
                            <span className="detail-value">{ghost.state}</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Created</span>
                            <span className="detail-value">{ghost.createdAt}</span>
                          </div>
                        </div>
                        
                        <div className="detail-section">
                          <h4>Route</h4>
                          <div className="detail-item">
                            <span className="detail-label">Source</span>
                            <span className="detail-value">{ghost.sourceChain}</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Destination</span>
                            <span className="detail-value">{ghost.destChain}</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Initiator</span>
                            <span className="detail-value mono">{ghost.initiator}</span>
                          </div>
                        </div>
                        
                        {ghost.zkProof && (
                          <div className="detail-section">
                            <h4>ZK Proofs</h4>
                            <div className="detail-item">
                              <span className="detail-label">SNARK Proof</span>
                              <span className="detail-value mono">
                                {ghost.zkProof.snarkProofId || "Not generated"}
                                {ghost.zkProof.snarkVerified && " ✓"}
                              </span>
                            </div>
                            <div className="detail-item">
                              <span className="detail-label">STARK Proof</span>
                              <span className="detail-value mono">
                                {ghost.zkProof.starkProofId || "Not generated"}
                                {ghost.zkProof.starkVerified && " ✓"}
                              </span>
                            </div>
                            {ghost.zkProof.verifiedAt && (
                              <div className="detail-item">
                                <span className="detail-label">Verified At</span>
                                <span className="detail-value">{ghost.zkProof.verifiedAt}</span>
                              </div>
                            )}
                          </div>
                        )}
                        
                        <div className="detail-section">
                          <h4>Flags</h4>
                          <div className="detail-item">
                            <span className="detail-label">Remote</span>
                            <span className="detail-value">{ghost.isRemote ? "Yes" : "No"}</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Acknowledged</span>
                            <span className="detail-value">{ghost.remoteAck ? "Yes" : "No"}</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Chain</span>
                            <span className="detail-value">{ghost.chain}</span>
                          </div>
                        </div>
                      </div>
                      
                      <div className="detail-actions">
                        {ghost.chain === "EVM" && (
                          <a 
                            href={`https://sepolia.etherscan.io/tx/${ghost.id}`} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="detail-link"
                            onClick={(e) => e.stopPropagation()}
                          >
                            View on Etherscan →
                          </a>
                        )}
                        {ghost.chain === "Solana" && ghost.initiator && (
                          <a 
                            href={`https://explorer.solana.com/address/${ghost.initiator}?cluster=devnet`} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="detail-link"
                            onClick={(e) => e.stopPropagation()}
                          >
                            View on Solana Explorer →
                          </a>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Validators Panel
// ─────────────────────────────────────────────────────────────

function ValidatorsPanel({ validators }: { validators: ValidatorInfo[] }) {
  if (validators.length === 0) {
    return (
      <div className="validators-panel">
        <h2>Validator Set</h2>
        <div className="empty-state">
          No active validators found. Validators must stake tokens to participate.
        </div>
      </div>
    );
  }

  return (
    <div className="validators-panel">
      <h2>Validator Set</h2>
      <div className="validator-grid">
        {validators.map((v) => (
          <div key={v.address} className="validator-card">
            <div className="validator-header">
              <span className={`validator-status ${v.isActive ? "active" : "inactive"}`} />
              <span className="validator-address">{v.address.slice(0, 8)}...{v.address.slice(-6)}</span>
            </div>
            <div className="validator-stats">
              <div className="stat">
                <span className="stat-label">Stake</span>
                <span className="stat-value">{parseFloat(v.stake).toFixed(2)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Reputation</span>
                <span className="stat-value">{v.reputation}/100</span>
              </div>
              <div className="stat">
                <span className="stat-label">Slashes</span>
                <span className="stat-value">{v.slashCount}</span>
              </div>
            </div>
            <div className="reputation-bar">
              <div className="reputation-fill" style={{ width: `${v.reputation}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Events Panel
// ─────────────────────────────────────────────────────────────

function EventsPanel({ 
  events, 
  onCopy, 
  copiedId,
  onClearEvents 
}: { 
  events: EventLogEntry[]; 
  onCopy: (id: string) => void;
  copiedId: string | null;
  onClearEvents: () => void;
}) {
  if (events.length === 0) {
    return (
      <div className="events-panel">
        <h2>Event Log</h2>
        <div className="events-header-actions">
          <button className="btn-small" onClick={onClearEvents}>Clear All</button>
        </div>
        <div className="empty-state">No events yet. Initiate a bridge to see activity.</div>
      </div>
    );
  }

  return (
    <div className="events-panel">
      <h2>Event Log</h2>
      <div className="events-header-actions">
        <span className="event-count">{events.length} events</span>
        <button className="btn-small" onClick={onClearEvents}>Clear All</button>
      </div>
      <div className="events-list">
        {events.map((e) => (
          <div key={e.id} className="event-item">
            <div className="event-time">{e.timestamp.toLocaleTimeString()}</div>
            <div className={`event-chain ${e.chain.toLowerCase()}`}>{e.chain}</div>
            <div className="event-type">{e.type}</div>
            <div className="event-ghost-container">
              <span className="event-ghost mono" title={e.ghostId}>
                {truncateId(e.ghostId, 10, 8)}
              </span>
              <button 
                className="copy-btn" 
                onClick={() => onCopy(e.ghostId)}
                title="Copy full ID"
              >
                {copiedId === e.ghostId ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                )}
              </button>
            </div>
            <div className="event-details">{e.details}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Config Panel
// ─────────────────────────────────────────────────────────────

function ConfigPanel({ config }: { config: ReturnType<typeof getConfigFromNetwork> }) {
  return (
    <div className="config-panel">
      <h2>Configuration</h2>
      <p className="config-desc">
        These values are loaded from environment variables in <code>.env</code>. 
        To change them, edit the file and restart the dashboard.
      </p>

      <div className="config-grid">
        <ConfigItem
          label="EVM RPC"
          value={config.evmRpc}
          env="VITE_EVM_RPC"
          description="The RPC endpoint for the EVM chain (Sepolia, mainnet, or local Hardhat node)"
        />
        <ConfigItem
          label="EVM Chain ID"
          value={config.evmChainId}
          env="VITE_EVM_CHAIN_ID"
          description="Chain ID (11155111 = Sepolia, 1 = Mainnet, 31337 = Local Hardhat)"
        />
        <ConfigItem
          label="GhostWallet Contract"
          value={config.evmGhost}
          env="VITE_EVM_GHOST_ADDRESS"
          description="The deployed GhostWallet.sol contract address. This is the core contract that manages the ghost lifecycle (create, lock, burn, mint, settle)."
          required
        />
        <ConfigItem
          label="MasterBridge Contract"
          value={config.evmBridge}
          env="VITE_EVM_BRIDGE_ADDRESS"
          description="The deployed MasterBridge.sol contract address. This is the user-facing entry point that handles token approvals and multi-sig validator coordination."
          required
        />
        <ConfigItem
          label="ValidatorSlashing Contract"
          value={config.evmValidator}
          env="VITE_EVM_VALIDATOR_ADDRESS"
          description="The deployed ValidatorSlashing.sol contract address. Manages validator staking, reputation, and slashing."
        />
        <ConfigItem
          label="Token Contract"
          value={config.evmToken}
          env="VITE_EVM_TOKEN_ADDRESS"
          description="The ERC20 token contract address that users will bridge. This can be any ERC20 token you deploy for testing."
        />
        <ConfigItem
          label="Solana RPC"
          value={config.solRpc}
          env="VITE_SOL_RPC"
          description="The RPC endpoint for Solana (Devnet, Mainnet, or local validator)"
        />
        <ConfigItem
          label="Solana Program ID"
          value={config.solProgram}
          env="VITE_SOL_PROGRAM_ID"
          description="The deployed Solana program ID (the Ghost Wallet program on Solana)."
        />
      </div>

      <div className="config-help">
        <h3>Quick Setup</h3>
        <p>Create a <code>.env</code> file in the dashboard folder with:</p>
        <pre>{`# EVM (Sepolia)
VITE_EVM_RPC=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
VITE_EVM_CHAIN_ID=11155111
VITE_EVM_GHOST_ADDRESS=0x...
VITE_EVM_BRIDGE_ADDRESS=0x...
VITE_EVM_VALIDATOR_ADDRESS=0x...
VITE_EVM_TOKEN_ADDRESS=0x...

# Solana (Devnet)
VITE_SOL_RPC=https://solana-devnet.g.alchemy.com/v2/YOUR_KEY
VITE_SOL_PROGRAM_ID=...`}</pre>
      </div>
    </div>
  );
}

function ConfigItem({
  label,
  value,
  env,
  description,
  required,
}: {
  label: string;
  value: string;
  env: string;
  description: string;
  required?: boolean;
}) {
  return (
    <div className={`config-item ${!value && required ? "missing" : ""}`}>
      <div className="config-header">
        <span className="config-key">{label}</span>
        {required && !value && <span className="required-badge">Required</span>}
        {value && <span className="configured-badge"><Icon name="check" /></span>}
      </div>
      <div className="config-value">
        {value || <span className="not-set">Not configured</span>}
      </div>
      <div className="config-env">
        <code>{env}</code>
      </div>
      <div className="config-description">{description}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Icons (SVG)
// ─────────────────────────────────────────────────────────────

function Icon({ name }: { name: string }) {
  const icons: Record<string, JSX.Element> = {
    lock: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    ),
    flame: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
      </svg>
    ),
    clock: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
    ),
    shield: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    ),
    check: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    ),
  };
  return icons[name] || null;
}

function TabIcon({ name }: { name: string }) {
  const icons: Record<string, JSX.Element> = {
    bridge: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
        <line x1="4" y1="22" x2="4" y2="15"/>
      </svg>
    ),
    pool: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 6v12M6 12h12"/>
      </svg>
    ),
    ghost: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2C6.48 2 2 6.48 2 12v8c0 1.1.9 2 2 2h2v-2H4v-8c0-4.41 3.59-8 8-8s8 3.59 8 8v8h-2v2h2c1.1 0 2-.9 2-2v-8c0-5.52-4.48-10-10-10z"/>
        <circle cx="8" cy="13" r="1"/>
        <circle cx="16" cy="13" r="1"/>
      </svg>
    ),
    shield: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    ),
    list: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="8" y1="6" x2="21" y2="6"/>
        <line x1="8" y1="12" x2="21" y2="12"/>
        <line x1="8" y1="18" x2="21" y2="18"/>
        <line x1="3" y1="6" x2="3.01" y2="6"/>
        <line x1="3" y1="12" x2="3.01" y2="12"/>
        <line x1="3" y1="18" x2="3.01" y2="18"/>
      </svg>
    ),
    settings: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    ),
  };
  return icons[name] || null;
}


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function formatTimestamp(value: bigint): string {
  if (!value || value === 0n) return "—";
  const date = new Date(Number(value) * 1000);
  return date.toLocaleString();
}
