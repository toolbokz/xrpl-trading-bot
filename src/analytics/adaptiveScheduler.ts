/**
 * Adaptive Scheduler Module
 *
 * Periodically runs the adaptive learner to update tunings
 * based on recent trading performance.
 */

import { getAdaptiveLearner, AdaptiveLearner } from './adaptiveLearner';
import { setAdaptiveTunings, isAdaptiveEnabled } from './adaptiveConfig';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

interface SchedulerConfig {
    /** Update interval in minutes (default: 15) */
    intervalMinutes: number;
    /** Pair keys to update */
    pairKeys: string[];
    /** Strategy names to update */
    strategies: string[];
}

function getConfigFromEnv(): SchedulerConfig {
    return {
        intervalMinutes: parseInt(process.env.ADAPTIVE_UPDATE_INTERVAL_MIN || '15', 10),
        pairKeys: [], // Will be set by caller
        strategies: [], // Will be set by caller
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler State
// ─────────────────────────────────────────────────────────────────────────────

let schedulerInterval: NodeJS.Timeout | null = null;
let learner: AdaptiveLearner | null = null;
let currentConfig: SchedulerConfig | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface StartSchedulerOptions {
    /** Trading pair keys to learn from */
    pairKeys: string[];
    /** Strategy names to learn from */
    strategies: string[];
    /** Override update interval in minutes */
    intervalMinutes?: number;
}

/**
 * Start the adaptive learning scheduler.
 * Runs immediately then on configured interval.
 */
export function startAdaptiveScheduler(opts: StartSchedulerOptions): void {
    if (schedulerInterval) {
        logger.warn('Adaptive scheduler already running, stopping first');
        stopAdaptiveScheduler();
    }

    if (!isAdaptiveEnabled()) {
        logger.info('Adaptive learning disabled, scheduler not started');
        return;
    }

    const envConfig = getConfigFromEnv();
    currentConfig = {
        intervalMinutes: opts.intervalMinutes ?? envConfig.intervalMinutes,
        pairKeys: opts.pairKeys,
        strategies: opts.strategies,
    };

    learner = getAdaptiveLearner();

    // Load persisted state into runtime config
    const state = learner.getState();
    setAdaptiveTunings(state);

    logger.info({
        intervalMinutes: currentConfig.intervalMinutes,
        pairKeys: currentConfig.pairKeys,
        strategies: currentConfig.strategies,
    }, 'Starting adaptive learning scheduler');

    // Run immediately
    runUpdate();

    // Schedule periodic updates
    const intervalMs = currentConfig.intervalMinutes * 60 * 1000;
    schedulerInterval = setInterval(runUpdate, intervalMs);
}

/**
 * Stop the adaptive learning scheduler.
 */
export function stopAdaptiveScheduler(): void {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
    }
    learner = null;
    currentConfig = null;
    logger.info('Adaptive learning scheduler stopped');
}

/**
 * Check if scheduler is running.
 */
export function isSchedulerRunning(): boolean {
    return schedulerInterval !== null;
}

/**
 * Trigger an immediate update (manual recompute).
 */
export function triggerUpdate(): void {
    if (!learner || !currentConfig) {
        logger.warn('Cannot trigger update - scheduler not running');
        return;
    }
    runUpdate();
}

/**
 * Get current scheduler config.
 */
export function getSchedulerConfig(): SchedulerConfig | null {
    return currentConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

function runUpdate(): void {
    if (!learner || !currentConfig) {
        return;
    }

    if (!isAdaptiveEnabled()) {
        logger.debug('Skipping adaptive update - disabled');
        return;
    }

    try {
        logger.debug('Running adaptive learning update');

        learner.updateOnce({
            pairKeys: currentConfig.pairKeys,
            strategies: currentConfig.strategies,
        });

        // Push updated state to runtime config
        const state = learner.getState();
        setAdaptiveTunings(state);

    } catch (err) {
        // Never crash trading - log and continue
        logger.warn({ err }, 'Adaptive learning update failed');
    }
}
