
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
    CHAIN_ID
} from '../config';
import { ERC20_ABI, PAIR_ABI, ROUTER_ABI } from '../abis';
import { retry, sleep, logger } from '../utils';

export class DLMMBot {
    private publicClient: PublicClient;
    private walletClient: WalletClient;
    private account = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY as `0x${string}` : `0x${PRIVATE_KEY}` as `0x${string}`);

    // State
    private isRebalancing = false;
    private lastActiveBin = 0;
    private currentCenterBin = 0; // Center bin of current 3-bin range [center-1, center, center+1]

    // Time-based range tracking
    private inRangeStartTime: number | null = null; // Timestamp when position entered IN-RANGE state
    private outOfRangeStartTime: number | null = null; // Timestamp when position entered OUT-OF-RANGE state
    private inRangeTimer: NodeJS.Timeout | null = null; // Timer for 3-minute maintenance rebalance
    private readonly MAINTENANCE_REBALANCE_INTERVAL_MS = 1.5 * 60 * 1000; // 1.5 minutes

    // Pool Info
    private tokenX!: Address;
    private tokenY!: Address;
    private binStep!: number;
    private tokenXDecimals!: number;
    private tokenYDecimals!: number;
    private tokenXSymbol!: string;
    private tokenYSymbol!: string;

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
        const rangeCheck = 5;
        for (let i = activeId - rangeCheck; i <= activeId + rangeCheck; i++) {
            const b = await this.publicClient.readContract({
                address: POOL_ADDRESS,
                abi: PAIR_ABI,
                functionName: 'balanceOf',
                args: [this.account.address, BigInt(i)]
            });
            if (b > 0n) {
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
            for (let i = activeId - rangeCheck; i <= activeId + rangeCheck; i++) {
                const b = await this.publicClient.readContract({
                    address: POOL_ADDRESS,
                    abi: PAIR_ABI,
                    functionName: 'balanceOf',
                    args: [this.account.address, BigInt(i)]
                });
                if (b > 0n) {
                    // Assume the center is near the active bin
                    foundCenterBin = activeId;
                    break;
                }
            }
            if (foundCenterBin > 0) {
                this.currentCenterBin = foundCenterBin;
                this.lastActiveBin = activeId;
                logger.info('Entry', `Existing position detected. Center bin: ${foundCenterBin}, Active bin: ${activeId}`);
            } else {
                // Fallback: set to active bin
                this.currentCenterBin = activeId;
                this.lastActiveBin = activeId;
                logger.info('Entry', `Setting center bin to active bin: ${activeId}`);
            }
        }
    }

    private async initializePoolData() {
        this.tokenX = await this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getTokenX' });
        this.tokenY = await this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getTokenY' });
        this.binStep = await this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getBinStep' });

        this.tokenXDecimals = await this.publicClient.readContract({ address: this.tokenX, abi: ERC20_ABI, functionName: 'decimals' });
        this.tokenYDecimals = await this.publicClient.readContract({ address: this.tokenY, abi: ERC20_ABI, functionName: 'decimals' });
        this.tokenXSymbol = await this.publicClient.readContract({ address: this.tokenX, abi: ERC20_ABI, functionName: 'symbol' });
        this.tokenYSymbol = await this.publicClient.readContract({ address: this.tokenY, abi: ERC20_ABI, functionName: 'symbol' });

        const activeId = await this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getActiveId' });
        this.lastActiveBin = activeId;
        // currentCenterBin will be set after ensureEntry() determines if we have existing liquidity

        logger.info('Init', `Connected. TokenX: ${this.tokenXSymbol} (${this.tokenX}), TokenY: ${this.tokenYSymbol} (${this.tokenY})`);
        logger.info('Init', `Bin Step: ${this.binStep}, Active Bin: ${activeId}`);
    }

    private async checkHealth() {
        const balWei = await this.publicClient.getBalance({ address: this.account.address });
        const balMon = parseFloat(formatUnits(balWei, 18));

        if (balMon < STRATEGY.MIN_GAS_RESERVE_MON) {
            logger.error('Health', `CRITICAL: Balance low (${balMon.toFixed(4)} MON). Pausing bot.`);
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

        logger.info('Timer', 'Starting 3-minute in-range maintenance timer');
        this.inRangeTimer = setTimeout(async () => {
            if (!this.isRebalancing) {
                logger.info('Timer', '3-minute in-range timer expired. Performing maintenance rebalance...');
                await this.executeMaintenanceRebalance();
            }
        }, this.MAINTENANCE_REBALANCE_INTERVAL_MS);
    }

    private async checkRebalance() {
        try {
            const activeId = await this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getActiveId' });
            const isInRange = this.isPositionInRange(activeId);

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
                    await this.executeRebalance(activeId);
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
        await this.executeRebalance(this.currentCenterBin, true);
    }

    private async executeRebalance(newCenterId: number, isMaintenance = false) {
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

            // 2. Add Liquidity
            await this.addLiquidity(newCenterId);

            // Update tracking state
            this.lastActiveBin = newCenterId;
            this.currentCenterBin = newCenterId;

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

        const balances = [];
        for (const id of idsToCheck) {
            const b = await this.publicClient.readContract({
                address: POOL_ADDRESS,
                abi: PAIR_ABI,
                functionName: 'balanceOf',
                args: [this.account.address, BigInt(id)]
            });
            if (b > 0n) balances.push({ id: BigInt(id), amount: b });
        }

        if (balances.length === 0) {
            logger.info('Rebalance', `No existing liquidity found (or first run). Proceeding to Add.`);
            return;
        }

        logger.info('Rebalance', `Removing liquidity from ${balances.length} bins...`);

        const idsToRemove = balances.map(b => b.id);
        const amountsToRemove = balances.map(b => b.amount);

        // Approval Check
        const isApproved = await this.publicClient.readContract({
            address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'isApprovedForAll', args: [this.account.address, ROUTER_ADDRESS]
        });

        if (!isApproved) {
            logger.info('Rebalance', `Approving pair...`);
            // Skip simulation for approval (Monad RPC issue)
            const hash = await this.walletClient.writeContract({
                address: POOL_ADDRESS,
                abi: PAIR_ABI,
                functionName: 'setApprovalForAll',
                args: [ROUTER_ADDRESS, true]
            } as any);
            await this.publicClient.waitForTransactionReceipt({ hash });
            logger.info('Rebalance', `Approved.`);
        }

        // Remove with retry
        await retry(async () => {
            const { request: removeReq } = await this.publicClient.simulateContract({
                address: ROUTER_ADDRESS,
                abi: ROUTER_ABI,
                functionName: 'removeLiquidity',
                args: [
                    this.tokenX,
                    this.tokenY,
                    this.binStep,
                    0n,
                    0n,
                    idsToRemove,
                    amountsToRemove,
                    this.account.address,
                    BigInt(Math.floor(Date.now() / 1000) + 300)
                ],
                account: this.account
            });

            const removeHash = await this.walletClient.writeContract(removeReq);
            const receipt = await this.publicClient.waitForTransactionReceipt({ hash: removeHash });

            if (receipt.status === 'reverted') {
                throw new Error(`Transaction reverted: ${removeHash}`);
            }

            logger.info('Rebalance', `Liquidity Removed. Hash: ${removeHash}`);
        }, 3, 2000);
    }


    private async addLiquidity(centerId: number) {
        // Step 1: Get fresh balances
        let balX = await this.publicClient.readContract({
            address: this.tokenX, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.account.address]
        });
        let balY = await this.publicClient.readContract({
            address: this.tokenY, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.account.address]
        });

        logger.info('Rebalance', `Wallet Balances - X: ${formatUnits(balX, this.tokenXDecimals)}, Y: ${formatUnits(balY, this.tokenYDecimals)}`);

        // Step 2: Filter dust amounts (< 1000 wei treated as zero)
        const MIN_AMOUNT = 1000n;
        if (balX < MIN_AMOUNT) balX = 0n;
        if (balY < MIN_AMOUNT) balY = 0n;

        if (balX === 0n && balY === 0n) {
            logger.warn('Rebalance', `Zero/dust balances. Nothing to add.`);
            return;
        }

        // Step 3: Ensure approvals
        await this.ensureApprove(this.tokenX, ROUTER_ADDRESS, balX);
        await this.ensureApprove(this.tokenY, ROUTER_ADDRESS, balY);

        // Step 4: CRITICAL - Fetch FRESH activeId from chain
        const freshActiveId = await this.publicClient.readContract({
            address: POOL_ADDRESS,
            abi: PAIR_ABI,
            functionName: 'getActiveId'
        });

        logger.info('Rebalance', `Fresh ActiveId from chain: ${freshActiveId} (requested: ${centerId})`);

        // Step 5: Build DLMM-safe liquidity params
        const params = this.buildSafeLiquidityParams(freshActiveId, balX, balY);

        if (!params) {
            logger.error('Rebalance', 'Failed to build safe liquidity params. Aborting.');
            return;
        }

        // Step 6: Simulate & Send with retry
        logger.info('Rebalance', `Simulating Add Liquidity...`);
        await retry(async () => {
            const { request: addReq } = await this.publicClient.simulateContract({
                address: ROUTER_ADDRESS,
                abi: ROUTER_ABI,
                functionName: 'addLiquidity',
                args: [params],
                account: this.account
            });

            const addHash = await this.walletClient.writeContract(addReq);
            logger.info('Rebalance', `Add Liquidity Sent. Hash: ${addHash}`);

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
}
