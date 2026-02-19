/**
 * Adaptive Learner Module
 *
 * Computes per-strategy, per-pair, per-regime performance scores from recent data
 * and produces bounded parameter adjustments (nudges) and regime allow/deny gates.
 *
 * Key principles:
 * - Deterministic and explainable
 * - Bounded changes (no wild swings)
 * - Smoothed with exponential decay
 * - Persists state to disk for restart recovery
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { FlowRegime } from '../market/flowMetrics';
import { feedbackEngine, QueryFilters } from './feedbackEngine';
import { TradeEventRecord } from './feedbackDb';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type StrategyKey = string;
export type PairKey = string;
export type Regime = FlowRegime;

/**
 * Tuning parameters for a specific strategy+pair+regime combination.
 * All values are bounded to prevent extreme adjustments.
 */
export interface AdaptiveTuning {
    /** Size multiplier for position sizing [0, 1.5] */
    sizeMultiplier: number;
    /** Quote skew in basis points [-25, +25] */
    quoteSkewBps: number;
    /** Maximum slippage allowed in bps [10, 150] */
    maxSlippageBps: number;
    /** Minimum edge required to trade in bps [0, 30] */
    minEdgeBpsToTrade: number;
    /** Cooldown between trades in ms [0, 60000] */
    coolDownMs: number;
    /** Regimes where this strategy is disabled */
    disabledRegimes: Regime[];
    /** Last update timestamp */
    updatedAt: number;
    /** Human-readable explanation of tuning decisions */
    reason: string;
}

/**
 * Performance metrics for a strategy+regime combination.
 */
export interface PerformanceRow {
    strategy: StrategyKey;
    regime: Regime;
    fills: number;
    avgNetEdgeBps: number;
    avgSlippageBpsVsMid: number;
    avgSpreadPaidBps: number;
    partialFillRate: number;
    winRateProxy: number;
    score: number;
}

/**
 * Full adaptive state persisted to disk.
 */
export interface AdaptiveState {
    version: number;
    updatedAt: number;
    /** Nested map: pairKey -> strategy -> regime -> tuning */
    tunings: Record<PairKey, Record<StrategyKey, Partial<Record<Regime, AdaptiveTuning>>>>;
}

/**
 * Learning dataset entry: trade event with regime context.
 */
export interface LearningDataPoint {
    event: TradeEventRecord;
    regime: FlowRegime | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface AdaptiveLearnerConfig {
    /** Hours of data to consider for learning (default: 24) */
    lookbackHours: number;
    /** Minimum samples required before adjusting tuning (default: 25) */
    minSamples: number;
    /** Smoothing factor for exponential moving average (default: 0.2) */
    alpha: number;
    /** Maximum size multiplier step per update (default: 0.1) */
    maxSizeStep: number;
    /** Maximum slippage step per update in bps (default: 10) */
    maxSlippageStep: number;
    /** Path to state file */
    statePath: string;
}

function getConfigFromEnv(): AdaptiveLearnerConfig {
    return {
        lookbackHours: parseInt(process.env.ADAPTIVE_LOOKBACK_HOURS || '24', 10),
        minSamples: parseInt(process.env.ADAPTIVE_MIN_SAMPLES || '25', 10),
        alpha: parseFloat(process.env.ADAPTIVE_ALPHA || '0.2'),
        maxSizeStep: parseFloat(process.env.ADAPTIVE_MAX_SIZE_STEP || '0.1'),
        maxSlippageStep: parseFloat(process.env.ADAPTIVE_MAX_SLIPPAGE_STEP || '10'),
        statePath: process.env.ADAPTIVE_STATE_PATH || join(process.cwd(), 'data', 'adaptive-state.json'),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CURRENT_VERSION = 1;

const ALL_REGIMES: Regime[] = ['quiet', 'normal', 'trendingUp', 'trendingDown', 'chaotic', 'illiquid'];

/** Default tuning values */
export const DEFAULT_TUNING: AdaptiveTuning = {
    sizeMultiplier: 1.0,
    quoteSkewBps: 0,
    maxSlippageBps: 50,
    minEdgeBpsToTrade: 0,
    coolDownMs: 0,
    disabledRegimes: [],
    updatedAt: 0,
    reason: 'default',
};

// Bounds for tuning parameters
const BOUNDS = {
    sizeMultiplier: { min: 0, max: 1.5 },
    quoteSkewBps: { min: -25, max: 25 },
    maxSlippageBps: { min: 10, max: 150 },
    minEdgeBpsToTrade: { min: 0, max: 30 },
    coolDownMs: { min: 0, max: 60000 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load adaptive state from disk.
 * Returns default state if file is missing or corrupt.
 */
export function loadAdaptiveState(statePath?: string): AdaptiveState {
    const path = statePath ?? getConfigFromEnv().statePath;

    if (!existsSync(path)) {
        logger.info({ path }, 'Adaptive state file not found, starting with defaults');
        return createDefaultState();
    }

    try {
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw) as AdaptiveState;

        // Validate structure
        if (typeof parsed.version !== 'number' || typeof parsed.tunings !== 'object') {
            throw new Error('Invalid state structure');
        }

        // Handle version migrations if needed
        if (parsed.version < CURRENT_VERSION) {
            logger.info({ oldVersion: parsed.version, newVersion: CURRENT_VERSION }, 'Migrating adaptive state');
            return migrateState(parsed);
        }

        logger.info({ path, updatedAt: new Date(parsed.updatedAt).toISOString() }, 'Loaded adaptive state');
        return parsed;
    } catch (err) {
        logger.warn({ err, path }, 'Failed to load adaptive state, starting with defaults');
        return createDefaultState();
    }
}

/**
 * Save adaptive state to disk atomically.
 * Writes to temp file then renames to prevent corruption.
 */
export function saveAdaptiveState(state: AdaptiveState, statePath?: string): void {
    const path = statePath ?? getConfigFromEnv().statePath;
    const tempPath = `${path}.tmp`;

    try {
        // Ensure directory exists
        const dir = dirname(path);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        // Update timestamp
        state.updatedAt = Date.now();

        // Write to temp file
        writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');

        // Atomic rename
        renameSync(tempPath, path);

        logger.debug({ path }, 'Saved adaptive state');
    } catch (err) {
        logger.error({ err, path }, 'Failed to save adaptive state');
        throw err;
    }
}

function createDefaultState(): AdaptiveState {
    return {
        version: CURRENT_VERSION,
        updatedAt: Date.now(),
        tunings: {},
    };
}

function migrateState(state: AdaptiveState): AdaptiveState {
    // Future migrations can be handled here
    return {
        ...state,
        version: CURRENT_VERSION,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Learning Dataset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get learning dataset from feedback engine.
 * Returns fill events with their corresponding regime context.
 */
export function getLearningDataset(filters: QueryFilters = {}): LearningDataPoint[] {
    return feedbackEngine.getLearningDataset(filters);
}

// ─────────────────────────────────────────────────────────────────────────────
// Performance Matrix
// ─────────────────────────────────────────────────────────────────────────────

export interface ComputePerformanceOptions {
    pairKey: string;
    sinceMs?: number;
    minSamples?: number;
}

/**
 * Compute performance matrix for all strategies and regimes.
 */
export function computePerformanceMatrix(opts: ComputePerformanceOptions): PerformanceRow[] {
    const config = getConfigFromEnv();
    const minSamples = opts.minSamples ?? config.minSamples;
    const sinceMs = opts.sinceMs ?? Date.now() - config.lookbackHours * 60 * 60 * 1000;

    const dataset = getLearningDataset({ pairKey: opts.pairKey, sinceMs });

    // Group by strategy + regime
    const groups = new Map<string, LearningDataPoint[]>();

    for (const dp of dataset) {
        const regime = dp.regime ?? 'normal';
        const key = `${dp.event.strategy}:${regime}`;
        const existing = groups.get(key) || [];
        existing.push(dp);
        groups.set(key, existing);
    }

    // Compute metrics for each group
    const results: PerformanceRow[] = [];

    for (const [key, points] of groups) {
        const parts = key.split(':');
        const strategy = parts[0] ?? 'unknown';
        const regime = (parts[1] ?? 'normal') as Regime;

        if (points.length < minSamples) {
            // Not enough samples, skip
            continue;
        }

        const metrics = computeGroupMetrics(points);
        results.push({
            strategy,
            regime,
            ...metrics,
        });
    }

    return results;
}

function computeGroupMetrics(points: LearningDataPoint[]): Omit<PerformanceRow, 'strategy' | 'regime'> {
    const fills = points.length;

    let sumNetEdge = 0;
    let countNetEdge = 0;
    let sumSlippage = 0;
    let countSlippage = 0;
    let sumSpread = 0;
    let countSpread = 0;
    let partialCount = 0;
    let positiveEdgeCount = 0;

    for (const dp of points) {
        const e = dp.event;

        if (e.netEdgeBpsVsMid != null) {
            sumNetEdge += e.netEdgeBpsVsMid;
            countNetEdge++;
            if (e.netEdgeBpsVsMid > 0) {
                positiveEdgeCount++;
            }
        }

        if (e.slippageBpsVsMid != null) {
            sumSlippage += e.slippageBpsVsMid;
            countSlippage++;
        }

        if (e.spreadPaidBps != null) {
            sumSpread += e.spreadPaidBps;
            countSpread++;
        }

        if (e.isPartial === 1) {
            partialCount++;
        }
    }

    const avgNetEdgeBps = countNetEdge > 0 ? sumNetEdge / countNetEdge : 0;
    const avgSlippageBpsVsMid = countSlippage > 0 ? sumSlippage / countSlippage : 0;
    const avgSpreadPaidBps = countSpread > 0 ? sumSpread / countSpread : 0;
    const partialFillRate = fills > 0 ? partialCount / fills : 0;
    const winRateProxy = countNetEdge > 0 ? positiveEdgeCount / countNetEdge : 0;

    // Composite score formula:
    // score = avgNetEdgeBps - 0.5*avgSlippageBpsVsMid - 0.25*avgSpreadPaidBps - 20*partialFillRate
    const rawScore = avgNetEdgeBps - 0.5 * avgSlippageBpsVsMid - 0.25 * avgSpreadPaidBps - 20 * partialFillRate;
    const score = Math.max(-100, Math.min(100, rawScore));

    return {
        fills,
        avgNetEdgeBps,
        avgSlippageBpsVsMid,
        avgSpreadPaidBps,
        partialFillRate,
        winRateProxy,
        score,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuning Recommendations
// ─────────────────────────────────────────────────────────────────────────────

export interface RecommendTuningOptions {
    perfRow: PerformanceRow;
    priorTuning?: AdaptiveTuning;
    config?: AdaptiveLearnerConfig;
}

/**
 * Generate tuning recommendation based on performance metrics.
 * Applies bounded heuristics and smoothing.
 */
export function recommendTuning(opts: RecommendTuningOptions): AdaptiveTuning {
    const { perfRow, priorTuning } = opts;
    const config = opts.config ?? getConfigFromEnv();

    const prior = priorTuning ?? { ...DEFAULT_TUNING };

    // Start from defaults
    let sizeMultiplier = 1.0;
    let maxSlippageBps = DEFAULT_TUNING.maxSlippageBps;
    let minEdgeBpsToTrade = 0;
    let coolDownMs = 0;
    const disabledRegimes: Regime[] = [];

    const { avgNetEdgeBps, avgSlippageBpsVsMid, partialFillRate, score, regime, winRateProxy } = perfRow;

    // ─────────────────────────────────────────────────────────────────────────
    // Heuristic 1: Disable dangerous regimes
    // ─────────────────────────────────────────────────────────────────────────
    if ((regime === 'chaotic' || regime === 'illiquid') && score < 0) {
        disabledRegimes.push(regime);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Heuristic 2: Negative edge → reduce exposure
    // ─────────────────────────────────────────────────────────────────────────
    if (avgNetEdgeBps < 0) {
        // Reduce size by up to 0.25
        const reduction = Math.min(0.25, Math.abs(avgNetEdgeBps) / 40);
        sizeMultiplier = Math.max(0, 1 - reduction);

        // Increase min edge threshold (up to +10)
        const edgeIncrease = Math.min(10, Math.abs(avgNetEdgeBps) / 2);
        minEdgeBpsToTrade = edgeIncrease;

        // Add cooldown (up to 10s)
        const cooldownIncrease = Math.min(10000, Math.abs(avgNetEdgeBps) * 200);
        coolDownMs = cooldownIncrease;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Heuristic 3: High partial fill rate → reduce size
    // ─────────────────────────────────────────────────────────────────────────
    if (partialFillRate > 0.3) {
        const reduction = Math.min(0.2, (partialFillRate - 0.3) * 0.5);
        sizeMultiplier = Math.max(0, sizeMultiplier - reduction);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Heuristic 4: Strong performance → reward
    // ─────────────────────────────────────────────────────────────────────────
    if (avgNetEdgeBps > 5 && avgSlippageBpsVsMid < 10 && winRateProxy > 0.55) {
        sizeMultiplier = Math.min(1.2, sizeMultiplier + 0.1);
        minEdgeBpsToTrade = Math.max(0, minEdgeBpsToTrade - 2);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Apply smoothing with prior tuning
    // ─────────────────────────────────────────────────────────────────────────
    const alpha = config.alpha;

    // Smooth size multiplier
    const smoothedSize = smoothValue(prior.sizeMultiplier, sizeMultiplier, alpha, config.maxSizeStep);
    sizeMultiplier = clamp(smoothedSize, BOUNDS.sizeMultiplier.min, BOUNDS.sizeMultiplier.max);

    // Smooth max slippage
    const smoothedSlippage = smoothValue(prior.maxSlippageBps, maxSlippageBps, alpha, config.maxSlippageStep);
    maxSlippageBps = clamp(smoothedSlippage, BOUNDS.maxSlippageBps.min, BOUNDS.maxSlippageBps.max);

    // Smooth min edge (no max step, just alpha smoothing)
    const smoothedMinEdge = smoothValue(prior.minEdgeBpsToTrade, minEdgeBpsToTrade, alpha, 5);
    minEdgeBpsToTrade = clamp(smoothedMinEdge, BOUNDS.minEdgeBpsToTrade.min, BOUNDS.minEdgeBpsToTrade.max);

    // Smooth cooldown
    const smoothedCooldown = smoothValue(prior.coolDownMs, coolDownMs, alpha, 5000);
    coolDownMs = clamp(Math.round(smoothedCooldown), BOUNDS.coolDownMs.min, BOUNDS.coolDownMs.max);

    // Merge disabled regimes (keep prior disables unless explicitly cleared)
    const mergedDisabled = new Set([...prior.disabledRegimes, ...disabledRegimes]);

    // Build reason string using final (post-smoothing) values
    const finalReasons: string[] = [];
    if (mergedDisabled.size > 0) {
        finalReasons.push(`disabled: ${Array.from(mergedDisabled).join(', ')}`);
    }
    if (avgNetEdgeBps < 0) {
        finalReasons.push(`negEdge=${avgNetEdgeBps.toFixed(1)}bps → size×${sizeMultiplier.toFixed(2)}, minEdge=${minEdgeBpsToTrade.toFixed(1)}bps, cooldown=${(coolDownMs / 1000).toFixed(1)}s`);
    }
    if (partialFillRate > 0.3) {
        finalReasons.push(`highPartials=${(partialFillRate * 100).toFixed(0)}%`);
    }
    if (avgNetEdgeBps > 5 && avgSlippageBpsVsMid < 10 && winRateProxy > 0.55) {
        finalReasons.push(`strongPerf (edge=${avgNetEdgeBps.toFixed(1)}, wr=${(winRateProxy * 100).toFixed(0)}%) → size×${sizeMultiplier.toFixed(2)}`);
    }
    const reasonStr = finalReasons.length > 0
        ? `${perfRow.fills} fills: ${finalReasons.join('; ')}`
        : `stable (score=${score.toFixed(1)}, fills=${perfRow.fills})`;

    return {
        sizeMultiplier,
        quoteSkewBps: prior.quoteSkewBps, // Keep prior skew
        maxSlippageBps,
        minEdgeBpsToTrade,
        coolDownMs,
        disabledRegimes: Array.from(mergedDisabled),
        updatedAt: Date.now(),
        reason: reasonStr,
    };
}

/**
 * Apply exponential smoothing with max step constraint.
 */
function smoothValue(prior: number, target: number, alpha: number, maxStep: number): number {
    const raw = prior + alpha * (target - prior);
    const delta = raw - prior;
    const clampedDelta = Math.max(-maxStep, Math.min(maxStep, delta));
    return prior + clampedDelta;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptive Learner Class
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateOptions {
    pairKeys: string[];
    strategies: string[];
    forceUpdate?: boolean;
}

export class AdaptiveLearner {
    private state: AdaptiveState;
    private config: AdaptiveLearnerConfig;

    constructor(config?: Partial<AdaptiveLearnerConfig>) {
        this.config = { ...getConfigFromEnv(), ...config };
        this.state = loadAdaptiveState(this.config.statePath);
    }

    /**
     * Get current state (read-only).
     */
    getState(): AdaptiveState {
        return this.state;
    }

    /**
     * Get tuning for specific combination.
     */
    getTuning(pairKey: string, strategy: string, regime: Regime): AdaptiveTuning | null {
        const byPair = this.state.tunings[pairKey];
        if (!byPair) return null;
        const byStrat = byPair[strategy];
        if (!byStrat) return null;
        return byStrat[regime] ?? null;
    }

    /**
     * Run one learning update cycle.
     * Computes performance for each strategy+regime and updates tunings.
     */
    updateOnce(opts: UpdateOptions): void {
        const { pairKeys, strategies, forceUpdate } = opts;
        const sinceMs = Date.now() - this.config.lookbackHours * 60 * 60 * 1000;

        logger.info({ pairKeys, strategies, sinceMs: new Date(sinceMs).toISOString() }, 'Starting adaptive learning update');

        let updatedCount = 0;
        let skippedCount = 0;

        for (const pairKey of pairKeys) {
            // Ensure nested structure exists
            if (!this.state.tunings[pairKey]) {
                this.state.tunings[pairKey] = {};
            }

            // Compute performance matrix for this pair
            const perfMatrix = computePerformanceMatrix({
                pairKey,
                sinceMs,
                minSamples: forceUpdate ? 1 : this.config.minSamples,
            });

            // Index by strategy+regime for quick lookup
            const perfIndex = new Map<string, PerformanceRow>();
            for (const row of perfMatrix) {
                perfIndex.set(`${row.strategy}:${row.regime}`, row);
            }

            // Get or create pair tunings
            const pairTunings = this.state.tunings[pairKey]!;

            for (const strategy of strategies) {
                if (!pairTunings[strategy]) {
                    pairTunings[strategy] = {};
                }
                const strategyTunings = pairTunings[strategy]!;

                for (const regime of ALL_REGIMES) {
                    const key = `${strategy}:${regime}`;
                    const perfRow = perfIndex.get(key);

                    const priorTuning = strategyTunings[regime];

                    if (perfRow) {
                        // Generate recommendation based on performance
                        const tuningOpts: RecommendTuningOptions = {
                            perfRow,
                            config: this.config,
                        };
                        if (priorTuning) {
                            tuningOpts.priorTuning = priorTuning;
                        }
                        const newTuning = recommendTuning(tuningOpts);

                        strategyTunings[regime] = newTuning;
                        updatedCount++;

                        logger.debug({
                            pairKey,
                            strategy,
                            regime,
                            fills: perfRow.fills,
                            score: perfRow.score.toFixed(1),
                            sizeMultiplier: newTuning.sizeMultiplier.toFixed(2),
                            reason: newTuning.reason,
                        }, 'Updated adaptive tuning');
                    } else if (!priorTuning) {
                        // Initialize baseline tuning so UI/runtime always have a visible
                        // context while the learner is still collecting enough samples.
                        strategyTunings[regime] = {
                            ...DEFAULT_TUNING,
                            updatedAt: Date.now(),
                            reason: forceUpdate ? 'initialized (no data)' : `collecting samples (<${this.config.minSamples})`,
                        };
                        updatedCount++;
                    } else {
                        // No new performance data; keep prior tuning unchanged.
                        skippedCount++;
                    }
                }
            }
        }

        // Save state
        this.state.updatedAt = Date.now();
        saveAdaptiveState(this.state, this.config.statePath);

        logger.info({ updatedCount, skippedCount }, 'Adaptive learning update complete');
    }

    /**
     * Reload state from disk.
     */
    reload(): void {
        this.state = loadAdaptiveState(this.config.statePath);
    }

    /**
     * Get the performance row used for a specific tuning.
     * Useful for explainability.
     */
    explainTuning(pairKey: string, strategy: string, regime: Regime): {
        tuning: AdaptiveTuning | null;
        performance: PerformanceRow | null;
    } {
        const tuning = this.getTuning(pairKey, strategy, regime);

        const sinceMs = Date.now() - this.config.lookbackHours * 60 * 60 * 1000;
        const perfMatrix = computePerformanceMatrix({
            pairKey,
            sinceMs,
            minSamples: 1, // Get data even with few samples for explanation
        });

        const performance = perfMatrix.find(r => r.strategy === strategy && r.regime === regime) ?? null;

        return { tuning, performance };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

let learnerInstance: AdaptiveLearner | null = null;

export function getAdaptiveLearner(): AdaptiveLearner {
    if (!learnerInstance) {
        learnerInstance = new AdaptiveLearner();
    }
    return learnerInstance;
}

export function resetAdaptiveLearner(): void {
    learnerInstance = null;
}
