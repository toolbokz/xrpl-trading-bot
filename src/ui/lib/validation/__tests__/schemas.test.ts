/**
 * Sprint 2 Tests
 * - Input validation
 * - Circuit breaker persistence
 * - Graceful shutdown
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    validateBody,
    positionSizeSchema,
    tradingPairSchema,
    ordersUpdateSchema,
    ordersCancelSchema,
} from '../schemas';

describe('Input Validation Schemas', () => {
    describe('positionSizeSchema', () => {
        it('accepts valid positive size', () => {
            const result = validateBody({ size: 100 }, positionSizeSchema);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.size).toBe(100);
            }
        });

        it('accepts decimal size', () => {
            const result = validateBody({ size: 0.5 }, positionSizeSchema);
            expect(result.success).toBe(true);
        });

        it('rejects negative size', () => {
            const result = validateBody({ size: -10 }, positionSizeSchema);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.errors[0]?.field).toBe('size');
                expect(result.errors[0]?.message).toContain('positive');
            }
        });

        it('rejects zero size', () => {
            const result = validateBody({ size: 0 }, positionSizeSchema);
            expect(result.success).toBe(false);
        });

        it('rejects missing size', () => {
            const result = validateBody({}, positionSizeSchema);
            expect(result.success).toBe(false);
        });

        it('rejects non-number size', () => {
            const result = validateBody({ size: 'large' }, positionSizeSchema);
            expect(result.success).toBe(false);
        });

        it('rejects size exceeding maximum', () => {
            const result = validateBody({ size: 2_000_000 }, positionSizeSchema);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.errors[0]?.message).toContain('exceeds maximum');
            }
        });

        it('rejects Infinity', () => {
            const result = validateBody({ size: Infinity }, positionSizeSchema);
            expect(result.success).toBe(false);
        });
    });

    describe('tradingPairSchema', () => {
        it('accepts valid pairKey from TRADING_PAIRS', () => {
            const result = validateBody({ pairKey: 'XRP/RLUSD' }, tradingPairSchema);
            expect(result.success).toBe(true);
        });

        it('accepts another valid pairKey', () => {
            const result = validateBody({ pairKey: 'XRP/USDT' }, tradingPairSchema);
            expect(result.success).toBe(true);
        });

        it('rejects invalid pairKey not in TRADING_PAIRS', () => {
            const result = validateBody({ pairKey: 'XRP/INVALID' }, tradingPairSchema);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.errors[0]?.message).toContain('valid trading pair');
            }
        });

        it('rejects empty pairKey', () => {
            const result = validateBody({ pairKey: '' }, tradingPairSchema);
            expect(result.success).toBe(false);
        });

        it('rejects missing pairKey', () => {
            const result = validateBody({}, tradingPairSchema);
            expect(result.success).toBe(false);
        });

        it('rejects too long pairKey', () => {
            const result = validateBody({ pairKey: 'a'.repeat(101) }, tradingPairSchema);
            expect(result.success).toBe(false);
        });
    });

    describe('ordersUpdateSchema', () => {
        it('accepts valid settings', () => {
            const result = validateBody(
                { autoManageEnabled: true, stalenessThresholdSec: 120 },
                ordersUpdateSchema
            );
            expect(result.success).toBe(true);
        });

        it('accepts partial settings (autoManageEnabled only)', () => {
            const result = validateBody({ autoManageEnabled: false }, ordersUpdateSchema);
            expect(result.success).toBe(true);
        });

        it('accepts partial settings (stalenessThresholdSec only)', () => {
            const result = validateBody({ stalenessThresholdSec: 60 }, ordersUpdateSchema);
            expect(result.success).toBe(true);
        });

        it('accepts empty object', () => {
            const result = validateBody({}, ordersUpdateSchema);
            expect(result.success).toBe(true);
        });

        it('rejects negative stalenessThresholdSec', () => {
            const result = validateBody({ stalenessThresholdSec: -1 }, ordersUpdateSchema);
            expect(result.success).toBe(false);
        });

        it('rejects non-integer stalenessThresholdSec', () => {
            const result = validateBody({ stalenessThresholdSec: 60.5 }, ordersUpdateSchema);
            expect(result.success).toBe(false);
        });

        it('rejects stalenessThresholdSec exceeding maximum', () => {
            const result = validateBody({ stalenessThresholdSec: 4000 }, ordersUpdateSchema);
            expect(result.success).toBe(false);
        });
    });

    describe('ordersCancelSchema', () => {
        it('accepts valid sequence', () => {
            const result = validateBody({ sequence: 12345 }, ordersCancelSchema);
            expect(result.success).toBe(true);
        });

        it('rejects negative sequence', () => {
            const result = validateBody({ sequence: -1 }, ordersCancelSchema);
            expect(result.success).toBe(false);
        });

        it('rejects zero sequence', () => {
            const result = validateBody({ sequence: 0 }, ordersCancelSchema);
            expect(result.success).toBe(false);
        });

        it('rejects missing sequence', () => {
            const result = validateBody({}, ordersCancelSchema);
            expect(result.success).toBe(false);
        });

        it('rejects non-integer sequence', () => {
            const result = validateBody({ sequence: 123.45 }, ordersCancelSchema);
            expect(result.success).toBe(false);
        });
    });
});
