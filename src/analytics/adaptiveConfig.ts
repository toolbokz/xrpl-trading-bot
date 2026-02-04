/**
 * Adaptive Config Module
 *
 * Runtime singleton that provides read-only access to adaptive tunings.
 * Used by OfferExecutor and TradingRuntime to apply learned adjustments.
 *
 * This module is intentionally "read-only" for consumers - only the
 * AdaptiveLearner/Scheduler can update the tunings via setAdaptiveTunings().
 */

import { FlowRegime } from '../market/flowMetrics';
import { AdaptiveTuning, AdaptiveState } from './adaptiveLearner';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let enabled = process.env.ADAPTIVE_LEARNING_ENABLED !== 'false';

let current: {
    updatedAt: number;
    tunings: Record<string, Record<string, Partial<Record<FlowRegime, AdaptiveTuning>>>>;
} = {
    updatedAt: 0,
    tunings: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the current adaptive tunings from AdaptiveLearner.
 * Called by the scheduler after each learning cycle.
 */
export function setAdaptiveTunings(state: AdaptiveState): void {
    current = {
        updatedAt: state.updatedAt,
        tunings: state.tunings,
    };
    logger.debug({ updatedAt: new Date(state.updatedAt).toISOString() }, 'Adaptive tunings updated');
}

/**
 * Check if adaptive learning is enabled.
 */
export function isAdaptiveEnabled(): boolean {
    return enabled;
}

/**
 * Enable or disable adaptive learning at runtime.
 * Does not delete state - just stops applying tunings.
 */
export function setAdaptiveEnabled(value: boolean): void {
    if (enabled !== value) {
        logger.info({ enabled: value }, 'Adaptive learning toggled');
    }
    enabled = value;
}

/**
 * Get the current tunings state for debugging/API.
 */
export function getAdaptiveState(): typeof current {
    return current;
}

/**
 * Get tuning for a specific pairKey + strategy + regime.
 * Returns null if adaptive is disabled or no tuning exists.
 *
 * Fallback order:
 * 1. Exact regime match
 * 2. "normal" regime
 * 3. First available regime for that strategy
 * 4. null
 */
export function getAdaptiveTuning(
    pairKey: string,
    strategy: string,
    regime: FlowRegime | null
): AdaptiveTuning | null {
    if (!enabled) return null;

    const byPair = current.tunings[pairKey];
    if (!byPair) return null;

    const byStrat = byPair[strategy];
    if (!byStrat) return null;

    const r = (regime ?? 'normal') as FlowRegime;

    // Prefer exact regime → else normal → else any first available
    const tuning = byStrat[r] ?? byStrat['normal'] ?? Object.values(byStrat)[0] ?? null;

    return tuning ?? null;
}

/**
 * Check if a specific regime is disabled for a strategy+pair.
 */
export function isRegimeDisabled(
    pairKey: string,
    strategy: string,
    regime: FlowRegime
): boolean {
    if (!enabled) return false;

    const tuning = getAdaptiveTuning(pairKey, strategy, regime);
    if (!tuning) return false;

    return tuning.disabledRegimes.includes(regime);
}

/**
 * Get effective max slippage for a strategy+pair+regime.
 * Returns null if no adaptive tuning (use default).
 */
export function getAdaptiveMaxSlippageBps(
    pairKey: string,
    strategy: string,
    regime: FlowRegime | null
): number | null {
    const tuning = getAdaptiveTuning(pairKey, strategy, regime);
    return tuning?.maxSlippageBps ?? null;
}

/**
 * Get effective size multiplier for a strategy+pair+regime.
 * Returns null if no adaptive tuning (use 1.0).
 */
export function getAdaptiveSizeMultiplier(
    pairKey: string,
    strategy: string,
    regime: FlowRegime | null
): number | null {
    const tuning = getAdaptiveTuning(pairKey, strategy, regime);
    return tuning?.sizeMultiplier ?? null;
}

/**
 * Get effective min edge threshold for a strategy+pair+regime.
 * Returns null if no adaptive tuning (use 0).
 */
export function getAdaptiveMinEdgeBps(
    pairKey: string,
    strategy: string,
    regime: FlowRegime | null
): number | null {
    const tuning = getAdaptiveTuning(pairKey, strategy, regime);
    return tuning?.minEdgeBpsToTrade ?? null;
}

/**
 * Get effective cooldown for a strategy+pair+regime.
 * Returns null if no adaptive tuning (use 0).
 */
export function getAdaptiveCooldownMs(
    pairKey: string,
    strategy: string,
    regime: FlowRegime | null
): number | null {
    const tuning = getAdaptiveTuning(pairKey, strategy, regime);
    return tuning?.coolDownMs ?? null;
}
