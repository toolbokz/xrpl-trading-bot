import { describe, expect, it } from 'vitest';
import { hasOrderFilledEvent } from '../runtimeEvents';

describe('hasOrderFilledEvent', () => {
    it('returns true when ORDER_FILLED is present', () => {
        const events = [
            { eventType: 'ORDER_PLACED' },
            { eventType: 'ORDER_FILLED' },
        ];
        expect(hasOrderFilledEvent(events)).toBe(true);
    });

    it('returns false when ORDER_FILLED is absent', () => {
        const events = [
            { eventType: 'FSM_TRANSITION' },
            { eventType: 'ORDER_PLACED' },
        ];
        expect(hasOrderFilledEvent(events)).toBe(false);
    });

    it('handles malformed event payloads safely', () => {
        const events: unknown[] = [null, 1, 'event', { nope: true }];
        expect(hasOrderFilledEvent(events)).toBe(false);
    });
});
