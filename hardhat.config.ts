import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const RELAYER_KEY = process.env.RELAYER_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";
const EVM_RPC = process.env.EVM_RPC || "https://eth-sepolia.g.alchemy.com/v2/demo";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      accounts: {
        count: 20,
        accountsBalance: "10000000000000000000000",
      },
    },
    sepolia: {
      url: EVM_RPC,
      accounts: [RELAYER_KEY],
      chainId: 11155111,
    },
  },
  mocha: {
    timeout: 120000,
  },
};

export default config;

