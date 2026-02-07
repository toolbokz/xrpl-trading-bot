/**
 * Event Loop Lag Tracker — Infrastructure Safety Monitor
 *
 * Measures Node.js event loop lag via setTimeout delta technique.
 * Maintains a rolling window of samples for P50/P95/P99 calculation.
 * Drives auto-pause decisions when lag indicates system overload.
 *
 * Usage:
 *   const tracker = new EventLoopLagTracker();
 *   tracker.start();
 *   // ... later in the tick loop ...
 *   if (tracker.shouldAutoPause()) { return; }
 *
 * @module monitoring/eventLoopLag
 */

import { logger } from '../analytics/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EventLoopLagConfig {
    /** Sample interval in ms (default: 500). */
    sampleIntervalMs: number;
    /** Number of samples in the rolling window (default: 120 = 60s at 500ms interval). */
    windowSize: number;
    /** P95 lag threshold for auto-pause in ms (default: 100). */
    lagLimitMs: number;
    /** CPU load threshold for auto-pause (default: 80). */
    cpuLoadLimit: number;
    /** Recovery window — samples below threshold before un-pausing (default: 10). */
    recoveryWindow: number;
}

export interface EventLoopLagState {
    /** Current P50 lag in ms. */
    p50Ms: number;
    /** Current P95 lag in ms. */
    p95Ms: number;
    /** Current P99 lag in ms. */
    p99Ms: number;
    /** Whether auto-pause is currently active. */
    autoPaused: boolean;
    /** Number of samples collected. */
    sampleCount: number;
    /** Last sample timestamp. */
    lastSampleMs: number;
    /** Whether the tracker is running. */
    running: boolean;
}

export interface InfraSafetyState {
    eventLoopLagP95Ms: number;
    cpuLoad: number;
    unstable: boolean;
    autoPaused: boolean;
}

const DEFAULT_CONFIG: EventLoopLagConfig = {
    sampleIntervalMs: 500,
    windowSize: 120,
    lagLimitMs: 100,
    cpuLoadLimit: 80,
    recoveryWindow: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure decision function (testable without timers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine if trading should be auto-paused based on infra metrics.
 */
export function shouldAutoPauseTrading(input: {
    eventLoopLagP95Ms: number;
    cpuLoad: number;
    lagLimitMs: number;
    cpuLimit: number;
}): boolean {
    return input.eventLoopLagP95Ms > input.lagLimitMs || input.cpuLoad > input.cpuLimit;
}

/**
 * Record one event loop lag sample and return the measured lag in ms.
 * This is the core measurement primitive — call via setTimeout(fn, 0)
 * and compare actual elapsed time vs expected.
 */
export function recordInfraLagSample(expectedMs: number, actualElapsedMs: number): number {
    return Math.max(0, actualElapsedMs - expectedMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracker
// ─────────────────────────────────────────────────────────────────────────────

export class EventLoopLagTracker {
    private readonly config: EventLoopLagConfig;
    private samples: number[] = [];
    private running = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private autoPaused = false;
    private consecutiveBelowThreshold = 0;
    private lastSampleMs = 0;

    constructor(config: Partial<EventLoopLagConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Start the event loop lag sampler.
     */
    start(): void {
        if (this.running) return;
        this.running = true;
        this.samples = [];
        this.autoPaused = false;
        this.consecutiveBelowThreshold = 0;
        this.scheduleSample();
        logger.info({ lagLimitMs: this.config.lagLimitMs }, 'Event loop lag tracker started');
    }

    /**
     * Stop the tracker.
     */
    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /**
     * Whether trading should be paused due to infra instability.
     */
    isAutoPaused(): boolean {
        return this.autoPaused;
    }

    /**
     * Get current state snapshot.
     */
    getState(): EventLoopLagState {
        const sorted = [...this.samples].sort((a, b) => a - b);
        return {
            p50Ms: percentile(sorted, 50),
            p95Ms: percentile(sorted, 95),
            p99Ms: percentile(sorted, 99),
            autoPaused: this.autoPaused,
            sampleCount: this.samples.length,
            lastSampleMs: this.lastSampleMs,
            running: this.running,
        };
    }

    /**
     * Get infra safety state for integration with execution gate.
     */
    getInfraSafetyState(cpuLoad: number = 0): InfraSafetyState {
        const sorted = [...this.samples].sort((a, b) => a - b);
        const p95 = percentile(sorted, 95);
        return {
            eventLoopLagP95Ms: p95,
            cpuLoad,
            unstable: p95 > this.config.lagLimitMs || cpuLoad > this.config.cpuLoadLimit,
            autoPaused: this.autoPaused,
        };
    }

    /**
     * Manually add a sample (for testing).
     */
    addSample(lagMs: number): void {
        this.pushSample(lagMs);
    }

    // ─── Internals ───────────────────────────────────────────────────────

    private scheduleSample(): void {
        if (!this.running) return;

        const start = Date.now();
        this.timer = setTimeout(() => {
            if (!this.running) return;

            const elapsed = Date.now() - start;
            const lag = recordInfraLagSample(this.config.sampleIntervalMs, elapsed);
            this.pushSample(lag);
            this.evaluateAutoPause();
            this.scheduleSample();
        }, this.config.sampleIntervalMs);

        // Unref so the timer doesn't prevent process exit
        if (this.timer && typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }

    private pushSample(lagMs: number): void {
        this.samples.push(lagMs);
        this.lastSampleMs = Date.now();

        // Ring buffer eviction
        if (this.samples.length > this.config.windowSize) {
            this.samples.shift();
        }
    }

    private evaluateAutoPause(): void {
        if (this.samples.length < 3) return;

        const sorted = [...this.samples].sort((a, b) => a - b);
        const p95 = percentile(sorted, 95);

        const shouldPause = shouldAutoPauseTrading({
            eventLoopLagP95Ms: p95,
            cpuLoad: 0, // CPU is tracked separately by cpuWatchdog
            lagLimitMs: this.config.lagLimitMs,
            cpuLimit: this.config.cpuLoadLimit,
        });

        if (shouldPause) {
            this.consecutiveBelowThreshold = 0;
            if (!this.autoPaused) {
                this.autoPaused = true;
                logger.warn(
                    { p95Ms: p95, lagLimitMs: this.config.lagLimitMs },
                    '🚨 Event loop lag auto-pause triggered',
                );
            }
        } else {
            this.consecutiveBelowThreshold += 1;
            // Recovery hysteresis — require multiple samples below threshold
            if (this.autoPaused && this.consecutiveBelowThreshold >= this.config.recoveryWindow) {
                this.autoPaused = false;
                logger.info(
                    { p95Ms: p95, recoveryWindow: this.config.recoveryWindow },
                    '✅ Event loop lag recovered — resuming trading',
                );
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let globalTracker: EventLoopLagTracker | null = null;

export function getEventLoopLagTracker(config?: Partial<EventLoopLagConfig>): EventLoopLagTracker {
    if (!globalTracker) {
        globalTracker = new EventLoopLagTracker(config);
    }
    return globalTracker;
}

export function stopEventLoopLagTracker(): void {
    if (globalTracker) {
        globalTracker.stop();
        globalTracker = null;
    }
}

/**
 * Load event loop lag config from environment.
 */
export function loadEventLoopLagConfig(): Partial<EventLoopLagConfig> {
    const toNumber = (val: string | undefined): number | undefined => {
        if (val === undefined) return undefined;
        const parsed = Number(val);
        return Number.isFinite(parsed) ? parsed : undefined;
    };
    const config: Partial<EventLoopLagConfig> = {};
    const lag = toNumber(process.env.EVENT_LOOP_LAG_LIMIT_MS);
    if (lag !== undefined) config.lagLimitMs = lag;
    const interval = toNumber(process.env.EVENT_LOOP_SAMPLE_INTERVAL_MS);
    if (interval !== undefined) config.sampleIntervalMs = interval;
    return config;
}
