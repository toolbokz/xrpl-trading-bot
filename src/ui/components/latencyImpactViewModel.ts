export interface LatencyImpactSummary {
    events: number;
    fills: number;
    rejects: number;
    partials: number;
    avgFillRatio: number | null;
    avgSlippageBpsVsIntent: number | null;
    avgImpactBps1m: number | null;
    avgImpactBps5m: number | null;
    avgRealizedSpreadBps1m: number | null;
    avgRealizedSpreadBps5m: number | null;
    avgDecisionToSubmitMs: number | null;
    avgSubmitToValidatedMs: number | null;
    avgDecisionToValidatedMs: number | null;
    missingFillSnapshotRate: number;
    missingAckRate: number;
    missingMarkoutRate: number;
    tsMonotonicityViolationRate: number;
    negRateAgeDelta: number;
    weeklyP50DriftBps: number | null;
    weeklyP90DriftBps: number | null;
}

export interface LatencyImpactConfigModel {
    quantiles?: number;
    defaultField?: string;
    decisionFreshnessMs: number;
    sendFreshnessMs: number;
    fillFreshnessMs: number;
    maxTsMonotonicityViolationRate: number;
    maxMissingFillSnapshotRate: number;
    maxMissingAckRate: number;
    maxMissingMarkoutRate: number;
    maxNegRateAgeDelta: number;
    slippageImprovementBps: number;
    weeklyP50DriftLimitBps: number;
    weeklyP90DriftLimitBps: number;
}

export type LatencyImpactVerdict = 'GOOD' | 'WARN' | 'DEGRADED' | 'NO_DATA';
export type ThresholdCheckStatus = 'PASS' | 'WARN' | 'FAIL';

const safeRate = (num: number, den: number): number => (den > 0 ? num / den : 0);

export interface LatencyImpactViewModel {
    verdict: LatencyImpactVerdict;
    reasons: string[];
    rejectRate: number;
    partialRate: number;
    latencyBudgetUsedPct: number | null;
    profitabilityScore: number | null;
    breachedChecks: string[];
    warningChecks: string[];
    thresholdChecks: Array<{
        key: string;
        label: string;
        actual: number | null;
        limit: number | null;
        unit: '%' | 'bps' | 'ms';
        status: ThresholdCheckStatus;
    }>;
}

export function deriveLatencyImpactViewModel(
    summary: LatencyImpactSummary | null,
    config: LatencyImpactConfigModel | null,
): LatencyImpactViewModel {
    if (!summary || !config || summary.events <= 0) {
        return {
            verdict: 'NO_DATA',
            reasons: ['Waiting for execution-quality samples'],
            rejectRate: 0,
            partialRate: 0,
            latencyBudgetUsedPct: null,
            profitabilityScore: null,
            breachedChecks: [],
            warningChecks: [],
            thresholdChecks: [],
        };
    }

    const breachedChecks: string[] = [];
    const warningChecks: string[] = [];
    const thresholdChecks: LatencyImpactViewModel['thresholdChecks'] = [];
    const reasons: string[] = [];
    const warnBuffer = 0.85;

    const rejectRate = safeRate(summary.rejects, summary.events);
    const partialRate = safeRate(summary.partials, summary.events);

    const avgLatency = summary.avgDecisionToValidatedMs;
    const budgetLatency = config.decisionFreshnessMs;
    const latencyBudgetUsedPct = avgLatency == null || budgetLatency <= 0
        ? null
        : (avgLatency / budgetLatency) * 100;

    const checkThreshold = (
        key: string,
        label: string,
        actual: number | null,
        limit: number | null,
        unit: '%' | 'bps' | 'ms',
    ) => {
        if (actual == null || limit == null || !Number.isFinite(actual) || !Number.isFinite(limit)) {
            thresholdChecks.push({ key, label, actual, limit, unit, status: 'PASS' });
            return;
        }

        const status: ThresholdCheckStatus = actual > limit
            ? 'FAIL'
            : (limit > 0 && actual >= limit * warnBuffer ? 'WARN' : 'PASS');

        thresholdChecks.push({ key, label, actual, limit, unit, status });
        if (status === 'FAIL') {
            if (unit === '%') {
                breachedChecks.push(`${label}: ${(actual * 100).toFixed(2)}% > ${(limit * 100).toFixed(2)}%`);
            } else if (unit === 'ms') {
                breachedChecks.push(`${label}: ${actual.toFixed(0)}ms > ${limit.toFixed(0)}ms`);
            } else {
                breachedChecks.push(`${label}: ${actual.toFixed(3)} bps > ${limit.toFixed(3)} bps`);
            }
        } else if (status === 'WARN') {
            if (unit === '%') {
                warningChecks.push(`${label}: ${(actual * 100).toFixed(2)}% near ${(limit * 100).toFixed(2)}%`);
            } else if (unit === 'ms') {
                warningChecks.push(`${label}: ${actual.toFixed(0)}ms near ${limit.toFixed(0)}ms`);
            } else {
                warningChecks.push(`${label}: ${actual.toFixed(3)} bps near ${limit.toFixed(3)} bps`);
            }
        }
    };

    checkThreshold('missingFillSnapshot', 'Missing fill snapshot rate', summary.missingFillSnapshotRate, config.maxMissingFillSnapshotRate, '%');
    checkThreshold('missingAck', 'Missing ack rate', summary.missingAckRate, config.maxMissingAckRate, '%');
    checkThreshold('missingMarkout', 'Missing markout rate', summary.missingMarkoutRate, config.maxMissingMarkoutRate, '%');
    checkThreshold('tsMonotonicity', 'Timestamp monotonicity violation rate', summary.tsMonotonicityViolationRate, config.maxTsMonotonicityViolationRate, '%');
    checkThreshold('negAgeDelta', 'Negative slippage age-delta rate', summary.negRateAgeDelta, config.maxNegRateAgeDelta, '%');
    checkThreshold('weeklyP50Drift', 'Weekly P50 drift', summary.weeklyP50DriftBps, config.weeklyP50DriftLimitBps, 'bps');
    checkThreshold('weeklyP90Drift', 'Weekly P90 drift', summary.weeklyP90DriftBps, config.weeklyP90DriftLimitBps, 'bps');
    checkThreshold('decisionToFillLatency', 'Decision-to-fill latency', avgLatency, budgetLatency, 'ms');

    const profitabilityScore = (
        (summary.avgRealizedSpreadBps1m ?? 0)
        + (summary.avgRealizedSpreadBps5m ?? 0)
        - Math.max(0, summary.avgImpactBps1m ?? 0)
        - Math.max(0, summary.avgImpactBps5m ?? 0)
    );
    const verdict: LatencyImpactVerdict = breachedChecks.length > 0
        ? 'DEGRADED'
        : warningChecks.length > 0
            ? 'WARN'
            : 'GOOD';

    if (breachedChecks.length > 0) {
        reasons.push(`Policy breaches: ${breachedChecks.length}`);
        reasons.push(...breachedChecks.slice(0, 3));
    } else if (warningChecks.length > 0) {
        reasons.push(`Near-threshold checks: ${warningChecks.length}`);
        reasons.push(...warningChecks.slice(0, 3));
    } else {
        reasons.push('All latency-impact policy checks are within .env limits');
    }

    return {
        verdict,
        reasons,
        rejectRate,
        partialRate,
        latencyBudgetUsedPct,
        profitabilityScore,
        breachedChecks,
        warningChecks,
        thresholdChecks,
    };
}
