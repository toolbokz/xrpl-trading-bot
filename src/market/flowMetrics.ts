/**
 * Flow Metrics Module
 * 
 * XRPL-native market sentiment using executed trade flow (TradeTape) + order book signals.
 * Computes microstructure signals and classifies market regime for strategy decisions.
 */

import { TradeAggression, TradeTape } from './tradeTape';
import { OrderBookState } from '../utils/types';
import type { TrendSignal } from './midPriceTrend';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Market regime classification based on flow metrics.
 * Strategies use this to adapt behavior or skip ticks.
 */
export type FlowRegime =
    | 'quiet'        // Low volume, tight spread - market-making friendly
    | 'normal'       // Balanced flow, healthy liquidity
    | 'trendingUp'   // Strong buy pressure, momentum
    | 'trendingDown' // Strong sell pressure, momentum
    | 'chaotic'      // Contradictory signals, wide spread - avoid trading
    | 'illiquid';    // Thin book or no recent trades - dangerous to trade

/**
 * Computed flow metrics from trade tape and order book.
 */
export interface FlowMetrics {
    /** Current market regime classification */
    regime: FlowRegime;

    // ─────────────────────────────────────────────────────────────────────────
    // Trade Flow Signals
    // ─────────────────────────────────────────────────────────────────────────

    /** Order flow imbalance: (buyVol - sellVol) / (buyVol + sellVol), range [-1, 1] */
    imbalance: number;

    /** Volume-Weighted Average Price over flow window */
    vwap: number | null;

    /** Deviation of current mid-price from VWAP in basis points */
    vwapDeviationBps: number;

    /** Trade count in the flow window */
    tradeCount: number;

    /** Total volume (buy + sell) in base currency */
    totalVolumeBase: number;

    /** Buy aggression ratio: buyCount / totalCount */
    buyAggressionRatio: number;

    /** Volume velocity: trades per minute in window */
    volumeVelocity: number;

    // ─────────────────────────────────────────────────────────────────────────
    // Order Book Signals
    // ─────────────────────────────────────────────────────────────────────────

    /** Best bid price */
    bestBid: number;

    /** Best ask price */
    bestAsk: number;

    /** Mid-market price: (bestBid + bestAsk) / 2 */
    midPrice: number;

    /** Bid-ask spread in basis points */
    spreadBps: number;

    /** Depth imbalance: (bidDepth - askDepth) / (bidDepth + askDepth) at N levels */
    depthImbalance: number;

    /** Total bid depth in base currency (sum of top N levels) */
    bidDepthBase: number;

    /** Total ask depth in base currency (sum of top N levels) */
    askDepthBase: number;

    /** Weighted average bid price (by quantity) */
    weightedBid: number;

    /** Weighted average ask price (by quantity) */
    weightedAsk: number;

    // ─────────────────────────────────────────────────────────────────────────
    // Composite Signals
    // ─────────────────────────────────────────────────────────────────────────

    /** Combined signal: average of imbalance and depthImbalance */
    combinedSignal: number;

    /** Signal strength: abs(combinedSignal), range [0, 1] */
    signalStrength: number;

    /** Timestamp when metrics were computed */
    computedAt: number;

    // ─────────────────────────────────────────────────────────────────────────
    // Mid-Price Trend (longer-horizon direction detection)
    // ─────────────────────────────────────────────────────────────────────────

    /** Mid-price trend signal from EMA tracker (null when tracker not wired) */
    trend: TrendSignal | null;
}

/**
 * Configuration for flow metrics computation.
 */
export interface FlowConfig {
    /** Time window for trade flow analysis in ms (default: 60000) */
    flowWindowMs: number;

    /** Time window for short-term aggression in ms (default: 10000) */
    aggressionWindowMs: number;

    /** Number of order book levels to consider for depth (default: 10) */
    depthLevels: number;

    /** Imbalance threshold to classify as trending (default: 0.3) */
    trendingThreshold: number;

    /** Spread threshold in bps to classify as chaotic (default: 200) */
    chaoticSpreadBps: number;

    /** Minimum trades in window to classify as not-illiquid (default: 3) */
    minTradesForLiquidity: number;

    /** Minimum total depth (bid+ask) in base to classify as not-illiquid (default: 100) */
    minDepthForLiquidity: number;

    /** Combined signal threshold for quiet regime (default: 0.1) */
    quietThreshold: number;
}

/**
 * Default flow configuration values.
 */
export const DEFAULT_FLOW_CONFIG: FlowConfig = {
    flowWindowMs: 60_000,
    aggressionWindowMs: 10_000,
    depthLevels: 10,
    trendingThreshold: 0.3,
    chaoticSpreadBps: 200,
    minTradesForLiquidity: 3,
    minDepthForLiquidity: 100,
    quietThreshold: 0.1,
};

// ─────────────────────────────────────────────────────────────────────────────
// Computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute flow metrics from trade tape and order book state.
 * 
 * @param tradeTape - TradeTape instance with recent trades
 * @param orderBook - Current order book state
 * @param config - Flow configuration (uses defaults if not provided)
 * @returns Computed flow metrics with regime classification
 */
export function computeFlowMetrics(
    tradeTape: TradeTape | null,
    orderBook: OrderBookState,
    config: Partial<FlowConfig> = {}
): FlowMetrics {
    const cfg: FlowConfig = { ...DEFAULT_FLOW_CONFIG, ...config };
    const now = Date.now();

    // ─────────────────────────────────────────────────────────────────────────
    // Trade Flow Signals
    // ─────────────────────────────────────────────────────────────────────────

    let aggression: TradeAggression = { buyVolumeBase: 0, sellVolumeBase: 0, buyCount: 0, sellCount: 0 };
    let vwap: number | null = null;

    if (tradeTape) {
        aggression = tradeTape.getAggression(cfg.aggressionWindowMs);
        vwap = tradeTape.getVWAP(cfg.flowWindowMs);
    }

    const totalVolumeBase = aggression.buyVolumeBase + aggression.sellVolumeBase;
    const tradeCount = aggression.buyCount + aggression.sellCount;

    // Order flow imbalance: (buyVol - sellVol) / (buyVol + sellVol)
    const imbalance = totalVolumeBase > 0
        ? (aggression.buyVolumeBase - aggression.sellVolumeBase) / totalVolumeBase
        : 0;

    // Buy aggression ratio: buyCount / totalCount
    const buyAggressionRatio = tradeCount > 0
        ? aggression.buyCount / tradeCount
        : 0.5;

    // Volume velocity: trades per minute
    const windowMinutes = cfg.aggressionWindowMs / 60_000;
    const volumeVelocity = windowMinutes > 0 ? tradeCount / windowMinutes : 0;

    // ─────────────────────────────────────────────────────────────────────────
    // Order Book Signals
    // ─────────────────────────────────────────────────────────────────────────

    const bestBid = orderBook.bids[0]?.price ?? 0;
    const bestAsk = orderBook.asks[0]?.price ?? 0;
    const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
    const spreadBps = orderBook.spread;

    // Depth at N levels
    const bidLevels = orderBook.bids.slice(0, cfg.depthLevels);
    const askLevels = orderBook.asks.slice(0, cfg.depthLevels);

    const bidDepthBase = bidLevels.reduce((sum, o) => sum + o.quantity, 0);
    const askDepthBase = askLevels.reduce((sum, o) => sum + o.quantity, 0);

    // Depth imbalance: (bidDepth - askDepth) / (bidDepth + askDepth)
    const totalDepth = bidDepthBase + askDepthBase;
    const depthImbalance = totalDepth > 0
        ? (bidDepthBase - askDepthBase) / totalDepth
        : 0;

    // Weighted average prices
    const weightedBid = computeWeightedPrice(bidLevels);
    const weightedAsk = computeWeightedPrice(askLevels);

    // VWAP deviation from mid-price
    const vwapDeviationBps = vwap && midPrice > 0
        ? ((midPrice - vwap) / vwap) * 10_000
        : 0;

    // ─────────────────────────────────────────────────────────────────────────
    // Composite Signals
    // ─────────────────────────────────────────────────────────────────────────

    // Combined signal: average of trade flow imbalance and depth imbalance
    const combinedSignal = (imbalance + depthImbalance) / 2;
    const signalStrength = Math.abs(combinedSignal);

    // ─────────────────────────────────────────────────────────────────────────
    // Regime Classification
    // ─────────────────────────────────────────────────────────────────────────

    const regime = classifyFlowRegime({
        imbalance,
        spreadBps,
        tradeCount,
        totalDepth,
        combinedSignal,
        signalStrength,
    }, cfg);

    return {
        regime,
        imbalance,
        vwap,
        vwapDeviationBps,
        tradeCount,
        totalVolumeBase,
        buyAggressionRatio,
        volumeVelocity,
        bestBid,
        bestAsk,
        midPrice,
        spreadBps,
        depthImbalance,
        bidDepthBase,
        askDepthBase,
        weightedBid,
        weightedAsk,
        combinedSignal,
        signalStrength,
        computedAt: now,
        trend: null, // populated by runtime via MidPriceTrendTracker
    };
}

/**
 * Compute volume-weighted average price from order book levels.
 */
function computeWeightedPrice(levels: Array<{ price: number; quantity: number }>): number {
    if (levels.length === 0) return 0;

    let totalValue = 0;
    let totalQuantity = 0;

    for (const level of levels) {
        totalValue += level.price * level.quantity;
        totalQuantity += level.quantity;
    }

    return totalQuantity > 0 ? totalValue / totalQuantity : 0;
}

/**
 * Inputs for regime classification.
 */
interface RegimeInputs {
    imbalance: number;
    spreadBps: number;
    tradeCount: number;
    totalDepth: number;
    combinedSignal: number;
    signalStrength: number;
}

/**
 * Classify market regime based on flow metrics.
 * 
 * Priority order:
 * 1. illiquid - Thin book or no trades (dangerous)
 * 2. chaotic - Wide spread with contradictory signals
 * 3. trendingUp/trendingDown - Strong directional pressure
 * 4. quiet - Low activity, tight spread
 * 5. normal - Balanced market
 */
export function classifyFlowRegime(inputs: RegimeInputs, config: FlowConfig): FlowRegime {
    const { imbalance, spreadBps, tradeCount, totalDepth, combinedSignal, signalStrength } = inputs;

    // 1. Check for illiquidity first (most dangerous)
    if (tradeCount < config.minTradesForLiquidity || totalDepth < config.minDepthForLiquidity) {
        return 'illiquid';
    }

    // 2. Check for chaotic market (wide spread with low signal coherence)
    if (spreadBps > config.chaoticSpreadBps) {
        // Wide spread - check if signals are contradictory
        const signalsContradict = Math.sign(imbalance) !== Math.sign(combinedSignal);
        if (signalsContradict || signalStrength < config.quietThreshold) {
            return 'chaotic';
        }
    }

    // 3. Check for trending markets (strong directional pressure)
    if (combinedSignal > config.trendingThreshold) {
        return 'trendingUp';
    }
    if (combinedSignal < -config.trendingThreshold) {
        return 'trendingDown';
    }

    // 4. Check for quiet market (low activity but healthy)
    if (signalStrength < config.quietThreshold && spreadBps < config.chaoticSpreadBps / 2) {
        return 'quiet';
    }

    // 5. Default to normal
    return 'normal';
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if regime is safe for market-making strategies.
 */
export function isRegimeSafeForMM(regime: FlowRegime): boolean {
    return regime === 'quiet' || regime === 'normal';
}

/**
 * Check if regime is safe for arbitrage strategies.
 */
export function isRegimeSafeForArb(regime: FlowRegime): boolean {
    return regime !== 'illiquid' && regime !== 'chaotic';
}

/**
 * Get a human-readable description of the regime.
 */
export function getRegimeDescription(regime: FlowRegime): string {
    switch (regime) {
        case 'quiet':
            return 'Low activity, tight spread - favorable for market-making';
        case 'normal':
            return 'Balanced flow, healthy liquidity - normal trading';
        case 'trendingUp':
            return 'Strong buy pressure - momentum/trend following favorable';
        case 'trendingDown':
            return 'Strong sell pressure - momentum/trend following favorable';
        case 'chaotic':
            return 'Wide spread, contradictory signals - avoid trading';
        case 'illiquid':
            return 'Thin book or no trades - dangerous to trade';
        default:
            return 'Unknown regime';
    }
}

/**
 * Get suggested position sizing multiplier based on regime and signal strength.
 * Returns a value between 0 and 1 to scale position size.
 */
export function getRegimeSizeMultiplier(flow: FlowMetrics): number {
    switch (flow.regime) {
        case 'illiquid':
            return 0; // Don't trade
        case 'chaotic':
            return 0; // Don't trade
        case 'quiet':
            return 0.5; // Reduced size in quiet markets
        case 'trendingUp':
        case 'trendingDown':
            // Scale with signal strength but cap at 1.0
            return Math.min(1.0, 0.5 + flow.signalStrength);
        case 'normal':
            return 1.0; // Full size
        default:
            return 0.5;
    }
}

/**
 * Calculate quote skew based on flow imbalance.
 * Positive imbalance (more buys) → raise ask / lower bid
 * Negative imbalance (more sells) → lower ask / raise bid
 * 
 * @returns Skew in basis points to apply to quotes
 */
export function calculateQuoteSkew(flow: FlowMetrics, maxSkewBps: number = 10): number {
    // Skew proportional to imbalance, capped at maxSkewBps
    return flow.imbalance * maxSkewBps;
}

/**
 * Check for adverse selection risk.
 * Returns true if we should retreat from the market.
 */
export function hasAdverseSelectionRisk(flow: FlowMetrics): boolean {
    // High signal strength + trending = informed traders moving the market
    if (flow.signalStrength > 0.5 && (flow.regime === 'trendingUp' || flow.regime === 'trendingDown')) {
        return true;
    }

    // VWAP deviation too large - we might be on the wrong side
    if (Math.abs(flow.vwapDeviationBps) > 50) {
        return true;
    }

    return false;
}
