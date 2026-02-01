import { logger } from './analytics/logger';
import { loadConfig } from './config';
import { TradingRuntime } from './runtime/tradingRuntime';

async function main(): Promise<void> {
    const runtime = new TradingRuntime(loadConfig());
    let interval: ReturnType<typeof setInterval> | undefined;

    try {
        await runtime.start();

        const runLoop = async () => {
            try {
                await runtime.tick();
            } catch (err) {
                logger.error({ err }, 'Main loop error');
            }
        };

        interval = setInterval(runLoop, 4_000);

        process.on('SIGINT', async () => {
            if (interval) clearInterval(interval);
            await runtime.kill().catch((err) => logger.warn({ err }, 'Graceful shutdown failed'));
            logger.info('Shutdown complete');
            process.exit(0);
        });
    } catch (err) {
        logger.error({ err }, 'Startup failure');
        if (interval) clearInterval(interval);
        await runtime.kill().catch(() => undefined);
        throw err;
    }
}

main().catch((err) => {
    logger.error({ err }, 'Fatal error');
    process.exit(1);
});
