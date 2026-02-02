import pino from 'pino';

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

export type BotState = 'RUNNING' | 'PAUSED' | 'STOPPED';

export type BotHooks = {
    start?: () => Promise<void> | void; // Called when entering RUNNING
    pause?: () => Promise<void> | void; // Called when entering PAUSED
    kill?: () => Promise<void> | void;  // Called when entering STOPPED
    tick?: () => Promise<void> | void;  // Optional polling loop when running
};

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

    async run(): Promise<BotState> {
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
        this.loop = setInterval(() => {
            Promise.resolve(this.hooks.tick?.())
                .catch((err) => logger.error({ err }, 'Tick error'));
        }, 4_000);
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
