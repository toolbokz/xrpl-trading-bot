/**
 * Tests for the unified order sizing pipeline (one-knob sizing).
 *
 * @module execution/__tests__/orderSizing.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    computeFinalOrderSizeXrp,
    loadOrderSizingConfig,
    deriveMinBaseXrp,
    deriveMinQuoteRlusd,
    logSizingConfigSummary,
    type OrderSizingConfig,
    type OrderSizingContext,
    type CpMode,
} from '../orderSizing';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCfg(overrides: Partial<OrderSizingConfig> = {}): OrderSizingConfig {
    return {
        baseOrderSizeXrp: 1.2,
        maxTradeSize: 1.5,
        executionMinBaseFrac: 0.25,
        explicitMinBaseXrp: null,
        explicitMinQuoteRlusd: null,
        ...overrides,
    };
}

function makeCtx(overrides: Partial<OrderSizingContext> = {}): OrderSizingContext {
    return {
        cpMode: 'NORMAL',
        cpSizeMult: 1.0,
        regimeSizeMult: 1.0,
        adaptiveSizeMult: 1.0,
        strategy: 'test-strategy',
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Config loading: BASE_ORDER_SIZE_XRP precedence over POSITION_SIZE_XRP
// ─────────────────────────────────────────────────────────────────────────────

describe('loadOrderSizingConfig', () => {
    const original = { ...process.env };

    afterEach(() => {
        // Restore env
        for (const key of Object.keys(process.env)) {
            if (!(key in original)) delete process.env[key];
        }
        Object.assign(process.env, original);
    });

    it('prefers BASE_ORDER_SIZE_XRP over POSITION_SIZE_XRP', () => {
        const env: Record<string, string> = {
            BASE_ORDER_SIZE_XRP: '2.5',
            POSITION_SIZE_XRP: '1.0',
            MAX_TRADE_SIZE: '10',
        };
        const cfg = loadOrderSizingConfig(env as unknown as NodeJS.ProcessEnv);
        expect(cfg.baseOrderSizeXrp).toBe(2.5);
    });

    it('falls back to POSITION_SIZE_XRP when BASE_ORDER_SIZE_XRP is not set', () => {
        const env: Record<string, string> = {
            POSITION_SIZE_XRP: '3.0',
            MAX_TRADE_SIZE: '10',
        };
        const cfg = loadOrderSizingConfig(env as unknown as NodeJS.ProcessEnv);
        expect(cfg.baseOrderSizeXrp).toBe(3.0);
    });

    it('defaults to 5 when neither knob is set', () => {
        const env: Record<string, string> = {};
        const cfg = loadOrderSizingConfig(env as unknown as NodeJS.ProcessEnv);
        expect(cfg.baseOrderSizeXrp).toBe(5);
    });

    it('reads EXECUTION_MIN_BASE_FRAC', () => {
        const env: Record<string, string> = {
            BASE_ORDER_SIZE_XRP: '2',
            EXECUTION_MIN_BASE_FRAC: '0.5',
        };
        const cfg = loadOrderSizingConfig(env as unknown as NodeJS.ProcessEnv);
        expect(cfg.executionMinBaseFrac).toBe(0.5);
    });

    it('defaults EXECUTION_MIN_BASE_FRAC to 0.25', () => {
        const env: Record<string, string> = { BASE_ORDER_SIZE_XRP: '2' };
        const cfg = loadOrderSizingConfig(env as unknown as NodeJS.ProcessEnv);
        expect(cfg.executionMinBaseFrac).toBe(0.25);
    });

    it('reads explicit EXECUTION_MIN_BASE_XRP', () => {
        const env: Record<string, string> = {
            BASE_ORDER_SIZE_XRP: '2',
            EXECUTION_MIN_BASE_XRP: '0.75',
        };
        const cfg = loadOrderSizingConfig(env as unknown as NodeJS.ProcessEnv);
        expect(cfg.explicitMinBaseXrp).toBe(0.75);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Derived min base scales with BASE_ORDER_SIZE_XRP
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveMinBaseXrp', () => {
    it('computes min from fraction when no explicit min is set', () => {
        const cfg = makeCfg({ baseOrderSizeXrp: 4.0, executionMinBaseFrac: 0.25, explicitMinBaseXrp: null });
        expect(deriveMinBaseXrp(cfg)).toBe(1.0);
    });

    it('scales with base order size', () => {
        // 2x base → 2x min
        const small = makeCfg({ baseOrderSizeXrp: 1.0, executionMinBaseFrac: 0.25, explicitMinBaseXrp: null });
        const large = makeCfg({ baseOrderSizeXrp: 2.0, executionMinBaseFrac: 0.25, explicitMinBaseXrp: null });
        expect(deriveMinBaseXrp(large)).toBe(2 * deriveMinBaseXrp(small));
    });

    it('takes max of explicit and derived', () => {
        // derived = 4 * 0.25 = 1.0; explicit = 0.5 → max = 1.0
        const cfg = makeCfg({ baseOrderSizeXrp: 4.0, executionMinBaseFrac: 0.25, explicitMinBaseXrp: 0.5 });
        expect(deriveMinBaseXrp(cfg)).toBe(1.0);
    });

    it('uses explicit min when it is larger', () => {
        // derived = 1 * 0.25 = 0.25; explicit = 0.5 → max = 0.5
        const cfg = makeCfg({ baseOrderSizeXrp: 1.0, executionMinBaseFrac: 0.25, explicitMinBaseXrp: 0.5 });
        expect(deriveMinBaseXrp(cfg)).toBe(0.5);
    });
});

describe('deriveMinQuoteRlusd', () => {
    it('derives from mid price when available', () => {
        const cfg = makeCfg({ baseOrderSizeXrp: 4.0, executionMinBaseFrac: 0.25 });
        // 4.0 * 2.0 * 0.25 = 2.0
        expect(deriveMinQuoteRlusd(cfg, 2.0)).toBe(2.0);
    });

    it('falls back to explicit when no mid price', () => {
        const cfg = makeCfg({ explicitMinQuoteRlusd: 0.6 });
        expect(deriveMinQuoteRlusd(cfg, null)).toBe(0.6);
    });

    it('falls back to proportional min when nothing is available', () => {
        // baseOrderSizeXrp=1.2, executionMinBaseFrac=0.25 → 1.2 * 0.25 = 0.30
        const cfg = makeCfg({ explicitMinQuoteRlusd: null });
        expect(deriveMinQuoteRlusd(cfg, null)).toBeCloseTo(0.30, 6);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Normal mode: final = base * regime * adaptive (cp=1)
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFinalOrderSizeXrp — NORMAL mode', () => {
    it('final = base * regime * adaptive when all multipliers are 1', () => {
        const cfg = makeCfg({ baseOrderSizeXrp: 1.2, maxTradeSize: 10 });
        const ctx = makeCtx();
        const result = computeFinalOrderSizeXrp(ctx, cfg);

        expect(result.skip).toBe(false);
        expect(result.finalSize).toBeCloseTo(1.2, 6);
        expect(result.cpMult).toBe(1.0);
        expect(result.regimeMult).toBe(1.0);
        expect(result.adaptiveMult).toBe(1.0);
    });

    it('applies regime multiplier', () => {
        const cfg = makeCfg({ baseOrderSizeXrp: 2.0, maxTradeSize: 10 });
        const ctx = makeCtx({ regimeSizeMult: 0.5 });
        const result = computeFinalOrderSizeXrp(ctx, cfg);

        expect(result.skip).toBe(false);
        expect(result.finalSize).toBeCloseTo(1.0, 6);
    });

    it('applies adaptive multiplier', () => {
        const cfg = makeCfg({ baseOrderSizeXrp: 2.0, maxTradeSize: 10 });
        const ctx = makeCtx({ adaptiveSizeMult: 0.84 });
        const result = computeFinalOrderSizeXrp(ctx, cfg);

        expect(result.skip).toBe(false);
        expect(result.finalSize).toBeCloseTo(1.68, 6);
    });

    it('clamps to maxTradeSize', () => {
        const cfg = makeCfg({ baseOrderSizeXrp: 5.0, maxTradeSize: 1.5 });
        const ctx = makeCtx();
        const result = computeFinalOrderSizeXrp(ctx, cfg);

        expect(result.skip).toBe(false);
        expect(result.finalSize).toBe(1.5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THROTTLE shrinkage causing final < min triggers "skip" not "reject"
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFinalOrderSizeXrp — THROTTLE skip', () => {
    it('skips when THROTTLE shrinks final below min', () => {
        // base=1.2, cp=0.1, regime=1, adaptive=1 → raw=0.12
        // min = 1.2 * 0.25 = 0.3 → 0.12 < 0.3 → skip
        const cfg = makeCfg({ baseOrderSizeXrp: 1.2, maxTradeSize: 10 });
        const ctx = makeCtx({ cpMode: 'THROTTLE', cpSizeMult: 0.1 });
        const result = computeFinalOrderSizeXrp(ctx, cfg);

        expect(result.skip).toBe(true);
        expect(result.reason).toContain('final<min');
        expect(result.finalSize).toBeCloseTo(0.12, 6);
        expect(result.minSize).toBeCloseTo(0.3, 6);
    });

    it('does NOT skip when THROTTLE does not shrink below min', () => {
        // base=1.2, cp=0.5, regime=1, adaptive=1 → raw=0.6
        // min = 1.2 * 0.25 = 0.3 → 0.6 >= 0.3 → no skip
        const cfg = makeCfg({ baseOrderSizeXrp: 1.2, maxTradeSize: 10 });
        const ctx = makeCtx({ cpMode: 'THROTTLE', cpSizeMult: 0.5 });
        const result = computeFinalOrderSizeXrp(ctx, cfg);

        expect(result.skip).toBe(false);
        expect(result.finalSize).toBeCloseTo(0.6, 6);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. PAUSE multiplier makes final size 0 and causes skip
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFinalOrderSizeXrp — PAUSE mode', () => {
    it('skips when PAUSE sets multiplier to 0', () => {
        const cfg = makeCfg({ baseOrderSizeXrp: 1.2, maxTradeSize: 10 });
        const ctx = makeCtx({ cpMode: 'PAUSE', cpSizeMult: 0.0 });
        const result = computeFinalOrderSizeXrp(ctx, cfg);

        expect(result.skip).toBe(true);
        expect(result.finalSize).toBe(0);
        expect(result.reason).toContain('final<min');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Combined multipliers
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFinalOrderSizeXrp — combined multipliers', () => {
    it('applies all three multipliers together', () => {
        // base=1.2, cp=0.5, regime=0.8, adaptive=0.9 → 1.2*0.5*0.8*0.9 = 0.432
        // min = 1.2*0.25 = 0.3 → 0.432 >= 0.3 → ok
        const cfg = makeCfg({ baseOrderSizeXrp: 1.2, maxTradeSize: 10 });
        const ctx = makeCtx({
            cpMode: 'THROTTLE',
            cpSizeMult: 0.5,
            regimeSizeMult: 0.8,
            adaptiveSizeMult: 0.9,
        });
        const result = computeFinalOrderSizeXrp(ctx, cfg);

        expect(result.skip).toBe(false);
        expect(result.finalSize).toBeCloseTo(0.432, 4);
    });

    it('skips when combined multipliers drive below min', () => {
        // base=1.2, cp=0.3, regime=0.5, adaptive=0.5 → 1.2*0.3*0.5*0.5 = 0.09
        // min = 1.2*0.25 = 0.3 → 0.09 < 0.3 → skip
        const cfg = makeCfg({ baseOrderSizeXrp: 1.2, maxTradeSize: 10 });
        const ctx = makeCtx({
            cpMode: 'THROTTLE',
            cpSizeMult: 0.3,
            regimeSizeMult: 0.5,
            adaptiveSizeMult: 0.5,
        });
        const result = computeFinalOrderSizeXrp(ctx, cfg);

        expect(result.skip).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Result structure
// ─────────────────────────────────────────────────────────────────────────────

describe('OrderSizingResult structure', () => {
    it('contains all expected fields', () => {
        const cfg = makeCfg({ baseOrderSizeXrp: 1.0, maxTradeSize: 10 });
        const ctx = makeCtx({ cpSizeMult: 0.7, regimeSizeMult: 0.9, adaptiveSizeMult: 0.8 });
        const result = computeFinalOrderSizeXrp(ctx, cfg);

        expect(result).toHaveProperty('baseSize', 1.0);
        expect(result).toHaveProperty('cpMult', 0.7);
        expect(result).toHaveProperty('regimeMult', 0.9);
        expect(result).toHaveProperty('adaptiveMult', 0.8);
        expect(result).toHaveProperty('finalSize');
        expect(result).toHaveProperty('minSize');
        expect(result).toHaveProperty('maxSize', 10);
        expect(result).toHaveProperty('skip');
    });

    it('skip result includes a reason string', () => {
        const cfg = makeCfg({ baseOrderSizeXrp: 1.0, maxTradeSize: 10 });
        const ctx = makeCtx({ cpSizeMult: 0.0 });
        const result = computeFinalOrderSizeXrp(ctx, cfg);

        expect(result.skip).toBe(true);
        expect(typeof result.reason).toBe('string');
        expect(result.reason!.length).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. logSizingConfigSummary does not throw
// ─────────────────────────────────────────────────────────────────────────────

describe('logSizingConfigSummary', () => {
    it('does not throw', () => {
        const cfg = makeCfg();
        expect(() => logSizingConfigSummary(cfg)).not.toThrow();
    });
});
