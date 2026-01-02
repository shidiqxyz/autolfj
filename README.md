# Monad DLMM Spam Bot

Automated liquidity "spam" bot for LFJ (Trader Joe) Liquidity Book on Monad Mainnet. This bot repeatedly adds and removes liquidity to generate activity.

## Project Structure
```
src/
├── abis/           # Contract ABIs
├── config/         # Configuration & Constants
├── core/           # Main Bot Logic
├── utils/          # Helper functions
└── index.ts        # Entry point
```

## Features
- **Target Pool**: 
  - **MON/WETH**: `0x0594c7505A667933c7d8CB1064BcA58A2211a3be` (Default)
  - **MON/AUSD**: `0xdd0a93642B0e1e938a75B400f31095Af4C4BECE5`
  - *Note: Switch pools by updating `POOL_ADDRESS` in `src/config/index.ts`*
- **Strategy**: Cyclic Add/Remove in a 2-bin range `[activeId, activeId + 1]`
- **Cycle-based**: 
  1. Adds liquidity
  2. Waits (random delay)
  3. Removes liquidity
  4. Repeats
- **Native Token Support**: Uses `addLiquidityNATIVE` and `removeLiquidityNATIVE`
- **Liquidity Usage**: Uses 100% of usable balance per cycle

## Safety Features
- **Gas Reserve**: Reserves 10 MON for gas fees
- **Safety Stop**: Stops automatically if balance falls below 1 MON
- **Slippage Protection**: 5 bins tolerance
- **Retry Logic**: 3 attempts with exponential backoff for transactions

## Prerequisites
- Node.js >= 18
- MON for gas and liquidity
- WETH (optional, bot handles single-sided MON if needed, but intended for mixed usage if available)

## Setup

### 1. Install
```bash
npm install
```

### 2. Configure
```bash
cp .env.example .env
```

Edit `.env`:
```
PRIVATE_KEY=your_private_key_without_0x
RPC_URL=https://rpc.monad.xyz
```

### 3. Run
```bash
npm start
```

## Production (PM2)

### Install PM2
```bash
npm install -g pm2
```

### Start with PM2
```bash
# Basic start
pm2 start npm --name "dlmm-bot" -- start

# With auto-restart (recommended)
pm2 start npm --name "dlmm-bot" --cron-restart="0 0 * * *" -- start
```

## Configuration
Edit `src/config/index.ts` to change:
- `STRATEGY` settings:
    - `LIQUIDITY_USE_PERCENT`: Percentage of balance to use (Default: 1 for 100%)
    - `DELAY_AFTER_ADD_MIN/MAX`: Time to hold position (Default: 10-90s)
    - `DELAY_AFTER_REMOVE_MIN/MAX`: Time to wait before next cycle (Default: 5-30s)
    - `MIN_GAS_RESERVE_MON`: Amount to keep for gas (Default: 10 MON)

## Logs
- `[Init]` - Startup info
- `[Cycle]` - Cycle start/end summary
- `[Balance]` - Balance checks
- `[Liquidity]` - Calculation of amounts to add
- `[Pool]` - Active bin tracking
- `[Add]` - Add liquidity operations
- `[Remove]` - Remove liquidity operations
- `[Delay]` - Waiting periods
- `[Error]` - Error reporting

## Liquidity Distribution
- **2-Bin Range**: `[activeId, activeId + 1]`
- **Distribution**:
    - **Token X (MON)**: Split 50/50 between `activeId` and `activeId + 1`
    - **Token Y (WETH)**: 
        - If `activeId` is the first bin: 100% to `activeId`
        - If `activeId` is the second bin: 100% to `activeId`
        - Typically aims effectively for `activeId` for WETH.

## Disclaimer
⚠️ Use at your own risk. This bot handles private keys and executes real transactions.
