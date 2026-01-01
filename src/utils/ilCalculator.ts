/**
 * Impermanent Loss Calculator for DLMM (Dynamic Liquidity Market Maker)
 * 
 * In DLMM, price is determined by bin ID:
 * price = (1 + binStep / 10000)^(activeId - 8388608)
 * 
 * IL = (Value of LP Position / Value of Holding Tokens) - 1
 */

export interface ILResult {
    impermanentLossPercent: number; // Negative = loss, Positive = gain
    lpValueInTokenX: number; // Current value of LP position in token X terms
    holdValueInTokenX: number; // Value if we just held the tokens
    priceRatio: number; // Current price / Entry price (where 1.0 = no change)
}

/**
 * Calculate price from bin ID
 * @param binId The bin ID
 * @param binStep The bin step (e.g., 1 = 0.01%, 10 = 0.1%)
 * @returns Price (tokenY/tokenX)
 */
export function binIdToPrice(binId: number, binStep: number): number {
    // DLMM formula: price = (1 + binStep / 10000)^(activeId - 8388608)
    const base = 1 + binStep / 10000;
    const exponent = binId - 8388608; // 8388608 is the reference bin ID (price = 1)
    return Math.pow(base, exponent);
}

/**
 * Calculate price ratio change
 * @param entryBinId Bin ID when position was entered
 * @param currentBinId Current active bin ID
 * @param binStep Bin step of the pool
 * @returns Price ratio (current / entry), where 1.0 = no change
 */
export function calculatePriceRatio(entryBinId: number, currentBinId: number, binStep: number): number {
    if (entryBinId === currentBinId) return 1.0;
    
    const entryPrice = binIdToPrice(entryBinId, binStep);
    const currentPrice = binIdToPrice(currentBinId, binStep);
    
    return currentPrice / entryPrice;
}

/**
 * Calculate impermanent loss for concentrated liquidity (approximation for tight ranges)
 * 
 * For tight ranges, we can approximate IL using the formula:
 * IL ≈ -0.5 * (priceRatio - 1)^2 for small changes
 * 
 * More accurately for concentrated liquidity:
 * IL depends on the range width and price movement
 * 
 * @param priceRatio Current price / Entry price (where 1.0 = no change)
 * @param rangeWidth Approximate range width in bins (default 3 for tight range)
 * @returns Impermanent loss as a percentage (negative = loss)
 */
export function calculateImpermanentLoss(priceRatio: number, rangeWidth: number = 3): number {
    if (priceRatio <= 0) return -100; // Invalid
    
    // For very tight ranges (like 3 bins), IL is much smaller than full-range pools
    // The formula is complex, but for tight ranges near 1.0, we can approximate
    
    // If price hasn't moved outside range, IL is minimal (close to 0)
    // The wider the range, the less IL for same price movement
    
    // Simplified approximation for tight ranges:
    // IL is roughly proportional to (priceRatio - 1)^2, but scaled by range width
    const priceChange = Math.abs(priceRatio - 1);
    
    // For tight 3-bin range, IL is significantly reduced
    // Factor: 1/sqrt(rangeWidth) gives rough scaling
    const rangeFactor = 1 / Math.sqrt(rangeWidth);
    
    // Approximation: IL ≈ -0.5 * rangeFactor * (priceRatio - 1)^2
    // This gives smaller IL for tighter ranges
    let il = -0.5 * rangeFactor * Math.pow(priceRatio - 1, 2) * 100;
    
    // For large price movements outside range, IL can be more significant
    // But since bot rebalances immediately, we mainly care about small movements
    return il;
}

/**
 * Calculate the value of an LP position vs holding tokens
 * @param amountX Amount of token X
 * @param amountY Amount of token Y
 * @param entryPrice Price when entered (tokenY/tokenX)
 * @param currentPrice Current price (tokenY/tokenX)
 * @returns IL result
 */
export function calculateILForPosition(
    amountX: bigint,
    amountY: bigint,
    entryPrice: number,
    currentPrice: number,
    tokenXDecimals: number,
    tokenYDecimals: number
): ILResult {
    // Convert to numbers (assuming reasonable sizes)
    const amountXNum = Number(amountX) / Math.pow(10, tokenXDecimals);
    const amountYNum = Number(amountY) / Math.pow(10, tokenYDecimals);
    
    // Calculate values in token X terms
    const lpValueInTokenX = amountXNum + (amountYNum / currentPrice);
    const holdValueInTokenX = amountXNum + (amountYNum / entryPrice);
    
    // Calculate IL
    const ilPercent = holdValueInTokenX > 0 
        ? ((lpValueInTokenX / holdValueInTokenX) - 1) * 100
        : 0;
    
    const priceRatio = entryPrice > 0 ? currentPrice / entryPrice : 1.0;
    
    return {
        impermanentLossPercent: ilPercent,
        lpValueInTokenX,
        holdValueInTokenX,
        priceRatio
    };
}

/**
 * Calculate IL using bin IDs (DLMM-specific)
 */
export function calculateILFromBins(
    entryBinId: number,
    currentBinId: number,
    binStep: number,
    rangeWidth: number = 3
): ILResult {
    const entryPrice = binIdToPrice(entryBinId, binStep);
    const currentPrice = binIdToPrice(currentBinId, binStep);
    const priceRatio = currentPrice / entryPrice;
    
    const ilPercent = calculateImpermanentLoss(priceRatio, rangeWidth);
    
    // For display, we need actual token amounts to show absolute values
    // But we can return the percentage which is most useful
    
    return {
        impermanentLossPercent: ilPercent,
        lpValueInTokenX: 0, // Would need actual amounts to calculate
        holdValueInTokenX: 0, // Would need actual amounts to calculate
        priceRatio
    };
}

