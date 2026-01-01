import {
    PublicClient,
    WalletClient,
    Address,
    formatUnits,
    createPublicClient,
    createWalletClient,
    http,
    decodeEventLog,
    parseAbiItem
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

    // State
    private isProcessing = false;

    // Pool Info
    private tokenX!: Address;
    private tokenY!: Address;
    private binStep!: number;
    private tokenXDecimals!: number;
    private tokenYDecimals!: number;
    private tokenXSymbol!: string;
    private tokenYSymbol!: string;
    private isTokenXNative!: boolean;

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
        logger.info('Init', `🚀 Starting Spam Bot on Monad Mainnet...`);
        logger.info('Init', `📍 Pool: ${POOL_ADDRESS}`);
        logger.info('Init', `👛 Account: ${this.account.address}`);

        try {
            await this.initializePoolData();
            await this.cleanupExistingPositions();
            await this.runSpamCycle();
        } catch (err) {
            logger.error('Init', 'Critical error:', err);
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

        this.isTokenXNative = this.tokenXSymbol.toUpperCase() === 'WMON' || this.tokenXSymbol.toUpperCase() === 'WNATIVE';

        logger.info('Init', `✅ TokenX: ${this.tokenXSymbol}, TokenY: ${this.tokenYSymbol}`);
        logger.info('Init', `✅ Native token: ${this.isTokenXNative ? this.tokenXSymbol : this.tokenYSymbol}`);
        logger.info('Init', `✅ Bin Step: ${this.binStep}`);
    }

    private async cleanupExistingPositions() {
        logger.info('Cleanup', '🔍 Checking for existing positions...');

        try {
            const activeId = await this.publicClient.readContract({
                address: POOL_ADDRESS,
                abi: PAIR_ABI,
                functionName: 'getActiveId'
            }) as number;

            // Check bins around activeId for existing liquidity
            const rangeToCheck = 20;
            const binsToCheck: number[] = [];
            for (let i = activeId - rangeToCheck; i <= activeId + rangeToCheck; i++) {
                binsToCheck.push(i);
            }

            const balanceCalls = binsToCheck.map(id => ({
                address: POOL_ADDRESS as Address,
                abi: PAIR_ABI,
                functionName: 'balanceOf' as const,
                args: [this.account.address, BigInt(id)] as const
            }));

            const balanceResults = await Promise.allSettled(
                balanceCalls.map(call => this.publicClient.readContract(call as any))
            );

            const existingPositions: number[] = [];
            for (let i = 0; i < balanceResults.length; i++) {
                const result = balanceResults[i];
                if (result.status === 'fulfilled' && (result.value as bigint) > 0n) {
                    existingPositions.push(binsToCheck[i]);
                }
            }

            if (existingPositions.length > 0) {
                logger.warn('Cleanup', `⚠️ Found ${existingPositions.length} existing positions: [${existingPositions.join(', ')}]`);
                logger.info('Cleanup', '🧹 Removing existing positions...');
                await this.removeLiquidity(existingPositions);
                logger.info('Cleanup', '✅ Cleanup complete');
            } else {
                logger.info('Cleanup', '✅ No existing positions found. Starting fresh.');
            }
        } catch (err: any) {
            logger.warn('Cleanup', `⚠️ Cleanup failed (non-critical): ${err?.message || err}`);
            logger.info('Cleanup', 'Continuing with spam cycle...');
        }
    }

    private async runSpamCycle() {
        let cycleCount = 0;

        while (true) {
            cycleCount++;
            logger.info('Cycle', `\n${'='.repeat(60)}`);
            logger.info('Cycle', `🔄 Starting Cycle #${cycleCount}`);
            logger.info('Cycle', `${'='.repeat(60)}`);

            try {
                // Step 1: Check MON balance
                const balance = await this.publicClient.getBalance({ address: this.account.address });
                const balanceMON = parseFloat(formatUnits(balance, 18));

                logger.info('Balance', `💰 Current MON balance: ${balanceMON.toFixed(4)} MON`);

                // Step 2: Exit if insufficient balance
                if (balanceMON < STRATEGY.MIN_SAFE_BALANCE_MON) {
                    logger.error('Balance', `❌ Insufficient MON (${balanceMON.toFixed(4)} < ${STRATEGY.MIN_SAFE_BALANCE_MON}). Stopping bot.`);
                    process.exit(0);
                }

                // Step 3: Calculate usable MON
                const usableMON = balance - BigInt(Math.floor(STRATEGY.MIN_GAS_RESERVE_MON * 1e18));
                if (usableMON <= 0n) {
                    logger.warn('Balance', '⚠️ No usable MON after gas reserve. Skipping cycle...');
                    await sleep(randomDelay(STRATEGY.DELAY_AFTER_REMOVE_MIN, STRATEGY.DELAY_AFTER_REMOVE_MAX));
                    continue;
                }

                // Step 4: Calculate amount for add (95% of usable MON)
                const amountForAdd = (usableMON * BigInt(Math.floor(STRATEGY.LIQUIDITY_USE_PERCENT * 100))) / 100n;
                logger.info('Liquidity', `📊 Usable MON: ${formatUnits(usableMON, 18)} → Adding: ${formatUnits(amountForAdd, 18)} MON (${STRATEGY.LIQUIDITY_USE_PERCENT * 100}%)`);

                // Step 5: Get activeId
                const activeId = await this.publicClient.readContract({
                    address: POOL_ADDRESS,
                    abi: PAIR_ABI,
                    functionName: 'getActiveId'
                }) as number;

                logger.info('Pool', `📈 Active Bin ID: ${activeId}`);

                // Step 6: Select 2 bins (activeId, activeId+1)
                const bins = [activeId, activeId + 1];
                logger.info('Pool', `🎯 Target bins: [${bins.join(', ')}]`);

                // Step 7: Removed (was AUSD estimation)
                // Step 8: Add liquidity
                const positionIds = await this.addLiquidity(bins, amountForAdd);

                if (!positionIds || positionIds.length === 0) {
                    logger.warn('Cycle', '⚠️ No positions created. Skipping remove...');
                    await sleep(randomDelay(STRATEGY.DELAY_AFTER_REMOVE_MIN, STRATEGY.DELAY_AFTER_REMOVE_MAX));
                    continue;
                }

                // Step 9: Log position IDs
                logger.info('Position', `✅ Position IDs: [${positionIds.join(', ')}]`);

                // Step 10: Random delay 10-90s
                const delayAfterAdd = randomDelay(STRATEGY.DELAY_AFTER_ADD_MIN, STRATEGY.DELAY_AFTER_ADD_MAX);
                logger.info('Delay', `⏳ Waiting ${(delayAfterAdd / 1000).toFixed(1)}s before remove...`);
                await sleep(delayAfterAdd);

                // Step 11: Remove 100% using maxInt128 (now replaced with logic)
                await this.removeLiquidity(positionIds);

                // Step 12: Log completion
                const newBalance = await this.publicClient.getBalance({ address: this.account.address });
                const newBalanceMON = parseFloat(formatUnits(newBalance, 18));
                const gasUsed = balanceMON - newBalanceMON;

                logger.info('Cycle', `\n${'─'.repeat(60)}`);
                logger.info('Cycle', `✅ Cycle #${cycleCount} Complete`);
                logger.info('Cycle', `💰 Balance: ${balanceMON.toFixed(4)} → ${newBalanceMON.toFixed(4)} MON`);
                logger.info('Cycle', `⛽ Gas used: ~${gasUsed.toFixed(6)} MON`);
                logger.info('Cycle', `${'─'.repeat(60)}\n`);



            } catch (err: any) {
                logger.error('Cycle', `❌ Cycle #${cycleCount} failed:`);

                // Enhanced error logging
                if (err.message) logger.error('Error', `Message: ${err.message}`);
                if (err.cause?.reason) logger.error('Error', `Reason: ${err.cause.reason}`);
                if (err.shortMessage) logger.error('Error', `Short: ${err.shortMessage}`);
                if (err.details) logger.error('Error', `Details: ${err.details}`);

                logger.warn('Cycle', '⏭️ Skipping to next cycle in 30s...');
                await sleep(30000);
            }
        }
    }



    private async addLiquidity(bins: number[], monAmount: bigint): Promise<number[]> {
        logger.info('Add', `➕ Adding liquidity to bins [${bins.join(', ')}]...`);

        // Check actual AUSD balance
        const nonNativeToken = this.isTokenXNative ? this.tokenY : this.tokenX;
        const ausdBalance = await this.publicClient.readContract({
            address: nonNativeToken,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [this.account.address]
        }) as bigint;

        logger.info('Add', `💰 AUSD balance: ${formatUnits(ausdBalance, this.tokenYDecimals)} ${this.tokenYSymbol}`);

        // Always use full AUSD balance and let Router refund the unused amount
        // This bypasses potential price estimation errors
        let actualAusdAmount = ausdBalance;
        logger.info('Add', `💰 Using full AUSD balance: ${formatUnits(actualAusdAmount, this.tokenYDecimals)} (Router will refund excess)`);

        // Ensure AUSD approval if we have AUSD to add
        if (actualAusdAmount > 0n) {
            await this.ensureApprove(nonNativeToken, ROUTER_ADDRESS, actualAusdAmount);
        }

        // Get activeId for params
        const activeId = await this.publicClient.readContract({
            address: POOL_ADDRESS,
            abi: PAIR_ABI,
            functionName: 'getActiveId'
        }) as number;

        // Build params for 2-bin add
        const params = this.buildTwoBinParams(activeId, bins, monAmount, actualAusdAmount);

        let positionIds: number[] = [];

        await retry(async () => {
            let addReq: any;

            try {
                logger.info('Add', '🔍 Simulating add liquidity...');
                const simulated = await this.publicClient.simulateContract({
                    address: ROUTER_ADDRESS,
                    abi: ROUTER_ABI,
                    functionName: 'addLiquidityNATIVE',
                    args: [params],
                    account: this.account,
                    value: monAmount
                });
                addReq = simulated.request;
            } catch (simError: any) {
                const errorMsg = simError?.message || '';
                if (errorMsg.toLowerCase().includes('txpool not responding')) {
                    logger.warn('Add', '⚠️ Simulation failed (txpool). Sending directly...');
                    addReq = {
                        address: ROUTER_ADDRESS,
                        abi: ROUTER_ABI,
                        functionName: 'addLiquidityNATIVE',
                        args: [params]
                    };
                } else {
                    throw simError;
                }
            }

            const addHash = await this.walletClient.writeContract({
                ...addReq,
                value: monAmount,
                maxFeePerGas: GAS_SETTINGS.MAX_FEE_PER_GAS,
                maxPriorityFeePerGas: GAS_SETTINGS.MAX_PRIORITY_FEE_PER_GAS
            });
            logger.info('Add', `📤 TX sent: ${addHash}`);

            const receipt = await this.publicClient.waitForTransactionReceipt({ hash: addHash });
            if (receipt.status === 'reverted') {
                throw new Error(`Add liquidity reverted: ${addHash}`);
            }

            logger.info('Add', `✅ Liquidity added successfully`);

            // Extract position IDs from receipt
            positionIds = this.extractPositionIds(receipt, bins);
        }, 3, 2000);

        return positionIds;
    }

    private buildTwoBinParams(activeId: number, bins: number[], monAmount: bigint, ausdAmount: bigint) {
        const PRECISION = BigInt('1000000000000000000'); // 1e18

        // Build deltaIds relative to activeId
        const deltaIds: bigint[] = bins.map(bin => BigInt(bin - activeId));

        // Distribution: 50/50 split for MON across both bins
        const distributionX: bigint[] = [PRECISION / 2n, PRECISION / 2n];

        // AUSD goes only to activeId (first bin if bins[0] === activeId)
        let distributionY: bigint[];
        if (bins[0] === activeId && ausdAmount > 0n) {
            distributionY = [PRECISION, 0n]; // All AUSD to activeId
        } else if (bins[1] === activeId && ausdAmount > 0n) {
            distributionY = [0n, PRECISION]; // All AUSD to activeId
        } else {
            distributionY = [0n, 0n]; // No AUSD (single-sided MON)
        }

        const amountX = this.isTokenXNative ? monAmount : ausdAmount;
        const amountY = this.isTokenXNative ? ausdAmount : monAmount;

        logger.info('Params', `📋 DeltaIds: [${deltaIds.join(', ')}]`);
        logger.info('Params', `📋 AmountX: ${formatUnits(amountX, this.tokenXDecimals)} ${this.tokenXSymbol}`);
        logger.info('Params', `📋 AmountY: ${formatUnits(amountY, this.tokenYDecimals)} ${this.tokenYSymbol}`);

        return {
            tokenX: this.tokenX,
            tokenY: this.tokenY,
            binStep: BigInt(this.binStep),
            amountX,
            amountY,
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
    }

    private extractPositionIds(receipt: any, expectedBins: number[]): number[] {
        try {
            // DepositedToBins event signature
            const depositedEvent = parseAbiItem('event DepositedToBins(address indexed sender, address indexed to, uint256[] ids, bytes32[] amounts)');

            for (const log of receipt.logs) {
                try {
                    const decoded = decodeEventLog({
                        abi: [depositedEvent],
                        data: log.data,
                        topics: log.topics
                    });

                    if (decoded.eventName === 'DepositedToBins') {
                        const ids = (decoded.args as any).ids as bigint[];
                        logger.info('Extract', `📍 Extracted bin IDs from event: [${ids.map(id => Number(id)).join(', ')}]`);
                        return ids.map(id => Number(id));
                    }
                } catch {
                    // Skip logs that don't match
                    continue;
                }
            }

            // Fallback: use expected bins
            logger.warn('Extract', `⚠️ Could not extract position IDs from receipt. Using expected bins: [${expectedBins.join(', ')}]`);
            return expectedBins;
        } catch (err) {
            logger.error('Extract', 'Error extracting position IDs:', err);
            return expectedBins;
        }
    }

    private async removeLiquidity(binIds: number[]) {
        logger.info('Remove', `➖ Removing liquidity from bins [${binIds.join(', ')}]...`);

        // 1. Ensure Router is approved to spend LBPair tokens
        const isApproved = await this.publicClient.readContract({
            address: POOL_ADDRESS,
            abi: PAIR_ABI,
            functionName: 'isApprovedForAll',
            args: [this.account.address, ROUTER_ADDRESS]
        }) as boolean;

        if (!isApproved) {
            logger.info('Remove', '🔓 Approving Router for LBPair tokens...');
            await retry(async () => {
                const { request } = await this.publicClient.simulateContract({
                    address: POOL_ADDRESS,
                    abi: PAIR_ABI,
                    functionName: 'setApprovalForAll',
                    args: [ROUTER_ADDRESS, true],
                    account: this.account
                });
                const hash = await this.walletClient.writeContract(request);
                await this.publicClient.waitForTransactionReceipt({ hash });
                logger.info('Remove', '✅ Router approved for LBPair');
            }, 3, 2000);
        }

        // 2. Fetch exact balances to remove
        const balanceCalls = binIds.map(id => ({
            address: POOL_ADDRESS as Address,
            abi: PAIR_ABI,
            functionName: 'balanceOf' as const,
            args: [this.account.address, BigInt(id)] as const
        }));

        const balanceResults = await Promise.allSettled(
            balanceCalls.map(call => this.publicClient.readContract(call as any))
        );

        const idsToRemove: bigint[] = [];
        const amountsToRemove: bigint[] = [];

        for (let i = 0; i < balanceResults.length; i++) {
            const result = balanceResults[i];
            if (result.status === 'fulfilled' && (result.value as bigint) > 0n) {
                idsToRemove.push(BigInt(binIds[i]));
                amountsToRemove.push(result.value as bigint);
            }
        }

        if (idsToRemove.length === 0) {
            logger.warn('Remove', '⚠️ No liquidity found to remove.');
            return;
        }

        logger.info('Remove', `🔥 Removing exact amounts from ${idsToRemove.length} bins: [${amountsToRemove.join(', ')}]`);

        await retry(async () => {
            const nonNativeToken = this.isTokenXNative ? this.tokenY : this.tokenX;

            try {
                const { request: removeReq } = await this.publicClient.simulateContract({
                    address: ROUTER_ADDRESS,
                    abi: ROUTER_ABI,
                    functionName: 'removeLiquidityNATIVE',
                    args: [
                        nonNativeToken,
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

                const { type, ...requestWithoutType } = removeReq as any;
                const removeHash = await this.walletClient.writeContract({
                    ...requestWithoutType,
                    maxFeePerGas: GAS_SETTINGS.MAX_FEE_PER_GAS,
                    maxPriorityFeePerGas: GAS_SETTINGS.MAX_PRIORITY_FEE_PER_GAS
                } as any);

                logger.info('Remove', `📤 TX sent: ${removeHash}`);

                const receipt = await this.publicClient.waitForTransactionReceipt({ hash: removeHash });
                if (receipt.status === 'reverted') {
                    throw new Error(`Remove liquidity reverted: ${removeHash}`);
                }

                logger.info('Remove', `✅ Liquidity removed successfully`);
            } catch (err: any) {
                // Try without simulation if it fails
                const errorMsg = err?.message || '';
                logger.warn('Remove', `⚠️ Simulation failed: ${errorMsg.slice(0, 100)}... Sending directly...`);

                const removeHash = await this.walletClient.writeContract({
                    address: ROUTER_ADDRESS,
                    abi: ROUTER_ABI,
                    functionName: 'removeLiquidityNATIVE',
                    args: [
                        nonNativeToken,
                        this.binStep,
                        0n,
                        0n,
                        idsToRemove,
                        amountsToRemove,
                        this.account.address,
                        BigInt(Math.floor(Date.now() / 1000) + 300)
                    ],
                    maxFeePerGas: GAS_SETTINGS.MAX_FEE_PER_GAS,
                    maxPriorityFeePerGas: GAS_SETTINGS.MAX_PRIORITY_FEE_PER_GAS
                } as any);

                const receipt = await this.publicClient.waitForTransactionReceipt({ hash: removeHash });
                if (receipt.status === 'reverted') {
                    throw new Error(`Remove liquidity reverted: ${removeHash}`);
                }

                logger.info('Remove', `✅ Liquidity removed successfully`);
            }
        }, 3, 2000);
    }

    private async ensureApprove(token: Address, spender: Address, amount: bigint) {
        if (amount === 0n) return;

        const allowance = await this.publicClient.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [this.account.address, spender]
        });

        if (allowance > 0n) {
            logger.info('Approve', `✅ ${token} already approved`);
            return;
        }

        const MAX_UINT256 = 2n ** 256n - 1n;
        logger.info('Approve', `🔓 Approving ${token}...`);

        await retry(async () => {
            const { request } = await this.publicClient.simulateContract({
                address: token,
                abi: ERC20_ABI,
                functionName: 'approve',
                args: [spender, MAX_UINT256],
                account: this.account
            });
            const hash = await this.walletClient.writeContract(request);
            await this.publicClient.waitForTransactionReceipt({ hash });
            logger.info('Approve', `✅ Approved ${token}`);
        }, 3, 2000);
    }
}
