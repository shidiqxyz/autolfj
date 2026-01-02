
import { createPublicClient, http, formatUnits, parseUnits } from 'viem';
import { POOL_ADDRESS, RPC_URL, ROUTER_ADDRESS } from './config';
import { PAIR_ABI, ERC20_ABI, ROUTER_ABI } from './abis';

const CHAIN_ID = 143;

async function main() {
    const publicClient = createPublicClient({
        chain: {
            id: CHAIN_ID,
            name: 'Monad Mainnet',
            nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
            rpcUrls: { default: { http: [RPC_URL] } }
        },
        transport: http()
    });

    console.log('--- Diagnostic Start ---');
    console.log(`Pool: ${POOL_ADDRESS}`);

    const [tokenX, tokenY, binStep, activeId] = await Promise.all([
        publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getTokenX' }),
        publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getTokenY' }),
        publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getBinStep' }),
        publicClient.readContract({ address: POOL_ADDRESS, abi: PAIR_ABI, functionName: 'getActiveId' })
    ]);

    console.log(`Token X: ${tokenX}`);
    console.log(`Token Y: ${tokenY}`);
    console.log(`Bin Step: ${binStep}`);
    console.log(`Active Id: ${activeId}`);

    const [symX, symY, decX, decY] = await Promise.all([
        publicClient.readContract({ address: tokenX, abi: ERC20_ABI, functionName: 'symbol' }),
        publicClient.readContract({ address: tokenY, abi: ERC20_ABI, functionName: 'symbol' }),
        publicClient.readContract({ address: tokenX, abi: ERC20_ABI, functionName: 'decimals' }),
        publicClient.readContract({ address: tokenY, abi: ERC20_ABI, functionName: 'decimals' })
    ]);

    console.log(`X: ${symX} (${decX}), Y: ${symY} (${decY})`);

    const isXNative = symX === 'WMON' || symX === 'WNATIVE';
    const isYNative = symY === 'WMON' || symY === 'WNATIVE'; // Added Y check just in case

    console.log(`Detected Native X: ${isXNative}`);
    console.log(`Detected Native Y: ${isYNative}`);

    if (!isXNative && !isYNative) {
        console.warn('WARNING: Neither token detected as WMON/WNATIVE. addLiquidityNATIVE might be wrong if this is not a native pair.');
    }

    // Checking factory to see if we can find WNATIVE info (optional, skipped for now)

    console.log('\n--- Simulation Params Check ---');
    // Replicate Bot Logic for params
    const bins = isXNative ? [Number(activeId), Number(activeId) + 1] : [Number(activeId) - 1, Number(activeId)];
    const deltaIds = bins.map(b => BigInt(b - Number(activeId)));
    console.log(`Target Bins: ${bins.join(', ')}`);
    console.log(`Delta IDs: ${deltaIds.join(', ')}`);

    // Verify 2-bin distribution logic manually
    // If we call addLiquidityNATIVE, we send ETH (MON) as value.
    // That MON matches the Native token side.

    // Example from error:
    // amountX (TokenX is Native?) = 95486607300521466 (0.095 MON)
    // distributionX = [0, 1000000000000000000] (0% to active, 100% to active+1) if X is native?
    // Wait, in the error logs:
    // deltaIds: ["-1","0"]
    // distributionX: ["0","1000000000000000000"] -> 0% to bin -1, 100% to bin 0 ?
    // tokenX in error log: 0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242

    // Let's resolve the actual symbols for the address in the error log
    // Error Contract Call Address: 0x1855... (Router)
    // Args: tokenX: 0xEE8c... tokenY: 0x3bd3...

    if (tokenX.toLowerCase() !== '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242') {
        console.log('NOTE: Pool tokens match error logs?');
        console.log(`Config TokenX: ${tokenX}`);
        console.log(`Error TokenX: 0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242`);
    } else {
        console.log('Confirmed: Configured pool matches error log pool.');
    }

}

main().catch(console.error);
