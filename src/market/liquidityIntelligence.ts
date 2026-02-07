/**
 * Liquidity Intelligence — Dynamic Liquidity Scoring
 *
 * Replaces the static `Instrument.liquidity` field ('high'/'medium'/'low')
 * with a real-time, evidence-based liquidity score computed from:
 *
 *   1. Depth profile — notional depth within 1% and 2% of BBO
 *   2. Spread statistics — rolling percentiles (P50/P95)
 *   3. Trade flow — volume velocity, trade frequency
 *   4. Market impact estimate — expected cost to execute a given size
 *
 * The score (0–100) maps to a LiquidityGrade:
 *   A (80–100) — Institutional-grade depth + tight spread
 *   B (60–79)  — Healthy retail liquidity
 *   C (40–59)  — Thin but tradeable
 *   D (20–39)  — Illiquid, wide spreads
 *   F (0–19)   — Untradeable
 *
 * Usage:
 *   const engine = new LiquidityIntelligence();
 *   engine.ingestTick({ bids, asks, spread, lastUpdated }, trades, nowMs);
 *   const snapshot = engine.getSnapshot();
 *   //  → { score: 72, grade: 'B', depth: ..., spread: ..., ... }
 *
 * @module market/liquidityIntelligence
 */

import { OrderBookState, BookOffer } from '../utils/types';
import { Trade } from './tradeTape';
import { LiquidityLevel } from './instrumentRegistry/schema';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Letter grade derived from the composite liquidity score. */
export type LiquidityGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/** Depth profile at a single snapshot in time. */
export interface DepthProfile {
    /** Notional value of bids within 1% of best bid (quote currency). */
    bidNotional1Pct: number;
    /** Notional value of asks within 1% of best ask (quote currency). */
    askNotional1Pct: number;
    /** Combined notional within 1% of BBO. */
    totalNotional1Pct: number;
    /** Combined notional within 2% of BBO. */
    totalNotional2Pct: number;
    /** Number of non-zero bid levels. */
    bidLevelCount: number;
    /** Number of non-zero ask levels. */
    askLevelCount: number;
    /** Depth imbalance: (bidNotional - askNotional) / (bidNotional + askNotional). */
    imbalance: number;
}

/** Rolling spread statistics. */
export interface SpreadStats {
    /** Current spread in basis points. */
    currentBps: number;
    /** Median spread (P50) over the rolling window. */
    p50Bps: number;
    /** 95th percentile spread over the rolling window. */
    p95Bps: number;
    /** Number of samples in the window. */
    sampleCount: number;
}

/** Trade flow statistics within the analysis window. */
export interface TradeFlowStats {
    /** Trades per minute within the window. */
    tradesPerMinute: number;
    /** Total volume in base currency. */
    volumeBase: number;
    /** Total volume in quote currency. */
    volumeQuote: number;
    /** Buy volume fraction (0–1). */
    buyRatio: number;
    /** Number of trades in window. */
    tradeCount: number;
}

/** Estimated market impact for a hypothetical order. */
export interface ImpactEstimate {
    /** Reference size in base currency. */
    sizeBase: number;
    /** Estimated slippage in basis points for a buy. */
    buySlippageBps: number;
    /** Estimated slippage in basis points for a sell. */
    sellSlippageBps: number;
    /** Average of buy + sell slippage. */
    avgSlippageBps: number;
}

/** Full liquidity intelligence snapshot. */
export interface LiquiditySnapshot {
    /** Composite score (0–100). */
    score: number;
    /** Letter grade. */
    grade: LiquidityGrade;
    /** Mapped to registry LiquidityLevel. */
    level: LiquidityLevel;
    /** Depth profile from latest tick. */
    depth: DepthProfile;
    /** Rolling spread statistics. */
    spread: SpreadStats;
    /** Trade flow statistics. */
    flow: TradeFlowStats;
    /** Market impact estimates at reference sizes. */
    impact: ImpactEstimate[];
    /** Timestamp of the snapshot. */
    computedAtMs: number;
    /** Number of ticks ingested. */
    tickCount: number;
}

/** Configuration for the liquidity engine. */
export interface LiquidityIntelligenceConfig {
    /** Rolling window size for spread samples (default: 120 = ~2 min at 1s ticks). */
    spreadWindowSize: number;
    /** Trade flow analysis window in ms (default: 60_000). */
    tradeFlowWindowMs: number;
    /** Reference sizes for impact estimation (in base currency). */
    impactReferenceSizes: number[];
    /** Weight for depth component in composite score (default: 0.35). */
    weightDepth: number;
    /** Weight for spread component in composite score (default: 0.30). */
    weightSpread: number;
    /** Weight for flow component in composite score (default: 0.20). */
    weightFlow: number;
    /** Weight for impact component in composite score (default: 0.15). */
    weightImpact: number;
}

const DEFAULT_CONFIG: LiquidityIntelligenceConfig = {
    spreadWindowSize: 120,
    tradeFlowWindowMs: 60_000,
    impactReferenceSizes: [10, 100, 1000],
    weightDepth: 0.35,
    weightSpread: 0.30,
    weightFlow: 0.20,
    weightImpact: 0.15,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, v));

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)]!;
}

/** Map composite score to letter grade. */
export function scoreToGrade(score: number): LiquidityGrade {
    if (score >= 80) return 'A';
    if (score >= 60) return 'B';
    if (score >= 40) return 'C';
    if (score >= 20) return 'D';
    return 'F';
}

/** Map composite score to registry LiquidityLevel for backward compat. */
export function scoreToLevel(score: number): LiquidityLevel {
    if (score >= 60) return 'high';
    if (score >= 30) return 'medium';
    if (score > 0) return 'low';
    return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Component Scoring Functions (pure, testable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score depth quality (0–100).
 *
 * Thresholds (quote-denominated notional within 1% of BBO):
 *   ≥ 100K → 100   (deep institutional book)
 *   ≥  50K →  90
 *   ≥  10K →  70
 *   ≥   2K →  50
 *   ≥   500 →  30
 *   <   500 →  10
 *
 * Adjusted down by up to 20 points for severe depth imbalance (>0.7).
 */
export function scoreDepth(profile: DepthProfile): number {
    const notional = profile.totalNotional1Pct;
    let score: number;
    if (notional >= 100_000) score = 100;
    else if (notional >= 50_000) score = 90;
    else if (notional >= 10_000) score = 70;
    else if (notional >= 2_000) score = 50;
    else if (notional >= 500) score = 30;
    else score = 10;

    // Imbalance penalty: severe one-sidedness makes depth unreliable
    const absImbalance = Math.abs(profile.imbalance);
    if (absImbalance > 0.7) {
        score -= 20;
    } else if (absImbalance > 0.5) {
        score -= 10;
    }

    // Level count penalty: fewer than 3 levels on either side
    if (profile.bidLevelCount < 3 || profile.askLevelCount < 3) {
        score -= 15;
    }

    return clamp(score, 0, 100);
}

/**
 * Score spread quality (0–100).
 *
 * Uses P50 (median) spread from the rolling window:
 *   ≤   5 bps → 100   (institutional)
 *   ≤  15 bps →  85
 *   ≤  30 bps →  70
 *   ≤  50 bps →  55
 *   ≤ 100 bps →  35
 *   > 100 bps →  10
 *
 * Additional penalty if P95 is more than 3× P50 (spread instability).
 */
export function scoreSpread(stats: SpreadStats): number {
    const p50 = stats.p50Bps;
    let score: number;
    if (p50 <= 5) score = 100;
    else if (p50 <= 15) score = 85;
    else if (p50 <= 30) score = 70;
    else if (p50 <= 50) score = 55;
    else if (p50 <= 100) score = 35;
    else score = 10;

    // Instability penalty: P95 much wider than P50
    if (stats.sampleCount >= 5 && stats.p95Bps > 0 && p50 > 0) {
        const ratio = stats.p95Bps / p50;
        if (ratio > 5) score -= 20;
        else if (ratio > 3) score -= 10;
    }

    return clamp(score, 0, 100);
}

/**
 * Score trade flow quality (0–100).
 *
 * Based on trades-per-minute and total volume:
 *   ≥ 10 tpm → 100
 *   ≥  5 tpm →  80
 *   ≥  2 tpm →  60
 *   ≥  0.5 tpm →  40
 *   > 0      →  20
 *   0        →   5
 */
export function scoreFlow(stats: TradeFlowStats): number {
    const tpm = stats.tradesPerMinute;
    let score: number;
    if (tpm >= 10) score = 100;
    else if (tpm >= 5) score = 80;
    else if (tpm >= 2) score = 60;
    else if (tpm >= 0.5) score = 40;
    else if (tpm > 0) score = 20;
    else score = 5;

    return clamp(score, 0, 100);
}

/**
 * Score market impact quality (0–100).
 *
 * Uses the average slippage at the middle reference size:
 *   ≤   5 bps → 100
 *   ≤  15 bps →  80
 *   ≤  30 bps →  60
 *   ≤  50 bps →  40
 *   ≤ 100 bps →  20
 *   > 100 bps →   5
 */
export function scoreImpact(estimates: ImpactEstimate[]): number {
    if (estimates.length === 0) return 50; // no data — neutral

    // Use the middle reference size (or first if only one)
    const midIdx = Math.floor(estimates.length / 2);
    const midEstimate = estimates[midIdx]!;
    const avg = midEstimate.avgSlippageBps;

    let score: number;
    if (avg <= 5) score = 100;
    else if (avg <= 15) score = 80;
    else if (avg <= 30) score = 60;
    else if (avg <= 50) score = 40;
    else if (avg <= 100) score = 20;
    else score = 5;

    return clamp(score, 0, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Depth Profiling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a depth profile from raw order book state.
 */
export function buildDepthProfile(
    bids: readonly BookOffer[],
    asks: readonly BookOffer[],
): DepthProfile {
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;

    if (bestBid <= 0 || bestAsk <= 0) {
        return {
            bidNotional1Pct: 0,
            askNotional1Pct: 0,
            totalNotional1Pct: 0,
            totalNotional2Pct: 0,
            bidLevelCount: bids.length,
            askLevelCount: asks.length,
            imbalance: 0,
        };
    }

    const bidFloor1 = bestBid * 0.99;
    const askCeiling1 = bestAsk * 1.01;
    const bidFloor2 = bestBid * 0.98;
    const askCeiling2 = bestAsk * 1.02;

    let bidNotional1 = 0;
    let askNotional1 = 0;
    let totalNotional2 = 0;

    for (const b of bids) {
        const notional = b.price * b.quantity;
        if (b.price >= bidFloor2) totalNotional2 += notional;
        if (b.price >= bidFloor1) bidNotional1 += notional;
    }

    for (const a of asks) {
        const notional = a.price * a.quantity;
        if (a.price <= askCeiling2) totalNotional2 += notional;
        if (a.price <= askCeiling1) askNotional1 += notional;
    }

    const totalNotional1 = bidNotional1 + askNotional1;
    const imbalance =
        totalNotional1 > 0
            ? (bidNotional1 - askNotional1) / totalNotional1
            : 0;

    return {
        bidNotional1Pct: Math.round(bidNotional1 * 100) / 100,
        askNotional1Pct: Math.round(askNotional1 * 100) / 100,
        totalNotional1Pct: Math.round(totalNotional1 * 100) / 100,
        totalNotional2Pct: Math.round(totalNotional2 * 100) / 100,
        bidLevelCount: bids.length,
        askLevelCount: asks.length,
        imbalance: Math.round(imbalance * 10_000) / 10_000,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Market Impact Estimation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate slippage for a hypothetical market order of a given size.
 *
 * Walks the order book levels to compute the volume-weighted fill price,
 * then expresses the deviation from BBO in basis points.
 */
export function estimateImpact(
    sizeBase: number,
    levels: readonly BookOffer[],
    bboPrice: number,
): number {
    if (sizeBase <= 0 || levels.length === 0 || bboPrice <= 0) return 0;

    let remaining = sizeBase;
    let totalCost = 0;

    for (const level of levels) {
        if (remaining <= 0) break;
        const fill = Math.min(remaining, level.quantity);
        totalCost += fill * level.price;
        remaining -= fill;
    }

    // If book doesn't have enough depth, penalize heavily
    if (remaining > 0) {
        // Assume remaining fills at 5% worse than last level
        const lastPrice = levels[levels.length - 1]?.price ?? bboPrice;
        const penaltyPrice = lastPrice * 1.05;
        totalCost += remaining * penaltyPrice;
    }

    const filledSize = sizeBase;
    const avgFillPrice = totalCost / filledSize;
    const slippageBps = Math.abs((avgFillPrice - bboPrice) / bboPrice) * 10_000;

    return Math.round(slippageBps * 100) / 100;
}

/**
 * Compute impact estimates for multiple reference sizes.
 */
export function computeImpactEstimates(
    bids: readonly BookOffer[],
    asks: readonly BookOffer[],
    referenceSizes: readonly number[],
): ImpactEstimate[] {
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;

    return referenceSizes.map((size) => {
        const buySlippage = estimateImpact(size, asks, bestAsk);
        const sellSlippage = estimateImpact(size, bids, bestBid);
        return {
            sizeBase: size,
            buySlippageBps: buySlippage,
            sellSlippageBps: sellSlippage,
            avgSlippageBps: Math.round(((buySlippage + sellSlippage) / 2) * 100) / 100,
        };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade Flow Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute trade flow statistics from recent trades.
 */
export function computeTradeFlowStats(
    trades: readonly Trade[],
    windowMs: number,
    nowMs: number,
): TradeFlowStats {
    const cutoff = nowMs - windowMs;
    const recent = trades.filter((t) => t.ts >= cutoff);

    if (recent.length === 0) {
        return {
            tradesPerMinute: 0,
            volumeBase: 0,
            volumeQuote: 0,
            buyRatio: 0.5,
            tradeCount: 0,
        };
    }

    let volumeBase = 0;
    let volumeQuote = 0;
    let buyCount = 0;

    for (const t of recent) {
        volumeBase += t.sizeBase;
        volumeQuote += t.sizeQuote;
        if (t.side === 'buy') buyCount++;
    }

    const windowMinutes = windowMs / 60_000;
    const tpm = recent.length / Math.max(windowMinutes, 1 / 60);

    return {
        tradesPerMinute: Math.round(tpm * 100) / 100,
        volumeBase: Math.round(volumeBase * 1_000_000) / 1_000_000,
        volumeQuote: Math.round(volumeQuote * 100) / 100,
        buyRatio: recent.length > 0
            ? Math.round((buyCount / recent.length) * 100) / 100
            : 0.5,
        tradeCount: recent.length,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite Score
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the composite liquidity score from component scores.
 */
export function computeCompositeScore(
    depthScore: number,
    spreadScore: number,
    flowScore: number,
    impactScore: number,
    config: LiquidityIntelligenceConfig = DEFAULT_CONFIG,
): number {
    const raw =
        depthScore * config.weightDepth +
        spreadScore * config.weightSpread +
        flowScore * config.weightFlow +
        impactScore * config.weightImpact;
    return clamp(Math.round(raw), 0, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stateful liquidity intelligence engine.
 *
 * Call `ingestTick()` on each order book refresh.
 * Call `getSnapshot()` to retrieve the latest liquidity assessment.
 */
export class LiquidityIntelligence {
    private readonly config: LiquidityIntelligenceConfig;

    /** Rolling spread samples (ring buffer). */
    private spreadSamples: number[] = [];

    /** Latest depth profile. */
    private latestDepth: DepthProfile | null = null;

    /** Latest spread stats. */
    private latestSpread: SpreadStats | null = null;

    /** Latest flow stats. */
    private latestFlow: TradeFlowStats | null = null;

    /** Latest impact estimates. */
    private latestImpact: ImpactEstimate[] = [];

    /** Latest composite score. */
    private latestScore = 0;

    /** Tick counter. */
    private tickCount = 0;

    /** Last computation timestamp. */
    private lastComputedMs = 0;

    constructor(config?: Partial<LiquidityIntelligenceConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Ingest a tick of market data and recompute all liquidity signals.
     *
     * @param book - Current order book state.
     * @param trades - Recent trades (from TradeTape.getAll() or similar).
     * @param nowMs - Current timestamp in ms.
     */
    ingestTick(
        book: OrderBookState,
        trades: readonly Trade[],
        nowMs: number,
    ): void {
        this.tickCount++;
        this.lastComputedMs = nowMs;

        // 1. Depth profile
        this.latestDepth = buildDepthProfile(book.bids, book.asks);

        // 2. Spread — add sample to ring buffer
        const spreadBps = Math.max(0, book.spread);
        this.spreadSamples.push(spreadBps);
        if (this.spreadSamples.length > this.config.spreadWindowSize) {
            this.spreadSamples.shift();
        }
        const sorted = [...this.spreadSamples].sort((a, b) => a - b);
        this.latestSpread = {
            currentBps: spreadBps,
            p50Bps: Math.round(percentile(sorted, 50) * 100) / 100,
            p95Bps: Math.round(percentile(sorted, 95) * 100) / 100,
            sampleCount: sorted.length,
        };

        // 3. Trade flow
        this.latestFlow = computeTradeFlowStats(
            trades,
            this.config.tradeFlowWindowMs,
            nowMs,
        );

        // 4. Market impact
        this.latestImpact = computeImpactEstimates(
            book.bids,
            book.asks,
            this.config.impactReferenceSizes,
        );

        // 5. Composite score
        const depthScore = scoreDepth(this.latestDepth);
        const spreadScoreVal = scoreSpread(this.latestSpread);
        const flowScoreVal = scoreFlow(this.latestFlow);
        const impactScoreVal = scoreImpact(this.latestImpact);

        this.latestScore = computeCompositeScore(
            depthScore,
            spreadScoreVal,
            flowScoreVal,
            impactScoreVal,
            this.config,
        );
    }

    /**
     * Get the latest liquidity snapshot.
     * Returns null if no ticks have been ingested.
     */
    getSnapshot(): LiquiditySnapshot | null {
        if (this.tickCount === 0 || !this.latestDepth || !this.latestSpread || !this.latestFlow) {
            return null;
        }

        return {
            score: this.latestScore,
            grade: scoreToGrade(this.latestScore),
            level: scoreToLevel(this.latestScore),
            depth: this.latestDepth,
            spread: this.latestSpread,
            flow: this.latestFlow,
            impact: this.latestImpact,
            computedAtMs: this.lastComputedMs,
            tickCount: this.tickCount,
        };
    }

    /**
     * Get the current score (0 if no data).
     */
    getScore(): number {
        return this.latestScore;
    }

    /**
     * Get the current grade.
     */
    getGrade(): LiquidityGrade {
        return scoreToGrade(this.latestScore);
    }

    /**
     * Get the current level (for registry backward compat).
     */
    getLevel(): LiquidityLevel {
        return scoreToLevel(this.latestScore);
    }

    /**
     * Reset all state (called on pair switch).
     */
    reset(): void {
        this.spreadSamples = [];
        this.latestDepth = null;
        this.latestSpread = null;
        this.latestFlow = null;
        this.latestImpact = [];
        this.latestScore = 0;
        this.tickCount = 0;
        this.lastComputedMs = 0;
    }

    /**
     * Get tick count.
     */
    getTickCount(): number {
        return this.tickCount;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load liquidity intelligence config from environment variables.
 */
export function loadLiquidityConfig(): Partial<LiquidityIntelligenceConfig> {
    const toNumber = (val: string | undefined): number | undefined => {
        if (val === undefined) return undefined;
        const parsed = Number(val);
        return Number.isFinite(parsed) ? parsed : undefined;
    };

    const config: Partial<LiquidityIntelligenceConfig> = {};

    const spreadWindow = toNumber(process.env.LIQUIDITY_SPREAD_WINDOW_SIZE);
    if (spreadWindow !== undefined) config.spreadWindowSize = spreadWindow;

    const flowWindow = toNumber(process.env.LIQUIDITY_FLOW_WINDOW_MS);
    if (flowWindow !== undefined) config.tradeFlowWindowMs = flowWindow;

    return config;
}
