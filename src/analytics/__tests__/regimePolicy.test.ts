/**
 * Regime Policy Engine unit tests
 * Tests hysteresis, smoothing, size mapping, and persistence logic
 */
import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import {
    RegimePolicyEngine,
    RegimePolicy,
    RegimePolicyConfig,
    resetRegimePolicyEngine,
    loadRegimePolicyConfig,
} from '../regimePolicy';
import { feedbackEngine, RegimeHeatmapResponse, RegimeHeatmapCell } from '../feedbackEngine';

// Mock fs module
vi.mock('fs', () => ({
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
}));

// Mock feedbackEngine.getRegimeHeatmap
vi.mock('../feedbackEngine', () => ({
    feedbackEngine: {
        getRegimeHeatmap: vi.fn(),
    },
}));

// Mock logger
vi.mock('../logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    },
}));

type FlowRegime = 'quiet' | 'normal' | 'trendingUp' | 'trendingDown' | 'chaotic' | 'illiquid';
const ALL_REGIMES: FlowRegime[] = ['quiet', 'normal', 'trendingUp', 'trendingDown', 'chaotic', 'illiquid'];

// Helper: create empty heatmap cell
function createEmptyCell(regime: FlowRegime): RegimeHeatmapCell {
    return {
        regime,
        trades: 0,
        winRate: 0,
        profitFactor: 1,
        expectancyBps: 0,
        avgEdgeBps: 0,
        avgSlippageBps: 0,
        avgSpreadBps: 0,
        partialFillRate: 0,
        score: 0,
    };
}

// Helper: create heatmap cell with specific values
function createCell(regime: FlowRegime, trades: number, score: number): RegimeHeatmapCell {
    return {
        ...createEmptyCell(regime),
        regime,
        trades,
        score,
    };
}

// Helper: create full heatmap response
function createHeatmapResponse(
    globalScores: Record<FlowRegime, { trades: number; score: number }>,
    perStrategy: Record<string, Record<FlowRegime, { trades: number; score: number }>> = {}
): RegimeHeatmapResponse {
    const global: Record<FlowRegime, RegimeHeatmapCell> = {} as Record<FlowRegime, RegimeHeatmapCell>;
    for (const regime of ALL_REGIMES) {
        const data = globalScores[regime] ?? { trades: 0, score: 0 };
        global[regime] = createCell(regime, data.trades, data.score);
    }

    const strategies: Record<string, Record<FlowRegime, RegimeHeatmapCell>> = {};
    for (const [strategy, regimeData] of Object.entries(perStrategy)) {
        strategies[strategy] = {} as Record<FlowRegime, RegimeHeatmapCell>;
        for (const regime of ALL_REGIMES) {
            const data = regimeData[regime] ?? { trades: 0, score: 0 };
            strategies[strategy][regime] = createCell(regime, data.trades, data.score);
        }
    }

    return {
        global,
        perStrategy: strategies,
        meta: {
            lookbackHours: 24,
            minTrades: 5,
            totalTrades: Object.values(globalScores).reduce((sum, d) => sum + d.trades, 0),
            computedAt: Date.now(),
        },
    };
}

describe('RegimePolicyEngine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRegimePolicyEngine();
        // Default: no files exist
        (existsSync as Mock).mockReturnValue(false);
    });

    afterEach(() => {
        resetRegimePolicyEngine();
    });

    describe('loadRegimePolicyConfig', () => {
        it('should return default config when no env vars set', () => {
            const config = loadRegimePolicyConfig();
            expect(config.enabled).toBe(true);
            expect(config.lookbackHours).toBe(24);
            expect(config.minTrades).toBe(30);
            expect(config.alpha).toBe(0.2);
            expect(config.disableScoreBps).toBe(-5);
            expect(config.enableScoreBps).toBe(2);
            expect(config.minSize).toBe(0.2);
            expect(config.maxSize).toBe(1.2);
        });

        it('should respect environment variables', () => {
            const originalEnv = process.env;
            process.env = {
                ...originalEnv,
                REGIME_POLICY_ENABLED: 'false',
                REGIME_POLICY_LOOKBACK_HOURS: '48',
                REGIME_POLICY_MIN_TRADES: '50',
            };

            const config = loadRegimePolicyConfig();
            expect(config.enabled).toBe(false);
            expect(config.lookbackHours).toBe(48);
            expect(config.minTrades).toBe(50);

            process.env = originalEnv;
        });
    });

    describe('recompute', () => {
        it('should compute policy from heatmap data', () => {
            const heatmap = createHeatmapResponse({
                quiet: { trades: 50, score: 10 },
                normal: { trades: 100, score: 5 },
                trendingUp: { trades: 40, score: -10 },
                trendingDown: { trades: 30, score: -20 },
                chaotic: { trades: 20, score: -30 },
                illiquid: { trades: 10, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({ minTrades: 25 });
            const policy = engine.recompute();

            expect(policy.updatedAt).toBeGreaterThan(0);
            expect(policy.global).toBeDefined();
            expect(policy.stats.totalTrades).toBe(250);
        });

        it('should disable regimes with scores below threshold', () => {
            const heatmap = createHeatmapResponse({
                quiet: { trades: 50, score: 10 },
                normal: { trades: 50, score: 5 },
                trendingUp: { trades: 50, score: -10 }, // Below -5, should be disabled
                trendingDown: { trades: 50, score: -20 }, // Below -5, should be disabled
                chaotic: { trades: 50, score: -50 }, // Below -5, should be disabled
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({ minTrades: 30, disableScoreBps: -5 });
            const policy = engine.recompute();

            // Initial computation: smoothed = alpha * raw + (1-alpha) * 0 = 0.2 * score
            // trendingUp: 0.2 * -10 = -2 (not below -5)
            // trendingDown: 0.2 * -20 = -4 (not below -5)
            // chaotic: 0.2 * -50 = -10 (below -5, should be disabled)
            expect(policy.global.disabledRegimes).toContain('chaotic');
            expect(policy.global.disabledRegimes).not.toContain('quiet');
            expect(policy.global.disabledRegimes).not.toContain('normal');
        });

        it('should include reasons for policy decisions', () => {
            const heatmap = createHeatmapResponse({
                quiet: { trades: 50, score: 10 },
                normal: { trades: 50, score: 5 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: -50 }, // Will be disabled
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({ minTrades: 30 });
            const policy = engine.recompute();

            expect(policy.reasons.length).toBeGreaterThan(0);
            expect(policy.reasons.some(r => r.includes('chaotic'))).toBe(true);
        });

        it('should save policy and smoothed state to disk', () => {
            const heatmap = createHeatmapResponse({
                quiet: { trades: 50, score: 10 },
                normal: { trades: 50, score: 5 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: 0 },
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({ minTrades: 30 });
            engine.recompute();

            // Should write policy and smoothed state files
            expect(writeFileSync).toHaveBeenCalled();
            expect(renameSync).toHaveBeenCalled();
        });
    });

    describe('hysteresis', () => {
        it('should keep regime disabled until score exceeds enableScoreBps', () => {
            // First computation: disable chaotic
            const heatmap1 = createHeatmapResponse({
                quiet: { trades: 50, score: 10 },
                normal: { trades: 50, score: 5 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: -50 }, // Disabled
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap1);

            const engine = new RegimePolicyEngine({
                minTrades: 30,
                alpha: 1.0, // No smoothing for test clarity
                disableScoreBps: -5,
                enableScoreBps: 2,
            });

            const policy1 = engine.recompute();
            expect(policy1.global.disabledRegimes).toContain('chaotic');

            // Second computation: chaotic improves but not enough to re-enable
            const heatmap2 = createHeatmapResponse({
                quiet: { trades: 50, score: 10 },
                normal: { trades: 50, score: 5 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: 0 }, // Improved but still < +2
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap2);
            const policy2 = engine.recompute();

            // Still disabled (hysteresis: needs score >= +2 to re-enable)
            expect(policy2.global.disabledRegimes).toContain('chaotic');

            // Third computation: chaotic exceeds enableScoreBps
            const heatmap3 = createHeatmapResponse({
                quiet: { trades: 50, score: 10 },
                normal: { trades: 50, score: 5 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: 5 }, // Now above +2
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap3);
            const policy3 = engine.recompute();

            // Now re-enabled
            expect(policy3.global.disabledRegimes).not.toContain('chaotic');
        });

        it('should keep regime enabled until score drops below disableScoreBps', () => {
            // Start with all regimes enabled
            const heatmap1 = createHeatmapResponse({
                quiet: { trades: 50, score: 10 },
                normal: { trades: 50, score: 5 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: -3 }, // Above -5, stays enabled
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap1);

            const engine = new RegimePolicyEngine({
                minTrades: 30,
                alpha: 1.0,
                disableScoreBps: -5,
                enableScoreBps: 2,
            });

            const policy1 = engine.recompute();
            expect(policy1.global.disabledRegimes).not.toContain('chaotic');

            // Chaotic gets worse but not below threshold
            const heatmap2 = createHeatmapResponse({
                quiet: { trades: 50, score: 10 },
                normal: { trades: 50, score: 5 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: -4 }, // Still above -5
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap2);
            const policy2 = engine.recompute();
            expect(policy2.global.disabledRegimes).not.toContain('chaotic');
        });
    });

    describe('exponential smoothing', () => {
        it('should apply smoothing with configured alpha', () => {
            const heatmap1 = createHeatmapResponse({
                quiet: { trades: 50, score: 0 },
                normal: { trades: 50, score: 100 }, // High score
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: 0 },
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap1);

            const engine = new RegimePolicyEngine({ minTrades: 30, alpha: 0.2 });
            const policy1 = engine.recompute();

            // First computation: smoothed = 0.2 * 100 + 0.8 * 0 = 20
            expect(policy1.global.sizeByRegime.normal.smoothedScore).toBeCloseTo(20, 1);
            expect(policy1.global.sizeByRegime.normal.rawScore).toBe(100);

            // Second computation with same score
            const policy2 = engine.recompute();

            // Smoothed = 0.2 * 100 + 0.8 * 20 = 36
            expect(policy2.global.sizeByRegime.normal.smoothedScore).toBeCloseTo(36, 1);
        });
    });

    describe('scoreToSizeMultiplier', () => {
        it('should map score 0 to multiplier 1.0', () => {
            const heatmap = createHeatmapResponse({
                quiet: { trades: 50, score: 0 },
                normal: { trades: 50, score: 0 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: 0 },
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({ minTrades: 30, alpha: 1.0 });
            const policy = engine.recompute();

            expect(policy.global.sizeByRegime.normal.multiplier).toBe(1.0);
        });

        it('should increase multiplier for positive scores', () => {
            const heatmap = createHeatmapResponse({
                quiet: { trades: 50, score: 50 }, // +50 => multiplier > 1.0
                normal: { trades: 50, score: 0 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: 0 },
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({ minTrades: 30, alpha: 1.0 });
            const policy = engine.recompute();

            // score 50 => delta = 0.5 => multiplier = 1.5, but capped at maxSize (1.2)
            expect(policy.global.sizeByRegime.quiet.multiplier).toBeCloseTo(1.2, 1);
            expect(policy.global.sizeByRegime.quiet.multiplier).toBeGreaterThan(1.0);
        });

        it('should decrease multiplier for negative scores', () => {
            const heatmap = createHeatmapResponse({
                quiet: { trades: 50, score: 0 },
                normal: { trades: 50, score: 0 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: -40 }, // Negative => multiplier < 1.0
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({ minTrades: 30, alpha: 1.0 });
            const policy = engine.recompute();

            // score -40 => delta = -0.4 => multiplier = 0.6
            expect(policy.global.sizeByRegime.chaotic.multiplier).toBeLessThan(1.0);
            expect(policy.global.sizeByRegime.chaotic.multiplier).toBeGreaterThanOrEqual(0.2);
        });

        it('should clamp multiplier to min/max bounds', () => {
            const heatmap = createHeatmapResponse({
                quiet: { trades: 50, score: 100 }, // Should hit maxSize
                normal: { trades: 50, score: -100 }, // Should hit minSize
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: 0 },
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({
                minTrades: 30,
                alpha: 1.0,
                minSize: 0.2,
                maxSize: 1.2,
            });
            const policy = engine.recompute();

            expect(policy.global.sizeByRegime.quiet.multiplier).toBeCloseTo(1.2, 1);
            expect(policy.global.sizeByRegime.normal.multiplier).toBeCloseTo(0.2, 1);
        });

        it('should quantize multiplier to sizeStep', () => {
            const heatmap = createHeatmapResponse({
                quiet: { trades: 50, score: 15 }, // multiplier = 1.15, should quantize to 1.2 or 1.1
                normal: { trades: 50, score: 0 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: 0 },
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({
                minTrades: 30,
                alpha: 1.0,
                sizeStep: 0.1,
            });
            const policy = engine.recompute();

            // 1.15 rounded to nearest 0.1 = 1.2
            const multiplier = policy.global.sizeByRegime.quiet.multiplier;
            expect(multiplier % 0.1).toBeCloseTo(0, 5);
        });
    });

    describe('getEffectiveSizeMultiplier', () => {
        it('should return 1.0 when policy is disabled', () => {
            const engine = new RegimePolicyEngine({ enabled: false });
            const multiplier = engine.getEffectiveSizeMultiplier('scalper', 'normal');
            expect(multiplier).toBe(1.0);
        });

        it('should prefer per-strategy multiplier over global', () => {
            const heatmap = createHeatmapResponse(
                {
                    quiet: { trades: 50, score: 0 },
                    normal: { trades: 50, score: 20 }, // Global: 1.2
                    trendingUp: { trades: 50, score: 0 },
                    trendingDown: { trades: 50, score: 0 },
                    chaotic: { trades: 50, score: 0 },
                    illiquid: { trades: 50, score: 0 },
                },
                {
                    scalper: {
                        quiet: { trades: 50, score: 0 },
                        normal: { trades: 50, score: -30 }, // Strategy-specific: 0.7
                        trendingUp: { trades: 50, score: 0 },
                        trendingDown: { trades: 50, score: 0 },
                        chaotic: { trades: 50, score: 0 },
                        illiquid: { trades: 50, score: 0 },
                    },
                }
            );

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({ minTrades: 30, alpha: 1.0 });
            engine.recompute();

            // Scalper should use per-strategy multiplier
            const scalperMultiplier = engine.getEffectiveSizeMultiplier('scalper', 'normal');
            const otherMultiplier = engine.getEffectiveSizeMultiplier('amm_arb', 'normal');

            expect(scalperMultiplier).toBeLessThan(1.0);
            // amm_arb falls back to global
            expect(otherMultiplier).toBeCloseTo(1.2, 1);
        });
    });

    describe('isRegimeDisabled', () => {
        it('should return false when policy is disabled', () => {
            const engine = new RegimePolicyEngine({ enabled: false });
            expect(engine.isRegimeDisabled('scalper', 'chaotic')).toBe(false);
        });

        it('should check both strategy-specific and global disabled regimes', () => {
            // Create scenario where global disables 'chaotic' and strategy disables 'illiquid'
            const heatmap = createHeatmapResponse(
                {
                    quiet: { trades: 50, score: 0 },
                    normal: { trades: 50, score: 0 },
                    trendingUp: { trades: 50, score: 0 },
                    trendingDown: { trades: 50, score: 0 },
                    chaotic: { trades: 50, score: -50 }, // Global disabled
                    illiquid: { trades: 50, score: 0 },
                },
                {
                    scalper: {
                        quiet: { trades: 50, score: 0 },
                        normal: { trades: 50, score: 0 },
                        trendingUp: { trades: 50, score: 0 },
                        trendingDown: { trades: 50, score: 0 },
                        chaotic: { trades: 50, score: 0 }, // Not disabled at strategy level
                        illiquid: { trades: 50, score: -50 }, // Strategy disabled
                    },
                }
            );

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({ minTrades: 30, alpha: 1.0 });
            engine.recompute();

            // Global chaotic should be disabled for all strategies
            expect(engine.isRegimeDisabled('scalper', 'chaotic')).toBe(true);
            expect(engine.isRegimeDisabled('amm_arb', 'chaotic')).toBe(true);

            // Illiquid should be disabled for scalper only
            expect(engine.isRegimeDisabled('scalper', 'illiquid')).toBe(true);
            expect(engine.isRegimeDisabled('amm_arb', 'illiquid')).toBe(false);
        });
    });

    describe('getDisabledRegimes', () => {
        it('should return union of strategy-specific and global disabled regimes', () => {
            const heatmap = createHeatmapResponse(
                {
                    quiet: { trades: 50, score: 0 },
                    normal: { trades: 50, score: 0 },
                    trendingUp: { trades: 50, score: 0 },
                    trendingDown: { trades: 50, score: 0 },
                    chaotic: { trades: 50, score: -50 }, // Global disabled
                    illiquid: { trades: 50, score: 0 },
                },
                {
                    scalper: {
                        quiet: { trades: 50, score: 0 },
                        normal: { trades: 50, score: 0 },
                        trendingUp: { trades: 50, score: 0 },
                        trendingDown: { trades: 50, score: -50 }, // Strategy disabled
                        chaotic: { trades: 50, score: 0 },
                        illiquid: { trades: 50, score: 0 },
                    },
                }
            );

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({ minTrades: 30, alpha: 1.0 });
            engine.recompute();

            const disabled = engine.getDisabledRegimes('scalper');
            expect(disabled).toContain('chaotic'); // From global
            expect(disabled).toContain('trendingDown'); // From strategy
            expect(disabled).toHaveLength(2);
        });
    });

    describe('persistence', () => {
        it('should load existing policy from disk', () => {
            const existingPolicy: RegimePolicy = {
                updatedAt: Date.now() - 1000,
                lookbackHours: 24,
                global: {
                    disabledRegimes: ['chaotic'],
                    sizeByRegime: {} as any,
                },
                strategies: {},
                reasons: [],
                stats: { totalTrades: 100, regimeCounts: {} as any, computedAt: Date.now() - 1000 },
            };

            (existsSync as Mock).mockImplementation((path: string) => {
                return path.includes('regime-policy.json');
            });
            (readFileSync as Mock).mockReturnValue(JSON.stringify(existingPolicy));

            const engine = new RegimePolicyEngine();
            const policy = engine.getCurrentPolicy();

            expect(policy).not.toBeNull();
            expect(policy?.global.disabledRegimes).toContain('chaotic');
        });

        it('should load smoothed state and continue from previous values', () => {
            const existingSmoothed = {
                global: {
                    quiet: 5,
                    normal: 10,
                    trendingUp: -3,
                    trendingDown: 0,
                    chaotic: -15,
                    illiquid: 0,
                },
                strategies: {},
                lastUpdatedAt: Date.now() - 1000,
            };

            (existsSync as Mock).mockImplementation((path: string) => {
                return path.includes('regime-smoothed.json');
            });
            (readFileSync as Mock).mockReturnValue(JSON.stringify(existingSmoothed));

            const heatmap = createHeatmapResponse({
                quiet: { trades: 50, score: 0 },
                normal: { trades: 50, score: 0 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: 0 },
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap);

            const engine = new RegimePolicyEngine({ minTrades: 30, alpha: 0.2 });
            const policy = engine.recompute();

            // With alpha=0.2 and new score=0, smoothed = 0.2 * 0 + 0.8 * prevSmoothed
            // For normal: 0.8 * 10 = 8
            expect(policy.global.sizeByRegime.normal.smoothedScore).toBeCloseTo(8, 1);
        });
    });

    describe('insufficient data handling', () => {
        it('should keep previous state when trades below minTrades', () => {
            // First: disable chaotic
            const heatmap1 = createHeatmapResponse({
                quiet: { trades: 50, score: 0 },
                normal: { trades: 50, score: 0 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 50, score: -50 }, // Disabled
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap1);

            const engine = new RegimePolicyEngine({ minTrades: 30, alpha: 1.0 });
            engine.recompute();

            // Second: chaotic has insufficient data
            const heatmap2 = createHeatmapResponse({
                quiet: { trades: 50, score: 0 },
                normal: { trades: 50, score: 0 },
                trendingUp: { trades: 50, score: 0 },
                trendingDown: { trades: 50, score: 0 },
                chaotic: { trades: 5, score: 10 }, // Insufficient trades, even with good score
                illiquid: { trades: 50, score: 0 },
            });

            (feedbackEngine.getRegimeHeatmap as Mock).mockReturnValue(heatmap2);
            const policy2 = engine.recompute();

            // Should keep previous disabled state
            expect(policy2.global.disabledRegimes).toContain('chaotic');
        });
    });
});
