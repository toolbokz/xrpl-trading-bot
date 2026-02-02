import { Wallet, isValidClassicAddress, Client } from 'xrpl';
import { AppConfig, TradingPair, loadConfig } from '../config';
import { logger } from '../analytics/logger';
import { XRPLWebSocket } from '../xrpl/client';
import { OrderBookTracker } from '../market/orderBookTracker';
import { RiskEngine } from '../risk/riskEngine';
import { OfferExecutor } from '../execution/offerExecutor';
import { ScalperStrategy } from '../strategies/scalper';
import { AMMService } from '../market/amm';
import { AMMArbitrageStrategy } from '../strategies/ammArbitrage';
import { PathArbitrageStrategy } from '../strategies/pathArbitrage';
import { Strategy } from '../strategies/types';
import { getWallet, initWallet } from '../xrpl/wallet';
import { ExecutionResult } from '../utils/types';
import { closeBreakerStore } from '../persistence/breakerStore';

const cloneConfig = (cfg: AppConfig): AppConfig => ({
    xrpl: { ...cfg.xrpl },
    tradingPair: { ...cfg.tradingPair },
    tradingPairs: cfg.tradingPairs.map((p) => ({ ...p })),
    walletSeed: cfg.walletSeed,
    walletSecretNumbers: cfg.walletSecretNumbers,
    enableTestnetFaucet: cfg.enableTestnetFaucet,
    paperTrading: cfg.paperTrading,
    risk: { ...cfg.risk, issuerBlacklist: new Set(cfg.risk.issuerBlacklist) },
    strategy: { ...cfg.strategy },
    analytics: { ...cfg.analytics },
});

export const validateTradingPair = (pair: TradingPair): void => {
    const isXRP = (c: string) => c.toUpperCase() === 'XRP';
    if (!isXRP(pair.baseCurrency)) {
        const issuer = pair.baseIssuer || pair.issuer;
        if (!issuer || !isValidClassicAddress(issuer)) {
            throw new Error('Base issued currency requires a valid classic issuer address');
        }
    }
    if (!isXRP(pair.quoteCurrency)) {
        const issuer = pair.quoteIssuer || pair.issuer;
        if (!issuer || !isValidClassicAddress(issuer)) {
            throw new Error('Quote issued currency requires a valid classic issuer address');
        }
    }
    if (pair.baseCurrency.toUpperCase() === pair.quoteCurrency.toUpperCase()) {
        throw new Error('Base and quote currency must differ');
    }
};

export class TradingRuntime {
    private xrpl: XRPLWebSocket | null = null;
    private tracker: OrderBookTracker | null = null;
    private risk: RiskEngine | null = null;
    private executor: OfferExecutor | null = null;
    private strategies: Strategy[] = [];
    private walletAddress: string | null = null;
    private tickInFlight = false;
    private started = false;
    private shutdownInProgress = false;
    private readonly baseConfig: AppConfig;

    constructor(config?: AppConfig) {
        this.baseConfig = config ?? loadConfig();
    }

    async start(): Promise<void> {
        if (this.started) return;
        const config = cloneConfig(this.baseConfig);
        validateTradingPair(config.tradingPair);

        // Wallet init is required for network safety checks even in paper mode.
        let walletCtx: ReturnType<typeof initWallet>;
        try {
            walletCtx = initWallet(config);
        } catch (err) {
            logger.error({ err }, 'Wallet initialization failed');
            throw err instanceof Error ? err : new Error('Wallet initialization failed');
        }
        if (walletCtx.network === 'mainnet' && config.xrpl.network !== 'mainnet') {
            throw new Error('Wallet network mismatch: mainnet wallet with non-mainnet config');
        }
        if (walletCtx.network === 'testnet' && config.xrpl.network === 'mainnet') {
            throw new Error('Wallet network mismatch: testnet wallet with mainnet config');
        }

        const xrpl = new XRPLWebSocket(config.xrpl);
        try {
            await xrpl.connect();
            await xrpl.subscribe(config.tradingPair);

            const client = xrpl.getClient();
            const wallet: Wallet | null = config.paperTrading ? null : getWallet();

            const tracker = new OrderBookTracker(xrpl, config.tradingPair);
            const risk = new RiskEngine(config.risk, client);
            const executor = new OfferExecutor(client, wallet, risk, config.paperTrading, config.tradingPair, config.strategy);
            const amm = new AMMService(client);

            this.strategies = [
                new ScalperStrategy(tracker, config.strategy, config.tradingPair, executor, risk),
                new AMMArbitrageStrategy(amm, config.strategy, config.tradingPair, executor),
                new PathArbitrageStrategy(client, config.strategy, config.tradingPair, executor, config.paperTrading),
            ];

            this.xrpl = xrpl;
            this.tracker = tracker;
            this.risk = risk;
            this.executor = executor;
            this.walletAddress = wallet?.classicAddress ?? null;
            this.started = true;
            logger.info('Trading runtime started');
        } catch (err) {
            await xrpl.disconnect().catch(() => undefined);
            this.reset();
            throw err;
        }
    }

    async tick(): Promise<void> {
        if (!this.started || !this.xrpl || !this.tracker || !this.risk) {
            throw new Error('Trading runtime not started');
        }
        if (this.tickInFlight) return; // avoid overlapping ticks
        this.tickInFlight = true;
        try {
            // Check for daily loss reset at UTC midnight
            this.risk.checkAndResetDaily();

            if (this.risk.isShutdown()) return;
            if (this.walletAddress) {
                const reservesOk = await this.risk.checkReserves(this.walletAddress);
                if (!reservesOk) return;
            }
            await this.tracker.refresh();
            const ctx = { orderBook: this.tracker.getState(), ledgerIndex: this.xrpl.getLedgerIndex() };
            for (const strategy of this.strategies) {
                await strategy.tick(ctx);
            }
        } finally {
            this.tickInFlight = false;
        }
    }

    async pause(): Promise<void> {
        if (!this.started) return;
        logger.info('Trading runtime paused');
    }

    async kill(): Promise<void> {
        if (this.xrpl) {
            await this.xrpl.disconnect().catch((err) => logger.warn({ err }, 'XRPL disconnect failed'));
        }
        this.reset();
        logger.info('Trading runtime stopped');
    }

    /**
     * Graceful shutdown: cancel open offers, stop strategies, disconnect.
     * Called on SIGTERM/SIGINT for clean process exit.
     * 
     * Idempotent: calling multiple times is safe.
     * Uses LIFO (Last-In-First-Out) order for strategy teardown.
     */
    async shutdown(): Promise<void> {
        // Idempotency guard: prevent concurrent/duplicate shutdown
        if (this.shutdownInProgress) {
            logger.debug('Shutdown already in progress, skipping duplicate call');
            return;
        }
        this.shutdownInProgress = true;

        const totalSteps = 6;
        let currentStep = 0;

        const logStep = (description: string) => {
            currentStep++;
            logger.info({ step: currentStep, totalSteps }, `[Shutdown ${currentStep}/${totalSteps}] ${description}`);
        };

        logger.info('Starting graceful shutdown sequence...');

        // Step 1: Stop accepting new ticks
        logStep('Stopping tick processing');
        this.tickInFlight = true;

        // Step 2: Cancel all open offers created by the bot (best-effort)
        logStep('Cancelling open offers');
        if (this.executor && this.walletAddress && this.xrpl?.getClient()?.isConnected()) {
            try {
                await this.cancelAllOpenOffers();
            } catch (err) {
                logger.warn({ err }, 'Failed to cancel some offers during shutdown');
            }
        }

        // Step 3: Stop strategies in LIFO order (reverse of initialization)
        logStep('Stopping strategies (LIFO order)');
        for (let i = this.strategies.length - 1; i >= 0; i--) {
            const strategy = this.strategies[i];
            if (!strategy) continue;
            const strategyName = strategy.name || `Strategy[${i}]`;
            logger.debug({ strategyName, index: i }, 'Shutting down strategy');
            if ('shutdown' in strategy && typeof strategy.shutdown === 'function') {
                try {
                    await strategy.shutdown();
                    logger.debug({ strategyName }, 'Strategy shutdown complete');
                } catch (err) {
                    logger.warn({ err, strategyName }, 'Strategy shutdown error');
                }
            }
        }

        // Step 4: Close circuit breaker persistence store
        logStep('Closing persistence stores');
        try {
            await closeBreakerStore();
        } catch (err) {
            logger.warn({ err }, 'Failed to close breaker store');
        }

        // Step 5: Disconnect XRPL cleanly
        logStep('Disconnecting XRPL client');
        if (this.xrpl) {
            await this.xrpl.disconnect().catch((err) => logger.warn({ err }, 'XRPL disconnect failed during shutdown'));
        }

        // Step 6: Reset state
        logStep('Resetting runtime state');
        this.reset();

        logger.info({ totalSteps }, 'Graceful shutdown complete');
    }

    /**
     * Cancel all open offers for the bot's wallet (best-effort).
     * Used during graceful shutdown.
     */
    private async cancelAllOpenOffers(): Promise<void> {
        if (!this.walletAddress || !this.xrpl?.getClient()?.isConnected()) {
            return;
        }

        const client = this.xrpl.getClient();

        try {
            const response = await client.request({
                command: 'account_offers',
                account: this.walletAddress,
            });

            const offers = response.result?.offers ?? [];
            if (offers.length === 0) {
                logger.info('No open offers to cancel during shutdown');
                return;
            }

            logger.info({ offerCount: offers.length }, 'Cancelling open offers during shutdown');

            // Cancel each offer (with some parallelism but not too aggressive)
            const cancelPromises = offers.map((offer: any, index: number) =>
                // Stagger cancellations slightly to avoid sequence issues
                new Promise<void>((resolve) => {
                    setTimeout(async () => {
                        try {
                            await this.executor?.cancelOffer(offer.seq);
                            logger.debug({ seq: offer.seq }, 'Cancelled offer during shutdown');
                        } catch (err) {
                            logger.warn({ err, seq: offer.seq }, 'Failed to cancel offer during shutdown');
                        }
                        resolve();
                    }, index * 100); // 100ms stagger between cancellations
                })
            );

            await Promise.all(cancelPromises);
            logger.info({ cancelled: offers.length }, 'Finished cancelling offers during shutdown');
        } catch (err) {
            logger.warn({ err }, 'Failed to fetch open offers during shutdown');
        }
    }

    setPositionSize(size: number): void {
        if (!Number.isFinite(size) || size <= 0) {
            throw new Error('Position size must be positive');
        }
        this.baseConfig.strategy.positionSize = size;
        this.strategies.forEach((strategy: any) => {
            if (typeof strategy.setPositionSize === 'function') {
                strategy.setPositionSize(size);
            }
        });
        logger.info({ size }, 'Updated position size');
    }

    setTradingPair(pair: TradingPair): void {
        if (this.started) {
            throw new Error('Cannot change trading pair while bot is running. Pause/kill first.');
        }
        validateTradingPair(pair);
        const { baseCurrency, quoteCurrency, baseIssuer, quoteIssuer, issuer, description } = pair;
        if (baseCurrency.toUpperCase() === quoteCurrency.toUpperCase()) {
            throw new Error('Base and quote currency must differ');
        }
        this.baseConfig.tradingPair = {
            baseCurrency,
            quoteCurrency,
            baseIssuer: baseIssuer ?? issuer ?? '',
            quoteIssuer: quoteIssuer ?? issuer ?? '',
            issuer: issuer ?? '',
            ...(description ? { description } : {}),
        };
        this.baseConfig.tradingPairs = [this.baseConfig.tradingPair];
        logger.info({ tradingPair: this.baseConfig.tradingPair }, 'Updated trading pair');
    }

    /**
     * Cancel an offer by sequence number.
     * Routes through the executor to use proper signing.
     */
    async cancelOffer(offerSequence: number): Promise<ExecutionResult> {
        if (!this.executor) {
            throw new Error('Trading runtime not started - cannot cancel offers');
        }
        logger.info({ offerSequence }, 'Cancelling offer via runtime');
        return this.executor.cancelOffer(offerSequence);
    }

    /**
     * Get the XRPL client for read-only operations.
     * Returns null if runtime not started.
     */
    getClient(): Client | null {
        return this.xrpl?.getClient() ?? null;
    }

    /**
     * Check if runtime is started.
     */
    isStarted(): boolean {
        return this.started;
    }

    /**
     * Get the wallet address (if available).
     */
    getWalletAddress(): string | null {
        return this.walletAddress;
    }

    private reset(): void {
        this.xrpl = null;
        this.tracker = null;
        this.risk = null;
        this.executor = null;
        this.strategies = [];
        this.walletAddress = null;
        this.tickInFlight = false;
        this.started = false;
        this.shutdownInProgress = false;
    }
}
