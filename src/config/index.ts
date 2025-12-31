
import { Address, Hex } from 'viem';
import { config } from 'dotenv';

config();

// ENVIRONMENT VARIABLES
export const RPC_URL = process.env.RPC_URL || 'https://rpc.monad.xyz';
export const PRIVATE_KEY = process.env.PRIVATE_KEY as Hex;
export const CHAIN_ID = 143; // Monad Mainnet

// CONTRACT ADDRESSES
export const POOL_ADDRESS = '0xdd0a93642B0e1e938a75B400f31095Af4C4BECE5' as Address;
export const ROUTER_ADDRESS = '0x18556DA13313f3532c54711497A8FedAC273220E' as Address;

// Gas price settings (higher = faster inclusion = less retries)
export const GAS_SETTINGS = {
    MAX_FEE_PER_GAS: 150n * 1_000_000_000n, // 150 Gwei
    MAX_PRIORITY_FEE_PER_GAS: 2n * 1_000_000_000n, // 2 Gwei tip
};

// STRATEGY CONSTANTS
export const STRATEGY = {
    REBALANCE_THRESH_PRICE: 0.0005, // 0.05%
    REBALANCE_THRESH_FEE_VALUE: 0.001, // 0.1%
    SLIPPAGE: 0.002, // 0.2%
    MIN_GAS_RESERVE_MON: 1, // Minimum MON to keep for gas
    GAS_RESERVE_PERCENT: 0.02,
    THREE_BIN_SPREAD: 1, // Range: [active-1, active, active+1]
};

if (!PRIVATE_KEY) {
    console.error('FATAL: PRIVATE_KEY not found in .env');
    process.exit(1);
}
