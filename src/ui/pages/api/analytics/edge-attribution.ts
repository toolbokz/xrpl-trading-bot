import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import {
    feedbackEngine,
    EdgeAttributionAnalytics,
    EdgeAttributionSummary,
    EdgeAttributionBucket,
    EdgeAttributionHistogramBin,
    EdgeAttributionBreakdownRow,
    EdgeAttributionTopTrade,
} from '../../../../analytics/feedbackEngine';
import { canonicalizePairKey } from '../../../../xrpl/currency';
import { buildAnalyticsCacheKey, getAnalyticsCacheTtlMs, getCachedAnalytics, setCachedAnalytics } from './_cache';
import { loadConfig } from '../../../../config';

export const config = {
    api: { bodyParser: false },
};

export interface EdgeAttributionApiResponse {
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
    summary: EdgeAttributionSummary;
    series: EdgeAttributionBucket[];
    histograms: {
        executionEdgeBps: EdgeAttributionHistogramBin[];
        driftBps: EdgeAttributionHistogramBin[];
    };
    breakdowns: {
        byPair: EdgeAttributionBreakdownRow[];
        byStrategy: EdgeAttributionBreakdownRow[];
        bySide: EdgeAttributionBreakdownRow[];
        byRegime: EdgeAttributionBreakdownRow[];
    };
    topTrades: {
        worstExecution: EdgeAttributionTopTrade[];
        adverseSelection: EdgeAttributionTopTrade[];
    };
}

function parsePositiveInt(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
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
    if (normalized === 'bot' || normalized === 'manual' || normalized === 'unknown') return normalized;
    return null;
}

function handler(req: LocalRequest, res: NextApiResponse<EdgeAttributionApiResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { pairKey, pair, sinceMs, strategy, side, source, bucketMs } = req.query;
        const filters: {
            pairKey?: string;
            sinceMs?: number;
            strategy?: string;
            side?: 'buy' | 'sell';
            source?: 'bot' | 'manual' | 'unknown';
            bucketMs?: number;
            paperMode?: boolean;
        } = {};

        const resolvedPair =
            (typeof pairKey === 'string' && pairKey.trim())
            || (typeof pair === 'string' && pair.trim())
            || '';
        if (resolvedPair) filters.pairKey = resolvedPair;

        const parsedSinceMs = parsePositiveInt(sinceMs);
        if (parsedSinceMs != null) filters.sinceMs = parsedSinceMs;

        if (typeof strategy === 'string' && strategy.trim()) {
            filters.strategy = strategy.trim();
        }

        const parsedSide = parseSide(side);
        if (parsedSide) filters.side = parsedSide;

        const parsedSource = parseSource(source);
        if (parsedSource) filters.source = parsedSource;

        const parsedBucketMs = parsePositiveInt(bucketMs);
        if (parsedBucketMs != null) filters.bucketMs = parsedBucketMs;

        const paperMode = loadConfig().paperTrading;
        filters.paperMode = paperMode;

        const cacheKey = buildAnalyticsCacheKey('edge-attribution', {
            pairKey: filters.pairKey ? canonicalizePairKey(filters.pairKey) : null,
            sinceMs: filters.sinceMs ?? null,
            strategy: filters.strategy ?? null,
            side: filters.side ?? null,
            source: filters.source ?? null,
            bucketMs: filters.bucketMs ?? 60_000,
            paperMode,
        });
        const cached = getCachedAnalytics<Omit<EdgeAttributionApiResponse, 'requestId' | 'timestamp'>>(cacheKey);
        if (cached) {
            return res.status(200).json({
                requestId: req.requestId,
                timestamp: new Date().toISOString(),
                ...cached,
            });
        }

        const analytics: EdgeAttributionAnalytics = feedbackEngine.getEdgeAttributionAnalytics(filters);

        const payload: Omit<EdgeAttributionApiResponse, 'requestId' | 'timestamp'> = {
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
            topTrades: analytics.topTrades,
        };

        setCachedAnalytics(cacheKey, payload, getAnalyticsCacheTtlMs());

        const response: EdgeAttributionApiResponse = {
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

export default withLocalApi(withApiRouteContext(handler));
