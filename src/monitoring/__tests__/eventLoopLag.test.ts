/**
 * Tests for event loop lag tracker.
 */

import { describe, it, expect } from 'vitest';
import {
    shouldAutoPauseTrading,
    recordInfraLagSample,
    EventLoopLagTracker,
} from '../../monitoring/eventLoopLag';

describe('shouldAutoPauseTrading (pure function)', () => {
    const base = {
        eventLoopLagP95Ms: 5,
        cpuLoad: 30,
        lagLimitMs: 100,
        cpuLimit: 80,
    };

    it('returns false when all metrics healthy', () => {
        expect(shouldAutoPauseTrading(base)).toBe(false);
    });

    it('returns true when p95 exceeds lag limit', () => {
        expect(shouldAutoPauseTrading({ ...base, eventLoopLagP95Ms: 150 })).toBe(true);
    });

    it('returns true when CPU load exceeds limit', () => {
        expect(shouldAutoPauseTrading({ ...base, cpuLoad: 95 })).toBe(true);
    });

    it('returns false when both are at limit', () => {
        // At limit, not over
        expect(shouldAutoPauseTrading({ ...base, eventLoopLagP95Ms: 100, cpuLoad: 80 })).toBe(false);
    });
});

describe('recordInfraLagSample', () => {
    it('returns the measured lag', () => {
        const lag = recordInfraLagSample(500, 508);
        expect(lag).toBe(8);
    });

    it('clamps negative lag to zero', () => {
        const lag = recordInfraLagSample(500, 498);
        expect(lag).toBe(0);
    });

    it('handles zero expected interval', () => {
        const lag = recordInfraLagSample(0, 10);
        expect(lag).toBe(10);
    });
});

describe('EventLoopLagTracker', () => {
    it('starts in not-paused state', () => {
        const tracker = new EventLoopLagTracker({ lagLimitMs: 100 });
        expect(tracker.isAutoPaused()).toBe(false);
    });

    it('getState returns initial state', () => {
        const tracker = new EventLoopLagTracker();
        const state = tracker.getState();
        expect(state.sampleCount).toBe(0);
        expect(state.autoPaused).toBe(false);
        expect(state.running).toBe(false);
    });

    it('addSample tracks samples', () => {
        const tracker = new EventLoopLagTracker({ windowSize: 10 });
        tracker.addSample(5);
        tracker.addSample(10);
        tracker.addSample(15);
        const state = tracker.getState();
        expect(state.sampleCount).toBe(3);
    });

    it('getInfraSafetyState returns safety state', () => {
        const tracker = new EventLoopLagTracker({ lagLimitMs: 50 });
        tracker.addSample(100);
        tracker.addSample(100);
        tracker.addSample(100);
        const safety = tracker.getInfraSafetyState(30);
        expect(safety.eventLoopLagP95Ms).toBeGreaterThan(0);
        expect(safety.cpuLoad).toBe(30);
        expect(safety.unstable).toBe(true);
    });
});
