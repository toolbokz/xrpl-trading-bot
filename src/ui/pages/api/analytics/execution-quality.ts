import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import {
    feedbackEngine,
    ExecutionQualityAnalytics,
    ExecutionQualityFilters,
    ExecutionQualitySummary,
    ExecutionQualityBucket,
    ExecutionQualityHistogramBin,
    ExecutionQualityBreakdownRow,
    ExecutionQualityAnomalies,
} from '../../../../analytics/feedbackEngine';
import { canonicalizePairKey } from '../../../../xrpl/currency';
import { buildAnalyticsCacheKey, getAnalyticsCacheTtlMs, getCachedAnalytics, setCachedAnalytics } from './_cache';

export const config = {
    api: { bodyParser: false },
};

export interface ExecutionQualityApiResponse {
    requestId: string;
    timestamp: string;
    filters: {
        pairKey: string | null;
        sinceMs: number | null;
        strategy: string | null;
        side: 'buy' | 'sell' | null;
        source: 'bot' | 'manual' | 'unknown' | null;
        bucketMs: number;
    };
    summary: ExecutionQualitySummary;
    series: ExecutionQualityBucket[];
    histograms: {
        slippageBps: ExecutionQualityHistogramBin[];
        spreadBps: ExecutionQualityHistogramBin[];
        postTradeDriftBps: ExecutionQualityHistogramBin[];
    };
    breakdowns: {
        byPair: ExecutionQualityBreakdownRow[];
        byStrategy: ExecutionQualityBreakdownRow[];
        bySide: ExecutionQualityBreakdownRow[];
        byRegime: ExecutionQualityBreakdownRow[];
    };
    anomalies: ExecutionQualityAnomalies;
}

function parseSide(value: unknown): 'buy' | 'sell' | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'buy' || normalized === 'sell') return normalized;
    return null;
}

function parseSource(value: unknown): 'bot' | 'manual' | 'unknown' | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'bot' || normalized === 'manual' || normalized === 'unknown') {
        return normalized;
    }
    return null;
}

function parsePositiveInt(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

function handler(req: LocalRequest, res: NextApiResponse<ExecutionQualityApiResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { pairKey, pair, sinceMs, strategy, side, source, bucketMs, window } = req.query;

        const filters: ExecutionQualityFilters = {};

        const resolvedPair =
            (typeof pairKey === 'string' && pairKey.trim())
            || (typeof pair === 'string' && pair.trim())
            || '';
        if (resolvedPair) filters.pairKey = resolvedPair;

        const parsedSinceMs = parsePositiveInt(sinceMs);
        if (parsedSinceMs != null) {
            filters.sinceMs = parsedSinceMs;
        } else {
            // Backward-compatible support for old `window` query.
            const parsedWindowMs = parsePositiveInt(window);
            if (parsedWindowMs != null) {
                filters.sinceMs = Date.now() - parsedWindowMs;
            }
        }

        if (typeof strategy === 'string' && strategy.trim()) {
            filters.strategy = strategy.trim();
        }

        const parsedSide = parseSide(side);
        if (parsedSide) {
            filters.side = parsedSide;
        }

        const parsedSource = parseSource(source);
        if (parsedSource) {
            filters.source = parsedSource;
        }

        const parsedBucketMs = parsePositiveInt(bucketMs);
        if (parsedBucketMs != null) {
            filters.bucketMs = parsedBucketMs;
        }

        const cacheKey = buildAnalyticsCacheKey('execution-quality', {
            pairKey: filters.pairKey ? canonicalizePairKey(filters.pairKey) : null,
            sinceMs: filters.sinceMs ?? null,
            strategy: filters.strategy ?? null,
            side: filters.side ?? null,
            source: filters.source ?? null,
            bucketMs: filters.bucketMs ?? 60_000,
        });
        const cached = getCachedAnalytics<Omit<ExecutionQualityApiResponse, 'requestId' | 'timestamp'>>(cacheKey);
        if (cached) {
            return res.status(200).json({
                requestId: req.requestId,
                timestamp: new Date().toISOString(),
                ...cached,
            });
        }

        const analytics: ExecutionQualityAnalytics = feedbackEngine.getExecutionQualityAnalytics(filters);

        const payload: Omit<ExecutionQualityApiResponse, 'requestId' | 'timestamp'> = {
            filters: {
                pairKey: filters.pairKey ? canonicalizePairKey(filters.pairKey) : null,
                sinceMs: filters.sinceMs ?? null,
                strategy: filters.strategy ?? null,
                side: filters.side ?? null,
                source: filters.source ?? null,
                bucketMs: filters.bucketMs ?? 60_000,
            },
            summary: analytics.summary,
            series: analytics.series,
            histograms: analytics.histograms,
            breakdowns: analytics.breakdowns,
            anomalies: analytics.anomalies,
        };

        setCachedAnalytics(cacheKey, payload, getAnalyticsCacheTtlMs());

        const response: ExecutionQualityApiResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            ...payload,
        };

        return res.status(200).json(response);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return res.status(500).json({ error: message });
    }
}

export default withLocalApi(handler);
