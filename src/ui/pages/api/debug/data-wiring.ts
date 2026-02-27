import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { feedbackEngine } from '../../../../analytics/feedbackEngine';
import { tradeHistory } from '../../../../analytics/tradeHistory';
import { getRuntimeInstance } from '../../../lib/runtimeBridge';
import type { ObservabilityEvent } from '../../../../observability/eventBus';

export const config = {
    api: { bodyParser: false },
};

type FieldStatus = 'yes' | 'no' | 'partial';

interface ConsumerWiringStatus {
    receives: {
        traceFields: FieldStatus;
        baselineFields: FieldStatus;
        expectedFields: FieldStatus;
        markouts: FieldStatus;
        runtimeLifecycle: FieldStatus;
    };
    uses: {
        traceFields: FieldStatus;
        baselineFields: FieldStatus;
        expectedFields: FieldStatus;
        markouts: FieldStatus;
        runtimeLifecycle: FieldStatus;
    };
    source: string;
    sampleKeys: string[];
}

interface DataWiringResponse {
    requestId: string;
    timestamp: string;
    requiredFields: {
        trace: string[];
        baseline: string[];
        expected: string[];
        markouts: string[];
        runtimeLifecyclePrefixes: string[];
    };
    tradeHistory: {
        count: number;
        latestTradeId: string | null;
        latestTracePresence: Record<string, boolean>;
    };
    runtimeLifecycle: {
        totalEventsScanned: number;
        countsByPrefix: {
            SUBMIT_: number;
            ORDER_: number;
            MARKOUT_: number;
        };
        correlatedCount: number;
        detailTradeIdMatchCount: number;
        sampleEventTypes: string[];
    };
    consumers: {
        adaptiveLearner: ConsumerWiringStatus & {
            datasetCount: number;
            sampleRegime: string | null;
            sampleEventKeys: string[];
            sampleTraceKeys: string[];
        };
        governance: ConsumerWiringStatus & {
            metricsKeys: string[];
            decisionInputKeys: string[];
        };
        regimeHeatmap: ConsumerWiringStatus & {
            totalTrades: number;
            heatmapCellKeys: string[];
        };
    };
}

const TRACE_FIELDS = [
    'decision_ts_ms',
    'submit_ts_ms',
    'submit_response_ts_ms',
    'validated_ts_ms',
    'fill_snapshot.fill_ts_ms',
];

const BASELINE_FIELDS = [
    'baseline_ts_ms',
    'baseline_best_bid',
    'baseline_best_ask',
    'baseline_mid',
    'baseline_spread_bps',
    'baseline_source',
    'baseline_book_age_ms',
];

const EXPECTED_FIELDS = [
    'expected_price',
    'expected_rule',
    'price_convention',
];

const MARKOUT_FIELDS = [
    'markouts.0.horizon_s',
    'markouts.0.status',
    'markouts.0.mark_price',
    'markouts.0.markout_bps',
    'markouts.0.due_ts_ms',
    'markouts.0.mark_ts_ms',
];

function hasPath(input: unknown, path: string): boolean {
    if (input == null) return false;
    const parts = path.split('.');
    let cursor: unknown = input;
    for (const part of parts) {
        if (cursor == null) return false;
        if (Array.isArray(cursor)) {
            const idx = Number(part);
            if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return false;
            cursor = cursor[idx];
            continue;
        }
        if (typeof cursor !== 'object') return false;
        const record = cursor as Record<string, unknown>;
        if (!(part in record)) return false;
        cursor = record[part];
    }
    return true;
}

function resolveStatus(values: boolean[]): FieldStatus {
    if (values.length === 0) return 'no';
    const hits = values.filter(Boolean).length;
    if (hits === 0) return 'no';
    if (hits === values.length) return 'yes';
    return 'partial';
}

function prefixOf(eventType: string): 'SUBMIT_' | 'ORDER_' | 'MARKOUT_' | null {
    if (eventType.startsWith('SUBMIT_')) return 'SUBMIT_';
    if (eventType.startsWith('ORDER_')) return 'ORDER_';
    if (eventType.startsWith('MARKOUT_')) return 'MARKOUT_';
    return null;
}

function handler(req: LocalRequest, res: NextApiResponse<DataWiringResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const trades = tradeHistory.getRecentTrades(200);
        const latestWithTrace = trades.find((trade) => trade.trace != null) ?? null;
        const latestTrace = latestWithTrace?.trace ?? null;
        const latestTracePresence = Object.fromEntries(
            [...TRACE_FIELDS, ...BASELINE_FIELDS, ...EXPECTED_FIELDS, ...MARKOUT_FIELDS].map((path) => [
                path,
                hasPath(latestTrace, path),
            ]),
        );

        const runtime = getRuntimeInstance();
        const bus = runtime?.getObservabilityBus?.();
        const lifecycleEvents = (bus?.getRecent(500) ?? []).filter((event: ObservabilityEvent) => prefixOf(event.eventType) !== null);
        const countsByPrefix = {
            SUBMIT_: 0,
            ORDER_: 0,
            MARKOUT_: 0,
        };
        let correlatedCount = 0;
        let detailTradeIdMatchCount = 0;
        for (const event of lifecycleEvents) {
            const prefix = prefixOf(event.eventType);
            if (prefix) {
                countsByPrefix[prefix] += 1;
            }
            if (typeof event.correlationId === 'string' && event.correlationId.length > 0) {
                correlatedCount += 1;
            }
            const detailTradeId = typeof (event.detail as Record<string, unknown> | undefined)?.trade_id === 'string'
                ? ((event.detail as Record<string, unknown>).trade_id as string)
                : null;
            if (detailTradeId && detailTradeId === event.correlationId) {
                detailTradeIdMatchCount += 1;
            }
        }

        const dataset = feedbackEngine.getLearningDataset({ sinceMs: Date.now() - (24 * 60 * 60 * 1000) });
        const datasetSample = dataset[0];
        const adaptiveEventKeys = datasetSample ? Object.keys(datasetSample.event).sort() : [];
        const adaptiveTrace = datasetSample?.trace ?? null;
        const adaptiveTraceKeys = adaptiveTrace ? Object.keys(adaptiveTrace).sort() : [];
        const adaptiveTracePresence = TRACE_FIELDS.map((field) => hasPath(adaptiveTrace, field));
        const adaptiveBaselinePresence = BASELINE_FIELDS.map((field) => hasPath(adaptiveTrace, field));
        const adaptiveExpectedPresence = EXPECTED_FIELDS.map((field) => hasPath(adaptiveTrace, field));
        const adaptiveMarkoutPresence = MARKOUT_FIELDS.map((field) => hasPath(adaptiveTrace, field));

        const rollingMetrics = feedbackEngine.getRollingRiskMetrics({
            ...(latestWithTrace?.pair ? { pairKey: latestWithTrace.pair } : {}),
            lookbackTrades: 200,
        });
        const governanceMetricsKeys = Object.keys(rollingMetrics).sort();
        const governanceDecisionInputKeys = [
            'tradesCount',
            'profitFactor',
            'expectancyBps',
            'drawdownPct',
            'drawdownConfidence',
            'peakEquity',
            'avgSlippageBps',
            'partialFillRate',
            'consecutiveFailures',
        ];

        const heatmap = feedbackEngine.getRegimeHeatmap({ lookbackHours: 24, minTrades: 1, byStrategy: true });
        const heatmapSampleCell = heatmap.global.normal;
        const heatmapCellKeys = heatmapSampleCell ? Object.keys(heatmapSampleCell).sort() : [];

        const response: DataWiringResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            requiredFields: {
                trace: TRACE_FIELDS,
                baseline: BASELINE_FIELDS,
                expected: EXPECTED_FIELDS,
                markouts: MARKOUT_FIELDS,
                runtimeLifecyclePrefixes: ['SUBMIT_', 'ORDER_', 'MARKOUT_'],
            },
            tradeHistory: {
                count: trades.length,
                latestTradeId: latestWithTrace?.id ?? null,
                latestTracePresence,
            },
            runtimeLifecycle: {
                totalEventsScanned: lifecycleEvents.length,
                countsByPrefix,
                correlatedCount,
                detailTradeIdMatchCount,
                sampleEventTypes: lifecycleEvents.slice(0, 12).map((event) => event.eventType),
            },
            consumers: {
                adaptiveLearner: {
                    receives: {
                        traceFields: resolveStatus(adaptiveTracePresence),
                        baselineFields: resolveStatus(adaptiveBaselinePresence),
                        expectedFields: resolveStatus(adaptiveExpectedPresence),
                        markouts: resolveStatus(adaptiveMarkoutPresence),
                        runtimeLifecycle: 'no',
                    },
                    uses: {
                        traceFields: 'no',
                        baselineFields: 'no',
                        expectedFields: 'no',
                        markouts: 'no',
                        runtimeLifecycle: 'no',
                    },
                    source: 'feedbackEngine.getLearningDataset() => trade_events + market_snapshots (+ joined trade.trace)',
                    sampleKeys: adaptiveEventKeys,
                    datasetCount: dataset.length,
                    sampleRegime: datasetSample?.regime ?? null,
                    sampleEventKeys: adaptiveEventKeys,
                    sampleTraceKeys: adaptiveTraceKeys,
                },
                governance: {
                    receives: {
                        traceFields: 'no',
                        baselineFields: 'no',
                        expectedFields: 'no',
                        markouts: 'no',
                        runtimeLifecycle: 'no',
                    },
                    uses: {
                        traceFields: 'no',
                        baselineFields: 'no',
                        expectedFields: 'no',
                        markouts: 'no',
                        runtimeLifecycle: 'no',
                    },
                    source: 'CapitalProtectionEngine -> feedbackEngine.getRollingRiskMetrics() -> trade_events',
                    sampleKeys: governanceMetricsKeys,
                    metricsKeys: governanceMetricsKeys,
                    decisionInputKeys: governanceDecisionInputKeys,
                },
                regimeHeatmap: {
                    receives: {
                        traceFields: 'no',
                        baselineFields: 'no',
                        expectedFields: 'no',
                        markouts: 'no',
                        runtimeLifecycle: 'no',
                    },
                    uses: {
                        traceFields: 'no',
                        baselineFields: 'no',
                        expectedFields: 'no',
                        markouts: 'no',
                        runtimeLifecycle: 'no',
                    },
                    source: 'feedbackEngine.getRegimeHeatmap() -> trade_events + market_snapshots -> /api/analytics/regimes/heatmap',
                    sampleKeys: heatmapCellKeys,
                    totalTrades: heatmap.meta.totalTrades,
                    heatmapCellKeys,
                },
            },
        };

        return res.status(200).json(response);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return res.status(500).json({ error: message });
    }
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET'], skipAudit: true });
