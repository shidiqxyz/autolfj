
import {
    PublicClient,
    WalletClient,
    Address,
    formatUnits,
    createPublicClient,
    createWalletClient,
    http
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
import { retry, sleep, logger } from '../utils';
import { calculateILFromBins, binIdToPrice } from '../utils/ilCalculator';

export class DLMMBot {
    private publicClient: PublicClient;
    private walletClient: WalletClient;
    private account = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY as `0x${string}` : `0x${PRIVATE_KEY}` as `0x${string}`);

    // State
    private isRebalancing = false;
    private lastActiveBin = 0;
    private currentCenterBin = 0; // Center bin of current 3-bin range [center-1, center, center+1]
    private isApproved = false; // Cache approval status to avoid redundant checks
    private entryBinId: number | null = null; // Track entry bin for IL calculation
    private entryTimestamp: number | null = null; // Track when position was entered

    // Time-based range tracking
    private inRangeStartTime: number | null = null; // Timestamp when position entered IN-RANGE state
    private outOfRangeStartTime: number | null = null; // Timestamp when position entered OUT-OF-RANGE state
    private inRangeTimer: NodeJS.Timeout | null = null; // Timer for 3-minute maintenance rebalance
    private readonly MAINTENANCE_REBALANCE_INTERVAL_MS = 1.5 * 60 * 1000; // 1 minutes

    // Pool Info
    private tokenX!: Address;
    private tokenY!: Address;
    private binStep!: number;
    private tokenXDecimals!: number;
    private tokenYDecimals!: number;
    private tokenXSymbol!: string;
    private tokenYSymbol!: string;
    private isTokenXNative!: boolean; // true if tokenX is WMON (wrapped native), false if tokenY is

    constructor() {
        this.publicClient = createPublicClient({
            chain: {
                id: CHAIN_ID,
                name: 'Monad Mainnet',
                nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
                rpcUrls: { default: { http: [RPC_URL] } }
            },
            transport: http()
        }) as PublicClient; // Type cast for custom chain

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
        logger.info('Init', `Starting Bot on Monad Mainnet... Pool: ${POOL_ADDRESS}`);
        logger.info('Init', `Account: ${this.account.address}`);

        try {
            await this.initializePoolData();
            await this.checkHealth();
            await this.ensureEntry(); // check if we need to enter immediately
            this.startWatcher();
        } catch (err) {
            logger.error('Init', 'Critical Error during initialization:', err);
            process.exit(1);
        }
    }

    private async ensureEntry() {
        logger.info('Entry', 'Checking if initial entry is needed...');
        // Scan for existing liquidity nearby
        const activeId = this.lastActiveBin;
        let hasLiquidity = false;

        // Check small range around active to see if we are already in
        // OPTIMIZATION: Use multicall for batch reads
        const rangeCheck = 5;
        const binIds: bigint[] = [];
        for (let i = activeId - rangeCheck; i <= activeId + rangeCheck; i++) {
            binIds.push(BigInt(i));
        }

        const balanceCalls = binIds.map(id => ({
            address: POOL_ADDRESS as Address,
            abi: PAIR_ABI,
            functionName: 'balanceOf' as const,
            args: [this.account.address, id] as const
        }));

        const balances = await Promise.allSettled(
            balanceCalls.map(call => this.publicClient.readContract(call))
        );

        // Check if any balance > 0
        for (const result of balances) {
            if (result.status === 'fulfilled' && result.value > 0n) {
                hasLiquidity = true;
                break;
            }
        }

        if (!hasLiquidity) {
            logger.info('Entry', 'No active liquidity found near current price. entering market immediately...');
            await this.executeRebalance(activeId);
        } else {
            logger.info('Entry', 'Liquidity found. Determining current center bin...');
            // Find the center bin of existing liquidity
            let foundCenterBin = 0;
            for (let i = 0; i < balances.length; i++) {
                const result = balances[i];
                if (result.status === 'fulfilled' && result.value > 0n) {
                    // Assume the center is near the active bin
                    foundCenterBin = activeId;
                    break;
                }
            }
            if (foundCenterBin > 0) {
                this.currentCenterBin = foundCenterBin;
                this.lastActiveBin = activeId;
                // Set entry tracking for IL calculation (use current center bin as entry point)
                if (this.entryBinId === null) {
                    this.entryBinId = foundCenterBin;
                    this.entryTimestamp = Date.now();
                    logger.info('IL', `Entry tracked for existing position: Bin ${foundCenterBin}`);
                }
                logger.info('Entry', `Existing position detected. Center bin: ${foundCenterBin}, Active bin: ${activeId}`);
            } else {
                // Fallback: set to active bin
                this.currentCenterBin = activeId;
                this.lastActiveBin = activeId;
                // Set entry tracking for IL calculation
                if (this.entryBinId === null) {
                    this.entryBinId = activeId;
                    this.entryTimestamp = Date.now();
                    logger.info('IL', `Entry tracked for existing position: Bin ${activeId}`);
                }
                logger.info('Entry', `Setting center bin to active bin: ${activeId}`);
            }
        }
    }

    private async initializePoolData() {
        // OPTIMIZATION: Batch all initialization reads using parallel readContract calls
        const [tokenX, tokenY, binStep, activeId] = await Promise.all([
            this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getTokenX' }),
            this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getTokenY' }),
            this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getBinStep' }),
            this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getActiveId' })
        ]);

        if (!tokenX || !tokenY || binStep === undefined || activeId === undefined) {
            throw new Error('Failed to initialize pool data');
        }

        this.tokenX = tokenX as Address;
        this.tokenY = tokenY as Address;
        this.binStep = binStep as number;
        this.lastActiveBin = activeId as number;

        // OPTIMIZATION: Batch token metadata reads in parallel
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

        // Detect which token is the wrapped native (WMON)
        this.isTokenXNative = this.tokenXSymbol.toUpperCase() === 'WMON' || this.tokenXSymbol.toUpperCase() === 'WNATIVE';
        const isTokenYNative = this.tokenYSymbol.toUpperCase() === 'WMON' || this.tokenYSymbol.toUpperCase() === 'WNATIVE';

        if (!this.isTokenXNative && !isTokenYNative) {
            logger.warn('Init', 'Warning: Neither token appears to be wrapped native. Assuming tokenX is native.');
            this.isTokenXNative = true; // Default assumption
        } else if (isTokenYNative && !this.isTokenXNative) {
            logger.warn('Init', 'Warning: tokenY is native but NATIVE functions expect tokenX to be native. This may cause issues.');
        }

        // currentCenterBin will be set after ensureEntry() determines if we have existing liquidity

        logger.info('Init', `Connected. TokenX: ${this.tokenXSymbol} (${this.tokenX}), TokenY: ${this.tokenYSymbol} (${this.tokenY})`);
        logger.info('Init', `Native token: ${this.isTokenXNative ? this.tokenXSymbol : this.tokenYSymbol}`);
        logger.info('Init', `Bin Step: ${this.binStep}, Active Bin: ${this.lastActiveBin}`);
    }

    private async checkHealth() {
        const balWei = await this.publicClient.getBalance({ address: this.account.address });
        const balMon = parseFloat(formatUnits(balWei, 18));

        if (balMon < STRATEGY.MIN_SAFE_BALANCE_MON) {
            logger.error('Health', `CRITICAL: Balance too low (${balMon.toFixed(4)} MON). Minimum safe balance: ${STRATEGY.MIN_SAFE_BALANCE_MON} MON. Stopping bot.`);
            process.exit(1);
        }
    }

    private startWatcher() {
        logger.info('Watcher', `Logic Loop Started.`);

        this.publicClient.watchBlocks({
            onBlock: async (block) => {
                logger.info('Watcher', `Block ${block.number} - Checking state...`);
                if (!this.isRebalancing) {
                    await this.checkRebalance();
                }
            },
            onError: (err) => {
                logger.error('Watcher', `Watch error:`, err);
            }
        });

        // Fallback Interval
        setInterval(async () => {
            if (!this.isRebalancing) {
                logger.info('Interval', `Fallback check...`);
                await this.checkRebalance();
            }
        }, 5 * 60 * 1000);
    }

    /**
     * Check if the active bin is within the current 3-bin range [centerBin - 1, centerBin, centerBin + 1]
     */
    private isPositionInRange(activeId: number): boolean {
        if (this.currentCenterBin === 0) {
            // No position established yet
            return false;
        }
        return activeId >= this.currentCenterBin - 1 && activeId <= this.currentCenterBin + 1;
    }

    /**
     * Cancel the in-range maintenance timer if it exists
     */
    private cancelInRangeTimer() {
        if (this.inRangeTimer !== null) {
            clearTimeout(this.inRangeTimer);
            this.inRangeTimer = null;
            logger.info('Timer', 'Cancelled in-range maintenance timer');
        }
    }

    /**
     * Start the in-range maintenance timer (3 minutes)
     */
    private startInRangeTimer() {
        // Cancel any existing timer first
        this.cancelInRangeTimer();

        logger.info('Timer', 'Starting 1-minute in-range maintenance timer');
        this.inRangeTimer = setTimeout(async () => {
            if (!this.isRebalancing) {
                logger.info('Timer', '1-minute in-range timer expired. Performing maintenance rebalance...');
                await this.executeMaintenanceRebalance();
            }
        }, this.MAINTENANCE_REBALANCE_INTERVAL_MS);
    }

    private async checkRebalance() {
        try {
            // OPTIMIZATION: Cache activeId to avoid re-reading in addLiquidity
            const activeId = await this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getActiveId' });
            const isInRange = this.isPositionInRange(activeId);
            
            // Calculate and log IL if entry is tracked
            if (this.entryBinId !== null && this.currentCenterBin > 0) {
                this.logImpermanentLoss(activeId);
            }

            // OUT-OF-RANGE handling (priority)
            if (!isInRange) {
                // Cancel in-range timer if position goes out of range
                this.cancelInRangeTimer();

                // Track out-of-range time
                if (this.outOfRangeStartTime === null) {
                    this.outOfRangeStartTime = Date.now();
                    logger.warn('Range', `Position OUT-OF-RANGE. Active: ${activeId}, Center: ${this.currentCenterBin}`);
                }

                // Reset in-range tracking
                this.inRangeStartTime = null;

                // Check if active bin has exited the current 3-bin range
                // Range is [currentCenterBin - 1, currentCenterBin, currentCenterBin + 1]
                const hasExitedRange = activeId < this.currentCenterBin - 1 || activeId > this.currentCenterBin + 1;

                if (hasExitedRange && this.currentCenterBin !== 0) {
                    logger.warn('Trigger', `Active bin (${activeId}) exited 3-bin range [${this.currentCenterBin - 1}, ${this.currentCenterBin}, ${this.currentCenterBin + 1}]. Immediate rebalance required.`);
                    await this.executeRebalance(activeId, false, activeId);
                    return;
                }
            } else {
                // IN-RANGE handling
                // Reset out-of-range tracking
                if (this.outOfRangeStartTime !== null) {
                    const outOfRangeDuration = Date.now() - this.outOfRangeStartTime;
                    logger.info('Range', `Position back IN-RANGE after ${Math.round(outOfRangeDuration / 1000)}s. Active: ${activeId}, Center: ${this.currentCenterBin}`);
                    this.outOfRangeStartTime = null;
                }

                // Track in-range time
                if (this.inRangeStartTime === null) {
                    this.inRangeStartTime = Date.now();
                    logger.info('Range', `Position IN-RANGE. Starting timer. Active: ${activeId}, Center: ${this.currentCenterBin}`);
                    // Start the 3-minute maintenance timer
                    this.startInRangeTimer();
                } else {
                    // Position is still in range, timer is already running
                    const inRangeDuration = Date.now() - this.inRangeStartTime;
                    logger.info('Range', `Position still IN-RANGE (${Math.round(inRangeDuration / 1000)}s). Active: ${activeId}, Center: ${this.currentCenterBin}`);
                }
            }
        } catch (err) {
            logger.error('Check', `Error checking rebalance conditions:`, err);
        }
    }

    /**
     * Execute maintenance rebalance: remove all liquidity and re-add to the same 3-bin range
     * This compounds accrued fees while keeping the position in the same range
     */
    private async executeMaintenanceRebalance() {
        if (this.isRebalancing) {
            logger.warn('Maintenance', 'Rebalance already in progress. Skipping maintenance rebalance.');
            return;
        }

        if (this.currentCenterBin === 0) {
            logger.warn('Maintenance', 'No position established. Skipping maintenance rebalance.');
            return;
        }

        logger.info('Maintenance', `Starting maintenance rebalance (same range: ${this.currentCenterBin})`);
        // OPTIMIZATION: Get fresh activeId once and pass it through
        const activeId = await this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getActiveId' });
        await this.executeRebalance(this.currentCenterBin, true, activeId);
    }

    private async executeRebalance(newCenterId: number, isMaintenance = false, cachedActiveId?: number) {
        if (this.isRebalancing) {
            logger.warn('Rebalance', 'Rebalance already in progress. Mutex lock active.');
            return;
        }
        this.isRebalancing = true;

        const rebalanceType = isMaintenance ? 'Maintenance' : 'Standard';
        logger.warn('Rebalance', `[${rebalanceType}] Starting rebalance sequence -> Target Center: ${newCenterId}`);

        try {
            // Cancel any running timers before rebalancing
            this.cancelInRangeTimer();

            await this.checkHealth();

            // 1. Remove Liquidity
            await this.removeLiquidity();

            // 2. Add Liquidity (OPTIMIZATION: Use cached activeId if available, otherwise fetch fresh)
            const activeId = cachedActiveId ?? await this.publicClient.readContract({ 
                address: POOL_ADDRESS, 
                abi: PAIR_ABI, 
                functionName: 'getActiveId' 
            });
            await this.addLiquidity(newCenterId, activeId);

            // Update tracking state
            this.lastActiveBin = newCenterId;
            this.currentCenterBin = newCenterId;
            
            // Track entry for IL calculation (reset on standard rebalance, keep on maintenance)
            if (!isMaintenance) {
                this.entryBinId = newCenterId;
                this.entryTimestamp = Date.now();
                logger.info('IL', `Entry tracked: Bin ${newCenterId} at ${new Date(this.entryTimestamp).toISOString()}`);
            }

            // Reset time tracking after rebalance
            this.inRangeStartTime = null;
            this.outOfRangeStartTime = null;

            logger.info('Rebalance', `[${rebalanceType}] Rebalance complete. New center: ${newCenterId}`);

        } catch (err) {
            logger.error('Rebalance', `[${rebalanceType}] FAILED:`, err);
        } finally {
            this.isRebalancing = false;
        }
    }

    private async removeLiquidity() {
        const idsToCheck: number[] = [];
        const rangeSearch = 20;
        for (let i = this.lastActiveBin - rangeSearch; i <= this.lastActiveBin + rangeSearch; i++) {
            idsToCheck.push(i);
        }

        // OPTIMIZATION: Use parallel readContract calls to batch all balanceOf calls
        const balanceCalls = idsToCheck.map(id => ({
            address: POOL_ADDRESS as Address,
            abi: PAIR_ABI,
            functionName: 'balanceOf' as const,
            args: [this.account.address, BigInt(id)] as const
        }));

        const balanceResults = await Promise.allSettled(
            balanceCalls.map(call => this.publicClient.readContract(call as any))
        );

        const balances: { id: bigint; amount: bigint }[] = [];
        for (let i = 0; i < balanceResults.length; i++) {
            const result = balanceResults[i];
            if (result.status === 'fulfilled' && (result.value as bigint) > 0n) {
                balances.push({ id: BigInt(idsToCheck[i]), amount: result.value as bigint });
            }
        }

        if (balances.length === 0) {
            logger.info('Rebalance', `No existing liquidity found (or first run). Proceeding to Add.`);
            return;
        }

        logger.info('Rebalance', `Removing liquidity from ${balances.length} bins...`);

        const idsToRemove: bigint[] = balances.map(b => b.id);
        const amountsToRemove: bigint[] = balances.map(b => b.amount);

        // OPTIMIZATION: Cache approval status to avoid redundant checks
        if (!this.isApproved) {
            const isApprovedResult = await this.publicClient.readContract({
                address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'isApprovedForAll', args: [this.account.address, ROUTER_ADDRESS]
            });
            this.isApproved = isApprovedResult;
        }

        if (!this.isApproved) {
            logger.info('Rebalance', `Approving pair...`);
            // OPTIMIZATION: Apply gas settings for better inclusion
            const hash = await this.walletClient.writeContract({
                address: POOL_ADDRESS,
                abi: PAIR_ABI,
                functionName: 'setApprovalForAll',
                args: [ROUTER_ADDRESS, true],
                gas: undefined, // Let viem estimate
                maxFeePerGas: GAS_SETTINGS.MAX_FEE_PER_GAS,
                maxPriorityFeePerGas: GAS_SETTINGS.MAX_PRIORITY_FEE_PER_GAS
            } as any);
            await this.publicClient.waitForTransactionReceipt({ hash });
            this.isApproved = true;
            logger.info('Rebalance', `Approved.`);
        }

        // Remove with retry using removeLiquidityNATIVE
        await retry(async () => {
            // Determine which token is non-native (the one that's not WMON)
            const nonNativeToken = this.isTokenXNative ? this.tokenY : this.tokenX;

            const { request: removeReq } = await this.publicClient.simulateContract({
                address: ROUTER_ADDRESS,
                abi: ROUTER_ABI,
                functionName: 'removeLiquidityNATIVE',
                args: [
                    nonNativeToken,
                    this.binStep,
                    0n, // amountTokenMin
                    0n, // amountNATIVEMin
                    idsToRemove,
                    amountsToRemove,
                    this.account.address,
                    BigInt(Math.floor(Date.now() / 1000) + 300)
                ],
                account: this.account
            });

            // OPTIMIZATION: Apply gas settings for better transaction inclusion
            const { type, ...requestWithoutType } = removeReq as any;
            const removeHash = await this.walletClient.writeContract({
                ...requestWithoutType,
                maxFeePerGas: GAS_SETTINGS.MAX_FEE_PER_GAS,
                maxPriorityFeePerGas: GAS_SETTINGS.MAX_PRIORITY_FEE_PER_GAS
            } as any);
            const receipt = await this.publicClient.waitForTransactionReceipt({ hash: removeHash });

            if (receipt.status === 'reverted') {
                throw new Error(`Transaction reverted: ${removeHash}`);
            }

            logger.info('Rebalance', `Liquidity Removed (NATIVE). Hash: ${removeHash}`);
        }, 3, 2000);
    }


    private async addLiquidity(centerId: number, cachedActiveId?: number) {
        // Step 1: Get fresh balances
        // OPTIMIZATION: Parallel balance reads
        let balX: bigint;
        let balY: bigint;

        if (this.isTokenXNative) {
            // tokenX is native (WMON), get native balance
            // OPTIMIZATION: Parallel read of native and ERC20 balance
            const [nativeBalance, tokenYBalance] = await Promise.all([
                this.publicClient.getBalance({ address: this.account.address }),
                this.publicClient.readContract({
                    address: this.tokenY, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.account.address]
                })
            ]);
            balX = nativeBalance;
            balY = tokenYBalance;
        } else {
            // tokenY is native (WMON), get native balance
            // OPTIMIZATION: Parallel read of native and ERC20 balance
            const [nativeBalance, tokenXBalance] = await Promise.all([
                this.publicClient.getBalance({ address: this.account.address }),
                this.publicClient.readContract({
                    address: this.tokenX, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.account.address]
                })
            ]);
            balX = tokenXBalance;
            balY = nativeBalance;
        }

        logger.info('Rebalance', `Wallet Balances - X: ${formatUnits(balX, this.tokenXDecimals)}, Y: ${formatUnits(balY, this.tokenYDecimals)}`);

        // Step 2: Filter dust amounts (< 1000 wei treated as zero)
        const MIN_AMOUNT = 1000n;
        if (balX < MIN_AMOUNT) balX = 0n;
        if (balY < MIN_AMOUNT) balY = 0n;

        if (balX === 0n && balY === 0n) {
            logger.warn('Rebalance', `Zero/dust balances. Nothing to add.`);
            return;
        }

        // Step 2.5: Use only 90% of X balance for liquidity (reserve 10%), but use 100% of Y balance
        const LIQUIDITY_PERCENTAGE = 95n; // 90%
        const PERCENTAGE_DIVISOR = 100n;
        if (balX > 0n) {
            balX = (balX * LIQUIDITY_PERCENTAGE) / PERCENTAGE_DIVISOR;
            logger.info('Rebalance', `Using 95% of X balance: ${formatUnits(balX, this.tokenXDecimals)} (5% reserved)`);
        }
        // Y balance uses 100% (no reserve)
        logger.info('Rebalance', `Using 100% of Y balance: ${formatUnits(balY, this.tokenYDecimals)} (no reserve)`);

        // Step 3: Ensure approvals (only for non-native token)
        // For native token, we send it as msg.value, no approval needed
        if (this.isTokenXNative) {
            // Only approve tokenY (non-native)
            await this.ensureApprove(this.tokenY, ROUTER_ADDRESS, balY);
        } else {
            // Only approve tokenX (non-native)
            await this.ensureApprove(this.tokenX, ROUTER_ADDRESS, balX);
        }

        // Step 4: CRITICAL - Use cached activeId if available, otherwise fetch fresh
        const freshActiveId = cachedActiveId ?? await this.publicClient.readContract({
            address: POOL_ADDRESS,
            abi: PAIR_ABI,
            functionName: 'getActiveId'
        });

        logger.info('Rebalance', `ActiveId: ${freshActiveId} (requested: ${centerId})`);

        // Step 4.5: Reserve gas for native token before building params
        const GAS_RESERVE_WEI = BigInt(Math.floor(STRATEGY.MIN_GAS_RESERVE_MON * 1e18));
        if (this.isTokenXNative && balX > GAS_RESERVE_WEI) {
            balX = balX - GAS_RESERVE_WEI;
        } else if (!this.isTokenXNative && balY > GAS_RESERVE_WEI) {
            balY = balY - GAS_RESERVE_WEI;
        } else if ((this.isTokenXNative && balX > 0n) || (!this.isTokenXNative && balY > 0n)) {
            logger.warn('Rebalance', 'Insufficient native token after gas reserve. Cannot add liquidity.');
            return;
        }

        // Step 5: Build DLMM-safe liquidity params
        const params = this.buildSafeLiquidityParams(freshActiveId, balX, balY);

        if (!params) {
            logger.error('Rebalance', 'Failed to build safe liquidity params. Aborting.');
            return;
        }

        // Step 6: Simulate & Send with retry using addLiquidityNATIVE
        // Calculate native token amount to send (msg.value)
        const nativeAmount = this.isTokenXNative ? balX : balY;

        logger.info('Rebalance', `Sending ${formatUnits(nativeAmount, 18)} native tokens as msg.value (reserved ${STRATEGY.MIN_GAS_RESERVE_MON} MON for gas)`);

        await retry(async () => {
            let addReq: any;
            
            // Try simulation first, but skip if RPC has txpool issues
            try {
                logger.info('Rebalance', `Simulating Add Liquidity (NATIVE)...`);
                const simulated = await this.publicClient.simulateContract({
                    address: ROUTER_ADDRESS,
                    abi: ROUTER_ABI,
                    functionName: 'addLiquidityNATIVE',
                    args: [params],
                    account: this.account,
                    value: nativeAmount
                });
                addReq = simulated.request;
            } catch (simError: any) {
                // Skip simulation if txpool is not responding (Monad RPC issue)
                const errorMsg = simError?.message || simError?.cause?.reason || simError?.shortMessage || '';
                if (errorMsg.toLowerCase().includes('txpool not responding')) {
                    logger.warn('Rebalance', 'Simulation failed (txpool not responding). Skipping simulation and sending directly...');
                    addReq = {
                        address: ROUTER_ADDRESS,
                        abi: ROUTER_ABI,
                        functionName: 'addLiquidityNATIVE',
                        args: [params]
                    } as any;
                } else {
                    throw simError;
                }
            }

            // OPTIMIZATION: Apply gas settings for better transaction inclusion
            const addHash = await this.walletClient.writeContract({
                ...addReq,
                value: nativeAmount,
                maxFeePerGas: GAS_SETTINGS.MAX_FEE_PER_GAS,
                maxPriorityFeePerGas: GAS_SETTINGS.MAX_PRIORITY_FEE_PER_GAS
            });
            logger.info('Rebalance', `Add Liquidity (NATIVE) Sent. Hash: ${addHash}`);

            const receipt = await this.publicClient.waitForTransactionReceipt({ hash: addHash });
            if (receipt.status === 'reverted') {
                throw new Error(`Add liquidity reverted: ${addHash}`);
            }

            logger.info('Rebalance', `SUCCESS. New Range Centered at: ${freshActiveId}`);
        }, 3, 2000);
    }

    /**
     * Build DLMM-safe liquidity parameters following strict bin rules
     * CRITICAL: bins < activeId = Y only, activeId = both, bins > activeId = X only
     */
    private buildSafeLiquidityParams(activeId: number, balX: bigint, balY: bigint) {
        try {
            // Define target bins (tight 3-bin range)
            const targetBins = [
                { id: activeId - 1, delta: -1n },  // Below active (Y only)
                { id: activeId, delta: 0n },  // Active (both)
                { id: activeId + 1, delta: 1n }   // Above active (X only)
            ];

            // Calculate how many bins will receive each token
            let xBinCount = 0;
            let yBinCount = 0;

            for (const bin of targetBins) {
                if (bin.id < activeId && balY > 0n) yBinCount++;  // Y-only bin
                if (bin.id === activeId && (balX > 0n || balY > 0n)) {
                    if (balX > 0n) xBinCount++;
                    if (balY > 0n) yBinCount++;
                }
                if (bin.id > activeId && balX > 0n) xBinCount++;  // X-only bin
            }

            if (xBinCount === 0 && yBinCount === 0) {
                logger.error('Rebalance', 'No valid bins to add liquidity');
                return null;
            }

            // Build distributions following DLMM rules
            const PRECISION = BigInt('1000000000000000000'); // 1e18
            const deltaIds: bigint[] = [];
            const distributionX: bigint[] = [];
            const distributionY: bigint[] = [];

            // Calculate per-bin share
            const shareX = xBinCount > 0 ? PRECISION / BigInt(xBinCount) : 0n;
            const shareY = yBinCount > 0 ? PRECISION / BigInt(yBinCount) : 0n;

            for (const bin of targetBins) {
                let distX = 0n;
                let distY = 0n;

                if (bin.id < activeId) {
                    // Bin below active: Y ONLY
                    distY = balY > 0n ? shareY : 0n;
                } else if (bin.id === activeId) {
                    // Active bin: BOTH
                    distX = balX > 0n ? shareX : 0n;
                    distY = balY > 0n ? shareY : 0n;
                } else {
                    // Bin above active: X ONLY
                    distX = balX > 0n ? shareX : 0n;
                }

                // Only include bins with non-zero contribution
                if (distX > 0n || distY > 0n) {
                    deltaIds.push(bin.delta);
                    distributionX.push(distX);
                    distributionY.push(distY);
                }
            }

            // Normalize to ensure sum = 1e18 (handle rounding)
            const sumX = distributionX.reduce((a, b) => a + b, 0n);
            const sumY = distributionY.reduce((a, b) => a + b, 0n);

            if (sumX > 0n && sumX !== PRECISION) {
                const diff = PRECISION - sumX;
                distributionX[distributionX.length - 1] += diff;
            }
            if (sumY > 0n && sumY !== PRECISION) {
                const diff = PRECISION - sumY;
                distributionY[distributionY.length - 1] += diff;
            }

            // Final validations
            if (deltaIds.length === 0) {
                logger.error('Rebalance', 'No bins in deltaIds after filtering');
                return null;
            }

            if (deltaIds.length !== distributionX.length || deltaIds.length !== distributionY.length) {
                logger.error('Rebalance', 'Array length mismatch');
                return null;
            }

            // Ensure activeId (delta 0) is included
            if (!deltaIds.includes(0n)) {
                logger.error('Rebalance', 'ActiveId not in deltaIds - CRITICAL DLMM violation');
                return null;
            }

            logger.info('Rebalance', `Built safe params: ${deltaIds.length} bins, activeId: ${activeId}`);
            logger.info('Rebalance', `DeltaIds: [${deltaIds.join(', ')}]`);

            return {
                tokenX: this.tokenX,
                tokenY: this.tokenY,
                binStep: BigInt(this.binStep),
                amountX: balX,
                amountY: balY,
                amountXMin: 0n,
                amountYMin: 0n,
                activeIdDesired: BigInt(activeId),
                idSlippage: 5n,
                deltaIds,
                distributionX,
                distributionY,
                to: this.account.address,
                refundTo: this.account.address,
                deadline: BigInt(Math.floor(Date.now() / 1000) + 300)
            };
        } catch (error) {
            logger.error('Rebalance', `Error building safe params: ${error}`);
            return null;
        }
    }

    private async ensureApprove(token: Address, spender: Address, amount: bigint) {
        if (amount === 0n) return;

        // Check current allowance
        const allowance = await this.publicClient.readContract({
            address: token, abi: ERC20_ABI, functionName: 'allowance', args: [this.account.address, spender]
        });

        // If already has ANY allowance, skip (we use unlimited so it won't run out)
        if (allowance > 0n) {
            logger.info('Approve', `${token} already approved (allowance: ${allowance}). Skipping.`);
            return;
        }

        // No allowance - approve unlimited
        const MAX_UINT256 = 2n ** 256n - 1n;
        logger.info('Approve', `Approving ${token} (unlimited)...`);
        await retry(async () => {
            const { request } = await this.publicClient.simulateContract({
                address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, MAX_UINT256], account: this.account
            });
            const hash = await this.walletClient.writeContract(request);
            await this.publicClient.waitForTransactionReceipt({ hash });
            logger.info('Approve', `Approved ${token} (unlimited)`);
        }, 3, 2000);
    }

    /**
     * Calculate and log impermanent loss metrics
     */
    private logImpermanentLoss(currentActiveId: number) {
        if (this.entryBinId === null) return;
        
        try {
            const ilResult = calculateILFromBins(this.entryBinId, currentActiveId, this.binStep, 3);
            const entryPrice = binIdToPrice(this.entryBinId, this.binStep);
            const currentPrice = binIdToPrice(currentActiveId, this.binStep);
            
            // Format prices for display
            const priceChangePercent = (ilResult.priceRatio - 1) * 100;
            
            // Log IL info (only log if significant movement or periodically)
            const ilSign = ilResult.impermanentLossPercent >= 0 ? '+' : '';
            logger.info('IL', 
                `IL: ${ilSign}${ilResult.impermanentLossPercent.toFixed(4)}% | ` +
                `Price: ${currentPrice.toFixed(6)} (${priceChangePercent >= 0 ? '+' : ''}${priceChangePercent.toFixed(3)}%) | ` +
                `Entry: ${this.entryBinId} → Current: ${currentActiveId}`
            );
            
            // Warn if IL becomes significant (e.g., > -1%)
            if (ilResult.impermanentLossPercent < -1.0) {
                logger.warn('IL', 
                    `⚠️ Significant IL detected: ${ilResult.impermanentLossPercent.toFixed(4)}%. ` +
                    `Consider if fees are offsetting this loss.`
                );
            }
        } catch (err) {
            // Silently fail IL calculation to avoid disrupting main flow
            logger.error('IL', 'Error calculating IL:', err);
        }
    }
}
