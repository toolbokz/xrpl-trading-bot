import { describe, it, expect, vi } from 'vitest';
import { schedulePostFillSnapshots, type PostFillSnapshot } from '../offerExecutor';

describe('schedulePostFillSnapshots', () => {
    it('fires 1s and 3s callbacks', () => {
        vi.useFakeTimers();
        const calls: PostFillSnapshot[] = [];

        schedulePostFillSnapshots({
            eventId: 'evt-1',
            getSnapshot: () => ({
                mid: 1.23,
                spreadBps: 12,
                flowCombined: 0.1,
                flowStrength: 0.2,
                flowRegime: 'normal',
            }),
            record1s: (snapshot) => calls.push(snapshot),
            record3s: (snapshot) => calls.push(snapshot),
            setTimeoutFn: setTimeout,
        });

        expect(calls.length).toBe(0);
        vi.advanceTimersByTime(1000);
        expect(calls.length).toBe(1);
        vi.advanceTimersByTime(2000);
        expect(calls.length).toBe(2);
        vi.useRealTimers();
    });
});
