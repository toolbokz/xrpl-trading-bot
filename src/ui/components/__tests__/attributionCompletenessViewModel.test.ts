import { describe, expect, it } from 'vitest';
import {
    deriveAttributionCompletenessViewModel,
    type AttributionCompletenessConfigModel,
    type AttributionCompletenessInput,
} from '../attributionCompletenessViewModel';

function makeInput(overrides: Partial<AttributionCompletenessInput> = {}): AttributionCompletenessInput {
    return {
        daily: { events: 1000, unknownRate: 0.004, collisionsPer10k: 0.5, orphanFillsPer10k: 0.5 },
        weekly: { events: 3000, unknownRate: 0.003, collisionsPer10k: 0.8, orphanFillsPer10k: 0.8 },
        monthly: { events: 9000, unknownRate: 0.0015, collisionsPer10k: 1, orphanFillsPer10k: 0.5 },
        tsMonotonicityRate30d: 0.0004,
        ...overrides,
    };
}

function makeConfig(overrides: Partial<AttributionCompletenessConfigModel> = {}): AttributionCompletenessConfigModel {
    return {
        unknownRateMaxDaily: 0.01,
        unknownRateMax7d: 0.005,
        unknownRateMax30d: 0.002,
        collisionsMaxPer10k: 2,
        orphanFillsMaxPer10k: 1,
        orphanOrdersMaxPer10k: 1,
        dupFinalMaxPer10k: 1,
        derivedShareMax: 0.05,
        derivedReversalMax: 0.01,
        quarantineP95MaxHours: 24,
        tsMonotonicityMaxRate: 0.001,
        ...overrides,
    };
}

describe('attributionCompletenessViewModel', () => {
    it('returns GOOD when measurable checks pass', () => {
        const model = deriveAttributionCompletenessViewModel(makeInput(), makeConfig());
        expect(model.verdict).toBe('GOOD');
        expect(model.checks.length).toBeGreaterThan(0);
    });

    it('returns WARN when near threshold', () => {
        const model = deriveAttributionCompletenessViewModel(
            makeInput({ daily: { events: 1000, unknownRate: 0.009, collisionsPer10k: 1.2, orphanFillsPer10k: 0.8 } }),
            makeConfig({ unknownRateMaxDaily: 0.01 }),
        );
        expect(model.verdict).toBe('WARN');
    });

    it('returns DEGRADED when threshold is breached', () => {
        const model = deriveAttributionCompletenessViewModel(
            makeInput({ monthly: { events: 9000, unknownRate: 0.004, collisionsPer10k: 3.5, orphanFillsPer10k: 1.8 } }),
            makeConfig({ unknownRateMax30d: 0.002, collisionsMaxPer10k: 2 }),
        );
        expect(model.verdict).toBe('DEGRADED');
    });
});
