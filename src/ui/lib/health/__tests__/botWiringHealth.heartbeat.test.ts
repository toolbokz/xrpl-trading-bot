import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateRuntimeHeartbeatLiveness } from '../botWiringHealth';

describe('evaluateRuntimeHeartbeatLiveness', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-23T00:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns OK when heartbeat is fresh', () => {
        const now = Date.now();
        const result = evaluateRuntimeHeartbeatLiveness({
            heartbeat: {
                ts: now - 5_000,
                tickId: 12,
                inFlight: false,
                lastError: null,
                lastSubmitTs: now - 6_000,
                lastValidatedTs: now - 5_500,
            },
            nowMs: now,
            maxAgeMs: 15_000,
            runtimeShouldBeRunning: true,
        });

        expect(result.liveness).toBe('OK');
        expect(result.ok).toBe(true);
        expect(result.heartbeat?.ageMs).toBe(5_000);
    });

    it('returns DEGRADED when heartbeat is stale while runtime should be running', () => {
        const now = Date.now();
        const result = evaluateRuntimeHeartbeatLiveness({
            heartbeat: {
                ts: now - 40_000,
                tickId: 13,
                inFlight: false,
                lastError: null,
                lastSubmitTs: now - 45_000,
                lastValidatedTs: now - 42_000,
            },
            nowMs: now,
            maxAgeMs: 15_000,
            runtimeShouldBeRunning: true,
        });

        expect(result.liveness).toBe('DEGRADED');
        expect(result.ok).toBe(false);
        expect(result.heartbeat?.ageMs).toBe(40_000);
    });

    it('returns FAIL when heartbeat is missing and runtime should be running', () => {
        const result = evaluateRuntimeHeartbeatLiveness({
            heartbeat: null,
            nowMs: Date.now(),
            maxAgeMs: 15_000,
            runtimeShouldBeRunning: true,
        });

        expect(result.liveness).toBe('FAIL');
        expect(result.ok).toBe(false);
        expect(result.heartbeat).toBeNull();
    });
});
