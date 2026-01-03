
import { keccak256, toBytes } from 'viem';

const errors = [
    'LBRouter__IdSlippageCaught(uint256,uint256)',
    'LBRouter__LengthsMismatch()',
    'LBRouter__WrongNativeLiquidityParameters()',
    'LBRouter__BinStepInvalid()',
    'LBRouter__BrokenDistribution()',
    'LBRouter__TooMuchActiveLiquidity()',
    'LBRouter__AmountSlippageCaught(uint256,uint256)',
    'LBRouter__IdOverflows(int256)',
    'LBRouter__BinReserveOverflows(uint256)',
    'LBRouter__SwapOverflows(uint256)',
    'LBRouter__PrematureDeadline(uint256,uint256)',
    'LBRouter__SenderNotSurplus()',
    'LBRouter__InvalidTokenPath()',
    'LBRouter__InvalidVersion(uint16)',
    'LBRouter__InsufficientAmountOut(uint256,uint256)',
    'LBRouter__InsufficientAmountIn(uint256,uint256)',
    'LBRouter__MaxAmountInExceeded(uint256,uint256)',
    'LBRouter__InvalidLiquidityParameters()',
];

errors.forEach(err => {
    const hash = keccak256(toBytes(err));
    const sig = hash.slice(0, 10);
    console.log(`${sig} : ${err}`);
});
