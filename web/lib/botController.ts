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
            console.log('[BotController] Bot is running');
            return this.state;
        } catch (err) {
            // If start fails, ensure we stay in STOPPED state
            this.stopLoop();
            console.error('[BotController] Failed to start bot:', err);
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
        console.log('[BotController] Bot is paused (monitoring only)');
        return this.state;
    }

    async kill(): Promise<BotState> {
        if (this.state === 'STOPPED') {
            throw new Error('Bot already stopped');
        }
        this.stopLoop();
        await this.hooks.kill?.();
        this.state = 'STOPPED';
        console.log('[BotController] Bot killed and halted');
        return this.state;
    }

    private startLoop(): void {
        if (this.loop) clearInterval(this.loop);
        if (!this.hooks.tick) return;
        this.loop = setInterval(() => {
            Promise.resolve(this.hooks.tick?.())
                .catch((err) => console.error('[BotController] tick error', err));
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
