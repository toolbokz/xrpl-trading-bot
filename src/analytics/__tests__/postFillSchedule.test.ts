import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('post-fill scheduling', () => {
    let feedbackEngine: typeof import('../feedbackEngine').feedbackEngine;
    let schedulePostFillSnapshots: typeof import('../../execution/offerExecutor').schedulePostFillSnapshots;
    let queryTradeEvents: typeof import('../feedbackDb').queryTradeEvents;

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        process.env.FEEDBACK_DB_PATH = ':memory:';

        ({ feedbackEngine } = await import('../feedbackEngine'));
        ({ schedulePostFillSnapshots } = await import('../../execution/offerExecutor'));
        ({ queryTradeEvents } = await import('../feedbackDb'));
    });

    afterEach(async () => {
        feedbackEngine.shutdown();
        const mod = await import('../feedbackDb');
        mod.closeFeedbackDb();
        vi.useRealTimers();
    });

    it('captures 1s and 3s post-fill snapshots for the same trade event', () => {
        const eventId = feedbackEngine.recordTradeEvent({
            pairKey: 'XRP/USD',
            strategy: 'test',
            action: 'fill',
            side: 'buy',
            fillPrice: 1.0,
            fillSizeBase: 1.0,
        });

        expect(eventId).toBeTruthy();

        let callCount = 0;
        schedulePostFillSnapshots({
            eventId: eventId as string,
            getSnapshot: () => {
                const isFirst = callCount === 0;
                callCount += 1;
                return isFirst
                    ? { mid: 1.01, spreadBps: 10, flowCombined: 0.1, flowStrength: 0.2, flowRegime: 'normal' }
                    : { mid: 1.02, spreadBps: 9, flowCombined: 0.12, flowStrength: 0.25, flowRegime: 'normal' };
            },
            record1s: (snapshot) => {
                feedbackEngine.recordPostFillSnapshot1s({
                    id: eventId as string,
                    postMid1s: snapshot.mid,
                    postSpread1s: snapshot.spreadBps,
                    postFlowCombined1s: snapshot.flowCombined,
                    postFlowStrength1s: snapshot.flowStrength,
                    postFlowRegime1s: snapshot.flowRegime,
                    postSignal1s: snapshot.flowStrength,
                });
            },
            record3s: (snapshot) => {
                feedbackEngine.recordPostFillSnapshot3s({
                    id: eventId as string,
                    postMid3s: snapshot.mid,
                    postSpread3s: snapshot.spreadBps,
                    postFlowCombined3s: snapshot.flowCombined,
                    postFlowStrength3s: snapshot.flowStrength,
                    postFlowRegime3s: snapshot.flowRegime,
                    postSignal3s: snapshot.flowStrength,
                });
            },
        });

        vi.advanceTimersByTime(1000);
        vi.runOnlyPendingTimers();

        vi.advanceTimersByTime(2000);
        vi.runOnlyPendingTimers();

        const events = queryTradeEvents();
        const event = events.find((e) => e.id === eventId);
        expect(event?.postMid1s).toBeCloseTo(1.01);
        expect(event?.postMid3s).toBeCloseTo(1.02);
    });
});
