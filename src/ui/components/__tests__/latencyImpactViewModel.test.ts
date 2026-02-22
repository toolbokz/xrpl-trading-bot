import { describe, expect, it } from 'vitest';
import { deriveLatencyImpactViewModel, type LatencyImpactConfigModel, type LatencyImpactSummary } from '../latencyImpactViewModel';

function makeSummary(overrides: Partial<LatencyImpactSummary> = {}): LatencyImpactSummary {
    return {
        events: 100,
        fills: 90,
        rejects: 5,
        partials: 10,
        avgFillRatio: 0.88,
        avgSlippageBpsVsIntent: 1,
        avgImpactBps1m: 0.1,
        avgImpactBps5m: 0.15,
        avgRealizedSpreadBps1m: 0.4,
        avgRealizedSpreadBps5m: 0.35,
        avgDecisionToSubmitMs: 45,
        avgSubmitToValidatedMs: 180,
        avgDecisionToValidatedMs: 225,
        missingFillSnapshotRate: 0.01,
        missingAckRate: 0.05,
        missingMarkoutRate: 0.1,
        tsMonotonicityViolationRate: 0.0001,
        negRateAgeDelta: 0.01,
        weeklyP50DriftBps: 0.1,
        weeklyP90DriftBps: 0.15,
        ...overrides,
    };
}

function makeConfig(overrides: Partial<LatencyImpactConfigModel> = {}): LatencyImpactConfigModel {
    return {
        decisionFreshnessMs: 1000,
        sendFreshnessMs: 500,
        fillFreshnessMs: 500,
        maxTsMonotonicityViolationRate: 0.001,
        maxMissingFillSnapshotRate: 0.02,
        maxMissingAckRate: 0.2,
        maxMissingMarkoutRate: 0.4,
        maxNegRateAgeDelta: 0.05,
        slippageImprovementBps: 5,
        weeklyP50DriftLimitBps: 0.2,
        weeklyP90DriftLimitBps: 0.2,
        ...overrides,
    };
}

describe('latencyImpactViewModel', () => {
    it('returns NO_DATA when summary is missing', () => {
        const model = deriveLatencyImpactViewModel(null, makeConfig());
        expect(model.verdict).toBe('NO_DATA');
    });

    it('returns GOOD when latency and execution quality are healthy', () => {
        const model = deriveLatencyImpactViewModel(makeSummary(), makeConfig());
        expect(model.verdict).toBe('GOOD');
        expect(model.reasons[0]).toContain('within .env limits');
        expect(model.thresholdChecks.length).toBe(8);
        expect(model.thresholdChecks.every((check) => check.status === 'PASS')).toBe(true);
    });

    it('returns WARN when checks are close to threshold but not breached', () => {
        const model = deriveLatencyImpactViewModel(
            makeSummary({ avgDecisionToValidatedMs: 860, missingAckRate: 0.19, weeklyP90DriftBps: 0.175 }),
            makeConfig({ decisionFreshnessMs: 1000, maxMissingAckRate: 0.2, weeklyP90DriftLimitBps: 0.2 }),
        );
        expect(model.verdict).toBe('WARN');
        expect(model.warningChecks.length).toBeGreaterThan(0);
        expect(model.thresholdChecks.some((check) => check.status === 'WARN')).toBe(true);
    });

    it('returns DEGRADED when a hard policy threshold is breached', () => {
        const model = deriveLatencyImpactViewModel(
            makeSummary({
                missingFillSnapshotRate: 0.08,
                tsMonotonicityViolationRate: 0.005,
            }),
            makeConfig({ maxMissingFillSnapshotRate: 0.02, maxTsMonotonicityViolationRate: 0.001 }),
        );
        expect(model.verdict).toBe('DEGRADED');
        expect(model.breachedChecks.join(' ')).toContain('Missing fill snapshot rate');
        expect(model.thresholdChecks.some((check) => check.status === 'FAIL')).toBe(true);
    });
});
