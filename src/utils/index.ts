
export async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function randomDelay(minSeconds: number, maxSeconds: number): number {
    const minMs = minSeconds * 1000;
    const maxMs = maxSeconds * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

export async function retry<T>(fn: () => Promise<T>, retries = 3, delay = 2000): Promise<T> {
    try {
        return await fn();
    } catch (e: any) {
        if (retries > 0) {
            console.warn(`[Retry] Operation failed, retrying in ${delay}ms... (${retries} left). Error: ${e.message}`);
            await sleep(delay);
            return retry(fn, retries - 1, delay * 2);
        }
        throw e;
    }
}

export const logger = {
    info: (tag: string, msg: string) => console.log(`[${tag}] ${msg}`),
    error: (tag: string, msg: string, err?: any) => console.error(`[${tag}] ${msg}`, err || ''),
    warn: (tag: string, msg: string) => console.warn(`[${tag}] ${msg}`)
};
