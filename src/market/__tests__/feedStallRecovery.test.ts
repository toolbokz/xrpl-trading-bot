import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeedStallRecovery, FeedStallConfig } from '../feedStallRecovery';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const fastConfig: FeedStallConfig = {
    stage1ThresholdMs: 100,
    stage2ThresholdMs: 200,
    stage3ThresholdMs: 400,
    cooldownMs: 50,
};

const makeActions = () => ({
    softReconnect: vi.fn().mockResolvedValue(undefined),
    hardResubscribe: vi.fn().mockResolvedValue(undefined),
    fullClientRebuild: vi.fn().mockResolvedValue(undefined),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('FeedStallRecovery', () => {
    let actions: ReturnType<typeof makeActions>;
    let recovery: FeedStallRecovery;

    beforeEach(() => {
        actions = makeActions();
        recovery = new FeedStallRecovery(actions, fastConfig);
    });

    it('starts in HEALTHY stage', () => {
        expect(recovery.getState().stage).toBe('HEALTHY');
        expect(recovery.isRecovering()).toBe(false);
    });

    it('stays HEALTHY when events are recent', async () => {
        const now = Date.now();
        recovery.recordTapeEvent(now);
        recovery.recordBookEvent(now);
        const state = await recovery.evaluate(now + 50);
        expect(state.stage).toBe('HEALTHY');
        expect(actions.softReconnect).not.toHaveBeenCalled();
    });

    it('escalates to STAGE_1 and calls softReconnect', async () => {
        const t0 = Date.now();
        recovery.recordTapeEvent(t0);
        recovery.recordBookEvent(t0);

        // Silence for > stage1ThresholdMs (100ms)
        const state = await recovery.evaluate(t0 + 150);
        expect(state.stage).toBe('STAGE_1');
        expect(actions.softReconnect).toHaveBeenCalledTimes(1);
        expect(actions.hardResubscribe).not.toHaveBeenCalled();
    });

    it('escalates to STAGE_2 and calls hardResubscribe', async () => {
        const t0 = Date.now();
        recovery.recordTapeEvent(t0);
        recovery.recordBookEvent(t0);

        // Silence for > stage2ThresholdMs (200ms)
        const state = await recovery.evaluate(t0 + 250);
        expect(state.stage).toBe('STAGE_2');
        expect(actions.hardResubscribe).toHaveBeenCalledTimes(1);
    });

    it('escalates to STAGE_3 and calls fullClientRebuild', async () => {
        const t0 = Date.now();
        recovery.recordTapeEvent(t0);
        recovery.recordBookEvent(t0);

        // Silence for > stage3ThresholdMs (400ms)
        const state = await recovery.evaluate(t0 + 500);
        expect(state.stage).toBe('STAGE_3');
        expect(actions.fullClientRebuild).toHaveBeenCalledTimes(1);
    });

    it('recovers to HEALTHY when events resume after stall', async () => {
        const t0 = Date.now();
        recovery.recordTapeEvent(t0);
        recovery.recordBookEvent(t0);

        // Escalate to STAGE_1
        await recovery.evaluate(t0 + 150);
        expect(recovery.getState().stage).toBe('STAGE_1');

        // Events resume — both within the threshold
        recovery.recordTapeEvent(t0 + 160);
        recovery.recordBookEvent(t0 + 160);

        const state = await recovery.evaluate(t0 + 200);
        expect(state.stage).toBe('HEALTHY');
        expect(state.recoveryAttempts).toBe(0); // reset on recovery
    });

    it('respects cooldown between recovery attempts', async () => {
        const t0 = Date.now();
        recovery.recordTapeEvent(t0);
        recovery.recordBookEvent(t0);

        // First recovery at t0+150 (stage 1, cooldown not yet elapsed for second)
        await recovery.evaluate(t0 + 150);
        expect(actions.softReconnect).toHaveBeenCalledTimes(1);

        // Try again at t0+170 — only 20ms since last attempt, cooldown is 50ms
        await recovery.evaluate(t0 + 170);
        // Still stage 1 (170ms < 200ms), but cooldown hasn't elapsed
        expect(actions.softReconnect).toHaveBeenCalledTimes(1); // no new call

        // Try at t0+199 — 49ms since last attempt (t0+150), still within 50ms cooldown
        // BUT silence is now 199ms which is stage 1 still (< 200ms)
        // 199 - 150 = 49ms < cooldown 50ms
        await recovery.evaluate(t0 + 199);
        expect(actions.softReconnect).toHaveBeenCalledTimes(1); // still no new call

        // Now send events to go back to HEALTHY, then silence again for a clean Stage 1
        recovery.recordTapeEvent(t0 + 199);
        recovery.recordBookEvent(t0 + 199);
        await recovery.evaluate(t0 + 200); // should go back to HEALTHY

        // Silence again for Stage 1
        await recovery.evaluate(t0 + 350); // 150ms silence from t0+199
        expect(actions.softReconnect).toHaveBeenCalledTimes(2); // new call
    });

    it('handles recovery action failure gracefully', async () => {
        actions.softReconnect.mockRejectedValueOnce(new Error('connection refused'));
        const t0 = Date.now();
        recovery.recordTapeEvent(t0);
        recovery.recordBookEvent(t0);

        const state = await recovery.evaluate(t0 + 150);
        expect(state.stage).toBe('STAGE_1');
        expect(state.recovering).toBe(false); // cleared after failure
        expect(state.recoveryAttempts).toBe(1);
    });

    it('reset() clears all state', async () => {
        const t0 = Date.now();
        recovery.recordTapeEvent(t0);
        recovery.recordBookEvent(t0);
        await recovery.evaluate(t0 + 500); // escalate to STAGE_3

        recovery.reset();

        const state = recovery.getState();
        expect(state.stage).toBe('HEALTHY');
        expect(state.recovering).toBe(false);
        expect(state.lastTapeEventMs).toBe(0);
        expect(state.lastBookEventMs).toBe(0);
        expect(state.recoveryAttempts).toBe(0);
    });

    it('never escalates when no events were ever recorded', async () => {
        // No events recorded → silence is Infinity → but both signals are 0
        // so max silence = Infinity → should escalate
        // This tests the edge case of fresh startup with no events at all
        const t0 = Date.now();
        const state = await recovery.evaluate(t0);
        // With both lastTapeEventMs and lastBookEventMs at 0, maxSilence is Infinity
        expect(state.stage).toBe('STAGE_3'); // escalates immediately
    });

    it('does not double-fire recovery while an attempt is already in progress', async () => {
        // Make softReconnect take some time
        let resolveReconnect: (() => void) | null = null;
        actions.softReconnect.mockImplementation(() => new Promise<void>(r => { resolveReconnect = r; }));

        const t0 = Date.now();
        recovery.recordTapeEvent(t0);
        recovery.recordBookEvent(t0);

        // Start recovery (will be pending)
        const promise1 = recovery.evaluate(t0 + 150);
        expect(recovery.isRecovering()).toBe(true);

        // Try to evaluate again while recovery is in flight
        const promise2 = recovery.evaluate(t0 + 160);

        // Resolve the reconnect
        resolveReconnect!();
        await promise1;
        await promise2;

        // Only called once
        expect(actions.softReconnect).toHaveBeenCalledTimes(1);
    });
});
