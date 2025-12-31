
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
            logger.info('Entry', 'Liquidity found. Waiting for volatility trigger.');
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

    private async checkRebalance() {
        try {
            const activeId = await this.publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getActiveId' });

            const diff = Math.abs(activeId - this.lastActiveBin);
            const hardTrigger = diff > 1; // "Hard Out-of-Range Rule"

            if (hardTrigger) {
                logger.warn('Trigger', `Hard Out-of-Range! Active: ${activeId}, Last Center: ${this.lastActiveBin}, Diff: ${diff}`);
                await this.executeRebalance(activeId);
                return;
            }
        } catch (err) {
            logger.error('Check', `Error checking rebalance conditions:`, err);
        }
    }

    private async executeRebalance(newCenterId: number) {
        if (this.isRebalancing) return;
        this.isRebalancing = true;
        logger.warn('Rebalance', `Starting rebalance sequence -> Target Center: ${newCenterId}`);

        try {
            await this.checkHealth();

            // 1. Remove Liquidity
            await this.removeLiquidity();

            // 2. Add Liquidity
            await this.addLiquidity(newCenterId);

            this.lastActiveBin = newCenterId;

        } catch (err) {
            logger.error('Rebalance', `FAILED:`, err);
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
        // Balances
        let balX = await this.publicClient.readContract({ address: this.tokenX, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.account.address] });
        let balY = await this.publicClient.readContract({ address: this.tokenY, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.account.address] });

        logger.info('Rebalance', `Wallet Balances - X: ${formatUnits(balX, this.tokenXDecimals)}, Y: ${formatUnits(balY, this.tokenYDecimals)}`);

        // Filter dust amounts (< 1000 wei is treated as zero to avoid router revert)
        const MIN_AMOUNT = 1000n;
        if (balX < MIN_AMOUNT) balX = 0n;
        if (balY < MIN_AMOUNT) balY = 0n;

        if (balX === 0n && balY === 0n) {
            logger.warn('Rebalance', `Zero/dust balances. Nothing to add.`);
            return;
        }

        await this.ensureApprove(this.tokenX, ROUTER_ADDRESS, balX);
        await this.ensureApprove(this.tokenY, ROUTER_ADDRESS, balY);

        // Distributions (3-bin strategy: Active-1, Active, Active+1)
        const rawDeltaIds = [-1n, 0n, 1n];
        const oneHalf = BigInt('500000000000000000'); // 50%

        // Raw weights
        const rawDistX = balX > 0n ? [0n, oneHalf, oneHalf] : [0n, 0n, 0n];
        const rawDistY = balY > 0n ? [oneHalf, oneHalf, 0n] : [0n, 0n, 0n];

        // Filter: Only include bins where we contribute something
        const deltaIds: bigint[] = [];
        const distX: bigint[] = [];
        const distY: bigint[] = [];

        for (let i = 0; i < 3; i++) {
            if (rawDistX[i] > 0n || rawDistY[i] > 0n) {
                deltaIds.push(rawDeltaIds[i]);
                distX.push(rawDistX[i]);
                distY.push(rawDistY[i]);
            }
        }

        const params = {
            tokenX: this.tokenX,
            tokenY: this.tokenY,
            binStep: BigInt(this.binStep),
            amountX: balX,
            amountY: balY,
            amountXMin: 0n,
            amountYMin: 0n,
            activeIdDesired: BigInt(centerId),
            idSlippage: 5n, // Allow 5 bins slippage (approx 0.05% if step=10) to prevent reverts
            deltaIds,
            distributionX: distX,
            distributionY: distY,
            to: this.account.address,
            refundTo: this.account.address,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 300)
        };

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

            logger.info('Rebalance', `SUCCESS. New Range Centered at: ${centerId}`);
        }, 3, 2000);
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
