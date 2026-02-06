import { logger } from './analytics/logger';
import { loadConfig } from './config';
import { TradingRuntime } from './runtime/tradingRuntime';
import { enforceLocalOnly, getLocalOnlyStatus, CloudExecutionBlockedError, RemoteExecutionBlockedError } from './security/localOnly';
import { BOT_LOOP_MIN_DELAY_MS } from './utils/sleep';

async function main(): Promise<void> {
    // Single-process mode is the only supported mode.
    // The runtime is started by the Next.js custom server (server.js).
    // This CLI entry point is no longer used.
    logger.warn('='.repeat(70));
    logger.warn('src/index.ts is a legacy CLI entry point.');
    logger.warn('Use "npm run dev" or "npm run start" instead.');
    logger.warn('The TradingRuntime runs inside Next.js (single-process mode).');
    logger.warn('='.repeat(70));
    process.exit(0);

    // Security gate: enforce local-only execution at startup
    logger.info('Performing local-only security check...');

    try {
        enforceLocalOnly('CLI');
    } catch (err) {
        if (err instanceof CloudExecutionBlockedError || err instanceof RemoteExecutionBlockedError) {
            logger.error({ err: (err as Error).message }, '🚫 SECURITY: Remote/cloud execution blocked');
            logger.error('This bot is locked to localhost for safety.');
            logger.error('Set BOT_LOCAL_ONLY=true to run locally, or BOT_ALLOW_REMOTE=true (dangerous) to override.');
            process.exit(1);
        }
        throw err;
    }

    const status = getLocalOnlyStatus();
    logger.info({ localOnly: status.isLocal, reason: status.reason }, '✅ Local-only security check passed');

    const config = loadConfig();
    const runtime = new TradingRuntime(config);

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

        // Use minimum loop delay from config (default 4s, min BOT_LOOP_MIN_DELAY_MS)
        const loopDelayMs = Math.max(4_000, BOT_LOOP_MIN_DELAY_MS);

        const runLoop = async () => {
            try {
                await runtime.tick();
            } catch (err) {
                logger.error({ err }, 'Main loop error');
            }
        };

        interval = setInterval(runLoop, loopDelayMs);

        logger.info({ loopDelayMs }, 'Trading bot started, press Ctrl+C to stop');
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
