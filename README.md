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

## Safety Features
- Gas Reserve: Keeps 5 MON minimum
- Slippage Protection: 5 bins tolerance
- Receipt Validation: Detects on-chain reverts
- Retry Logic: 3 attempts with exponential backoff
- Dust Filter: Ignores amounts < 1000 wei
- Unlimited Approvals: One-time max approval to save gas

## Prerequisites
- Node.js >= 18
- MON for gas (minimum 5 MON reserve)
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
- At least 5 MON for gas
- Pool tokens to provide liquidity

### 4. Run
```bash
npm start
```

## Configuration
Edit `src/config/index.ts` to change:
- Pool/Router addresses
- Strategy thresholds
- Network settings

## Logs
- `[Init]` - Startup info
- `[Entry]` - Initial entry check
- `[Watcher]` - Block scanning
- `[Trigger]` - Rebalance reason
- `[Rebalance]` - Execution details
- `[Approve]` - Token approvals
- `[Retry]` - Failed operation retries

## Rebalance Triggers
- **Hard Out-of-Range**: Active bin moves > 1 bin from center
- Price or fee thresholds (configurable)

## Disclaimer
⚠️ Use at your own risk. This bot handles private keys and executes real transactions.
