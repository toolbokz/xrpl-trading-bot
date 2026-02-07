/**
 * Tests for the reprice policy module.
 */

import { describe, it, expect } from 'vitest';
import {
    evaluateRepricePolicy,
    computeMakerQuote,
    loadRepriceConfig,
    type RepriceInput,
    type RepriceConfig,
} from '../../execution/repricePolicy';

const baseInput: RepriceInput = {
    currentQuote: 2.49,
    fairQuote: 2.50,
    driftBps: 2,
    feedStalenessMs: 500,
    spreadRegimeChanged: false,
    queueDeterioration: 0,
    replaceRatePerMin: 0,
    churnLimitPerMin: 8,
};

describe('evaluateRepricePolicy', () => {
    it('returns KEEP for input within drift tolerance', () => {
        const result = evaluateRepricePolicy(baseInput);
        expect(result.action).toBe('KEEP');
    });

    it('returns REPLACE when drift exceeds threshold', () => {
        const input: RepriceInput = {
            ...baseInput,
            driftBps: 10, // > default 5bps threshold
        };
        const result = evaluateRepricePolicy(input);
        expect(result.action).toBe('REPLACE');
        expect(result.reason).toContain('drift');
    });

    it('returns CANCEL when feed is hard-stale', () => {
        const input: RepriceInput = {
            ...baseInput,
            feedStalenessMs: 15_000, // > 10s default
        };
        const result = evaluateRepricePolicy(input);
        expect(result.action).toBe('CANCEL');
        expect(result.reason).toContain('staleness');
    });

    it('returns PAUSE when churn limit exceeded', () => {
        const input: RepriceInput = {
            ...baseInput,
            replaceRatePerMin: 10, // > default 8
            driftBps: 20, // would normally trigger REPLACE
        };
        const result = evaluateRepricePolicy(input);
        expect(result.action).toBe('PAUSE');
        expect(result.reason).toContain('churn');
    });

    it('returns REPLACE when spread regime changes with drift', () => {
        const input: RepriceInput = {
            ...baseInput,
            spreadRegimeChanged: true,
            driftBps: 4, // > 0.5 × 5 = 2.5 threshold
        };
        const result = evaluateRepricePolicy(input);
        expect(result.action).toBe('REPLACE');
        expect(result.reason).toContain('spread');
    });

    it('returns REPLACE when queue deterioration is significant', () => {
        const input: RepriceInput = {
            ...baseInput,
            queueDeterioration: 0.5, // > 0.3 threshold
            driftBps: 4,
        };
        const result = evaluateRepricePolicy(input);
        expect(result.action).toBe('REPLACE');
        expect(result.reason).toContain('queue');
    });

    it('returns REPLACE on soft staleness + drift', () => {
        const input: RepriceInput = {
            ...baseInput,
            feedStalenessMs: 4000, // > 3s soft threshold
            driftBps: 4.5, // > 0.75 × 5 = 3.75
        };
        const result = evaluateRepricePolicy(input);
        expect(result.action).toBe('REPLACE');
        expect(result.reason).toContain('soft-staleness');
    });
});

describe('computeMakerQuote', () => {
    it('generates buy quote below mid', () => {
        const q = computeMakerQuote({
            mid: 2.50,
            side: 'buy',
            spreadBps: 20,
            volBps: 5,
            stalenessMs: 0,
            minTick: 0.0001,
        });
        expect(q).toBeLessThan(2.50);
        expect(q).toBeGreaterThan(0);
    });

    it('generates sell quote above mid', () => {
        const q = computeMakerQuote({
            mid: 2.50,
            side: 'sell',
            spreadBps: 20,
            volBps: 5,
            stalenessMs: 0,
            minTick: 0.0001,
        });
        expect(q).toBeGreaterThan(2.50);
    });

    it('widens quote with higher spread', () => {
        const narrow = computeMakerQuote({
            mid: 2.50,
            side: 'buy',
            spreadBps: 10,
            volBps: 5,
            stalenessMs: 0,
            minTick: 0,
        });
        const wide = computeMakerQuote({
            mid: 2.50,
            side: 'buy',
            spreadBps: 50,
            volBps: 5,
            stalenessMs: 0,
            minTick: 0,
        });
        expect(wide).toBeLessThan(narrow);
    });

    it('widens quote with staleness', () => {
        const fresh = computeMakerQuote({
            mid: 2.50,
            side: 'buy',
            spreadBps: 20,
            volBps: 5,
            stalenessMs: 0,
            minTick: 0,
        });
        const stale = computeMakerQuote({
            mid: 2.50,
            side: 'buy',
            spreadBps: 20,
            volBps: 5,
            stalenessMs: 5000,
            minTick: 0,
        });
        expect(stale).toBeLessThan(fresh);
    });
});

describe('loadRepriceConfig', () => {
    it('returns partial config from env', () => {
        const config = loadRepriceConfig();
        // Should return an object (may be empty)
        expect(typeof config).toBe('object');
    });
});
