import { Amount, Client } from 'xrpl';
import { Strategy, StrategyContext } from './types';
import { StrategyConfig, TradingPair } from '../config';
import { OfferExecutor } from '../execution/offerExecutor';
import { logger } from '../analytics/logger';
import { toXrplCurrency } from '../xrpl/currency';

/**
 * Environment-based feature flags for path arbitrage.
 */
interface PathArbConfig {
    /** Enable path arbitrage execution (default: false) */
    enabled: boolean;
    /** Log trades without executing (default: true when enabled is true) */
    dryRun: boolean;
    /** Maximum loss in basis points before tripping circuit breaker */
    circuitBreakerMaxLossBps: number;
    /** Window in milliseconds to track losses for circuit breaker */
    circuitBreakerWindowMs: number;
    /** Cooldown in milliseconds after circuit breaker trips */
    circuitBreakerCooldownMs: number;
}

function loadPathArbConfig(): PathArbConfig {
    return {
        enabled: process.env.PATH_ARB_ENABLED === 'true',
        dryRun: process.env.PATH_ARB_DRY_RUN !== 'false', // default true
        circuitBreakerMaxLossBps: Number(process.env.PATH_ARB_CIRCUIT_BREAKER_MAX_LOSS_BPS) || 500,
        circuitBreakerWindowMs: Number(process.env.PATH_ARB_CIRCUIT_BREAKER_WINDOW_MS) || 300_000, // 5 min
        circuitBreakerCooldownMs: Number(process.env.PATH_ARB_CIRCUIT_BREAKER_COOLDOWN_MS) || 600_000, // 10 min
    };
}

/**
 * Simple circuit breaker to halt trading after excessive losses.
 */
class CircuitBreaker {
    private trades: Array<{ timestamp: number; pnlBps: number }> = [];
    private trippedAt: number | null = null;

    constructor(
        private readonly maxLossBps: number,
        private readonly windowMs: number,
        private readonly cooldownMs: number
    ) { }

    /** Returns true if circuit breaker is tripped (should halt trading) */
    isTripped(): boolean {
        if (this.trippedAt !== null) {
            if (Date.now() - this.trippedAt > this.cooldownMs) {
                logger.info({}, 'Path arbitrage circuit breaker reset after cooldown');
                this.trippedAt = null;
                this.trades = [];
                return false;
            }
            return true;
        }
        return false;
    }

    /** Record a trade and check if circuit breaker should trip */
    recordTrade(pnlBps: number): boolean {
        const now = Date.now();
        this.trades.push({ timestamp: now, pnlBps });

        // Clean up old trades outside window
        const windowStart = now - this.windowMs;
        this.trades = this.trades.filter(t => t.timestamp >= windowStart);

        // Calculate total PnL in window
        const totalPnlBps = this.trades.reduce((sum, t) => sum + t.pnlBps, 0);

        if (totalPnlBps < -this.maxLossBps) {
            this.trippedAt = now;
            logger.error(
                { totalPnlBps, maxLossBps: this.maxLossBps, tradeCount: this.trades.length },
                'Path arbitrage circuit breaker TRIPPED - halting execution'
            );
            return true; // tripped
        }

        return false;
    }

    /** Get current status for monitoring */
    getStatus(): { isTripped: boolean; totalPnlBps: number; tradeCount: number; cooldownRemaining: number | null } {
        const now = Date.now();
        const windowStart = now - this.windowMs;
        const recentTrades = this.trades.filter(t => t.timestamp >= windowStart);
        const totalPnlBps = recentTrades.reduce((sum, t) => sum + t.pnlBps, 0);

        return {
            isTripped: this.isTripped(),
            totalPnlBps,
            tradeCount: recentTrades.length,
            cooldownRemaining: this.trippedAt ? Math.max(0, this.cooldownMs - (now - this.trippedAt)) : null,
        };
    }
}

export class PathArbitrageStrategy implements Strategy {
    name = 'pathfinding-arbitrage';
    private lastLedger = 0;
    private readonly pathArbConfig: PathArbConfig;
    private readonly circuitBreaker: CircuitBreaker;

    constructor(
        private readonly client: Client,
        private readonly config: StrategyConfig,
        private readonly pair: TradingPair,
        private readonly executor: OfferExecutor,
        private readonly paperTrading: boolean
    ) {
        this.pathArbConfig = loadPathArbConfig();
        this.circuitBreaker = new CircuitBreaker(
            this.pathArbConfig.circuitBreakerMaxLossBps,
            this.pathArbConfig.circuitBreakerWindowMs,
            this.pathArbConfig.circuitBreakerCooldownMs
        );

        if (!this.pathArbConfig.enabled) {
            logger.info({}, 'Path arbitrage strategy DISABLED by env (PATH_ARB_ENABLED != true)');
        } else if (this.pathArbConfig.dryRun) {
            logger.info({}, 'Path arbitrage strategy running in DRY-RUN mode (PATH_ARB_DRY_RUN != false)');
        } else {
            logger.warn({}, 'Path arbitrage strategy LIVE execution enabled');
        }
    }

    async tick(ctx: StrategyContext): Promise<void> {
        // Feature flag check
        if (!this.pathArbConfig.enabled) {
            return;
        }

        // Circuit breaker check
        if (this.circuitBreaker.isTripped()) {
            return;
        }

        if (ctx.ledgerIndex === this.lastLedger) return;
        this.lastLedger = ctx.ledgerIndex;
        if (!ctx.orderBook.bids.length || !ctx.orderBook.asks.length) return;
        if (Date.now() - ctx.orderBook.lastUpdated > 15_000) return;

        const base = toXrplCurrency({
            currency: this.pair.baseCurrency,
            issuer: this.pair.baseCurrency.toUpperCase() === 'XRP' ? undefined : (this.pair.baseIssuer ?? this.pair.issuer)
        });
        const quote = toXrplCurrency({
            currency: this.pair.quoteCurrency,
            issuer: this.pair.quoteCurrency.toUpperCase() === 'XRP' ? undefined : (this.pair.quoteIssuer ?? this.pair.issuer)
        });
        const baseIssued = base.currency === 'XRP' ? null : (base as Extract<typeof base, { issuer: string }>);
        const quoteIssued = quote.currency === 'XRP' ? null : (quote as Extract<typeof quote, { issuer: string }>);
        const issuer = quoteIssued ? quoteIssued.issuer : baseIssued ? baseIssued.issuer : null;
        if (!issuer) return;

        const destAmount = quoteIssued
            ? { currency: quoteIssued.currency, issuer: quoteIssued.issuer, value: this.config.positionSize.toString() }
            : this.config.positionSize.toString(); // XRP as string drops

        // source_currency must be full currency object for issued currencies
        const sourceCurrency = baseIssued
            ? { currency: baseIssued.currency, issuer: baseIssued.issuer }
            : { currency: 'XRP' };

        const paths: any = await this.client.request({
            command: 'ripple_path_find',
            source_currencies: [sourceCurrency],
            source_account: issuer,
            destination_account: issuer,
            destination_amount: destAmount,
        });

        if (!paths.result?.alternatives?.length) return;
        const best = paths.result.alternatives[0] as any;
        const sourceValue = this.amountToNumber(best.source_amount as Amount | string | undefined);
        const destValue = this.config.positionSize; // requested destination amount
        if (!Number.isFinite(sourceValue) || sourceValue <= 0 || destValue <= 0) return;
        const computedRate = sourceValue / destValue;
        const bestBid = ctx.orderBook.bids[0]?.price ?? 0;
        const bestAsk = ctx.orderBook.asks[0]?.price ?? 0;
        const bookMid = (bestBid + bestAsk) / 2;
        const edgeBps = ((bookMid - computedRate) / computedRate) * 10_000;
        if (edgeBps < this.config.pathArbMinProfitBps) return;

        const side: 'buy' | 'sell' = edgeBps > 0 ? 'buy' : 'sell';
        const price = side === 'buy' ? ctx.orderBook.bids[0]?.price ?? 0 : ctx.orderBook.asks[0]?.price ?? 0;
        if (!price) return;

        // Dry-run mode: log but don't execute
        if (this.pathArbConfig.dryRun) {
            logger.info(
                { side, price, edgeBps, dryRun: true, circuitBreaker: this.circuitBreaker.getStatus() },
                'Path arbitrage opportunity detected (DRY-RUN - no execution)'
            );
            // Record simulated trade for circuit breaker testing
            this.circuitBreaker.recordTrade(edgeBps);
            return;
        }

        // Paper trading mode
        if (this.paperTrading) {
            const res = await this.executor.placeOffer({
                side,
                price,
                amount: this.config.positionSize,
                flags: { immediateOrCancel: true }
            });
            if (res.accepted) {
                logger.info({ side, price, edgeBps, paperTrading: true }, 'Executed path arbitrage leg (paper)');
                // Record trade for circuit breaker
                // In paper trading, assume we got the expected edge
                this.circuitBreaker.recordTrade(edgeBps);
            }
            return;
        }

        // Live execution
        try {
            const res = await this.executor.placeOffer({
                side,
                price,
                amount: this.config.positionSize,
                flags: { immediateOrCancel: true }
            });
            if (res.accepted) {
                logger.info({ side, price, edgeBps, live: true }, 'Executed path arbitrage leg (LIVE)');
                // Record trade - use expected edge for now, ideally would use actual fill
                this.circuitBreaker.recordTrade(edgeBps);
            } else {
                logger.warn({ side, price, edgeBps }, 'Path arbitrage offer rejected');
            }
        } catch (err: any) {
            logger.error({ err: err?.message, side, price, edgeBps }, 'Path arbitrage execution error');
            // Record as loss on execution error
            this.circuitBreaker.recordTrade(-Math.abs(edgeBps));
        }
    }

    private amountToNumber(value: Amount | string | undefined): number {
        if (!value) return NaN;
        if (typeof value === 'string') return Number(value);
        return Number((value as any).value ?? NaN);
    }
}
