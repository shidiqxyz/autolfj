
import { Address, Hex } from 'viem';
import { config } from 'dotenv';

config();

// ENVIRONMENT VARIABLES
export const RPC_URL = process.env.RPC_URL || 'https://rpc.monad.xyz';
export const PRIVATE_KEY = process.env.PRIVATE_KEY as Hex;
export const CHAIN_ID = 143; // Monad Mainnet

// CONTRACT ADDRESSES
//Pool WETH (0x0594c7505A667933c7d8CB1064BcA58A2211a3be)
//Pool AUSD (0xdd0a93642B0e1e938a75B400f31095Af4C4BECE5)
export const POOL_ADDRESS = '0x0594c7505A667933c7d8CB1064BcA58A2211a3be' as Address;
export const ROUTER_ADDRESS = '0x18556DA13313f3532c54711497A8FedAC273220E' as Address;

// Gas price settings (higher = faster inclusion = less retries)
export const GAS_SETTINGS = {
    MAX_FEE_PER_GAS: 150n * 1_000_000_000n, // 150 Gwei
    MAX_PRIORITY_FEE_PER_GAS: 2n * 1_000_000_000n, // 2 Gwei tip
};

// SPAM BOT STRATEGY CONSTANTS
export const STRATEGY = {
    MIN_GAS_RESERVE_MON: 50, // Reserve for gas operations
    MIN_SAFE_BALANCE_MON: 1, // Stop bot if balance < this threshold
    LIQUIDITY_USE_PERCENT: 1, // Use 100% of usable MON
    DELAY_AFTER_ADD_MIN: 10, // Min seconds to wait after adding liquidity
    DELAY_AFTER_ADD_MAX: 90, // Max seconds to wait after adding liquidity
    DELAY_AFTER_REMOVE_MIN: 0, // Min seconds to wait after removing liquidity
    DELAY_AFTER_REMOVE_MAX: 1, // Max seconds to wait after removing liquidity
    // IL Protection
    MAX_BIN_DRIFT: 2, // Max allowed bin deviation before holding (approx 0.2% if step=100)
    MAX_HOLD_DURATION_SEC: 600, // Max seconds to hold a losing position (5 mins)
    SLIPPAGE_TOLERANCE: 0.1, // 0.1% slippage tolerance
};

if (!PRIVATE_KEY) {
    console.error('FATAL: PRIVATE_KEY not found in .env');
    process.exit(1);
}
