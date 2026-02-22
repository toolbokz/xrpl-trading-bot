import { describe, expect, it } from 'vitest';
import { deriveSlippageRealismViewModel, type SlippageRealismConfigModel, type SlippageRealismSummary } from '../slippageRealismViewModel';

function makeSummary(overrides: Partial<SlippageRealismSummary> = {}): SlippageRealismSummary {
    return {
        events: 100,
        fills: 95,
        avgDecisionToValidatedMs: 280,
        missingFillSnapshotRate: 0.01,
        staleFillSnapshotRate: 0.01,
        tsMonotonicityViolationRate: 0.0002,
        negSlippageRate: 0.04,
        tooGoodRate: 0.02,
        tooBadRate: 0.03,
        ...overrides,
    };
}

function makeConfig(overrides: Partial<SlippageRealismConfigModel> = {}): SlippageRealismConfigModel {
    return {
        decisionFreshnessMs: 1000,
        maxMissingFillSnapshotRate: 0.02,
        maxStaleFillSnapshotRate: 0.02,
        maxTsMonotonicityViolationRate: 0.001,
        maxTouchSanityViolationRate: 0.0005,
        maxRecomputeMismatchRate: 0.01,
        maxNegRateTier1: 0.05,
        maxNegRateTier2: 0.1,
        maxNegRateTier3: 0.15,
        tooGoodBpsBuffer: 2,
        tooBadBpsBuffer: 5,
        sizeMonotonicityBps: 5,
        ...overrides,
    };
}

describe('slippageRealismViewModel', () => {
    it('returns GOOD when measurable checks pass', () => {
        const model = deriveSlippageRealismViewModel(makeSummary(), makeConfig());
        expect(model.verdict).toBe('GOOD');
        expect(model.checks.some((check) => check.status === 'PASS')).toBe(true);
    });

    it('returns WARN when near threshold', () => {
        const model = deriveSlippageRealismViewModel(
            makeSummary({ negSlippageRate: 0.048 }),
            makeConfig({ maxNegRateTier1: 0.05 }),
        );
        expect(model.verdict).toBe('WARN');
    });

    it('returns DEGRADED when threshold is breached', () => {
        const model = deriveSlippageRealismViewModel(
            makeSummary({ missingFillSnapshotRate: 0.08 }),
            makeConfig({ maxMissingFillSnapshotRate: 0.02 }),
        );
        expect(model.verdict).toBe('DEGRADED');
    });
});
