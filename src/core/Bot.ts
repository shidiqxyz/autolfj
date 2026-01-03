
// src/core/Bot.ts

import {
    PublicClient,
    WalletClient,
    Address,
    formatUnits,
    createPublicClient,
    createWalletClient,
    http,
    decodeEventLog,
    parseAbiItem,
    parseUnits
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
    POOL_ADDRESS,
    ROUTER_ADDRESS,
    STRATEGY,
    RPC_URL,
    PRIVATE_KEY,
    CHAIN_ID,
    GAS_SETTINGS
} from '../config';
import { ERC20_ABI, PAIR_ABI, ROUTER_ABI } from '../abis';
import { retry, sleep, logger, randomDelay } from '../utils';

export class DLMMBot {
    private publicClient: PublicClient;
    private walletClient: WalletClient;
    private account = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY as `0x${string}` : `0x${PRIVATE_KEY}` as `0x${string}`);

    // Pool Info
    private tokenX!: Address;
    private tokenY!: Address;
    private binStep!: number;
    private tokenXDecimals!: number;
    private tokenYDecimals!: number;
    private tokenXSymbol!: string;
    private tokenYSymbol!: string;
    private isTokenXNative!: boolean;

    // State Variables (Memory)
    private lastActiveBinId: number | null = null;
    private lastRebalanceTimestamp: number = 0;
    private currentBins: number[] | null = null;
    private executionLock: boolean = false;

    // Safety State
    private lastObservedBins: number[] = []; // Rolling window size 3
    private consecutiveFailures: number = 0;
    private dailyRebalanceCount: number = 0;
    private lastResetDay: number = new Date().getDay();

    constructor() {
        this.publicClient = createPublicClient({
            chain: {
                id: CHAIN_ID,
                name: 'Monad Mainnet',
                nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
                rpcUrls: { default: { http: [RPC_URL] } }
            },
            transport: http()
        }) as PublicClient;

        this.walletClient = createWalletClient({
            account: this.account,
            chain: {
                id: CHAIN_ID,
                name: 'Monad Mainnet',
                nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
                rpcUrls: { default: { http: [RPC_URL] } }
            },
            transport: http()
        });
    }

    public async start() {
        logger.info('Init', `🚀 Starting LFJ MM Bot on Monad...`);
        logger.info('Init', `📍 Pool: ${POOL_ADDRESS}`);
        logger.info('Init', `👛 Account: ${this.account.address}`);

        try {
            await this.initializePoolData();
            // Optional: check initial balance
            await this.runMarketMakingLogic();
        } catch (err) {
            logger.error('Init', 'Critical error during startup:', err);
            process.exit(1);
        }
    }

    private async initializePoolData() {
        const [tokenX, tokenY, binStep] = await Promise.all([
            this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getTokenX' }),
            this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getTokenY' }),
            this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getBinStep' })
        ]);

        this.tokenX = tokenX as Address;
        this.tokenY = tokenY as Address;
        this.binStep = binStep as number;

        const [tokenXDecimals, tokenYDecimals, tokenXSymbol, tokenYSymbol] = await Promise.all([
            this.publicClient.readContract({ address: this.tokenX, abi: ERC20_ABI, functionName: 'decimals' }),
            this.publicClient.readContract({ address: this.tokenY, abi: ERC20_ABI, functionName: 'decimals' }),
            this.publicClient.readContract({ address: this.tokenX, abi: ERC20_ABI, functionName: 'symbol' }),
            this.publicClient.readContract({ address: this.tokenY, abi: ERC20_ABI, functionName: 'symbol' })
        ]);

        this.tokenXDecimals = tokenXDecimals;
        this.tokenYDecimals = tokenYDecimals;
        this.tokenXSymbol = tokenXSymbol;
        this.tokenYSymbol = tokenYSymbol;

        const nativeSymbols = ['WMON', 'WNATIVE'];
        this.isTokenXNative = nativeSymbols.includes(this.tokenXSymbol.toUpperCase());

        logger.info('Init', `✅ Active: ${this.tokenXSymbol}/${this.tokenYSymbol} (Native: ${this.isTokenXNative ? 'X' : 'Y'})`);
    }

    // ==================================================
    // MAIN LOOP (SINGLE-THREADED)
    // ==================================================
    private async runMarketMakingLogic() {
        logger.info('Strategy', `🤖 MM Strategy Active: 3-Bin Range [${STRATEGY.BIN_RANGE}]`);

        while (true) {
            try {

                // Safety Module F: Daily Churn Limit
                if (this.checkDailyLimit()) {
                    await sleep(60000); // Sleep 1 min if limited
                    continue;
                }

                if (this.executionLock) {
                    await sleep(1000);
                    continue;
                }

                // Get Active Bin
                const activeId = await this.publicClient.readContract({
                    address: POOL_ADDRESS,
                    abi: PAIR_ABI,
                    functionName: 'getActiveId'
                }) as number;

                // Safety Module A: Anti-Churn Bin Stability Check
                if (this.detectBinChurn(activeId)) {
                    logger.warn('Safety', `Stable check: Churn detected. Skipping rebalance.`);
                    await sleep(STRATEGY.POLL_INTERVAL);
                    continue;
                }

                // Check 1: Initial State
                if (this.currentBins === null) {
                    logger.info('Loop', 'Startup: No active positions. Initial rebalance...');
                    await this.rebalance("initial", activeId);
                    await sleep(STRATEGY.POLL_INTERVAL);
                    continue;
                }

                // Check 2: In Range?
                const isInRange = this.currentBins.includes(activeId);
                // Safety Module C: Partial Rebalance Guard
                const targetBins = [activeId - STRATEGY.BIN_OFFSET, activeId, activeId + STRATEGY.BIN_OFFSET];
                const overlap = this.currentBins.filter(b => targetBins.includes(b)).length;

                if (isInRange) {
                    // Still earning fees, do nothing
                    await sleep(STRATEGY.POLL_INTERVAL);
                    continue;
                }

                if (overlap >= STRATEGY.PARTIAL_REBALANCE_OVERLAP) {
                    logger.info('Safety', `Partial overlap ok (${overlap} bins). Holding...`);
                    await sleep(STRATEGY.POLL_INTERVAL);
                    continue;
                }

                const now = Math.floor(Date.now() / 1000); // Seconds

                // Check 3: Grace Period
                if ((now - this.lastRebalanceTimestamp) < STRATEGY.OUT_OF_RANGE_GRACE) {
                    // Grace period active
                    await sleep(STRATEGY.POLL_INTERVAL);
                    continue;
                }

                // Safety Module B: Dynamic Cooldown
                const volatility = this.lastActiveBinId !== null && Math.abs(activeId - this.lastActiveBinId) >= 2;
                const activeCooldown = volatility ? STRATEGY.MIN_REBALANCE_INTERVAL * STRATEGY.VOLATILITY_MULTIPLIER : STRATEGY.MIN_REBALANCE_INTERVAL;

                if ((now - this.lastRebalanceTimestamp) < activeCooldown) {
                    // Cooldown active
                    await sleep(STRATEGY.POLL_INTERVAL);
                    continue;
                }

                // ACTION: Rebalance
                await this.rebalance("out_of_range", activeId);

                // Success - Reset failure checks
                this.consecutiveFailures = 0;

            } catch (err: any) {
                // Safety Module E: Soft Fail Recovery
                this.consecutiveFailures++;
                logger.error('Loop', `❌ Error in loop (Failures: ${this.consecutiveFailures}): ${err?.message || err}`);

                // Safety Module H: Safe Shutdown
                if (this.consecutiveFailures >= STRATEGY.SAFE_SHUTDOWN_RPC_FAILURES) {
                    logger.error('Safety', `🛑 SAFE SHUTDOWN: Too many failures.`);
                    await this.safeShutdown();
                    process.exit(1);
                }

                const backoff = Math.min(30 * this.consecutiveFailures, 600); // Max 10 mins
                await sleep(backoff * 1000);
            }

            // Allow state to settle
            await sleep(STRATEGY.POLL_INTERVAL);
            this.lastActiveBinId = (await this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getActiveId' }) as number);
        }
    }

    // ==================================================
    // REBALANCE CORE
    // ==================================================
    private async rebalance(reason: string, activeId: number) {
        this.executionLock = true;
        logger.info('Rebalance', `Starting rebalance [${reason}] @ Bin ${activeId}`);

        try {
            // Safety Module D: Gas Spike Protection
            const gasPrice = await this.publicClient.getGasPrice();
            const maxGasFee = parseUnits(STRATEGY.MAX_GAS_PER_TX_MON.toString(), 18);
            // Rough estimate for big complex tx: 500k gas
            const estimatedCost = gasPrice * 500000n;
            if (estimatedCost > maxGasFee) {
                logger.info('Safety', `⛽ Gas spike (${formatUnits(estimatedCost, 18)} MON). Skipping.`);
                return;
            }

            // Safety Module G: Profitability Check
            // Simplified: If gas cost is excessively high compared to expected buffer or logic
            // For now, relying on Gas Spike Protection as the primary "cost" guard.
            // (Real profitability requires historical fee query which is complex here)

            // Step 1: Remove ALL existing liquidity
            if (this.currentBins !== null && this.currentBins.length > 0) {
                await this.removeLiquidity(this.currentBins);
                // Wait for indexing? Usually tx confirmation is enough.
            }

            // Step 2: Read Balances
            const balanceNative = await this.publicClient.getBalance({ address: this.account.address });
            const tokenAddress = this.isTokenXNative ? this.tokenY : this.tokenX;
            const balanceToken = await this.publicClient.readContract({
                address: tokenAddress,
                abi: ERC20_ABI,
                functionName: 'balanceOf',
                args: [this.account.address]
            }) as bigint;

            // Gas Reserve Check
            // Safety Module I: Low Balance Stop
            const minSafeBalance = parseUnits(STRATEGY.MIN_SAFE_BALANCE_MON.toString(), 18);
            if (balanceNative < minSafeBalance) {
                logger.warn('Rebalance', `⚠️ Low Balance (${formatUnits(balanceNative, 18)} < ${STRATEGY.MIN_SAFE_BALANCE_MON}). Stopping.`);
                return;
            }

            // Calculate Usable (Reserve for Gas)
            const gasReserve = parseUnits(STRATEGY.MIN_GAS_RESERVE_MON.toString(), 18);
            let usableNative = ((balanceNative - gasReserve) * BigInt(Math.floor(STRATEGY.LIQUIDITY_USAGE_PERCENT * 100))) / 10000n;

            // Clamp to 0
            if (usableNative < 0n) usableNative = 0n;

            const usableToken = (balanceToken * BigInt(Math.floor(STRATEGY.LIQUIDITY_USAGE_PERCENT * 100))) / 10000n;

            // Step 3: Define Target
            // RE-READ Active ID to prevent slippage reverts (market moves during removeLiquidity)
            const currentActiveId = await this.publicClient.readContract({
                address: POOL_ADDRESS,
                abi: PAIR_ABI,
                functionName: 'getActiveId'
            }) as number;

            // [active-1, active, active+1]
            const targetBins = [
                currentActiveId - STRATEGY.BIN_OFFSET,
                currentActiveId,
                currentActiveId + STRATEGY.BIN_OFFSET
            ];

            // Step 4: Add Liquidity
            await this.addLiquidity(targetBins, usableNative, usableToken, currentActiveId);

            // Step 5: Update State
            this.currentBins = targetBins;
            this.lastActiveBinId = currentActiveId;
            this.lastRebalanceTimestamp = Math.floor(Date.now() / 1000);
            this.dailyRebalanceCount++;

            logger.info('Rebalance', `✅ SUCCESS: Active in bins [${targetBins.join(', ')}]`);

        } catch (e: any) {
            logger.error('Rebalance', `❌ Failed: ${e?.message}`);
            // If failed, we might be in weird state (removed but not added).
            // Soft fail loop will retry.
            throw e;
        } finally {
            this.executionLock = false;
        }
    }

    // ==================================================
    // LIQUIDITY ACTIONS
    // ==================================================

    private async addLiquidity(bins: number[], usableNative: bigint, usableToken: bigint, activeId: number) {
        if (usableNative <= 0n && usableToken <= 0n) {
            logger.warn('Add', 'No funds to add!');
            return;
        }

        // Helper to figure out X vs Y
        // If TokenX is Native (MON):
        // usableNative = AmountX, usableToken = AmountY

        let amountX = this.isTokenXNative ? usableNative : usableToken;
        let amountY = this.isTokenXNative ? usableToken : usableNative;

        // DYNAMIC UNIFORM DISTRIBUTION STRATEGY
        // We must avoid minting liquidity in bins where we provide (0, 0) amounts.
        // This causes "Broken Distribution" or similar reverts.

        const candidates = [
            { delta: -1, takesX: false, takesY: true }, // Lower: pure Y
            { delta: 0, takesX: true, takesY: true }, // Active: Both
            { delta: 1, takesX: true, takesY: false } // Upper: pure X
        ];

        const PRECISION = BigInt(1e18);
        const validBins: { delta: number, distX: bigint, distY: bigint }[] = [];

        // 1. Identify valid bins (must have >0 amount for at least one compatible token)
        const activeBins = candidates.filter(c =>
            (c.takesX && amountX > 0n) || (c.takesY && amountY > 0n)
        );

        if (activeBins.length === 0) {
            logger.warn('Add', 'No valid bins to add liquidity to (balances too low?).');
            return;
        }

        // 2. Calculate Distributions
        // Count how many bins will share X and Y
        const countX = activeBins.filter(b => b.takesX).length;
        const countY = activeBins.filter(b => b.takesY).length;

        // Share per bin
        const shareX = countX > 0 ? PRECISION / BigInt(countX) : 0n;
        const shareY = countY > 0 ? PRECISION / BigInt(countY) : 0n;

        // 3. Construct Arrays
        // Note: Sum of distributions MUST be 1e18 (if amount > 0)

        let allocatedX = 0n;
        let allocatedY = 0n;

        activeBins.forEach((bin, i) => {
            let dx = 0n;
            let dy = 0n;

            if (bin.takesX && amountX > 0n) dx = shareX;
            if (bin.takesY && amountY > 0n) dy = shareY;

            // Handle rounding for last valid bin of that type
            // Check if any subsequent bin takes X
            const pendingX = activeBins.slice(i + 1).some(b => b.takesX);
            // If NO pending bins take X, and this one does, give it the remainder
            if (!pendingX && bin.takesX && amountX > 0n) dx = PRECISION - allocatedX;

            const pendingY = activeBins.slice(i + 1).some(b => b.takesY);
            if (!pendingY && bin.takesY && amountY > 0n) dy = PRECISION - allocatedY;

            if (amountX > 0n && bin.takesX) allocatedX += dx;
            if (amountY > 0n && bin.takesY) allocatedY += dy;

            validBins.push({ delta: bin.delta, distX: dx, distY: dy });
        });

        // Map to contract format
        // deltaIds relative to activeId
        const activeIdBig = BigInt(activeId);
        const deltaIds = validBins.map(b => BigInt(b.delta));
        const distributionX = validBins.map(b => b.distX);
        const distributionY = validBins.map(b => b.distY);

        // Approvals
        const nonNativeToken = this.isTokenXNative ? this.tokenY : this.tokenX;
        const nonNativeAmount = this.isTokenXNative ? amountY : amountX;
        await this.ensureApprove(nonNativeToken, ROUTER_ADDRESS, nonNativeAmount);

        // Native Amount (for value field)
        const nativeAmount = this.isTokenXNative ? amountX : amountY;

        // Params
        const slippageBps = BigInt(Math.floor(STRATEGY.MAX_SLIPPAGE_PERCENT * 100));
        const minAmountX = amountX - (amountX * slippageBps) / 10000n;
        const minAmountY = amountY - (amountY * slippageBps) / 10000n;

        const params = {
            tokenX: this.tokenX,
            tokenY: this.tokenY,
            binStep: BigInt(this.binStep),
            amountX: amountX,
            amountY: amountY,
            amountXMin: minAmountX,
            amountYMin: minAmountY,
            activeIdDesired: activeIdBig,
            idSlippage: 10n,
            deltaIds: deltaIds,
            distributionX: distributionX,
            distributionY: distributionY,
            to: this.account.address,
            refundTo: this.account.address,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 300)
        };

        const { request } = await this.publicClient.simulateContract({
            address: ROUTER_ADDRESS,
            abi: ROUTER_ABI,
            functionName: 'addLiquidityNATIVE',
            args: [params],
            account: this.account,
            value: nativeAmount
        });

        const hash = await this.walletClient.writeContract(request);
        logger.info('Add', `Tx sent: ${hash}`);
        await this.publicClient.waitForTransactionReceipt({ hash });
    }

    private async removeLiquidity(bins: number[]) {
        logger.info('Remove', `Removing from ${bins.length} bins...`);

        // 1. Check allowances (LBToken is the pool itself)
        await this.ensureApprove(POOL_ADDRESS, ROUTER_ADDRESS, BigInt(2 ** 256) - 1n); // Lazy approve max if needed

        // 2. Get balances
        // ... (implementation same as before, get balances efficiently)
        const balanceCalls = bins.map(id => ({
            address: POOL_ADDRESS as Address,
            abi: PAIR_ABI,
            functionName: 'balanceOf' as const,
            args: [this.account.address, BigInt(id)] as const
        }));

        const results = await Promise.all(balanceCalls.map(c => this.publicClient.readContract(c as any)));

        const ids: bigint[] = [];
        const amts: bigint[] = [];

        results.forEach((bal, i) => {
            if ((bal as bigint) > 0n) {
                ids.push(BigInt(bins[i]));
                amts.push(bal as bigint);
            }
        });

        if (ids.length === 0) return;

        const nonNativeToken = this.isTokenXNative ? this.tokenY : this.tokenX;

        // 3. Remove
        const { request } = await this.publicClient.simulateContract({
            address: ROUTER_ADDRESS,
            abi: ROUTER_ABI,
            functionName: 'removeLiquidityNATIVE',
            args: [
                nonNativeToken,
                this.binStep,
                0n, 0n, // Min amounts
                ids,
                amts,
                this.account.address,
                BigInt(Math.floor(Date.now() / 1000) + 300)
            ],
            account: this.account
        });

        const hash = await this.walletClient.writeContract(request);
        logger.info('Remove', `Tx sent: ${hash}`);
        await this.publicClient.waitForTransactionReceipt({ hash });
    }

    private async ensureApprove(token: Address, spender: Address, amount: bigint) {
        if (token === POOL_ADDRESS) {
            // LBPair verification involves isApprovedForAll
            const isApproved = await this.publicClient.readContract({
                address: POOL_ADDRESS,
                abi: PAIR_ABI,
                functionName: 'isApprovedForAll',
                args: [this.account.address, spender]
            }) as boolean;
            if (!isApproved) {
                const { request } = await this.publicClient.simulateContract({
                    address: POOL_ADDRESS,
                    abi: PAIR_ABI,
                    functionName: 'setApprovalForAll',
                    args: [spender, true],
                    account: this.account
                });
                const hash = await this.walletClient.writeContract(request);
                await this.publicClient.waitForTransactionReceipt({ hash });
            }
            return;
        }

        // ERC20 verification
        const allowance = await this.publicClient.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [this.account.address, spender]
        }) as bigint;

        if (allowance < amount) {
            const { request } = await this.publicClient.simulateContract({
                address: token,
                abi: ERC20_ABI,
                functionName: 'approve',
                args: [spender, BigInt(2 ** 256) - 1n],
                account: this.account
            });
            const hash = await this.walletClient.writeContract(request);
            await this.publicClient.waitForTransactionReceipt({ hash });
        }
    }

    // ==================================================
    // HELPERS
    // ==================================================
    private detectBinChurn(activeId: number): boolean {
        this.lastObservedBins.push(activeId);
        if (this.lastObservedBins.length > 3) this.lastObservedBins.shift();

        if (this.lastObservedBins.length < 3) return false;

        // [x, x+1, x] or [x+1, x, x+1]
        const [a, b, c] = this.lastObservedBins;
        return (a === c && a !== b); // Simple oscillation
    }

    private checkDailyLimit(): boolean {
        const today = new Date().getDay();
        if (today !== this.lastResetDay) {
            this.dailyRebalanceCount = 0;
            this.lastResetDay = today;
        }
        if (this.dailyRebalanceCount >= STRATEGY.MAX_REBALANCES_PER_DAY) {
            logger.warn('Safety', 'Daily limit reached. Pausing until tomorrow.');
            return true;
        }
        return false;
    }

    private async safeShutdown() {
        if (this.currentBins) {
            try {
                await this.removeLiquidity(this.currentBins);
            } catch (e) {
                logger.error('Shutdown', 'Failed to clean up positions during shutdown');
            }
        }
    }
}
