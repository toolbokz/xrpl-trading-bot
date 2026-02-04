import { describe, it, expect, beforeEach } from 'vitest';
import {
    computeFlowMetrics,
    classifyFlowRegime,
    FlowMetrics,
    FlowRegime,
    DEFAULT_FLOW_CONFIG,
    isRegimeSafeForMM,
    isRegimeSafeForArb,
    getRegimeSizeMultiplier,
    calculateQuoteSkew,
    hasAdverseSelectionRisk,
    getRegimeDescription,
} from '../flowMetrics';
import { TradeTape, Trade } from '../tradeTape';
import { OrderBookState } from '../../utils/types';
import { TradingPair } from '../../config';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

const makeTradingPair = (): TradingPair => ({
    baseCurrency: 'XRP',
    quoteCurrency: 'USD',
    issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
});

const makeOrderBookState = (overrides: Partial<OrderBookState> = {}): OrderBookState => ({
    bids: [
        { price: 0.50, quantity: 100, quality: 2, isBuy: true, raw: {} as any },
        { price: 0.49, quantity: 200, quality: 2.04, isBuy: true, raw: {} as any },
        { price: 0.48, quantity: 150, quality: 2.08, isBuy: true, raw: {} as any },
    ],
    asks: [
        { price: 0.51, quantity: 100, quality: 1.96, isBuy: false, raw: {} as any },
        { price: 0.52, quantity: 200, quality: 1.92, isBuy: false, raw: {} as any },
        { price: 0.53, quantity: 150, quality: 1.89, isBuy: false, raw: {} as any },
    ],
    spread: 196, // ~2% spread in bps
    lastUpdated: Date.now(),
    ...overrides,
});

const makeTrade = (side: 'buy' | 'sell', sizeBase: number, price: number = 0.505): Trade => ({
    id: `tx-${Math.random().toString(36).slice(2)}:0`,
    ts: Date.now(),
    pairKey: 'XRP/USD',
    price,
    sizeBase,
    sizeQuote: sizeBase * price,
    side,
    txHash: `hash-${Math.random().toString(36).slice(2)}`,
    ledgerIndex: 12345678,
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: computeFlowMetrics
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFlowMetrics', () => {
    let tradeTape: TradeTape;
    let orderBook: OrderBookState;

    beforeEach(() => {
        tradeTape = new TradeTape(makeTradingPair());
        orderBook = makeOrderBookState();
    });

    it('should compute metrics with empty trade tape', () => {
        const metrics = computeFlowMetrics(tradeTape, orderBook);

        expect(metrics).toBeDefined();
        expect(metrics.imbalance).toBe(0);
        expect(metrics.tradeCount).toBe(0);
        expect(metrics.totalVolumeBase).toBe(0);
        expect(metrics.vwap).toBeNull();
        expect(metrics.bestBid).toBe(0.50);
        expect(metrics.bestAsk).toBe(0.51);
        expect(metrics.midPrice).toBeCloseTo(0.505, 4);
    });

    it('should compute positive imbalance with more buys', () => {
        // Add more buy volume than sell volume
        tradeTape.add(makeTrade('buy', 100));
        tradeTape.add(makeTrade('buy', 100));
        tradeTape.add(makeTrade('sell', 50));

        const metrics = computeFlowMetrics(tradeTape, orderBook);

        expect(metrics.imbalance).toBeGreaterThan(0);
        expect(metrics.imbalance).toBeCloseTo(0.6, 2); // (200-50)/(200+50) = 0.6
        expect(metrics.buyAggressionRatio).toBeCloseTo(0.667, 2); // 2/3
    });

    it('should compute negative imbalance with more sells', () => {
        tradeTape.add(makeTrade('sell', 100));
        tradeTape.add(makeTrade('sell', 100));
        tradeTape.add(makeTrade('buy', 50));

        const metrics = computeFlowMetrics(tradeTape, orderBook);

        expect(metrics.imbalance).toBeLessThan(0);
        expect(metrics.imbalance).toBeCloseTo(-0.6, 2);
    });

    it('should compute VWAP correctly', () => {
        tradeTape.add({ ...makeTrade('buy', 100), price: 0.50 });
        tradeTape.add({ ...makeTrade('buy', 100), price: 0.52 });

        const metrics = computeFlowMetrics(tradeTape, orderBook);

        // VWAP = (100 * 0.50 + 100 * 0.52) / 200 = 0.51
        expect(metrics.vwap).toBeCloseTo(0.51, 4);
    });

    it('should compute depth imbalance', () => {
        // More bid depth than ask depth
        const bidHeavyBook = makeOrderBookState({
            bids: [
                { price: 0.50, quantity: 500, quality: 2, isBuy: true, raw: {} as any },
            ],
            asks: [
                { price: 0.51, quantity: 100, quality: 1.96, isBuy: false, raw: {} as any },
            ],
        });

        const metrics = computeFlowMetrics(tradeTape, bidHeavyBook);

        expect(metrics.depthImbalance).toBeGreaterThan(0);
        expect(metrics.depthImbalance).toBeCloseTo(0.667, 2); // (500-100)/(500+100)
        expect(metrics.bidDepthBase).toBe(500);
        expect(metrics.askDepthBase).toBe(100);
    });

    it('should handle null trade tape gracefully', () => {
        const metrics = computeFlowMetrics(null, orderBook);

        expect(metrics).toBeDefined();
        expect(metrics.imbalance).toBe(0);
        expect(metrics.tradeCount).toBe(0);
        expect(metrics.bestBid).toBe(0.50);
    });

    it('should handle empty order book gracefully', () => {
        const emptyBook: OrderBookState = {
            bids: [],
            asks: [],
            spread: 0,
            lastUpdated: Date.now(),
        };

        const metrics = computeFlowMetrics(tradeTape, emptyBook);

        expect(metrics.bestBid).toBe(0);
        expect(metrics.bestAsk).toBe(0);
        expect(metrics.midPrice).toBe(0);
        expect(metrics.depthImbalance).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: classifyFlowRegime
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyFlowRegime', () => {
    const config = DEFAULT_FLOW_CONFIG;

    it('should classify as illiquid with few trades', () => {
        const regime = classifyFlowRegime({
            imbalance: 0,
            spreadBps: 50,
            tradeCount: 1, // Below minTradesForLiquidity (3)
            totalDepth: 200,
            combinedSignal: 0,
            signalStrength: 0,
        }, config);

        expect(regime).toBe('illiquid');
    });

    it('should classify as illiquid with thin depth', () => {
        const regime = classifyFlowRegime({
            imbalance: 0,
            spreadBps: 50,
            tradeCount: 10,
            totalDepth: 50, // Below minDepthForLiquidity (100)
            combinedSignal: 0,
            signalStrength: 0,
        }, config);

        expect(regime).toBe('illiquid');
    });

    it('should classify as chaotic with wide spread and contradictory signals', () => {
        const regime = classifyFlowRegime({
            imbalance: 0.5, // Positive imbalance
            spreadBps: 300, // Above chaoticSpreadBps (200)
            tradeCount: 10,
            totalDepth: 200,
            combinedSignal: -0.3, // Contradicts imbalance
            signalStrength: 0.05,
        }, config);

        expect(regime).toBe('chaotic');
    });

    it('should classify as trendingUp with strong positive signal', () => {
        const regime = classifyFlowRegime({
            imbalance: 0.5,
            spreadBps: 50,
            tradeCount: 10,
            totalDepth: 200,
            combinedSignal: 0.5, // Above trendingThreshold (0.3)
            signalStrength: 0.5,
        }, config);

        expect(regime).toBe('trendingUp');
    });

    it('should classify as trendingDown with strong negative signal', () => {
        const regime = classifyFlowRegime({
            imbalance: -0.5,
            spreadBps: 50,
            tradeCount: 10,
            totalDepth: 200,
            combinedSignal: -0.5, // Below -trendingThreshold (-0.3)
            signalStrength: 0.5,
        }, config);

        expect(regime).toBe('trendingDown');
    });

    it('should classify as quiet with low activity and tight spread', () => {
        const regime = classifyFlowRegime({
            imbalance: 0.05,
            spreadBps: 50, // Below chaoticSpreadBps/2 (100)
            tradeCount: 10,
            totalDepth: 200,
            combinedSignal: 0.05, // Below quietThreshold (0.1)
            signalStrength: 0.05,
        }, config);

        expect(regime).toBe('quiet');
    });

    it('should classify as normal by default', () => {
        const regime = classifyFlowRegime({
            imbalance: 0.15,
            spreadBps: 80,
            tradeCount: 10,
            totalDepth: 200,
            combinedSignal: 0.15, // Between quietThreshold and trendingThreshold
            signalStrength: 0.15,
        }, config);

        expect(regime).toBe('normal');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

describe('isRegimeSafeForMM', () => {
    it('should return true for quiet and normal', () => {
        expect(isRegimeSafeForMM('quiet')).toBe(true);
        expect(isRegimeSafeForMM('normal')).toBe(true);
    });

    it('should return false for trending, chaotic, and illiquid', () => {
        expect(isRegimeSafeForMM('trendingUp')).toBe(false);
        expect(isRegimeSafeForMM('trendingDown')).toBe(false);
        expect(isRegimeSafeForMM('chaotic')).toBe(false);
        expect(isRegimeSafeForMM('illiquid')).toBe(false);
    });
});

describe('isRegimeSafeForArb', () => {
    it('should return true for quiet, normal, and trending', () => {
        expect(isRegimeSafeForArb('quiet')).toBe(true);
        expect(isRegimeSafeForArb('normal')).toBe(true);
        expect(isRegimeSafeForArb('trendingUp')).toBe(true);
        expect(isRegimeSafeForArb('trendingDown')).toBe(true);
    });

    it('should return false for chaotic and illiquid', () => {
        expect(isRegimeSafeForArb('chaotic')).toBe(false);
        expect(isRegimeSafeForArb('illiquid')).toBe(false);
    });
});

describe('getRegimeSizeMultiplier', () => {
    it('should return 0 for illiquid and chaotic', () => {
        expect(getRegimeSizeMultiplier({ regime: 'illiquid' } as FlowMetrics)).toBe(0);
        expect(getRegimeSizeMultiplier({ regime: 'chaotic' } as FlowMetrics)).toBe(0);
    });

    it('should return 0.5 for quiet', () => {
        expect(getRegimeSizeMultiplier({ regime: 'quiet' } as FlowMetrics)).toBe(0.5);
    });

    it('should return 1.0 for normal', () => {
        expect(getRegimeSizeMultiplier({ regime: 'normal' } as FlowMetrics)).toBe(1.0);
    });

    it('should scale with signal strength for trending', () => {
        const lowStrength = getRegimeSizeMultiplier({ regime: 'trendingUp', signalStrength: 0.2 } as FlowMetrics);
        const highStrength = getRegimeSizeMultiplier({ regime: 'trendingUp', signalStrength: 0.8 } as FlowMetrics);

        expect(lowStrength).toBeCloseTo(0.7, 2);
        expect(highStrength).toBe(1.0); // Capped at 1.0
    });
});

describe('calculateQuoteSkew', () => {
    it('should return positive skew for positive imbalance', () => {
        const skew = calculateQuoteSkew({ imbalance: 0.5 } as FlowMetrics, 10);
        expect(skew).toBe(5); // 0.5 * 10
    });

    it('should return negative skew for negative imbalance', () => {
        const skew = calculateQuoteSkew({ imbalance: -0.5 } as FlowMetrics, 10);
        expect(skew).toBe(-5);
    });

    it('should respect maxSkewBps', () => {
        const skew = calculateQuoteSkew({ imbalance: 1.0 } as FlowMetrics, 5);
        expect(skew).toBe(5); // 1.0 * 5 = 5
    });
});

describe('hasAdverseSelectionRisk', () => {
    it('should return true for high signal strength during trending', () => {
        expect(hasAdverseSelectionRisk({
            regime: 'trendingUp',
            signalStrength: 0.6,
            vwapDeviationBps: 10,
        } as FlowMetrics)).toBe(true);
    });

    it('should return true for large VWAP deviation', () => {
        expect(hasAdverseSelectionRisk({
            regime: 'normal',
            signalStrength: 0.2,
            vwapDeviationBps: 60, // Above 50 threshold
        } as FlowMetrics)).toBe(true);
    });

    it('should return false for normal conditions', () => {
        expect(hasAdverseSelectionRisk({
            regime: 'normal',
            signalStrength: 0.2,
            vwapDeviationBps: 10,
        } as FlowMetrics)).toBe(false);
    });
});

describe('getRegimeDescription', () => {
    it('should return descriptions for all regimes', () => {
        const regimes: FlowRegime[] = ['quiet', 'normal', 'trendingUp', 'trendingDown', 'chaotic', 'illiquid'];

        for (const regime of regimes) {
            const desc = getRegimeDescription(regime);
            expect(desc).toBeTruthy();
            expect(typeof desc).toBe('string');
            expect(desc.length).toBeGreaterThan(10);
        }
    });
});
