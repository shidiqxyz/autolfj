
import { DLMMBot } from './core/Bot';
import { logger } from './utils';

async function main() {
    try {
        const bot = new DLMMBot();
        await bot.start();
    } catch (e: any) {
        logger.error('Main', `Unhadled exception:`, e);
        process.exit(1);
    }
}

main();
