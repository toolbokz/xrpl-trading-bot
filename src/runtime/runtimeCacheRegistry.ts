/**
 * Runtime Cache Registry — Pair-Keyed Truth Owner
 *
 * Centralizes all market-data snapshots that API routes consume.
 * Every cache entry is keyed by { pairKey, feedType, sequence }.
 *
 * Rules:
 *   1. API routes MUST read from here — never recompute independently.
 *   2. update() is called once per tick from TradingRuntime.
 *   3. reset() is called on every pair switch to prevent cross-pair leakage.
 *   4. Consumers get a frozen snapshot via getSnapshot().
 */

import { FlowMetrics, FlowRegime } from '../market/flowMetrics';
import { MarketHealthResult } from '../market/marketDataHealth';
import { ExecutionGateResult } from '../execution/executionGate';
import { OrderBookSnapshot, NormalizedTrade } from '../market/models';
import { Trade } from '../market/tradeTape';
import { RuntimeState } from './runtimeFsm';
import type { LiquiditySnapshot as LiquidityIntelligenceSnapshot } from '../market/liquidityIntelligence';
import type { SpreadDistributionSnapshot } from '../analytics/spreadDistribution';
import type { BackgroundScannerSnapshot } from '../market/backgroundScanner/types';
import type { StrategyDecisionFunnelMap } from '../observability/strategyDecisionFunnel';
import type { VolatilityStopResolution } from '../market/volatilityEstimator';

// ─────────────────────────────────────────────────────────────────────────────
// Feed types (used as cache partition keys)
// ─────────────────────────────────────────────────────────────────────────────

export type FeedType =
    | 'health'
    | 'flow'
    | 'tape'
    | 'orderbook'
    | 'balance'
    | 'execution-quality'
    | 'spread-regime'
    | 'liquidity';

// ─────────────────────────────────────────────────────────────────────────────
// Per-feed snapshot types
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthSnapshot {
    health: MarketHealthResult;
    gate: ExecutionGateResult | null;
}

export interface FlowSnapshot {
    metrics: FlowMetrics;
}

export interface TapeSnapshot {
    trades: Trade[];
    tradeCount: number;
    lastTradeAtMs: number | null;
}

export interface OrderBookCacheSnapshot {
    snapshot: OrderBookSnapshot;
    lastTrade: NormalizedTrade | null;
}

export interface BalanceSnapshot {
    xrpBalance: number;
    quoteBalance: number;
    quoteCurrency: string;
    ledgerIndex: number;
}

export interface ExecutionQualitySnapshot {
    /** Number of ticks where gate returned ALLOW in this session. */
    allowedTicks: number;
    /** Number of ticks where gate returned BLOCK in this session. */
    blockedTicks: number;
    /** Current gate verdict. */
    currentVerdict: 'ALLOW' | 'BLOCK' | null;
    /** Most recent block reasons. */
    lastBlockReasons: string[];
    /** Current market health score (0-100). */
    healthScore: number;
    /** Current flow regime. */
    regime: FlowRegime | null;
    /** Spread in basis points. */
    spreadBps: number;
}

export interface SpreadRegimeSnapshot {
    regime: FlowRegime;
    spreadBps: number;
    midPrice: number;
    bestBid: number;
    bestAsk: number;
}

export interface LiquidityCacheSnapshot {
    snapshot: LiquidityIntelligenceSnapshot;
}

export interface VolatilityStopCacheSnapshot extends VolatilityStopResolution {
    enabled: boolean;
    volBps: number;
    volReady: boolean;
    sampleCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified cache entry
// ─────────────────────────────────────────────────────────────────────────────

export interface CacheEntry<T> {
    pairKey: string;
    feedType: FeedType;
    sequence: number;
    asOfMs: number;
    data: T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full snapshot exposed to API layer
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeCacheSnapshot {
    pairKey: string;
    asOfMs: number;
    sequence: number;
    runtimeState: RuntimeState | null;
    executionAllowed: boolean;
    health: CacheEntry<HealthSnapshot> | null;
    flow: CacheEntry<FlowSnapshot> | null;
    tape: CacheEntry<TapeSnapshot> | null;
    orderbook: CacheEntry<OrderBookCacheSnapshot> | null;
    balance: CacheEntry<BalanceSnapshot> | null;
    executionQuality: CacheEntry<ExecutionQualitySnapshot> | null;
    spreadRegime: CacheEntry<SpreadRegimeSnapshot> | null;
    liquidity: CacheEntry<LiquidityCacheSnapshot> | null;
    volatilityStop: VolatilityStopCacheSnapshot | null;
    spreadDistribution?: SpreadDistributionSnapshot | null;
    background?: BackgroundScannerSnapshot | null;
    strategyFunnel?: StrategyDecisionFunnelMap | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update input (what TradingRuntime feeds in per tick)
// ─────────────────────────────────────────────────────────────────────────────

export interface CacheUpdateInput {
    pairKey: string;
    sequence: number;
    runtimeState: RuntimeState;
    health: MarketHealthResult | null;
    gate: ExecutionGateResult | null;
    flow: FlowMetrics | null;
    tape: { trades: Trade[]; tradeCount: number; lastTradeAtMs: number | null } | null;
    orderbook: OrderBookSnapshot | null;
    lastTrade: NormalizedTrade | null;
    liquidity: LiquidityIntelligenceSnapshot | null;
    volatilityStop?: VolatilityStopCacheSnapshot | null;
    spreadDistribution?: SpreadDistributionSnapshot | null;
    strategyFunnel?: StrategyDecisionFunnelMap | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export class RuntimeCacheRegistry {
    private pairKey = '';
    private sequence = 0;
    private asOfMs = 0;
    private runtimeState: RuntimeState | null = null;
    private executionAllowed = false;

    private health: CacheEntry<HealthSnapshot> | null = null;
    private flow: CacheEntry<FlowSnapshot> | null = null;
    private tape: CacheEntry<TapeSnapshot> | null = null;
    private orderbook: CacheEntry<OrderBookCacheSnapshot> | null = null;
    private balance: CacheEntry<BalanceSnapshot> | null = null;
    private executionQuality: CacheEntry<ExecutionQualitySnapshot> | null = null;
    private spreadRegime: CacheEntry<SpreadRegimeSnapshot> | null = null;
    private liquidity: CacheEntry<LiquidityCacheSnapshot> | null = null;
    private volatilityStop: VolatilityStopCacheSnapshot | null = null;
    private spreadDistribution: SpreadDistributionSnapshot | null = null;
    private background: BackgroundScannerSnapshot | null = null;
    private strategyFunnel: StrategyDecisionFunnelMap | null = null;

    // Execution quality counters (accumulated across ticks, reset on pair switch)
    private allowedTicks = 0;
    private blockedTicks = 0;

    // ─── Public API ──────────────────────────────────────────────────────

    /**
     * Update all caches from the latest tick data.
     * Called once per tick from TradingRuntime.
     */
    update(input: CacheUpdateInput): void {
        const now = Date.now();
        this.pairKey = input.pairKey;
        this.sequence = input.sequence;
        this.asOfMs = now;
        this.runtimeState = input.runtimeState;
        this.executionAllowed = input.gate?.verdict === 'ALLOW';

        // Track execution quality counters
        if (input.gate) {
            if (input.gate.verdict === 'ALLOW') {
                this.allowedTicks++;
            } else {
                this.blockedTicks++;
            }
        }

        // Health
        if (input.health) {
            this.health = this.entry('health', {
                health: input.health,
                gate: input.gate,
            });
        }

        // Flow
        if (input.flow) {
            this.flow = this.entry('flow', { metrics: input.flow });
        }

        // Tape
        if (input.tape) {
            this.tape = this.entry('tape', input.tape);
        }

        // Order book
        if (input.orderbook) {
            this.orderbook = this.entry('orderbook', {
                snapshot: input.orderbook,
                lastTrade: input.lastTrade,
            });
        }

        // Execution quality (always update when gate is available)
        if (input.gate) {
            this.executionQuality = this.entry('execution-quality', {
                allowedTicks: this.allowedTicks,
                blockedTicks: this.blockedTicks,
                currentVerdict: input.gate.verdict,
                lastBlockReasons: input.gate.verdict === 'BLOCK' ? input.gate.reasons : [],
                healthScore: input.gate.healthScore,
                regime: input.flow?.regime ?? null,
                spreadBps: input.flow?.spreadBps ?? input.orderbook?.spreadBps ?? 0,
            });
        }

        // Spread regime
        if (input.flow) {
            this.spreadRegime = this.entry('spread-regime', {
                regime: input.flow.regime,
                spreadBps: input.flow.spreadBps,
                midPrice: input.flow.midPrice,
                bestBid: input.flow.bestBid,
                bestAsk: input.flow.bestAsk,
            });
        }

        // Liquidity intelligence
        if (input.liquidity) {
            this.liquidity = this.entry('liquidity', {
                snapshot: input.liquidity,
            });
        }

        this.volatilityStop = input.volatilityStop ?? null;

        // Spread distribution (optional, observability-only)
        if (input.spreadDistribution) {
            this.spreadDistribution = input.spreadDistribution;
        }

        if (input.strategyFunnel) {
            this.strategyFunnel = cloneStrategyFunnel(input.strategyFunnel);
        }
    }

    /**
     * Update the balance cache.
     * Called separately from tick because balance fetches are async/less frequent.
     */
    updateBalance(pairKey: string, data: BalanceSnapshot): void {
        if (pairKey !== this.pairKey) return; // reject cross-pair updates
        this.balance = this.entry('balance', data);
    }

    /**
     * Update background scanner cache.
     * Called from background scanner callbacks (outside tick loop).
     */
    updateBackground(pairKey: string, data: BackgroundScannerSnapshot): void {
        if (this.pairKey && pairKey !== this.pairKey) return; // reject cross-pair updates
        if (!this.pairKey) {
            // Allow pre-tick scanner writes for the active pair.
            this.pairKey = pairKey;
            this.asOfMs = Date.now();
        }
        this.background = data;
    }

    /**
     * Update strategy funnel counters (observability-only).
     */
    updateStrategyFunnel(pairKey: string, data: StrategyDecisionFunnelMap): void {
        if (this.pairKey && pairKey !== this.pairKey) return; // reject cross-pair updates
        if (!this.pairKey) {
            this.pairKey = pairKey;
        }
        this.asOfMs = Date.now();
        this.strategyFunnel = cloneStrategyFunnel(data);
    }

    /**
     * Reset all caches.
     * MUST be called on every pair switch to prevent cross-pair contamination.
     */
    reset(): void {
        this.pairKey = '';
        this.sequence = 0;
        this.asOfMs = 0;
        this.runtimeState = null;
        this.executionAllowed = false;
        this.health = null;
        this.flow = null;
        this.tape = null;
        this.orderbook = null;
        this.balance = null;
        this.executionQuality = null;
        this.spreadRegime = null;
        this.liquidity = null;
        this.volatilityStop = null;
        this.spreadDistribution = null;
        this.background = null;
        this.strategyFunnel = null;
        this.allowedTicks = 0;
        this.blockedTicks = 0;
    }

    /**
     * Get a full frozen snapshot of all caches.
     * API routes call this — never access individual fields directly.
     */
    getSnapshot(): RuntimeCacheSnapshot {
        return {
            pairKey: this.pairKey,
            asOfMs: this.asOfMs,
            sequence: this.sequence,
            runtimeState: this.runtimeState,
            executionAllowed: this.executionAllowed,
            health: this.health,
            flow: this.flow,
            tape: this.tape,
            orderbook: this.orderbook,
            balance: this.balance,
            executionQuality: this.executionQuality,
            spreadRegime: this.spreadRegime,
            liquidity: this.liquidity,
            volatilityStop: this.volatilityStop,
            spreadDistribution: this.spreadDistribution,
            background: this.background,
            strategyFunnel: this.strategyFunnel,
        };
    }

    /**
     * Get a single feed entry (for targeted endpoint access).
     */
    getFeed<K extends FeedType>(
        feedType: K,
    ): CacheEntry<
        K extends 'health' ? HealthSnapshot :
        K extends 'flow' ? FlowSnapshot :
        K extends 'tape' ? TapeSnapshot :
        K extends 'orderbook' ? OrderBookCacheSnapshot :
        K extends 'balance' ? BalanceSnapshot :
        K extends 'execution-quality' ? ExecutionQualitySnapshot :
        K extends 'spread-regime' ? SpreadRegimeSnapshot :
        K extends 'liquidity' ? LiquidityCacheSnapshot :
        never
    > | null {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const map: Record<FeedType, CacheEntry<any> | null> = {
            health: this.health,
            flow: this.flow,
            tape: this.tape,
            orderbook: this.orderbook,
            balance: this.balance,
            'execution-quality': this.executionQuality,
            'spread-regime': this.spreadRegime,
            liquidity: this.liquidity,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return map[feedType] as any;
    }

    /**
     * Convenience: get the current pair key.
     */
    getPairKey(): string {
        return this.pairKey;
    }

    /**
     * Convenience: check if execution is currently allowed.
     */
    isExecutionAllowed(): boolean {
        return this.executionAllowed;
    }

    /**
     * Convenience: get the current runtime state.
     */
    getRuntimeState(): RuntimeState | null {
        return this.runtimeState;
    }

    // ─── Internal ────────────────────────────────────────────────────────

    private entry<T>(feedType: FeedType, data: T): CacheEntry<T> {
        return {
            pairKey: this.pairKey,
            feedType,
            sequence: this.sequence,
            asOfMs: Date.now(),
            data,
        };
    }
}

function cloneStrategyFunnel(data: StrategyDecisionFunnelMap): StrategyDecisionFunnelMap {
    const out: StrategyDecisionFunnelMap = {};
    for (const [strategy, funnel] of Object.entries(data)) {
        out[strategy] = {
            ...funnel,
            rejectedByReason: { ...funnel.rejectedByReason },
        };
    }
    return out;
}
