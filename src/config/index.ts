
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

export const STRATEGY = {
    // Market Maker Strategy (3-Bin Active Range)
    BIN_RANGE: 3,
    BIN_OFFSET: 1, // +/- 1 bin from active
    LIQUIDITY_USAGE_PERCENT: 97, // Use 97% of available balances
    MIN_GAS_RESERVE_MON: 50, // Amount to subtract from balance for gas buffer
    MIN_SAFE_BALANCE_MON: 1.0, // Critical low balance stop threshold

    // Timing & Cooldowns
    MIN_REBALANCE_INTERVAL: 60, // 60s cooldown
    OUT_OF_RANGE_GRACE: 180, // 3m grace period
    POLL_INTERVAL: 5000, // 5s loop

    // Execution
    MAX_SLIPPAGE_PERCENT: 0.15, // 0.15%

    // Safety Modules
    MAX_GAS_PER_TX_MON: 0.15,
    MAX_REBALANCES_PER_DAY: 200,
    MIN_EXPECTED_REWARD_MON: 0.20,
    SAFE_SHUTDOWN_RPC_FAILURES: 10,
    PARTIAL_REBALANCE_OVERLAP: 2, // If overlap >= 2 bins, skip rebalance
    VOLATILITY_MULTIPLIER: 2, // Double cooldown if volatile
};

if (!PRIVATE_KEY) {
    console.error('FATAL: PRIVATE_KEY not found in .env');
    process.exit(1);
}
