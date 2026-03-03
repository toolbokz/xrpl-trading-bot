import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import {
    feedbackEngine,
    ExecutionQualityAnalytics,
    ExecutionQualityFilters,
    ExecutionQualitySummary,
    ExecutionQualityBucket,
    ExecutionQualityHistogramBin,
    ExecutionQualityBreakdownRow,
    ExecutionQualityAnomalies,
    ExecutionQualityRealismDiagnostic,
    ExecutionQualityExcludedCounts,
} from '../../../../analytics/feedbackEngine';
import {
    parseCsvParam,
    resolveStrategyFilters,
    DEFAULT_EXECUTION_QUALITY_EXCLUDED_STRATEGIES,
} from '../../../../analytics/executionQualityEventFilters';
import { canonicalizePairKey } from '../../../../xrpl/currency';
import { buildAnalyticsCacheKey, getAnalyticsCacheTtlMs, getCachedAnalytics, setCachedAnalytics } from './_cache';
import { loadConfig } from '../../../../config';

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
        includeNonExecutionEvidence: boolean;
        includeStrategies: string[] | null;
        excludeStrategies: string[];
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
    slippageRealismDiagnostics: ExecutionQualityRealismDiagnostic[];
    totalEventsRaw: number;
    totalEventsAnalyzed: number;
    excludedCounts: ExecutionQualityExcludedCounts;
}

function firstQueryValue(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
        const trimmed = value[0].trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    return null;
}

function parseSide(value: unknown): 'buy' | 'sell' | null {
    const text = firstQueryValue(value);
    if (!text) return null;
    const normalized = text.toLowerCase();
    if (normalized === 'buy' || normalized === 'sell') return normalized;
    return null;
}

function parseSource(value: unknown): 'bot' | 'manual' | 'unknown' | null {
    const text = firstQueryValue(value);
    if (!text) return null;
    const normalized = text.toLowerCase();
    if (normalized === 'bot' || normalized === 'manual' || normalized === 'unknown') {
        return normalized;
    }
    return null;
}

function parsePositiveInt(value: unknown): number | null {
    const text = firstQueryValue(value);
    if (!text) return null;
    const parsed = parseInt(text, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

function parseBoolean(value: unknown): boolean | null {
    const text = firstQueryValue(value);
    if (!text) return null;
    const normalized = text.toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return null;
}

function handler(req: LocalRequest, res: NextApiResponse<ExecutionQualityApiResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const {
            pairKey,
            pair,
            sinceMs,
            strategy,
            side,
            source,
            bucketMs,
            window,
            includeNonExecutionEvidence,
            includeStrategies,
            excludeStrategies,
        } = req.query;

        const filters: ExecutionQualityFilters = {};

        const resolvedPair =
            firstQueryValue(pairKey)
            || firstQueryValue(pair)
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

        const parsedStrategy = firstQueryValue(strategy);
        if (parsedStrategy) {
            filters.strategy = parsedStrategy;
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

        const parsedIncludeNonExecutionEvidence = parseBoolean(includeNonExecutionEvidence);
        filters.includeNonExecutionEvidence = parsedIncludeNonExecutionEvidence === true;

        const parsedIncludeStrategies = parseCsvParam(includeStrategies);
        const hasExcludeStrategiesParam = Object.prototype.hasOwnProperty.call(req.query, 'excludeStrategies');
        const parsedExcludeStrategies = parseCsvParam(excludeStrategies);

        const strategyFilterOptions: {
            includeStrategies?: string[];
            excludeStrategies?: string[];
            defaultExcludedStrategies: readonly string[];
        } = {
            defaultExcludedStrategies: DEFAULT_EXECUTION_QUALITY_EXCLUDED_STRATEGIES,
        };
        if (parsedIncludeStrategies.length > 0) {
            strategyFilterOptions.includeStrategies = parsedIncludeStrategies;
        }
        if (hasExcludeStrategiesParam) {
            strategyFilterOptions.excludeStrategies = parsedExcludeStrategies;
        }

        const resolvedStrategyFilters = resolveStrategyFilters(strategyFilterOptions);

        if (resolvedStrategyFilters.includeStrategies) {
            filters.includeStrategies = resolvedStrategyFilters.includeStrategies;
            filters.excludeStrategies = [];
        } else {
            filters.excludeStrategies = resolvedStrategyFilters.excludeStrategies;
        }

        filters.paperMode = loadConfig().paperTrading;

        const cacheKey = buildAnalyticsCacheKey('execution-quality', {
            pairKey: filters.pairKey ? canonicalizePairKey(filters.pairKey) : null,
            sinceMs: filters.sinceMs ?? null,
            strategy: filters.strategy ?? null,
            side: filters.side ?? null,
            source: filters.source ?? null,
            bucketMs: filters.bucketMs ?? 60_000,
            includeNonExecutionEvidence: filters.includeNonExecutionEvidence ?? false,
            includeStrategies: filters.includeStrategies ?? null,
            excludeStrategies: filters.excludeStrategies ?? [],
            paperMode: filters.paperMode ?? null,
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
                includeNonExecutionEvidence: filters.includeNonExecutionEvidence ?? false,
                includeStrategies: filters.includeStrategies ?? null,
                excludeStrategies: filters.excludeStrategies ?? [],
            },
            summary: analytics.summary,
            series: analytics.series,
            histograms: analytics.histograms,
            breakdowns: analytics.breakdowns,
            anomalies: analytics.anomalies,
            slippageRealismDiagnostics: analytics.slippageRealismDiagnostics,
            totalEventsRaw: analytics.totalEventsRaw,
            totalEventsAnalyzed: analytics.totalEventsAnalyzed,
            excludedCounts: analytics.excludedCounts,
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

export default withLocalApi(withApiRouteContext(handler));
