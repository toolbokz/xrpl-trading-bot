import { describe, it, expect, beforeEach } from 'vitest';
import {
    HardRiskGuard,
    HardRiskInput,
    HardRiskConfig,
    HardRiskState,
    HardRiskBlockReason,
    HardRiskResult,
    HardRiskPayload,
    loadHardRiskConfig,
} from '../hardRiskGuard';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A fully healthy input — all conditions CLEAR. */
function clearInput(): HardRiskInput {
    return {
        currentExposureNotional: 0,
        inventorySkewPct: 0,
        drawdownPct: 0,
        runtimeReady: true,
        marketDataValid: true,
        balanceStalenessMs: 0,
        feedHealthScore: 100,
    };
}

/** Custom config with tight thresholds for easier testing. */
function tightConfig(): HardRiskConfig {
    return {
        maxExposureNotional: 1000,
        maxInventorySkewPct: 50,
        maxDrawdownPct: 5,
        maxBalanceStalenessMs: 60_000,
        minFeedHealthScore: 30,
        warningThresholdRatio: 0.8,
        maxEvents: 10,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// HardRiskGuard — Core Evaluation
// ─────────────────────────────────────────────────────────────────────────────

describe('HardRiskGuard', () => {
    let guard: HardRiskGuard;

    beforeEach(() => {
        guard = new HardRiskGuard(tightConfig());
        guard.setPairKey('XRP/RLUSD');
    });

    // ─── CLEAR state ─────────────────────────────────────────────────────

    describe('CLEAR state', () => {
        it('returns CLEAR when all conditions are healthy', () => {
            const result = guard.evaluate(clearInput());
            expect(result.riskState).toBe('CLEAR');
            expect(result.executionAllowed).toBe(true);
            expect(result.riskBlockReasons).toEqual([]);
            expect(result.warningReasons).toEqual([]);
        });

        it('returns CLEAR metrics snapshot', () => {
            const result = guard.evaluate(clearInput());
            expect(result.metrics.currentExposureNotional).toBe(0);
            expect(result.metrics.inventorySkewPct).toBe(0);
            expect(result.metrics.drawdownPct).toBe(0);
            expect(result.metrics.runtimeReady).toBe(true);
            expect(result.metrics.marketDataValid).toBe(true);
            expect(result.metrics.balancesFresh).toBe(true);
            expect(result.metrics.feedHealthy).toBe(true);
        });

        it('provides evaluatedAt timestamp', () => {
            const before = Date.now();
            const result = guard.evaluate(clearInput());
            const after = Date.now();
            expect(result.evaluatedAt).toBeGreaterThanOrEqual(before);
            expect(result.evaluatedAt).toBeLessThanOrEqual(after);
        });
    });

    // ─── Individual block conditions ─────────────────────────────────────

    describe('Block condition 1: exposure limit exceeded', () => {
        it('blocks when exposure exceeds max', () => {
            const input = { ...clearInput(), currentExposureNotional: 1001 };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('BLOCKED');
            expect(result.executionAllowed).toBe(false);
            expect(result.riskBlockReasons).toContain('exposure-limit-exceeded');
        });

        it('does not block at exactly the limit', () => {
            const input = { ...clearInput(), currentExposureNotional: 1000 };
            const result = guard.evaluate(input);
            expect(result.riskState).not.toBe('BLOCKED');
            expect(result.riskBlockReasons).not.toContain('exposure-limit-exceeded');
        });
    });

    describe('Block condition 2: inventory skew exceeded', () => {
        it('blocks when positive skew exceeds max', () => {
            const input = { ...clearInput(), inventorySkewPct: 51 };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('BLOCKED');
            expect(result.executionAllowed).toBe(false);
            expect(result.riskBlockReasons).toContain('inventory-skew-exceeded');
        });

        it('blocks when negative skew exceeds max', () => {
            const input = { ...clearInput(), inventorySkewPct: -51 };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('BLOCKED');
            expect(result.riskBlockReasons).toContain('inventory-skew-exceeded');
        });

        it('does not block at exactly the limit', () => {
            const input = { ...clearInput(), inventorySkewPct: 50 };
            const result = guard.evaluate(input);
            expect(result.riskBlockReasons).not.toContain('inventory-skew-exceeded');
        });
    });

    describe('Block condition 3: drawdown breached', () => {
        it('blocks when drawdown exceeds max', () => {
            const input = { ...clearInput(), drawdownPct: 5.1 };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('BLOCKED');
            expect(result.executionAllowed).toBe(false);
            expect(result.riskBlockReasons).toContain('drawdown-breached');
        });

        it('does not block at exactly the limit', () => {
            const input = { ...clearInput(), drawdownPct: 5.0 };
            const result = guard.evaluate(input);
            expect(result.riskBlockReasons).not.toContain('drawdown-breached');
        });
    });

    describe('Block condition 4: runtime not ready', () => {
        it('blocks when runtime is not ready', () => {
            const input = { ...clearInput(), runtimeReady: false };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('BLOCKED');
            expect(result.executionAllowed).toBe(false);
            expect(result.riskBlockReasons).toContain('runtime-not-ready');
        });
    });

    describe('Block condition 5: market data invalid', () => {
        it('blocks when market data is invalid', () => {
            const input = { ...clearInput(), marketDataValid: false };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('BLOCKED');
            expect(result.executionAllowed).toBe(false);
            expect(result.riskBlockReasons).toContain('market-data-invalid');
        });
    });

    describe('Block condition 6: balances stale', () => {
        it('blocks when balances are stale beyond threshold', () => {
            const input = { ...clearInput(), balanceStalenessMs: 60_001 };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('BLOCKED');
            expect(result.executionAllowed).toBe(false);
            expect(result.riskBlockReasons).toContain('balances-stale');
        });

        it('does not block at exactly the threshold', () => {
            const input = { ...clearInput(), balanceStalenessMs: 60_000 };
            const result = guard.evaluate(input);
            expect(result.riskBlockReasons).not.toContain('balances-stale');
        });
    });

    describe('Block condition 7: feed degraded', () => {
        it('blocks when feed health score is below minimum', () => {
            const input = { ...clearInput(), feedHealthScore: 29 };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('BLOCKED');
            expect(result.executionAllowed).toBe(false);
            expect(result.riskBlockReasons).toContain('feed-degraded');
        });

        it('does not block at exactly the threshold', () => {
            const input = { ...clearInput(), feedHealthScore: 30 };
            const result = guard.evaluate(input);
            expect(result.riskBlockReasons).not.toContain('feed-degraded');
        });
    });

    // ─── Multiple simultaneous blocks ────────────────────────────────────

    describe('multiple simultaneous blocks', () => {
        it('reports all block reasons when multiple conditions breached', () => {
            const input: HardRiskInput = {
                currentExposureNotional: 2000,
                inventorySkewPct: -90,
                drawdownPct: 10,
                runtimeReady: false,
                marketDataValid: false,
                balanceStalenessMs: 200_000,
                feedHealthScore: 10,
            };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('BLOCKED');
            expect(result.executionAllowed).toBe(false);
            expect(result.riskBlockReasons).toHaveLength(7);
            expect(result.riskBlockReasons).toContain('exposure-limit-exceeded');
            expect(result.riskBlockReasons).toContain('inventory-skew-exceeded');
            expect(result.riskBlockReasons).toContain('drawdown-breached');
            expect(result.riskBlockReasons).toContain('runtime-not-ready');
            expect(result.riskBlockReasons).toContain('market-data-invalid');
            expect(result.riskBlockReasons).toContain('balances-stale');
            expect(result.riskBlockReasons).toContain('feed-degraded');
        });

        it('blocks on two conditions and lists both reasons', () => {
            const input = {
                ...clearInput(),
                currentExposureNotional: 1500,
                drawdownPct: 8,
            };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('BLOCKED');
            expect(result.riskBlockReasons).toHaveLength(2);
            expect(result.riskBlockReasons).toContain('exposure-limit-exceeded');
            expect(result.riskBlockReasons).toContain('drawdown-breached');
        });
    });

    // ─── WARNING state ───────────────────────────────────────────────────

    describe('WARNING state', () => {
        it('warns when exposure approaches limit (>80%)', () => {
            // 80% of 1000 = 800, so 801 should warn
            const input = { ...clearInput(), currentExposureNotional: 801 };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('WARNING');
            expect(result.executionAllowed).toBe(true);
            expect(result.warningReasons).toContain('exposure-limit-exceeded');
        });

        it('warns when inventory skew approaches limit', () => {
            // 80% of 50 = 40, so 41 should warn
            const input = { ...clearInput(), inventorySkewPct: 41 };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('WARNING');
            expect(result.warningReasons).toContain('inventory-skew-exceeded');
        });

        it('warns when drawdown approaches limit', () => {
            // 80% of 5 = 4, so 4.1 should warn
            const input = { ...clearInput(), drawdownPct: 4.1 };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('WARNING');
            expect(result.warningReasons).toContain('drawdown-breached');
        });

        it('warns when balance staleness approaches limit', () => {
            // 80% of 60_000 = 48_000, so 48_001 should warn
            const input = { ...clearInput(), balanceStalenessMs: 48_001 };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('WARNING');
            expect(result.warningReasons).toContain('balances-stale');
        });

        it('does not warn when below warning threshold', () => {
            // 79% of 1000 = 790
            const input = { ...clearInput(), currentExposureNotional: 790 };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('CLEAR');
        });

        it('block overrides warning (block + warning → BLOCKED)', () => {
            const input = {
                ...clearInput(),
                currentExposureNotional: 1500, // blocked
                drawdownPct: 4.1,              // warning
            };
            const result = guard.evaluate(input);
            expect(result.riskState).toBe('BLOCKED');
            expect(result.executionAllowed).toBe(false);
            expect(result.riskBlockReasons).toContain('exposure-limit-exceeded');
            expect(result.warningReasons).toContain('drawdown-breached');
        });
    });

    // ─── State transitions & events ──────────────────────────────────────

    describe('state transitions and event emission', () => {
        it('emits RISK_LIMIT_BLOCK when transitioning CLEAR → BLOCKED', () => {
            // Start CLEAR
            guard.evaluate(clearInput());
            const eventsBefore = guard.getRecentEvents();
            expect(eventsBefore).toHaveLength(0);

            // Transition to BLOCKED
            guard.evaluate({ ...clearInput(), drawdownPct: 10 });
            const events = guard.getRecentEvents();
            expect(events).toHaveLength(1);
            expect(events[0]!.type).toBe('RISK_LIMIT_BLOCK');
            expect(events[0]!.pairKey).toBe('XRP/RLUSD');
            expect(events[0]!.reasons).toContain('drawdown-breached');
        });

        it('emits RISK_LIMIT_RECOVERY when transitioning BLOCKED → CLEAR', () => {
            // Start BLOCKED
            guard.evaluate({ ...clearInput(), drawdownPct: 10 });
            // Note: first BLOCKED from default wasBlocked=false also emits BLOCK event
            const blockEvents = guard.getRecentEvents();
            expect(blockEvents.some(e => e.type === 'RISK_LIMIT_BLOCK')).toBe(true);

            // Transition to CLEAR
            guard.evaluate(clearInput());
            const events = guard.getRecentEvents();
            expect(events.some(e => e.type === 'RISK_LIMIT_RECOVERY')).toBe(true);
        });

        it('emits RISK_LIMIT_WARNING on WARNING state', () => {
            guard.evaluate(clearInput());
            guard.evaluate({ ...clearInput(), currentExposureNotional: 900 });
            const events = guard.getRecentEvents();
            expect(events.some(e => e.type === 'RISK_LIMIT_WARNING')).toBe(true);
        });

        it('does not emit BLOCK event when staying BLOCKED', () => {
            // Become blocked
            guard.evaluate({ ...clearInput(), drawdownPct: 10 });
            const eventsAfterFirst = guard.getPayload().recentEvents.length;

            // Stay blocked — no new BLOCK event
            guard.evaluate({ ...clearInput(), drawdownPct: 12 });
            const eventsAfterSecond = guard.getPayload().recentEvents.length;
            expect(eventsAfterSecond).toBe(eventsAfterFirst);
        });

        it('does not emit RECOVERY event when staying CLEAR', () => {
            guard.evaluate(clearInput());
            guard.evaluate(clearInput());
            const events = guard.getPayload().recentEvents;
            expect(events.filter(e => e.type === 'RISK_LIMIT_RECOVERY')).toHaveLength(0);
        });

        it('full cycle: CLEAR → BLOCKED → CLEAR emits BLOCK then RECOVERY', () => {
            guard.evaluate(clearInput());
            guard.evaluate({ ...clearInput(), currentExposureNotional: 2000 });
            guard.evaluate(clearInput());

            const events = guard.getPayload().recentEvents;
            expect(events).toHaveLength(2);
            expect(events[0]!.type).toBe('RISK_LIMIT_BLOCK');
            expect(events[1]!.type).toBe('RISK_LIMIT_RECOVERY');
        });
    });

    // ─── Event ring buffer ───────────────────────────────────────────────

    describe('event ring buffer', () => {
        it('limits events to maxEvents config', () => {
            // Config maxEvents = 10
            // Generate 12 block/recovery cycles = 24 events, but capped at 10
            for (let i = 0; i < 12; i++) {
                guard.evaluate({ ...clearInput(), drawdownPct: 10 }); // BLOCK
                guard.evaluate(clearInput()); // RECOVERY
            }
            const events = guard.getPayload().recentEvents;
            expect(events.length).toBeLessThanOrEqual(10);
        });

        it('preserves most recent events when buffer is full', () => {
            for (let i = 0; i < 12; i++) {
                guard.evaluate({ ...clearInput(), drawdownPct: 10 });
                guard.evaluate(clearInput());
            }
            const events = guard.getPayload().recentEvents;
            // Last event should be RECOVERY (from last cycle)
            expect(events[events.length - 1]!.type).toBe('RISK_LIMIT_RECOVERY');
        });
    });

    // ─── Pair scoping ────────────────────────────────────────────────────

    describe('pair scoping', () => {
        it('events carry the active pair key', () => {
            guard.setPairKey('XRP/RLUSD');
            guard.evaluate({ ...clearInput(), drawdownPct: 10 });
            expect(guard.getRecentEvents()[0]!.pairKey).toBe('XRP/RLUSD');
        });

        it('pair key changes are reflected in subsequent events', () => {
            guard.evaluate({ ...clearInput(), drawdownPct: 10 }); // BLOCK for XRP/RLUSD
            guard.setPairKey('XRP/USD');
            guard.evaluate(clearInput()); // RECOVERY under XRP/USD
            const events = guard.getRecentEvents();
            const blockEvent = events.find(e => e.type === 'RISK_LIMIT_BLOCK');
            const recoveryEvent = events.find(e => e.type === 'RISK_LIMIT_RECOVERY');
            expect(blockEvent!.pairKey).toBe('XRP/RLUSD');
            expect(recoveryEvent!.pairKey).toBe('XRP/USD');
        });

        it('payload reports active pair key', () => {
            guard.setPairKey('XRP/USD');
            guard.evaluate(clearInput());
            const payload = guard.getPayload();
            expect(payload.pairKey).toBe('XRP/USD');
        });
    });

    // ─── Reset ───────────────────────────────────────────────────────────

    describe('reset', () => {
        it('clears all state', () => {
            guard.setPairKey('XRP/RLUSD');
            guard.evaluate({ ...clearInput(), drawdownPct: 10 });
            expect(guard.getLastResult()?.riskState).toBe('BLOCKED');

            guard.reset();
            expect(guard.getLastResult()).toBeNull();
            expect(guard.getPayload().pairKey).toBe('');
            expect(guard.getPayload().recentEvents).toHaveLength(0);
        });

        it('reset allows clean re-evaluation', () => {
            guard.evaluate({ ...clearInput(), drawdownPct: 10 }); // BLOCKED
            guard.reset();
            guard.setPairKey('XRP/USD');

            // First evaluation after reset should not carry over blocked state
            const result = guard.evaluate(clearInput());
            expect(result.riskState).toBe('CLEAR');
            expect(result.executionAllowed).toBe(true);
        });
    });

    // ─── getPayload / getLastResult ──────────────────────────────────────

    describe('getPayload', () => {
        it('returns empty result before first evaluation', () => {
            const payload = guard.getPayload();
            expect(payload.result.riskState).toBe('CLEAR');
            expect(payload.result.executionAllowed).toBe(false); // pre-evaluation = not allowed
            expect(payload.result.evaluatedAt).toBe(0);
        });

        it('returns full payload after evaluation', () => {
            guard.evaluate(clearInput());
            const payload = guard.getPayload();
            expect(payload.pairKey).toBe('XRP/RLUSD');
            expect(payload.result.riskState).toBe('CLEAR');
            expect(payload.result.executionAllowed).toBe(true);
            expect(payload.thresholds.maxExposureNotional).toBe(1000);
            expect(payload.thresholds.maxDrawdownPct).toBe(5);
        });

        it('includes thresholds from config', () => {
            const payload = guard.getPayload();
            expect(payload.thresholds).toEqual(tightConfig());
        });
    });

    describe('getLastResult', () => {
        it('returns null before first evaluation', () => {
            expect(guard.getLastResult()).toBeNull();
        });

        it('returns the last evaluation result', () => {
            guard.evaluate(clearInput());
            const result = guard.getLastResult();
            expect(result).not.toBeNull();
            expect(result!.riskState).toBe('CLEAR');
        });
    });

    // ─── getConfig ───────────────────────────────────────────────────────

    describe('getConfig', () => {
        it('returns a copy of the config', () => {
            const config = guard.getConfig();
            expect(config.maxExposureNotional).toBe(1000);
            // Mutating the returned copy should not affect the guard
            config.maxExposureNotional = 99999;
            expect(guard.getConfig().maxExposureNotional).toBe(1000);
        });
    });

    // ─── Default config ──────────────────────────────────────────────────

    describe('default config', () => {
        it('uses safe defaults when no config provided', () => {
            const defaultGuard = new HardRiskGuard();
            const config = defaultGuard.getConfig();
            expect(config.maxExposureNotional).toBe(5_000);
            expect(config.maxInventorySkewPct).toBe(80);
            expect(config.maxDrawdownPct).toBe(7);
            expect(config.maxBalanceStalenessMs).toBe(120_000);
            expect(config.minFeedHealthScore).toBe(40);
            expect(config.warningThresholdRatio).toBe(0.8);
            expect(config.maxEvents).toBe(100);
        });

        it('allows partial config overrides', () => {
            const g = new HardRiskGuard({ maxExposureNotional: 999 });
            expect(g.getConfig().maxExposureNotional).toBe(999);
            expect(g.getConfig().maxDrawdownPct).toBe(7); // default preserved
        });
    });

    // ─── getRecentEvents ─────────────────────────────────────────────────

    describe('getRecentEvents', () => {
        it('returns events newest-first', () => {
            guard.evaluate({ ...clearInput(), drawdownPct: 10 }); // BLOCK
            guard.evaluate(clearInput()); // RECOVERY
            const events = guard.getRecentEvents();
            expect(events[0]!.type).toBe('RISK_LIMIT_RECOVERY');
            expect(events[1]!.type).toBe('RISK_LIMIT_BLOCK');
        });

        it('respects limit parameter', () => {
            guard.evaluate({ ...clearInput(), drawdownPct: 10 });
            guard.evaluate(clearInput());
            guard.evaluate({ ...clearInput(), drawdownPct: 10 });
            guard.evaluate(clearInput());
            const events = guard.getRecentEvents(2);
            expect(events).toHaveLength(2);
        });
    });

    // ─── Metrics accuracy ────────────────────────────────────────────────

    describe('metrics accuracy', () => {
        it('balancesFresh is false when stale exceeds max', () => {
            const result = guard.evaluate({ ...clearInput(), balanceStalenessMs: 70_000 });
            expect(result.metrics.balancesFresh).toBe(false);
        });

        it('balancesFresh is true when within threshold', () => {
            const result = guard.evaluate({ ...clearInput(), balanceStalenessMs: 50_000 });
            expect(result.metrics.balancesFresh).toBe(true);
        });

        it('feedHealthy is false when score below min', () => {
            const result = guard.evaluate({ ...clearInput(), feedHealthScore: 20 });
            expect(result.metrics.feedHealthy).toBe(false);
        });

        it('feedHealthy is true when score at or above min', () => {
            const result = guard.evaluate({ ...clearInput(), feedHealthScore: 30 });
            expect(result.metrics.feedHealthy).toBe(true);
        });

        it('passes through numeric input values', () => {
            const input: HardRiskInput = {
                currentExposureNotional: 123.45,
                inventorySkewPct: -67,
                drawdownPct: 2.5,
                runtimeReady: true,
                marketDataValid: true,
                balanceStalenessMs: 5000,
                feedHealthScore: 85,
            };
            const result = guard.evaluate(input);
            expect(result.metrics.currentExposureNotional).toBe(123.45);
            expect(result.metrics.inventorySkewPct).toBe(-67);
            expect(result.metrics.drawdownPct).toBe(2.5);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadHardRiskConfig — env var loading
// ─────────────────────────────────────────────────────────────────────────────

describe('loadHardRiskConfig', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        // Reset env vars that tests may have set
        delete process.env.HARD_RISK_MAX_EXPOSURE;
        delete process.env.HARD_RISK_MAX_SKEW_PCT;
        delete process.env.HARD_RISK_MAX_DRAWDOWN_PCT;
        delete process.env.HARD_RISK_MAX_BALANCE_STALE_MS;
        delete process.env.HARD_RISK_MIN_FEED_HEALTH;
    });

    it('returns empty object when no env vars set', () => {
        const config = loadHardRiskConfig();
        expect(Object.keys(config)).toHaveLength(0);
    });

    it('parses HARD_RISK_MAX_EXPOSURE', () => {
        process.env.HARD_RISK_MAX_EXPOSURE = '2500';
        const config = loadHardRiskConfig();
        expect(config.maxExposureNotional).toBe(2500);
    });

    it('parses HARD_RISK_MAX_SKEW_PCT', () => {
        process.env.HARD_RISK_MAX_SKEW_PCT = '60';
        const config = loadHardRiskConfig();
        expect(config.maxInventorySkewPct).toBe(60);
    });

    it('parses HARD_RISK_MAX_DRAWDOWN_PCT', () => {
        process.env.HARD_RISK_MAX_DRAWDOWN_PCT = '3.5';
        const config = loadHardRiskConfig();
        expect(config.maxDrawdownPct).toBe(3.5);
    });

    it('parses HARD_RISK_MAX_BALANCE_STALE_MS', () => {
        process.env.HARD_RISK_MAX_BALANCE_STALE_MS = '90000';
        const config = loadHardRiskConfig();
        expect(config.maxBalanceStalenessMs).toBe(90000);
    });

    it('parses HARD_RISK_MIN_FEED_HEALTH', () => {
        process.env.HARD_RISK_MIN_FEED_HEALTH = '50';
        const config = loadHardRiskConfig();
        expect(config.minFeedHealthScore).toBe(50);
    });

    it('ignores invalid (non-finite) values', () => {
        process.env.HARD_RISK_MAX_EXPOSURE = 'notanumber';
        const config = loadHardRiskConfig();
        expect(config.maxExposureNotional).toBeUndefined();
    });
});
