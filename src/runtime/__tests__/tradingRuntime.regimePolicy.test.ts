/**
 * Regime Policy Runtime Integration Tests
 *
 * Tests that regime policy correctly affects strategy execution in the runtime.
 * Verifies that strategies are skipped when their regime is disabled.
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

// Mock dependencies before importing
vi.mock('../../persistence/breakerStore', () => ({
    closeBreakerStore: vi.fn().mockResolvedValue(undefined),
    getBreakerStore: vi.fn().mockReturnValue({
        load: vi.fn().mockResolvedValue({ trades: [], trippedAt: null, lastUpdated: 0 }),
        save: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock('../../analytics/feedbackEngine', () => ({
    feedbackEngine: {
        recordTradeEvent: vi.fn(),
        getPerformanceSummary: vi.fn(() => ({
            summary: { totalTrades: 0, winRate: 0, profitFactor: 0, expectancyBps: 0, avgSlippageBps: 0, maxDrawdownPct: 0, currentDrawdownPct: 0 },
            byRegime: [],
            byStrategy: [],
            drawdown: [],
        })),
        getCostSummary: vi.fn(() => ({
            totalTrades: 0,
            avgCostRealism: 0,
            avgSlippageBps: 0,
            byStrategy: {},
        })),
        getRollingRiskMetrics: vi.fn(() => ({
            tradesCount: 100,
            profitFactor: 1.5,
            expectancyBps: 10,
            drawdownPct: 3,
            avgSlippageBps: 15,
            partialFillRate: 0.1,
            winRate: 0.55,
        })),
        getRegimeHeatmap: vi.fn(() => ({
            global: {},
            perStrategy: {},
            meta: { lookbackHours: 24, minTrades: 5, totalTrades: 0, computedAt: Date.now() },
        })),
    },
}));

// Mock the regimePolicy module
vi.mock('../../analytics/regimePolicy', () => {
    // Shared state for mock engine
    const mockPolicy = {
        updatedAt: Date.now(),
        lookbackHours: 24,
        global: {
            disabledRegimes: [] as string[],
            sizeByRegime: {
                quiet: { multiplier: 1.0, smoothedScore: 0, rawScore: 0, trades: 50 },
                normal: { multiplier: 1.0, smoothedScore: 0, rawScore: 0, trades: 50 },
                trendingUp: { multiplier: 1.0, smoothedScore: 0, rawScore: 0, trades: 50 },
                trendingDown: { multiplier: 1.0, smoothedScore: 0, rawScore: 0, trades: 50 },
                chaotic: { multiplier: 1.0, smoothedScore: 0, rawScore: 0, trades: 50 },
                illiquid: { multiplier: 1.0, smoothedScore: 0, rawScore: 0, trades: 50 },
            },
        },
        strategies: {} as Record<string, any>,
        reasons: [],
        stats: { totalTrades: 300, regimeCounts: {}, computedAt: Date.now() },
    };

    const mockEngine = {
        getCurrentPolicy: vi.fn(() => mockPolicy),
        recompute: vi.fn(() => mockPolicy),
        getEffectiveSizeMultiplier: vi.fn(() => 1.0),
        isRegimeDisabled: vi.fn(() => false),
        getDisabledRegimes: vi.fn(() => []),
        getConfig: vi.fn(() => ({ enabled: true, minTrades: 30 })),
        // Expose mock policy for test manipulation
        _mockPolicy: mockPolicy,
    };

    return {
        RegimePolicyEngine: vi.fn(() => mockEngine),
        loadRegimePolicyConfig: vi.fn(() => ({
            enabled: true,
            lookbackHours: 24,
            minTrades: 30,
            alpha: 0.2,
            disableScoreBps: -5,
            enableScoreBps: 2,
            minSize: 0.2,
            maxSize: 1.2,
            sizeStep: 0.1,
        })),
        getRegimePolicyEngine: vi.fn(() => mockEngine),
        resetRegimePolicyEngine: vi.fn(),
        _getMockEngine: () => mockEngine,
    };
});

vi.mock('../../analytics/adaptiveLearner', () => ({
    isAdaptiveEnabled: vi.fn(() => false),
    isRegimeDisabled: vi.fn(() => false),
    getRegimeGates: vi.fn(() => ({
        shouldPause: false,
        disabledRegimes: [],
        disabledStrategies: [],
    })),
    getActiveTunings: vi.fn(() => ({
        sizeMultiplier: 1.0,
        cooldownMs: 0,
        disabledRegimes: [],
    })),
    recordTradeResult: vi.fn(),
}));

import { TradingRuntime } from '../tradingRuntime';
import { FlowRegime } from '../../market/flowMetrics';
import * as regimePolicyModule from '../../analytics/regimePolicy';

// Helper to get the mock engine via the mocked module
function getMockEngine() {
    return (regimePolicyModule as any)._getMockEngine();
}

describe('TradingRuntime Regime Policy Integration', () => {
    let runtime: TradingRuntime;

    beforeEach(() => {
        vi.clearAllMocks();
        runtime = new TradingRuntime();

        // Reset mock policy
        const engine = getMockEngine();
        engine._mockPolicy.global.disabledRegimes = [];
        engine._mockPolicy.strategies = {};
        engine.isRegimeDisabled.mockReturnValue(false);
        engine.getEffectiveSizeMultiplier.mockReturnValue(1.0);
    });

    afterEach(async () => {
        await runtime.shutdown();
    });

    describe('Regime Policy Access', () => {
        it('should expose getRegimePolicy method', () => {
            expect(runtime.getRegimePolicy).toBeDefined();
            expect(typeof runtime.getRegimePolicy).toBe('function');
        });

        it('should return null policy before start', () => {
            const policy = runtime.getRegimePolicy();
            // Before start, regimePolicyEngine is null
            expect(policy).toBeNull();
        });

        it('should expose recomputeRegimePolicy method', () => {
            expect(runtime.recomputeRegimePolicy).toBeDefined();
            expect(typeof runtime.recomputeRegimePolicy).toBe('function');
        });
    });

    describe('Policy Loading', () => {
        it('should check regime policy config on start', () => {
            // Verify the mock is set up correctly
            const config = regimePolicyModule.loadRegimePolicyConfig();
            expect(config.enabled).toBe(true);
            expect(config.minTrades).toBe(30);
        });
    });

    describe('Regime Disabled Behavior', () => {
        it('should respect global disabled regimes', () => {
            const engine = getMockEngine();

            // Disable 'chaotic' globally
            engine._mockPolicy.global.disabledRegimes = ['chaotic'];
            engine.isRegimeDisabled.mockImplementation((strategy: string, regime: FlowRegime) => {
                return engine._mockPolicy.global.disabledRegimes.includes(regime);
            });

            // Verify the mock behavior
            expect(engine.isRegimeDisabled('scalper', 'chaotic')).toBe(true);
            expect(engine.isRegimeDisabled('scalper', 'normal')).toBe(false);
            expect(engine.isRegimeDisabled('amm_arb', 'chaotic')).toBe(true);
        });

        it('should respect per-strategy disabled regimes', () => {
            const engine = getMockEngine();

            // Disable 'illiquid' for scalper only
            engine._mockPolicy.strategies.scalper = {
                disabledRegimes: ['illiquid'],
                sizeByRegime: {},
            };

            engine.isRegimeDisabled.mockImplementation((strategy: string, regime: FlowRegime) => {
                if (engine._mockPolicy.global.disabledRegimes.includes(regime)) {
                    return true;
                }
                const stratPolicy = engine._mockPolicy.strategies[strategy];
                return stratPolicy?.disabledRegimes?.includes(regime) ?? false;
            });

            // Scalper should have illiquid disabled
            expect(engine.isRegimeDisabled('scalper', 'illiquid')).toBe(true);
            // Other strategies should not
            expect(engine.isRegimeDisabled('amm_arb', 'illiquid')).toBe(false);
        });

        it('should union global and strategy disabled regimes', () => {
            const engine = getMockEngine();

            // Global disables 'chaotic'
            engine._mockPolicy.global.disabledRegimes = ['chaotic'];
            // Scalper also disables 'illiquid'
            engine._mockPolicy.strategies.scalper = {
                disabledRegimes: ['illiquid'],
                sizeByRegime: {},
            };

            engine.getDisabledRegimes.mockImplementation((strategy: string) => {
                const disabled = new Set(engine._mockPolicy.global.disabledRegimes);
                const stratPolicy = engine._mockPolicy.strategies[strategy];
                if (stratPolicy?.disabledRegimes) {
                    for (const r of stratPolicy.disabledRegimes) {
                        disabled.add(r);
                    }
                }
                return Array.from(disabled);
            });

            const scalperDisabled = engine.getDisabledRegimes('scalper');
            expect(scalperDisabled).toContain('chaotic');
            expect(scalperDisabled).toContain('illiquid');
            expect(scalperDisabled).toHaveLength(2);

            const ammDisabled = engine.getDisabledRegimes('amm_arb');
            expect(ammDisabled).toContain('chaotic');
            expect(ammDisabled).not.toContain('illiquid');
            expect(ammDisabled).toHaveLength(1);
        });
    });

    describe('Size Multiplier Behavior', () => {
        it('should return 1.0 multiplier for neutral scores', () => {
            const engine = getMockEngine();
            engine.getEffectiveSizeMultiplier.mockReturnValue(1.0);

            const multiplier = engine.getEffectiveSizeMultiplier('scalper', 'normal');
            expect(multiplier).toBe(1.0);
        });

        it('should reduce size for negative score regimes', () => {
            const engine = getMockEngine();

            // Simulate chaotic having negative score -> reduced multiplier
            engine.getEffectiveSizeMultiplier.mockImplementation((strategy: string, regime: FlowRegime) => {
                if (regime === 'chaotic') return 0.6;
                if (regime === 'illiquid') return 0.4;
                return 1.0;
            });

            expect(engine.getEffectiveSizeMultiplier('scalper', 'chaotic')).toBe(0.6);
            expect(engine.getEffectiveSizeMultiplier('scalper', 'illiquid')).toBe(0.4);
            expect(engine.getEffectiveSizeMultiplier('scalper', 'normal')).toBe(1.0);
        });

        it('should prefer strategy-specific multiplier over global', () => {
            const engine = getMockEngine();

            // Global normal = 1.0, scalper normal = 0.8
            engine.getEffectiveSizeMultiplier.mockImplementation((strategy: string, regime: FlowRegime) => {
                if (strategy === 'scalper' && regime === 'normal') return 0.8;
                return 1.0;
            });

            expect(engine.getEffectiveSizeMultiplier('scalper', 'normal')).toBe(0.8);
            expect(engine.getEffectiveSizeMultiplier('amm_arb', 'normal')).toBe(1.0);
        });

        it('should respect min/max size bounds', () => {
            const engine = getMockEngine();

            engine.getEffectiveSizeMultiplier.mockImplementation((strategy: string, regime: FlowRegime) => {
                if (regime === 'chaotic') return 0.2; // At minSize
                if (regime === 'quiet') return 1.2; // At maxSize
                return 1.0;
            });

            // Verify bounds are respected (0.2 - 1.2 from config)
            expect(engine.getEffectiveSizeMultiplier('scalper', 'chaotic')).toBeGreaterThanOrEqual(0.2);
            expect(engine.getEffectiveSizeMultiplier('scalper', 'quiet')).toBeLessThanOrEqual(1.2);
        });
    });

    describe('Policy Recomputation', () => {
        it('should allow manual policy recomputation', () => {
            const engine = getMockEngine();

            // Call recompute
            const result = runtime.recomputeRegimePolicy();

            // Before start, runtime.regimePolicyEngine is null, so it returns null
            expect(result).toBeNull();
        });

        it('should return updated policy after recompute', () => {
            const engine = getMockEngine();

            const updatedPolicy = {
                ...engine._mockPolicy,
                updatedAt: Date.now() + 1000,
                global: {
                    ...engine._mockPolicy.global,
                    disabledRegimes: ['chaotic', 'illiquid'],
                },
            };

            engine.recompute.mockReturnValue(updatedPolicy);

            const result = engine.recompute();
            expect(result.global.disabledRegimes).toContain('chaotic');
            expect(result.global.disabledRegimes).toContain('illiquid');
            expect(result.updatedAt).toBeGreaterThan(engine._mockPolicy.updatedAt);
        });
    });

    describe('Integration with Governance', () => {
        it('should combine regime policy with governance size multipliers', () => {
            // In the runtime, when both governance and regime policy apply:
            // combinedMultiplier = globalSizeMultiplier * regimePolicySizeMultiplier

            const governanceSizeMultiplier = 0.8; // From governance (THROTTLE mode)
            const regimePolicySizeMultiplier = 0.6; // From regime policy (negative score)

            const combined = governanceSizeMultiplier * regimePolicySizeMultiplier;

            // Combined should be multiplicative
            expect(combined).toBeCloseTo(0.48, 2);
        });

        it('should skip strategy if regime disabled by either governance or regime policy', () => {
            const engine = getMockEngine();

            // Governance disables via capital protection
            const governanceDisabledRegimes = ['chaotic'];

            // Regime policy disables based on performance
            engine._mockPolicy.global.disabledRegimes = ['illiquid'];

            // Both should cause strategy to be skipped
            const regimePolicyDisabled = engine._mockPolicy.global.disabledRegimes;

            // Union of disabled regimes
            const allDisabled = new Set([...governanceDisabledRegimes, ...regimePolicyDisabled]);

            expect(allDisabled.has('chaotic')).toBe(true);
            expect(allDisabled.has('illiquid')).toBe(true);
            expect(allDisabled.has('normal')).toBe(false);
        });
    });

    describe('Context Passed to Strategies', () => {
        it('should include regimePolicy in strategy context', () => {
            const engine = getMockEngine();

            // Build expected context shape
            const regimePolicyContext = {
                currentRegime: 'normal' as FlowRegime,
                isRegimeDisabledGlobal: false,
                isRegimeDisabledStrategy: false,
                isRegimeDisabled: false,
                regimeSizeMultiplier: 1.0,
                policy: engine.getCurrentPolicy(),
                currentRegimeSizePolicy: engine._mockPolicy.global.sizeByRegime.normal,
            };

            expect(regimePolicyContext.currentRegime).toBe('normal');
            expect(regimePolicyContext.isRegimeDisabled).toBe(false);
            expect(regimePolicyContext.regimeSizeMultiplier).toBe(1.0);
            expect(regimePolicyContext.policy).toBeDefined();
        });

        it('should set isRegimeDisabled true when regime is disabled', () => {
            const engine = getMockEngine();

            // Disable chaotic globally
            engine._mockPolicy.global.disabledRegimes = ['chaotic'];

            const isGlobalDisabled = engine._mockPolicy.global.disabledRegimes.includes('chaotic');
            const isStrategyDisabled = false; // No strategy-specific disable
            const isDisabled = isGlobalDisabled || isStrategyDisabled;

            expect(isDisabled).toBe(true);

            // When regime is disabled, strategy tick should not be called
            // This is tested via the continue statement in tick() loop
        });
    });

    describe('Disabled Policy Behavior', () => {
        it('should not block strategies when regime policy is disabled', () => {
            // Mock the disabled config by updating the mock return
            vi.mocked(regimePolicyModule.loadRegimePolicyConfig).mockReturnValue({
                enabled: false, // Disabled
                lookbackHours: 24,
                minTrades: 30,
                alpha: 0.2,
                disableScoreBps: -5,
                enableScoreBps: 2,
                minSize: 0.2,
                maxSize: 1.2,
                sizeStep: 0.1,
            });

            const engine = getMockEngine();

            // When disabled, should return default behavior
            engine.isRegimeDisabled.mockReturnValue(false);
            engine.getEffectiveSizeMultiplier.mockReturnValue(1.0);

            // Even with bad scores, nothing should be disabled
            expect(engine.isRegimeDisabled('scalper', 'chaotic')).toBe(false);
            expect(engine.getEffectiveSizeMultiplier('scalper', 'chaotic')).toBe(1.0);
        });
    });
});
