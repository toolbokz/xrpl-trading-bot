import { Wallet, isValidClassicAddress } from 'xrpl';
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

const cloneConfig = (cfg: AppConfig): AppConfig => ({
    xrpl: { ...cfg.xrpl },
    tradingPair: { ...cfg.tradingPair },
    tradingPairs: cfg.tradingPairs ? cfg.tradingPairs.map((p) => ({ ...p })) : undefined,
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
    private strategies: Strategy[] = [];
    private walletAddress: string | null = null;
    private tickInFlight = false;
    private started = false;
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
            baseIssuer: baseIssuer || issuer || '',
            quoteIssuer: quoteIssuer || issuer || '',
            issuer: issuer || '',
            description,
        };
        this.baseConfig.tradingPairs = [this.baseConfig.tradingPair];
        logger.info({ tradingPair: this.baseConfig.tradingPair }, 'Updated trading pair');
    }

    private reset(): void {
        this.xrpl = null;
        this.tracker = null;
        this.risk = null;
        this.strategies = [];
        this.walletAddress = null;
        this.tickInFlight = false;
        this.started = false;
    }
}
