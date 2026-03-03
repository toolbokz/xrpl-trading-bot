import pino from 'pino';
import { loadLocalOnlyConfig } from './security/localOnly';

const pinoOptions = process.env.NODE_ENV !== 'production'
    ? {
        level: process.env.LOG_LEVEL || 'info',
        transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
        },
    }
    : { level: process.env.LOG_LEVEL || 'info' };

const logger = pino(pinoOptions).child({ module: 'BotController' });

/** Minimum loop delay in ms (configurable via BOT_LOOP_MIN_DELAY_MS, default 50, min 25) */
const BOT_LOOP_MIN_DELAY_MS = Math.max(
    25,
    parseInt(process.env.BOT_LOOP_MIN_DELAY_MS ?? '50', 10) || 50
);

/** Main loop interval - use at least 4s or BOT_LOOP_MIN_DELAY_MS */
const LOOP_INTERVAL_MS = Math.max(4_000, BOT_LOOP_MIN_DELAY_MS);

export type BotState = 'RUNNING' | 'PAUSED' | 'STOPPED';

export type BotHooks = {
    start?: () => Promise<void> | void; // Called when entering RUNNING
    pause?: () => Promise<void> | void; // Called when entering PAUSED
    kill?: () => Promise<void> | void;  // Called when entering STOPPED
    tick?: () => Promise<void> | void;  // Optional polling loop when running
};

/**
 * Error thrown when attempting to run the bot in a disallowed environment.
 */
export class LocalOnlyError extends Error {
    constructor(reason: string) {
        super(`Bot execution blocked: ${reason}. This bot is locked to localhost for safety.`);
        this.name = 'LocalOnlyError';
    }
}

class BotController {
    private state: BotState = 'STOPPED';
    private loop: NodeJS.Timeout | null = null;
    private hooks: BotHooks = {};

    setHooks(hooks: BotHooks): void {
        this.hooks = hooks;
    }

    getState(): BotState {
        return this.state;
    }

    /**
     * Validate that the bot is allowed to run in this environment.
     * Throws LocalOnlyError if not allowed.
     */
    private enforceLocalOnlyExecution(): void {
        const config = loadLocalOnlyConfig();

        // Allow override for advanced users
        if (config.allowRemote) {
            if (config.isProduction) {
                logger.warn('⚠️  BOT_ALLOW_REMOTE is enabled in production - wallet exposed!');
            }
            return;
        }

        // Block cloud platforms (unless explicitly locked to localhost)
        if (config.cloudCheck.isCloud && !config.forceLocalOnly) {
            throw new LocalOnlyError(
                `Cloud execution blocked (${config.cloudCheck.platform}). ` +
                'This bot is restricted to local machines only.'
            );
        }

        // Block production without explicit local-only flag
        if (config.isProduction && !config.forceLocalOnly) {
            throw new LocalOnlyError(
                'Production mode requires BOT_LOCAL_ONLY=true to confirm local execution'
            );
        }

        logger.debug('Local-only security check passed');
    }

    async run(): Promise<BotState> {
        // Security gate: enforce local-only execution
        this.enforceLocalOnlyExecution();

        if (this.state === 'RUNNING') {
            throw new Error('Bot already running');
        }
        try {
            await this.hooks.start?.();
            this.startLoop();
            this.state = 'RUNNING';
            logger.info({ state: this.state }, 'Bot is running');
            return this.state;
        } catch (err) {
            // If start fails, ensure we stay in STOPPED state
            this.stopLoop();
            logger.error({ err }, 'Failed to start bot');
            throw err;
        }
    }

    async pause(): Promise<BotState> {
        if (this.state !== 'RUNNING') {
            throw new Error('Bot is not running');
        }
        this.stopLoop();
        await this.hooks.pause?.();
        this.state = 'PAUSED';
        logger.info({ state: this.state }, 'Bot is paused (monitoring only)');
        return this.state;
    }

    async kill(): Promise<BotState> {
        if (this.state === 'STOPPED') {
            throw new Error('Bot already stopped');
        }
        this.stopLoop();
        await this.hooks.kill?.();
        this.state = 'STOPPED';
        logger.info({ state: this.state }, 'Bot killed and halted');
        return this.state;
    }

    private startLoop(): void {
        if (this.loop) clearInterval(this.loop);
        if (!this.hooks.tick) return;
        // Use configurable loop interval (min 4s, respects BOT_LOOP_MIN_DELAY_MS)
        this.loop = setInterval(() => {
            Promise.resolve(this.hooks.tick?.())
                .catch((err) => logger.error({ err }, 'Tick error'));
        }, LOOP_INTERVAL_MS);
        logger.debug({ loopIntervalMs: LOOP_INTERVAL_MS }, 'Started bot loop');
    }

    private stopLoop(): void {
        if (this.loop) {
            clearInterval(this.loop);
            this.loop = null;
        }
    }
}

// Singleton across Next.js API route reloads
const globalController = (globalThis as typeof globalThis & { _botController?: BotController });
export const botController: BotController = globalController._botController || new BotController();
if (!globalController._botController) {
    globalController._botController = botController;
}
