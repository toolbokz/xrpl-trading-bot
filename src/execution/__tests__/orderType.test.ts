import { describe, it, expect, afterEach } from 'vitest';
import { getExecutionMode, getExecutionOrderFlags, getExecutionOrderType } from '../orderType';

describe('execution order type', () => {
    afterEach(() => {
        delete process.env.EXECUTION_ORDER_TYPE;
        delete process.env.EXECUTION_MIN_FILL_RATIO;
        delete process.env.FEATURE_STRICT_CONFIG;
    });

    it('defaults to IOC', () => {
        expect(getExecutionOrderType()).toBe('IOC');
        expect(getExecutionOrderFlags()).toEqual({ immediateOrCancel: true });
        expect(getExecutionMode().minFillRatio).toBe(0.5);
    });

    it('supports FOK via env', () => {
        process.env.EXECUTION_ORDER_TYPE = 'FOK';
        expect(getExecutionOrderType()).toBe('FOK');
        expect(getExecutionOrderFlags()).toEqual({ fillOrKill: true });
        expect(getExecutionMode().minFillRatio).toBe(1);
    });

    it('overrides invalid FOK min fill ratio to 1.0 when strict mode is disabled', () => {
        process.env.EXECUTION_ORDER_TYPE = 'FOK';
        process.env.EXECUTION_MIN_FILL_RATIO = '0.5';
        process.env.FEATURE_STRICT_CONFIG = '0';

        const mode = getExecutionMode();
        expect(mode.resolvedOrderType).toBe('FOK');
        expect(mode.minFillRatio).toBe(1);
    });

    it('throws on invalid FOK min fill ratio when strict mode is enabled', () => {
        process.env.EXECUTION_ORDER_TYPE = 'FOK';
        process.env.EXECUTION_MIN_FILL_RATIO = '0.5';
        process.env.FEATURE_STRICT_CONFIG = '1';

        expect(() => getExecutionMode()).toThrow(/FOK requires EXECUTION_MIN_FILL_RATIO=1.0/);
    });
});
