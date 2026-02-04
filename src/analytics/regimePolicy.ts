/**
 * Regime Policy Engine
 *
 * Computes regime-based trading policies using historical performance data
 * from the feedback engine. Applies smoothing, hysteresis, and sizing adjustments
 * to create stable, explainable policy decisions.
 *
 * Features:
 * - Exponential smoothing of scores to reduce noise
 * - Hysteresis thresholds to prevent flip-flopping
 * - Per-strategy and global regime disabling
 * - Size multiplier mapping from scores
 * - Atomic JSON persistence
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { FlowRegime } from '../market/flowMetrics';
import { feedbackEngine, RegimeHeatmapCell } from './feedbackEngine';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sizing policy for a regime
 */
export interface RegimeSizePolicy {
    /** Size multiplier (0.2 - 1.2 typically) */
    multiplier: number;
    /** Smoothed score used to compute the multiplier */
    smoothedScore: number;
    /** Raw score from heatmap (for explainability) */
    rawScore: number;
    /** Number of trades used in computation */
    trades: number;
}

/**
 * Policy for a strategy (or global)
 */
export interface StrategyRegimePolicy {
    /** Regimes that are currently disabled */
    disabledRegimes: FlowRegime[];
    /** Size multiplier by regime */
    sizeByRegime: Record<FlowRegime, RegimeSizePolicy>;
}

/**
 * Complete regime policy state
 */
export interface RegimePolicy {
    /** Timestamp when policy was updated */
    updatedAt: number;
    /** Lookback window used (hours) */
    lookbackHours: number;
    /** Global policy (applies to all strategies) */
    global: StrategyRegimePolicy;
    /** Per-strategy policies */
    strategies: Record<string, StrategyRegimePolicy>;
    /** Human-readable reasons for current state */
    reasons: string[];
    /** Raw stats used for computation (for debugging/display) */
    stats: {
        totalTrades: number;
        regimeCounts: Record<FlowRegime, number>;
        computedAt: number;
    };
}

/**
 * Internal smoothed state persisted between updates
 */
interface SmoothedState {
    global: Record<FlowRegime, number>;
    strategies: Record<string, Record<FlowRegime, number>>;
    lastUpdatedAt: number;
}

/**
 * Configuration for regime policy engine
 */
export interface RegimePolicyConfig {
    /** Enable regime policy (default: true) */
    enabled: boolean;
    /** Lookback window in hours (default: 24) */
    lookbackHours: number;
    /** Minimum trades for valid stats (default: 30) */
    minTrades: number;
    /** Smoothing alpha (default: 0.2, higher = more responsive) */
    alpha: number;
    /** Score below which regime is disabled (default: -5) */
    disableScoreBps: number;
    /** Score above which disabled regime is re-enabled (default: +2) */
    enableScoreBps: number;
    /** Minimum size multiplier (default: 0.2) */
    minSize: number;
    /** Maximum size multiplier (default: 1.2) */
    maxSize: number;
    /** Size step for quantization (default: 0.1) */
    sizeStep: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration from Environment
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RegimePolicyConfig = {
    enabled: true,
    lookbackHours: 24,
    minTrades: 30,
    alpha: 0.2,
    disableScoreBps: -5,
    enableScoreBps: 2,
    minSize: 0.2,
    maxSize: 1.2,
    sizeStep: 0.1,
};

export function loadRegimePolicyConfig(): RegimePolicyConfig {
    return {
        enabled: process.env.REGIME_POLICY_ENABLED !== 'false',
        lookbackHours: parseInt(process.env.REGIME_POLICY_LOOKBACK_HOURS || '', 10) || DEFAULT_CONFIG.lookbackHours,
        minTrades: parseInt(process.env.REGIME_POLICY_MIN_TRADES || '', 10) || DEFAULT_CONFIG.minTrades,
        alpha: parseFloat(process.env.REGIME_POLICY_ALPHA || '') || DEFAULT_CONFIG.alpha,
        disableScoreBps: parseFloat(process.env.REGIME_DISABLE_SCORE_BPS || '') || DEFAULT_CONFIG.disableScoreBps,
        enableScoreBps: parseFloat(process.env.REGIME_ENABLE_SCORE_BPS || '') || DEFAULT_CONFIG.enableScoreBps,
        minSize: parseFloat(process.env.REGIME_MIN_SIZE || '') || DEFAULT_CONFIG.minSize,
        maxSize: parseFloat(process.env.REGIME_MAX_SIZE || '') || DEFAULT_CONFIG.maxSize,
        sizeStep: parseFloat(process.env.REGIME_SIZE_STEP || '') || DEFAULT_CONFIG.sizeStep,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Regime Policy Engine
// ─────────────────────────────────────────────────────────────────────────────

const ALL_REGIMES: FlowRegime[] = ['quiet', 'normal', 'trendingUp', 'trendingDown', 'chaotic', 'illiquid'];
const DATA_DIR = join(process.cwd(), 'data');
const POLICY_FILE = join(DATA_DIR, 'regime-policy.json');
const SMOOTHED_FILE = join(DATA_DIR, 'regime-smoothed.json');

export class RegimePolicyEngine {
    private config: RegimePolicyConfig;
    private currentPolicy: RegimePolicy | null = null;
    private smoothedState: SmoothedState;

    constructor(config?: Partial<RegimePolicyConfig>) {
        this.config = { ...loadRegimePolicyConfig(), ...config };
        this.smoothedState = this.loadSmoothedState();
        this.currentPolicy = this.loadPolicy();
    }

    /**
     * Recompute the regime policy based on current heatmap data
     */
    recompute(): RegimePolicy {
        const heatmap = feedbackEngine.getRegimeHeatmap({
            lookbackHours: this.config.lookbackHours,
            minTrades: Math.max(1, Math.floor(this.config.minTrades / 6)), // Use lower threshold for per-regime
            byStrategy: true,
        });

        const reasons: string[] = [];
        const regimeCounts: Record<FlowRegime, number> = {} as Record<FlowRegime, number>;

        // Initialize regime counts
        for (const regime of ALL_REGIMES) {
            regimeCounts[regime] = heatmap.global[regime]?.trades ?? 0;
        }

        // Compute global policy
        const global = this.computeStrategyPolicy(
            heatmap.global,
            this.smoothedState.global,
            'global',
            reasons
        );

        // Update smoothed state for global
        for (const regime of ALL_REGIMES) {
            this.smoothedState.global[regime] = global.sizeByRegime[regime]?.smoothedScore ?? 0;
        }

        // Compute per-strategy policies
        const strategies: Record<string, StrategyRegimePolicy> = {};
        for (const [strategy, regimeStats] of Object.entries(heatmap.perStrategy)) {
            if (!this.smoothedState.strategies[strategy]) {
                this.smoothedState.strategies[strategy] = this.initSmoothedRegimes();
            }

            const strategySmoothed = this.smoothedState.strategies[strategy]!;

            const strategyPolicy = this.computeStrategyPolicy(
                regimeStats,
                strategySmoothed,
                strategy,
                reasons
            );
            strategies[strategy] = strategyPolicy;

            // Update smoothed state for strategy
            for (const regime of ALL_REGIMES) {
                strategySmoothed[regime] =
                    strategyPolicy.sizeByRegime[regime]?.smoothedScore ?? 0;
            }
        }

        this.smoothedState.lastUpdatedAt = Date.now();

        const policy: RegimePolicy = {
            updatedAt: Date.now(),
            lookbackHours: this.config.lookbackHours,
            global,
            strategies,
            reasons,
            stats: {
                totalTrades: heatmap.meta.totalTrades,
                regimeCounts,
                computedAt: heatmap.meta.computedAt,
            },
        };

        this.currentPolicy = policy;

        // Persist state
        this.savePolicy(policy);
        this.saveSmoothedState();

        logger.info({
            totalTrades: heatmap.meta.totalTrades,
            globalDisabled: global.disabledRegimes,
            strategyCount: Object.keys(strategies).length,
            reasonCount: reasons.length,
        }, 'Regime policy recomputed');

        return policy;
    }

    /**
     * Get the current policy (loads from disk if not in memory)
     */
    getCurrentPolicy(): RegimePolicy | null {
        if (!this.currentPolicy) {
            this.currentPolicy = this.loadPolicy();
        }
        return this.currentPolicy;
    }

    /**
     * Get effective size multiplier for a strategy+regime
     * Returns multiplier from per-strategy policy if available, else global
     */
    getEffectiveSizeMultiplier(strategy: string, regime: FlowRegime): number {
        if (!this.config.enabled) return 1.0;

        const policy = this.getCurrentPolicy();
        if (!policy) return 1.0;

        // Check per-strategy first
        const strategyPolicy = policy.strategies[strategy];
        if (strategyPolicy?.sizeByRegime[regime]) {
            return strategyPolicy.sizeByRegime[regime].multiplier;
        }

        // Fall back to global
        return policy.global.sizeByRegime[regime]?.multiplier ?? 1.0;
    }

    /**
     * Check if a regime is disabled for a strategy
     */
    isRegimeDisabled(strategy: string, regime: FlowRegime): boolean {
        if (!this.config.enabled) return false;

        const policy = this.getCurrentPolicy();
        if (!policy) return false;

        // Check per-strategy first
        const strategyPolicy = policy.strategies[strategy];
        if (strategyPolicy?.disabledRegimes.includes(regime)) {
            return true;
        }

        // Check global
        return policy.global.disabledRegimes.includes(regime);
    }

    /**
     * Get all disabled regimes for a strategy (union of strategy-specific and global)
     */
    getDisabledRegimes(strategy: string): FlowRegime[] {
        if (!this.config.enabled) return [];

        const policy = this.getCurrentPolicy();
        if (!policy) return [];

        const disabled = new Set<FlowRegime>(policy.global.disabledRegimes);
        const strategyPolicy = policy.strategies[strategy];
        if (strategyPolicy) {
            for (const regime of strategyPolicy.disabledRegimes) {
                disabled.add(regime);
            }
        }

        return Array.from(disabled);
    }

    /**
     * Get the config
     */
    getConfig(): RegimePolicyConfig {
        return { ...this.config };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private Methods
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Compute policy for a single entity (global or strategy)
     */
    private computeStrategyPolicy(
        regimeStats: Record<FlowRegime, RegimeHeatmapCell>,
        previousSmoothed: Record<FlowRegime, number>,
        entityName: string,
        reasons: string[]
    ): StrategyRegimePolicy {
        const disabledRegimes: FlowRegime[] = [];
        const sizeByRegime: Record<FlowRegime, RegimeSizePolicy> = {} as Record<FlowRegime, RegimeSizePolicy>;

        // Track what's currently disabled (for hysteresis)
        const wasDisabled = new Set(
            this.currentPolicy
                ? entityName === 'global'
                    ? this.currentPolicy.global.disabledRegimes
                    : this.currentPolicy.strategies[entityName]?.disabledRegimes ?? []
                : []
        );

        for (const regime of ALL_REGIMES) {
            const cell = regimeStats[regime];
            const rawScore = cell?.score ?? 0;
            const trades = cell?.trades ?? 0;

            // Apply exponential smoothing
            const prevSmoothed = previousSmoothed[regime] ?? 0;
            const smoothedScore = this.config.alpha * rawScore + (1 - this.config.alpha) * prevSmoothed;

            // Hysteresis for disabling/enabling
            const currentlyDisabled = wasDisabled.has(regime);
            let shouldDisable = false;

            if (trades >= this.config.minTrades) {
                if (currentlyDisabled) {
                    // To re-enable: score must exceed enableScoreBps
                    if (smoothedScore < this.config.enableScoreBps) {
                        shouldDisable = true;
                    } else {
                        reasons.push(`${entityName}: Re-enabled ${regime} (score ${smoothedScore.toFixed(1)} >= ${this.config.enableScoreBps})`);
                    }
                } else {
                    // To disable: score must fall below disableScoreBps
                    if (smoothedScore < this.config.disableScoreBps) {
                        shouldDisable = true;
                        reasons.push(`${entityName}: Disabled ${regime} (score ${smoothedScore.toFixed(1)} < ${this.config.disableScoreBps})`);
                    }
                }
            } else if (trades > 0 && trades < this.config.minTrades) {
                // Insufficient trades - keep previous state
                shouldDisable = currentlyDisabled;
            }
            // If trades === 0, keep enabled (no evidence to disable)

            if (shouldDisable) {
                disabledRegimes.push(regime);
            }

            // Compute size multiplier from score
            const multiplier = this.scoreToSizeMultiplier(smoothedScore);

            sizeByRegime[regime] = {
                multiplier,
                smoothedScore,
                rawScore,
                trades,
            };
        }

        return { disabledRegimes, sizeByRegime };
    }

    /**
     * Map score to size multiplier with clamping and quantization
     */
    private scoreToSizeMultiplier(score: number): number {
        // Base multiplier is 1.0
        // Negative scores decrease size, positive scores increase
        // Scale: every 10 bps of score = 0.1 multiplier change
        const delta = score / 100; // -1 to +1 for scores in [-100, 100]
        let multiplier = 1.0 + delta;

        // Clamp to bounds
        multiplier = Math.max(this.config.minSize, Math.min(this.config.maxSize, multiplier));

        // Quantize to step
        multiplier = Math.round(multiplier / this.config.sizeStep) * this.config.sizeStep;

        return multiplier;
    }

    /**
     * Initialize empty smoothed regimes
     */
    private initSmoothedRegimes(): Record<FlowRegime, number> {
        const result: Record<FlowRegime, number> = {} as Record<FlowRegime, number>;
        for (const regime of ALL_REGIMES) {
            result[regime] = 0;
        }
        return result;
    }

    /**
     * Load smoothed state from disk
     */
    private loadSmoothedState(): SmoothedState {
        try {
            if (existsSync(SMOOTHED_FILE)) {
                const data = JSON.parse(readFileSync(SMOOTHED_FILE, 'utf-8'));
                logger.debug({ path: SMOOTHED_FILE }, 'Loaded smoothed state');
                return {
                    global: data.global ?? this.initSmoothedRegimes(),
                    strategies: data.strategies ?? {},
                    lastUpdatedAt: data.lastUpdatedAt ?? 0,
                };
            }
        } catch (err) {
            logger.warn({ err }, 'Failed to load smoothed state, starting fresh');
        }

        return {
            global: this.initSmoothedRegimes(),
            strategies: {},
            lastUpdatedAt: 0,
        };
    }

    /**
     * Save smoothed state to disk (atomic write)
     */
    private saveSmoothedState(): void {
        try {
            const dir = dirname(SMOOTHED_FILE);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }

            const tmpFile = `${SMOOTHED_FILE}.tmp`;
            writeFileSync(tmpFile, JSON.stringify(this.smoothedState, null, 2), 'utf-8');
            renameSync(tmpFile, SMOOTHED_FILE);
        } catch (err) {
            logger.warn({ err }, 'Failed to save smoothed state');
        }
    }

    /**
     * Load policy from disk
     */
    private loadPolicy(): RegimePolicy | null {
        try {
            if (existsSync(POLICY_FILE)) {
                const data = JSON.parse(readFileSync(POLICY_FILE, 'utf-8')) as RegimePolicy;
                logger.debug({ path: POLICY_FILE, updatedAt: new Date(data.updatedAt).toISOString() }, 'Loaded regime policy');
                return data;
            }
        } catch (err) {
            logger.warn({ err }, 'Failed to load regime policy');
        }
        return null;
    }

    /**
     * Save policy to disk (atomic write)
     */
    private savePolicy(policy: RegimePolicy): void {
        try {
            const dir = dirname(POLICY_FILE);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }

            const tmpFile = `${POLICY_FILE}.tmp`;
            writeFileSync(tmpFile, JSON.stringify(policy, null, 2), 'utf-8');
            renameSync(tmpFile, POLICY_FILE);
            logger.debug({ path: POLICY_FILE }, 'Saved regime policy');
        } catch (err) {
            logger.warn({ err }, 'Failed to save regime policy');
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

let instance: RegimePolicyEngine | null = null;

/**
 * Get or create the singleton regime policy engine
 */
export function getRegimePolicyEngine(): RegimePolicyEngine {
    if (!instance) {
        instance = new RegimePolicyEngine();
    }
    return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetRegimePolicyEngine(): void {
    instance = null;
}
