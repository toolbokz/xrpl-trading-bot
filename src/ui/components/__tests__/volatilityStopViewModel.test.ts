import { describe, expect, it } from 'vitest';
import type { VolatilityStopApiResponse } from '../../pages/api/bot/volatility-stop';
import {
    deriveEffectiveStopBps,
    deriveVolatilityStopMode,
    deriveWarmupProgressPct,
} from '../volatilityStopViewModel';

function makePayload(overrides: Partial<VolatilityStopApiResponse> = {}): VolatilityStopApiResponse {
    return {
        requestId: 'test',
        timestamp: '2026-01-01T00:00:00.000Z',
        pairKey: 'XRP/RLUSD',
        asOfMs: 1,
        stalenessMs: 0,
        executionAllowed: true,
        runtimeState: 'READY',
        config: {
            enabled: true,
            warmupMs: 60_000,
            minSamples: 50,
            alpha: 0.2,
            multiplier: 2,
            minBps: 50,
            maxBps: 250,
            useForEnhanced: true,
            fixedStopLossBps: 60,
        },
        runtime: {
            enabled: true,
            volBps: 8,
            volReady: false,
            sampleCount: 20,
            stopLossBpsUsed: 60,
            enhancedStopBpsUsed: 30,
            source: 'fixed-warmup',
        },
        ...overrides,
    };
}

describe('volatilityStopViewModel', () => {
    it('returns OFF when config is disabled', () => {
        const payload = makePayload({
            config: { ...makePayload().config, enabled: false },
        });
        expect(deriveVolatilityStopMode(payload)).toBe('OFF');
    });

    it('returns ACTIVE when runtime is ready and adaptive', () => {
        const payload = makePayload({
            runtime: { ...makePayload().runtime!, volReady: true, source: 'adaptive' },
        });
        expect(deriveVolatilityStopMode(payload)).toBe('ACTIVE');
    });

    it('returns WARMING when enabled but not adaptive-ready', () => {
        const payload = makePayload();
        expect(deriveVolatilityStopMode(payload)).toBe('WARMING');
    });

    it('computes warmup progress using sample count and min samples', () => {
        const payload = makePayload({
            config: { ...makePayload().config, minSamples: 40 },
            runtime: { ...makePayload().runtime!, sampleCount: 10, volReady: false },
        });
        expect(deriveWarmupProgressPct(payload)).toBe(25);
    });

    it('uses live stop when available, falls back to fixed config otherwise', () => {
        const withRuntime = makePayload({
            runtime: { ...makePayload().runtime!, stopLossBpsUsed: 72.5 },
        });
        expect(deriveEffectiveStopBps(withRuntime)).toBe(72.5);

        const withoutRuntime = makePayload({ runtime: null });
        expect(deriveEffectiveStopBps(withoutRuntime)).toBe(60);
    });
});
