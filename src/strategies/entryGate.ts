import { FlowMetrics, FlowRegime } from '../market/flowMetrics';
import { OrderBookState } from '../utils/types';
import { logger } from '../analytics/logger';

export interface EntryGateConfig {
    enabled: boolean;
    minSpreadBps: number;
    minSignalStrength: number;
    requireFlow: boolean;
    blockLocalExtreme: boolean;
    localExtremeThreshold: number;
    localExtremeDecay: number;
    maxBookStaleMs: number;
}

export interface EntryGateMetrics {
    spreadBps: number | null;
    signalStrength: number | null;
    localExtremeScore: number | null;
    localExtremeEma: number | null;
    flowRegime: FlowRegime | null;
    bookAgeMs: number | null;
}

export interface EntryGateDecision {
    allowed: boolean;
    reasons: string[];
    metrics: EntryGateMetrics;
}

const DEFAULT_CONFIG: EntryGateConfig = {
    enabled: true,
    minSpreadBps: 0,
    minSignalStrength: 0,
    requireFlow: false,
    blockLocalExtreme: false,
    localExtremeThreshold: 0.6,
    localExtremeDecay: 0.25,
    maxBookStaleMs: 8_000,
};

export function loadEntryGateConfig(): EntryGateConfig {
    return {
        enabled: process.env.ENTRY_GATE_ENABLED !== 'false',
        minSpreadBps: Number(process.env.ENTRY_GATE_MIN_SPREAD_BPS) || DEFAULT_CONFIG.minSpreadBps,
        minSignalStrength: Number(process.env.ENTRY_GATE_MIN_SIGNAL_STRENGTH) || DEFAULT_CONFIG.minSignalStrength,
        requireFlow: process.env.ENTRY_GATE_REQUIRE_FLOW === 'true',
        blockLocalExtreme: process.env.ENTRY_GATE_BLOCK_LOCAL_EXTREME === 'true',
        localExtremeThreshold: Number(process.env.ENTRY_GATE_LOCAL_EXTREME_THRESHOLD) || DEFAULT_CONFIG.localExtremeThreshold,
        localExtremeDecay: Number(process.env.ENTRY_GATE_LOCAL_EXTREME_DECAY) || DEFAULT_CONFIG.localExtremeDecay,
        maxBookStaleMs: Number(process.env.ENTRY_GATE_MAX_BOOK_STALE_MS) || DEFAULT_CONFIG.maxBookStaleMs,
    };
}

function computeDepthImbalance(levels: number, bids: OrderBookState['bids'], asks: OrderBookState['asks']): number | null {
    if (!bids.length || !asks.length) return null;
    const bidSlice = bids.slice(0, levels);
    const askSlice = asks.slice(0, levels);
    const bidDepth = bidSlice.reduce((sum, o) => sum + (o.quantity || 0), 0);
    const askDepth = askSlice.reduce((sum, o) => sum + (o.quantity || 0), 0);
    const total = bidDepth + askDepth;
    if (total <= 0) return null;
    return (bidDepth - askDepth) / total;
}

export class EntryGate {
    private readonly config: EntryGateConfig;
    private localExtremeEma: number | null = null;
    private lastMetrics: EntryGateMetrics = {
        spreadBps: null,
        signalStrength: null,
        localExtremeScore: null,
        localExtremeEma: null,
        flowRegime: null,
        bookAgeMs: null,
    };

    constructor(config?: Partial<EntryGateConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    ingestTick(orderBook: OrderBookState, flow?: FlowMetrics | null): void {
        if (!this.config.enabled) return;

        const nowMs = Date.now();
        const bookAgeMs = nowMs - orderBook.lastUpdated;
        const spreadBps = Number.isFinite(orderBook.spread) ? orderBook.spread : null;
        const signalStrength = flow?.signalStrength ?? null;
        const flowRegime = flow?.regime ?? null;

        const l1 = computeDepthImbalance(1, orderBook.bids, orderBook.asks);
        const l5 = computeDepthImbalance(5, orderBook.bids, orderBook.asks);
        const l10 = computeDepthImbalance(10, orderBook.bids, orderBook.asks);
        const localExtremeScore = [l1, l5, l10]
            .filter((v) => v != null)
            .map((v) => Math.abs(v as number))
            .reduce((max, v) => Math.max(max, v), 0);

        if (Number.isFinite(localExtremeScore)) {
            if (this.localExtremeEma == null) {
                this.localExtremeEma = localExtremeScore;
            } else {
                const alpha = this.config.localExtremeDecay;
                this.localExtremeEma = alpha * localExtremeScore + (1 - alpha) * this.localExtremeEma;
            }
        }

        this.lastMetrics = {
            spreadBps,
            signalStrength,
            localExtremeScore: Number.isFinite(localExtremeScore) ? localExtremeScore : null,
            localExtremeEma: this.localExtremeEma,
            flowRegime,
            bookAgeMs,
        };
    }

    shouldEnter(options?: { minSpreadBps?: number; minSignalStrength?: number }): EntryGateDecision {
        const reasons: string[] = [];
        const metrics = this.lastMetrics;
        if (!this.config.enabled) {
            return { allowed: true, reasons, metrics };
        }

        if (metrics.bookAgeMs != null && metrics.bookAgeMs > this.config.maxBookStaleMs) {
            reasons.push('stale-book');
        }

        if (this.config.requireFlow && metrics.signalStrength == null) {
            reasons.push('missing-flow');
        }

        const minSpreadBps = options?.minSpreadBps ?? this.config.minSpreadBps;
        if (metrics.spreadBps != null && metrics.spreadBps < minSpreadBps) {
            reasons.push('spread-too-narrow');
        }

        const minSignalStrength = options?.minSignalStrength ?? this.config.minSignalStrength;
        if (metrics.signalStrength != null && metrics.signalStrength < minSignalStrength) {
            reasons.push('signal-too-weak');
        }

        if (this.config.blockLocalExtreme) {
            const score = metrics.localExtremeEma ?? metrics.localExtremeScore;
            if (score != null && score >= this.config.localExtremeThreshold) {
                reasons.push('local-extreme');
            }
        }

        return {
            allowed: reasons.length === 0,
            reasons,
            metrics,
        };
    }

    logDecision(strategy: string, decision: EntryGateDecision): void {
        if (decision.allowed || !this.config.enabled) return;
        logger.info({
            strategy,
            reasons: decision.reasons,
            metrics: decision.metrics,
        }, 'EntryGate: blocked entry');
    }
}
