import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../security/localOnly', () => ({
    enforceLocalOnly: vi.fn(),
}));

import { TradingRuntime } from '../tradingRuntime';

type HeartbeatWriterHarness = TradingRuntime & {
    writeTickHeartbeat: (tickId: number, inFlight: boolean, lastError: string | null) => void;
    heartbeatLastSubmitTs: number | null;
    heartbeatLastValidatedTs: number | null;
};

describe('TradingRuntime heartbeat writer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-23T00:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('writes heartbeat snapshots into runtime cache storage', () => {
        const runtime = new TradingRuntime();
        const harness = runtime as unknown as HeartbeatWriterHarness;
        const startTs = Date.now();

        harness.heartbeatLastSubmitTs = startTs - 500;
        harness.heartbeatLastValidatedTs = startTs - 250;
        harness.writeTickHeartbeat(10, true, null);

        const firstHeartbeat = runtime.getCacheRegistry().getSnapshot().heartbeat;
        expect(firstHeartbeat).toEqual({
            ts: startTs,
            tickId: 10,
            inFlight: true,
            lastError: null,
            lastSubmitTs: startTs - 500,
            lastValidatedTs: startTs - 250,
        });

        vi.advanceTimersByTime(1000);
        const endTs = Date.now();
        harness.writeTickHeartbeat(10, false, 'tick failed');

        const finalHeartbeat = runtime.getCacheRegistry().getSnapshot().heartbeat;
        expect(finalHeartbeat).toEqual({
            ts: endTs,
            tickId: 10,
            inFlight: false,
            lastError: 'tick failed',
            lastSubmitTs: startTs - 500,
            lastValidatedTs: startTs - 250,
        });
    });
});
