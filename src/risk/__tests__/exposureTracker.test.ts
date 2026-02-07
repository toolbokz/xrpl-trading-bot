/**
 * Tests for ExposureTracker durable persistence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExposureTracker } from '../../risk/exposureTracker';

// Mock the persistence layer to avoid real SQLite in tests
vi.mock('../../persistence/exposureStore', () => ({
    persistFillAndState: vi.fn(),
    loadExposureState: vi.fn().mockReturnValue(null),
    saveExposureState: vi.fn(),
    closeExposureDb: vi.fn(),
}));

import {
    persistFillAndState,
    loadExposureState,
    saveExposureState,
    closeExposureDb,
} from '../../persistence/exposureStore';

describe('ExposureTracker Persistence', () => {
    let tracker: ExposureTracker;

    beforeEach(() => {
        vi.clearAllMocks();
        tracker = new ExposureTracker();
        // Enable persistence explicitly (tests disable by default)
        tracker.setPersistence(true);
    });

    it('rehydrates from persisted state on setPairKey', () => {
        const mockState = {
            pairKey: 'XRP/RLUSD',
            netPositionBase: 42.5,
            totalBought: 100,
            totalSold: 57.5,
            fillCount: 15,
            lastFillMs: 1700000000000,
            lastMidPrice: 2.35,
            updatedAt: 1700000000000,
        };
        vi.mocked(loadExposureState).mockReturnValue(mockState);

        tracker.setPairKey('XRP/RLUSD');

        const snap = tracker.getSnapshot();
        expect(snap.netPositionBase).toBe(42.5);
        expect(snap.totalBought).toBe(100);
        expect(snap.totalSold).toBe(57.5);
        expect(snap.fillCount).toBe(15);
        expect(snap.lastMidPrice).toBe(2.35);
        expect(loadExposureState).toHaveBeenCalledWith('XRP/RLUSD');
    });

    it('starts fresh when no persisted state exists', () => {
        vi.mocked(loadExposureState).mockReturnValue(null);

        tracker.setPairKey('XRP/USDC');

        const snap = tracker.getSnapshot();
        expect(snap.netPositionBase).toBe(0);
        expect(snap.fillCount).toBe(0);
    });

    it('persists fill and state on recordFill', () => {
        vi.mocked(loadExposureState).mockReturnValue(null);
        tracker.setPairKey('XRP/RLUSD');
        tracker.updateMidPrice(2.5);

        tracker.recordFill('buy', 10, 'XRP/RLUSD', 2.5, 'trace-123');

        expect(persistFillAndState).toHaveBeenCalledTimes(1);
        const [fill, state] = vi.mocked(persistFillAndState).mock.calls[0];
        expect(fill.side).toBe('buy');
        expect(fill.sizeBase).toBe(10);
        expect(fill.pairKey).toBe('XRP/RLUSD');
        expect(fill.price).toBe(2.5);
        expect(fill.correlationId).toBe('trace-123');
        expect(state.netPositionBase).toBe(10);
    });

    it('does not persist when persistence is disabled', () => {
        tracker.setPersistence(false);
        tracker.setPairKey('XRP/RLUSD');

        tracker.recordFill('buy', 10, 'XRP/RLUSD');

        expect(persistFillAndState).not.toHaveBeenCalled();
    });

    it('reconcile corrects tracked position', () => {
        vi.mocked(loadExposureState).mockReturnValue(null);
        tracker.setPairKey('XRP/RLUSD');
        tracker.recordFill('buy', 10, 'XRP/RLUSD');

        // Ledger says we actually have 12 XRP net
        const corrected = tracker.reconcile(12);
        expect(corrected).toBe(true);
        expect(tracker.getSnapshot().netPositionBase).toBe(12);
        expect(saveExposureState).toHaveBeenCalled();
    });

    it('reconcile returns false when within tolerance', () => {
        vi.mocked(loadExposureState).mockReturnValue(null);
        tracker.setPairKey('XRP/RLUSD');
        tracker.recordFill('buy', 10, 'XRP/RLUSD');

        const corrected = tracker.reconcile(10.0005);
        expect(corrected).toBe(false);
    });

    it('flush persists current state', () => {
        vi.mocked(loadExposureState).mockReturnValue(null);
        tracker.setPairKey('XRP/RLUSD');
        tracker.recordFill('buy', 5, 'XRP/RLUSD');
        vi.clearAllMocks();

        tracker.flush();

        expect(saveExposureState).toHaveBeenCalledTimes(1);
        const state = vi.mocked(saveExposureState).mock.calls[0][0];
        expect(state.pairKey).toBe('XRP/RLUSD');
        expect(state.netPositionBase).toBe(5);
    });

    it('closePersistence flushes and closes DB', async () => {
        vi.mocked(loadExposureState).mockReturnValue(null);
        tracker.setPairKey('XRP/RLUSD');
        tracker.recordFill('buy', 5, 'XRP/RLUSD');
        vi.clearAllMocks();

        await tracker.closePersistence();

        expect(saveExposureState).toHaveBeenCalled();
        expect(closeExposureDb).toHaveBeenCalled();
    });

    it('reset clears in-memory state', () => {
        vi.mocked(loadExposureState).mockReturnValue(null);
        tracker.setPairKey('XRP/RLUSD');
        tracker.recordFill('buy', 10, 'XRP/RLUSD');

        tracker.reset();

        const snap = tracker.getSnapshot();
        expect(snap.netPositionBase).toBe(0);
        expect(snap.fillCount).toBe(0);
    });

    it('handles persistence errors gracefully', () => {
        vi.mocked(loadExposureState).mockReturnValue(null);
        vi.mocked(persistFillAndState).mockImplementation(() => {
            throw new Error('DB locked');
        });

        tracker.setPairKey('XRP/RLUSD');

        // Should not throw — persistence errors are swallowed
        expect(() => tracker.recordFill('buy', 10, 'XRP/RLUSD')).not.toThrow();
        expect(tracker.getSnapshot().netPositionBase).toBe(10);
    });

    it('handles rehydration errors gracefully', () => {
        vi.mocked(loadExposureState).mockImplementation(() => {
            throw new Error('DB corrupted');
        });

        // Should not throw — rehydration errors are swallowed
        expect(() => tracker.setPairKey('XRP/RLUSD')).not.toThrow();
        expect(tracker.getSnapshot().netPositionBase).toBe(0);
    });
});
