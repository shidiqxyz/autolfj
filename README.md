# Monad DLMM Rebalancing Bot

This is a personal, high-frequency auto-rebalancing bot for LFJ (Trader Joe) Liquidity Book on Monad Mainnet.

## Project Structure
The project is organized into a modular structure for better maintainability:

```text
src/
├── abis/           # Contract ABIs
├── config/         # Configuration & Constants (Edit here for Pool/Strategy)
├── core/           # Main Bot Logic (State & Execution)
├── utils/          # Helper functions
└── index.ts        # Entry point
```

## Features
- **Target**: Specific DLMM Pool (`0xdd...BECE5`).
- **Strategy**: Fixed range ±0.10% (3 Bins).
- **Safety**: 
  - Gas Reserve (5 MON).
  - Slippage Protection (0.2%).
  - Hard Out-of-Range Immediate Rebalance.
  - Simulation before Execution.

## Prerequisites
- Node.js >= 18
- A Monad Wallet with:
  - MON for gas (keeps 5 MON reserve).
  - Tokens for the pool.

## Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
1. Copy the example file:
   ```bash
   cp .env.example .env
   ```
   *(Or on Windows Copy-Paste `.env.example` to `.env`)*

2. Edit `.env` and add your **Private Key**:
   ```
   PRIVATE_KEY=your_private_key_without_0x
   RPC_URL=https://rpc.monad.xyz
   ```

### 3. Fund Your Wallet
Ensure you have:
- At least **5 MON** + Gas money.
- Tokens (TokenX/TokenY) for the pool.

### 4. Run Verification
**Safety Check**: The bot runs a 5 MON balance check immediately on start. If you have < 5 MON, it exits.

### 5. Start the Bot
```bash
npm start
```
(Executes `src/index.ts`)

## Configuration
To change pool settings, strategy thresholds, or network details, edit:
**`src/config/index.ts`**

## Logs
The bot logs important events:
- `[Init]`: Startup info.
- `[Health]`: Balance checks.
- `[Watcher]`: Block scanning.
- `[Trigger]`: Rebalance reason.
- `[Rebalance]`: Execution details.

## Disclaimer
Use at your own risk. This bot handles private keys and executes transactions automatically.
