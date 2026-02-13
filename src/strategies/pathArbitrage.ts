import { Amount, Client } from 'xrpl';
import { Strategy, StrategyContext } from './types';
import { StrategyConfig, TradingPair, FlowConfig } from '../config';
import { OfferExecutor } from '../execution/offerExecutor';
import { RiskEngine } from '../risk/riskEngine';
import { logger } from '../analytics/logger';
import { getBreakerStore, BreakerState, BreakerStore } from '../persistence/breakerStore';
import { extractPrimaryIssuer, resolvePair } from '../market/executionPairResolver';
import { isRegimeSafeForArb, getRegimeDescription, getRegimeSizeMultiplier } from '../market/flowMetrics';

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
 * Now with persistence support.
 */
class CircuitBreaker {
    private trades: Array<{ timestamp: number; pnlBps: number }> = [];
    private trippedAt: number | null = null;
    private store: BreakerStore;
    private saveDebounceTimer: NodeJS.Timeout | null = null;
    private readonly SAVE_DEBOUNCE_MS = 1000;
    private initialized = false;

    constructor(
        private readonly maxLossBps: number,
        private readonly windowMs: number,
        private readonly cooldownMs: number,
        private readonly storeKey: string = 'path_arb'
    ) {
        this.store = getBreakerStore();
    }

    /** Initialize breaker state from persistent store */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        try {
            const state = await this.store.load(this.storeKey);
            this.trades = state.trades;
            this.trippedAt = state.trippedAt;
            this.initialized = true;
            logger.info({
                tradeCount: this.trades.length,
                trippedAt: this.trippedAt,
            }, 'Circuit breaker state loaded from persistence');
        } catch (err) {
            logger.warn({ err }, 'Failed to load circuit breaker state, starting fresh');
            this.initialized = true;
        }
    }

    /** Save breaker state (debounced to avoid excessive writes) */
    private scheduleSave(): void {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
        }
        this.saveDebounceTimer = setTimeout(() => {
            const state: BreakerState = {
                trades: this.trades,
                trippedAt: this.trippedAt,
                lastUpdated: Date.now(),
            };
            this.store.save(this.storeKey, state).catch((err) => {
                logger.warn({ err }, 'Failed to save circuit breaker state');
            });
        }, this.SAVE_DEBOUNCE_MS);
    }

    /** Returns true if circuit breaker is tripped (should halt trading) */
    isTripped(): boolean {
        if (this.trippedAt !== null) {
            if (Date.now() - this.trippedAt > this.cooldownMs) {
                logger.info({}, 'Path arbitrage circuit breaker reset after cooldown');
                this.trippedAt = null;
                this.trades = [];
                this.scheduleSave();
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
            this.scheduleSave();
            return true; // tripped
        }

        this.scheduleSave();
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
    private breakerInitialized = false;
    private flowConfig: Partial<FlowConfig>;
    private lastLoggedRegime: string | null = null;
    private readonly risk: RiskEngine;

    constructor(
        private readonly client: Client,
        private readonly config: StrategyConfig,
        private pair: TradingPair,
        private readonly executor: OfferExecutor,
        private readonly paperTrading: boolean,
        risk: RiskEngine,
        flowConfig?: Partial<FlowConfig>
    ) {
        this.risk = risk;
        this.pathArbConfig = loadPathArbConfig();
        this.circuitBreaker = new CircuitBreaker(
            this.pathArbConfig.circuitBreakerMaxLossBps,
            this.pathArbConfig.circuitBreakerWindowMs,
            this.pathArbConfig.circuitBreakerCooldownMs,
            `path_arb_${pair.baseCurrency}_${pair.quoteCurrency}` // Unique key per pair
        );
        this.flowConfig = flowConfig ?? { enableRegimeFilter: true };

        if (!this.pathArbConfig.enabled) {
            logger.info({}, 'Path arbitrage strategy DISABLED by env (PATH_ARB_ENABLED != true)');
        } else if (this.pathArbConfig.dryRun) {
            logger.info({}, 'Path arbitrage strategy running in DRY-RUN mode (PATH_ARB_DRY_RUN != false)');
        } else {
            logger.warn({}, 'Path arbitrage strategy LIVE execution enabled');
        }
    }

    setPair(pair: TradingPair): void {
        this.pair = pair;
    }

    async tick(ctx: StrategyContext): Promise<void> {
        const reject = (reasonCode: string, detail?: Record<string, unknown>) => {
            ctx.strategyFunnel?.markRejected(reasonCode, detail);
        };
        const markCandidateBuilt = () => {
            ctx.strategyFunnel?.markCandidateBuilt();
        };
        const markApproved = (side: 'buy' | 'sell', sizeBase: number, expectedPriceSource: string) => {
            ctx.strategyFunnel?.markApproved({ side, sizeBase, expectedPriceSource });
        };

        // Feature flag check
        if (!this.pathArbConfig.enabled) {
            reject('pathArbDisabled');
            return;
        }

        // Initialize circuit breaker state on first tick (async)
        if (!this.breakerInitialized) {
            await this.circuitBreaker.initialize();
            this.breakerInitialized = true;
        }

        // Circuit breaker check
        if (this.circuitBreaker.isTripped()) {
            reject('cooldown', { reason: 'circuit-breaker-tripped' });
            return;
        }

        if (ctx.ledgerIndex === this.lastLedger) {
            reject('cooldown', { reason: 'duplicate-ledger', ledgerIndex: ctx.ledgerIndex });
            return;
        }
        this.lastLedger = ctx.ledgerIndex;
        if (!ctx.orderBook.bids.length || !ctx.orderBook.asks.length) {
            reject('routeUnavailable', {
                reason: 'book-empty',
                bids: ctx.orderBook.bids.length,
                asks: ctx.orderBook.asks.length,
            });
            return;
        }

        // ─────────────────────────────────────────────────────────────────────
        // Flow Regime Filter (skip dangerous regimes)
        // ─────────────────────────────────────────────────────────────────────
        const flow = ctx.flow;
        if (flow && this.flowConfig.enableRegimeFilter !== false) {
            // Log regime changes
            if (flow.regime !== this.lastLoggedRegime) {
                logger.info({
                    regime: flow.regime,
                    description: getRegimeDescription(flow.regime),
                }, 'Path Arb: 🌊 Flow regime changed');
                this.lastLoggedRegime = flow.regime;
            }

            if (!isRegimeSafeForArb(flow.regime)) {
                logger.debug({
                    regime: flow.regime,
                    reason: getRegimeDescription(flow.regime),
                }, 'Path Arb: ⚠️ Skipping tick - regime unsafe for arbitrage');
                reject('regimeNotAllowed', { regime: flow.regime });
                return;
            }
        }

        // Use configurable staleness threshold (default: 5000ms)
        const stalenessMs = this.config.orderBookStaleMs ?? 5_000;
        const bookAge = Date.now() - ctx.orderBook.lastUpdated;
        if (bookAge > stalenessMs) {
            logger.debug({ bookAge, stalenessMs }, 'PathArb: order book stale, skipping tick');
            reject('poolStale', { reason: 'order-book-stale', bookAge, stalenessMs });
            return;
        }

        if (ctx.entryGate) {
            const decision = ctx.entryGate.shouldEnter();
            if (!decision.allowed) {
                ctx.entryGate.logDecision(this.name, decision);
                reject('healthNotOk', {
                    reason: 'entry-gate-blocked',
                    gateReasons: decision.reasons,
                });
                return;
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // Position Sizing (scale based on regime)
        // ─────────────────────────────────────────────────────────────────────
        const sizeMultiplier = flow ? getRegimeSizeMultiplier(flow) : 1.0;
        const adjustedPositionSize = this.config.positionSize * sizeMultiplier;

        if (adjustedPositionSize <= 0) {
            logger.debug({ sizeMultiplier, regime: flow?.regime }, 'Path Arb: ⚠️ Position size zero after regime adjustment');
            reject('cooldown', { reason: 'position-size-zero', sizeMultiplier, regime: flow?.regime });
            return;
        }

        // ─────────────────────────────────────────────────────────────────────
        // Resolve pair via ExecutionPairResolver (replaces legacy issuer cascade)
        // ─────────────────────────────────────────────────────────────────────
        const resolved = resolvePair(this.pair, { failOnUnresolvable: false });
        if (!resolved.executable) {
            logger.debug({ blockReason: resolved.blockReason }, 'Path Arb: pair not executable');
            reject('routeUnavailable', { reason: resolved.blockReason ?? 'pair-not-executable' });
            return;
        }

        // ─────────────────────────────────────────────────────────────────────
        // Risk Engine Approval
        // ─────────────────────────────────────────────────────────────────────
        const riskIssuer = extractPrimaryIssuer(resolved);
        if (riskIssuer) {
            const riskIntent = {
                issuer: riskIssuer,
                size: adjustedPositionSize,
                potentialLoss: adjustedPositionSize * (this.config.stopLossBps / 10_000)
            };
            if (this.risk.approveIntent(riskIntent, this.pair) === false) {
                logger.info({
                    positionSize: adjustedPositionSize.toFixed(4),
                    potentialLoss: riskIntent.potentialLoss.toFixed(4)
                }, 'Path Arb: ❌ Risk engine rejected trade intent');
                reject('healthNotOk', {
                    reason: 'risk-intent-rejected',
                    positionSize: adjustedPositionSize,
                });
                return;
            }
        }

        const base = resolved.base.xrplCurrencyObj;
        const quote = resolved.quote.xrplCurrencyObj;
        const baseIssued = base.currency === 'XRP' ? null : (base as Extract<typeof base, { issuer: string }>);
        const quoteIssued = quote.currency === 'XRP' ? null : (quote as Extract<typeof quote, { issuer: string }>);
        const issuer = extractPrimaryIssuer(resolved);
        if (!issuer) {
            reject('routeUnavailable', { reason: 'issuer-unavailable' });
            return;
        }

        const destAmount = quoteIssued
            ? { currency: quoteIssued.currency, issuer: quoteIssued.issuer, value: adjustedPositionSize.toString() }
            : adjustedPositionSize.toString(); // XRP as string drops

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

        if (!paths.result?.alternatives?.length) {
            reject('routeUnavailable', { reason: 'no-path-alternatives' });
            return;
        }
        const best = paths.result.alternatives[0] as any;
        const sourceValue = this.amountToNumber(best.source_amount as Amount | string | undefined);
        const destValue = adjustedPositionSize; // requested destination amount
        if (!Number.isFinite(sourceValue) || sourceValue <= 0 || destValue <= 0) {
            reject('routeUnavailable', { reason: 'invalid-path-amounts', sourceValue, destValue });
            return;
        }
        const computedRate = sourceValue / destValue;
        const bestBid = ctx.orderBook.bids[0]?.price ?? 0;
        const bestAsk = ctx.orderBook.asks[0]?.price ?? 0;
        const bookMid = (bestBid + bestAsk) / 2;
        const edgeBps = ((bookMid - computedRate) / computedRate) * 10_000;
        if (edgeBps < this.config.pathArbMinProfitBps) {
            reject('minProfitBps', {
                edgeBps,
                minProfitBps: this.config.pathArbMinProfitBps,
            });
            return;
        }

        const side: 'buy' | 'sell' = edgeBps > 0 ? 'buy' : 'sell';
        const price = side === 'buy' ? ctx.orderBook.bids[0]?.price ?? 0 : ctx.orderBook.asks[0]?.price ?? 0;
        if (!price) {
            reject('routeUnavailable', { reason: 'missing-side-price', side });
            return;
        }

        markCandidateBuilt();

        // Dry-run mode: log but don't execute
        if (this.pathArbConfig.dryRun) {
            logger.info(
                {
                    side,
                    price: price.toFixed(6),
                    edgeBps: edgeBps.toFixed(2),
                    positionSize: adjustedPositionSize.toFixed(4),
                    sizeMultiplier: sizeMultiplier.toFixed(2),
                    regime: flow?.regime ?? 'unknown',
                    dryRun: true,
                    circuitBreaker: this.circuitBreaker.getStatus()
                },
                'Path Arb: 🎯 Opportunity detected (DRY-RUN - no execution)'
            );
            // Record simulated trade for circuit breaker testing
            this.circuitBreaker.recordTrade(edgeBps);
            reject('cooldown', { reason: 'dry-run-mode', edgeBps });
            return;
        }

        // Paper trading mode
        if (this.paperTrading) {
            markApproved(side, adjustedPositionSize, side === 'buy' ? 'bestBid' : 'bestAsk');
            const res = await this.executor.placeOffer({
                side,
                price,
                amount: adjustedPositionSize,
                strategy: this.name,
                flags: { immediateOrCancel: true }
            });
            if (res.accepted) {
                logger.info({
                    side,
                    price: price.toFixed(6),
                    edgeBps: edgeBps.toFixed(2),
                    positionSize: adjustedPositionSize.toFixed(4),
                    regime: flow?.regime ?? 'unknown',
                    paperTrading: true
                }, 'Path Arb: ✅ Executed path arbitrage leg (paper)');
                // Record trade for circuit breaker
                // In paper trading, assume we got the expected edge
                this.circuitBreaker.recordTrade(edgeBps);
            }
            return;
        }

        // Live execution
        try {
            markApproved(side, adjustedPositionSize, side === 'buy' ? 'bestBid' : 'bestAsk');
            const res = await this.executor.placeOffer({
                side,
                price,
                amount: adjustedPositionSize,
                strategy: this.name,
                flags: { immediateOrCancel: true }
            });
            if (res.accepted) {
                logger.info({
                    side,
                    price: price.toFixed(6),
                    edgeBps: edgeBps.toFixed(2),
                    positionSize: adjustedPositionSize.toFixed(4),
                    regime: flow?.regime ?? 'unknown',
                    live: true
                }, 'Path Arb: ✅ Executed path arbitrage leg (LIVE)');
                // Record trade - use expected edge for now, ideally would use actual fill
                this.circuitBreaker.recordTrade(edgeBps);
            } else {
                logger.warn({ side, price: price.toFixed(6), edgeBps: edgeBps.toFixed(2) }, 'Path Arb: ❌ Offer rejected');
                reject('unknown', { reason: 'offer-rejected', edgeBps, side });
            }
        } catch (err: any) {
            logger.error({ err: err?.message, side, price: price.toFixed(6), edgeBps: edgeBps.toFixed(2) }, 'Path Arb: ❌ Execution error');
            // Record as loss on execution error
            this.circuitBreaker.recordTrade(-Math.abs(edgeBps));
            reject('unknown', { reason: err?.message ?? 'execution-error', edgeBps, side });
        }
    }

    private amountToNumber(value: Amount | string | undefined): number {
        if (!value) return NaN;
        if (typeof value === 'string') return Number(value);
        return Number((value as any).value ?? NaN);
    }
}
