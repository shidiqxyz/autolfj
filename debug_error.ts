
import { decodeErrorResult, parseAbiItem } from 'viem';
import { ROUTER_ABI } from './src/abis';

const errorData = '0x9931a6ae'; // The revert data (signature only)

try {
    const error = decodeErrorResult({
        abi: ROUTER_ABI,
        data: errorData
    });
    console.log('Decoded Error:', error);
} catch (e: any) {
    console.log('Failed to decode:', e.message);

    // Check if it matches any manually
    // ...
}
