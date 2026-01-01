# Monad DLMM Rebalancing Bot

Auto-rebalancing bot for LFJ (Trader Joe) Liquidity Book on Monad Mainnet.

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
- **Target Pool**: `0xdd0a93642B0e1e938a75B400f31095Af4C4BECE5`
- **Strategy**: Tight 3-bin range around active price
- **Event-driven**: Triggers on every new block via `watchBlocks`
- **Fallback**: 5-minute interval check if block watching fails
- **Time-based Rebalancing**: Automatic maintenance rebalance after 1 minute of continuous IN-RANGE state
- **Native Token Support**: Uses `addLiquidityNATIVE` and `removeLiquidityNATIVE` for gas-efficient native token handling
- **Liquidity Reserve**: Uses 90% of balance for liquidity, reserves 10% in wallet

## Safety Features
- Gas Reserve: Reserves 10 MON for gas fees in every `addLiquidityNATIVE` operation
- Safety Stop: Bot stops automatically if balance falls below 1 MON
- Slippage Protection: 5 bins tolerance
- Receipt Validation: Detects on-chain reverts
- Retry Logic: 3 attempts with exponential backoff
- Dust Filter: Ignores amounts < 1000 wei
- Unlimited Approvals: One-time max approval to save gas
- Mutex Lock: Ensures only one rebalance operation runs at a time

## Prerequisites
- Node.js >= 18
- MON for gas (minimum 10 MON reserve for `addLiquidityNATIVE` operations)
- Pool tokens (WMON/AUSD or relevant pair)

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

### 3. Fund Wallet
- At least 10 MON for gas (reserved for `addLiquidityNATIVE` operations)
- Pool tokens to provide liquidity
- **Note**: Bot will stop if balance falls below 1 MON for safety

### 4. Run
```bash
npm start
```

## Production (PM2)

PM2 keeps the bot running 24/7 with auto-restart on crashes.

### Install PM2
```bash
npm install -g pm2
```

### Start with PM2
```bash
# Basic start
pm2 start npm --name "dlmm-bot" -- start

# With auto-restart every 24 hours (recommended)
pm2 start npm --name "dlmm-bot" --cron-restart="0 0 * * *" -- start
```

**Note**: The cron pattern `0 0 * * *` restarts the bot at midnight (00:00) every day.

### Useful Commands
```bash
pm2 logs dlmm-bot      # View logs
pm2 status             # Check status
pm2 restart dlmm-bot   # Restart bot
pm2 stop dlmm-bot      # Stop bot
pm2 delete dlmm-bot    # Remove from PM2
```

### Auto-start on System Boot
```bash
pm2 startup            # Generate startup script
pm2 save               # Save current process list
```

## Configuration
Edit `src/config/index.ts` to change:
- Pool/Router addresses
- Strategy thresholds
- Network settings
- Gas reserve minimum (default: 10 MON for `addLiquidityNATIVE`)
- Minimum safe balance (default: 1 MON - bot stops if below this)

Edit `src/core/Bot.ts` to change:
- Maintenance rebalance interval (default: 1 minute)
- Liquidity usage percentage (default: 90%)

## Logs
- `[Init]` - Startup info and pool initialization
- `[Entry]` - Initial entry check
- `[Watcher]` - Block scanning
- `[Range]` - IN-RANGE/OUT-OF-RANGE state tracking
- `[Timer]` - Maintenance timer status
- `[Trigger]` - Rebalance reason
- `[Rebalance]` - Execution details (Standard or Maintenance)
- `[Maintenance]` - Maintenance rebalance operations
- `[Approve]` - Token approvals
- `[Retry]` - Failed operation retries

## Rebalance Triggers

### OUT-OF-RANGE (Priority)
- **Immediate Rebalance**: If the active bin exits the current 3-bin range `[centerBin - 1, centerBin, centerBin + 1]`
  - Removes all liquidity immediately
  - Re-adds liquidity centered on the new active bin

### IN-RANGE
- **Maintenance Rebalance**: If position remains fully IN-RANGE for more than 1 minute
  - Removes all liquidity
  - Re-adds liquidity to the same 3-bin range
  - Compounds accrued fees
  - Timer is cancelled if position goes OUT-OF-RANGE before completion

## Liquidity Distribution
- **3-Bin Range**: `[activeId - 1, activeId, activeId + 1]`
- **Token X**: Distributed evenly (50% each) to `activeId` and `activeId + 1`
- **Token Y**: Distributed evenly (50% each) to `activeId - 1` and `activeId`
- **Active Bin**: Receives 50% of both tokens (if both exist)
- **Total Usage**: 90% of wallet balance (10% reserved in wallet)

## Disclaimer
⚠️ Use at your own risk. This bot handles private keys and executes real transactions.
