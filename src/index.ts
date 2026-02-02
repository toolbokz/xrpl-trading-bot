import { logger } from './analytics/logger';
import { loadConfig } from './config';
import { TradingRuntime } from './runtime/tradingRuntime';

async function main(): Promise<void> {
    const runtime = new TradingRuntime(loadConfig());
    let interval: ReturnType<typeof setInterval> | undefined;
    let isShuttingDown = false;

    /**
     * Graceful shutdown handler.
     * Ensures clean exit on SIGTERM (deploy/restart) and SIGINT (Ctrl+C).
     */
    const gracefulShutdown = async (signal: string) => {
        if (isShuttingDown) {
            logger.warn({ signal }, 'Shutdown already in progress, ignoring signal');
            return;
        }
        isShuttingDown = true;

        logger.info({ signal }, 'Received shutdown signal');

        // Stop the tick loop immediately
        if (interval) {
            clearInterval(interval);
            interval = undefined;
        }

        // Call graceful shutdown (cancels offers, disconnects, etc.)
        try {
            await runtime.shutdown();
        } catch (err) {
            logger.error({ err }, 'Error during graceful shutdown');
        }

        logger.info('Shutdown complete, exiting');
        process.exit(0);
    };

    // Register signal handlers
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught errors gracefully
    process.on('uncaughtException', async (err) => {
        logger.error({ err }, 'Uncaught exception');
        await gracefulShutdown('uncaughtException').catch(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error({ reason, promise }, 'Unhandled promise rejection');
        // Don't exit on unhandled rejection, just log
    });

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

        logger.info('Trading bot started, press Ctrl+C to stop');
    } catch (err) {
        logger.error({ err }, 'Startup failure');
        if (interval) clearInterval(interval);
        await runtime.shutdown().catch(() => undefined);
        throw err;
    }
}

main().catch((err) => {
    logger.error({ err }, 'Fatal error');
    process.exit(1);
});
