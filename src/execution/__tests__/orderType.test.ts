import { describe, it, expect, afterEach } from 'vitest';
import { getExecutionOrderFlags, getExecutionOrderType } from '../orderType';

describe('execution order type', () => {
    afterEach(() => {
        delete process.env.EXECUTION_ORDER_TYPE;
    });

    it('defaults to IOC', () => {
        expect(getExecutionOrderType()).toBe('IOC');
        expect(getExecutionOrderFlags()).toEqual({ immediateOrCancel: true });
    });

    it('supports FOK via env', () => {
        process.env.EXECUTION_ORDER_TYPE = 'FOK';
        expect(getExecutionOrderType()).toBe('FOK');
        expect(getExecutionOrderFlags()).toEqual({ fillOrKill: true });
    });
});
