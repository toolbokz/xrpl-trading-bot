/**
 * CPU watchdog - monitors CPU usage and triggers pause when threshold exceeded.
 * Prevents runaway processes from pegging CPU.
 */

import { logger } from '../analytics/logger';
import { sleep } from '../utils/sleep';

/** Max sustained CPU % (configurable via CPU_MAX_PERCENT) */
export const CPU_MAX_PERCENT = Math.max(
    10,
    Math.min(90, parseInt(process.env.CPU_MAX_PERCENT ?? '50', 10) || 50)
);

/** Duration in ms before triggering pause (configurable via CPU_MAX_DURATION_MS) */
export const CPU_MAX_DURATION_MS = Math.max(
    1000,
    parseInt(process.env.CPU_MAX_DURATION_MS ?? '5000', 10) || 5000
);

/** Check interval in ms */
const CHECK_INTERVAL_MS = 1000;

export interface CpuWatchdogConfig {
    maxPercent?: number;
    maxDurationMs?: number;
    onThresholdExceeded?: () => void | Promise<void>;
}

export interface CpuSample {
    timestamp: number;
    percent: number;
}

export class CpuWatchdog {
    private readonly maxPercent: number;
    private readonly maxDurationMs: number;
    private readonly onThresholdExceeded: (() => void | Promise<void>) | null;
    private running = false;
    private samples: CpuSample[] = [];
    private lastCpuUsage: NodeJS.CpuUsage | null = null;
    private lastSampleTime: number = 0;
    private thresholdExceededSince: number | null = null;
    private paused = false;

    constructor(config: CpuWatchdogConfig = {}) {
        this.maxPercent = config.maxPercent ?? CPU_MAX_PERCENT;
        this.maxDurationMs = config.maxDurationMs ?? CPU_MAX_DURATION_MS;
        this.onThresholdExceeded = config.onThresholdExceeded ?? null;
    }

    /**
     * Start the CPU watchdog.
     */
    start(): void {
        if (this.running) return;
        this.running = true;
        this.samples = [];
        this.lastCpuUsage = process.cpuUsage();
        this.lastSampleTime = Date.now();
        this.thresholdExceededSince = null;
        this.paused = false;
        this.monitorLoop();
        logger.info({ maxPercent: this.maxPercent, maxDurationMs: this.maxDurationMs }, 'CPU watchdog started');
    }

    /**
     * Stop the CPU watchdog.
     */
    stop(): void {
        this.running = false;
        logger.info('CPU watchdog stopped');
    }

    /**
     * Check if trading is paused due to high CPU.
     */
    isPaused(): boolean {
        return this.paused;
    }

    /**
     * Resume trading after CPU drops.
     */
    resume(): void {
        if (this.paused) {
            this.paused = false;
            this.thresholdExceededSince = null;
            logger.info('CPU watchdog: resumed trading');
        }
    }

    /**
     * Get recent CPU samples (for monitoring).
     */
    getRecentSamples(): CpuSample[] {
        return [...this.samples];
    }

    /**
     * Get current CPU percentage estimate.
     */
    getCurrentPercent(): number {
        if (this.samples.length === 0) return 0;
        const lastSample = this.samples[this.samples.length - 1];
        return lastSample?.percent ?? 0;
    }

    /**
     * Main monitoring loop.
     */
    private async monitorLoop(): Promise<void> {
        while (this.running) {
            try {
                const cpuPercent = this.sampleCpu();
                this.samples.push({ timestamp: Date.now(), percent: cpuPercent });

                // Keep only last 60 samples (1 minute)
                if (this.samples.length > 60) {
                    this.samples.shift();
                }

                // Check threshold
                if (cpuPercent > this.maxPercent) {
                    if (this.thresholdExceededSince === null) {
                        this.thresholdExceededSince = Date.now();
                        logger.warn(
                            { cpuPercent, maxPercent: this.maxPercent },
                            'CPU threshold exceeded - monitoring'
                        );
                    } else {
                        const duration = Date.now() - this.thresholdExceededSince;
                        if (duration >= this.maxDurationMs && !this.paused) {
                            this.paused = true;
                            logger.error(
                                { cpuPercent, duration, maxDurationMs: this.maxDurationMs },
                                '🚨 CPU threshold exceeded for too long - pausing trading'
                            );
                            if (this.onThresholdExceeded) {
                                try {
                                    await this.onThresholdExceeded();
                                } catch (err) {
                                    logger.error({ err }, 'Error in CPU threshold callback');
                                }
                            }
                        }
                    }
                } else {
                    // CPU dropped below threshold
                    if (this.thresholdExceededSince !== null) {
                        logger.info({ cpuPercent }, 'CPU dropped below threshold');
                        this.thresholdExceededSince = null;
                    }
                    // Auto-resume if paused and CPU is healthy for at least 5 seconds
                    if (this.paused) {
                        const recentSamples = this.samples.slice(-5);
                        const allBelowThreshold = recentSamples.every((s) => s.percent <= this.maxPercent);
                        if (recentSamples.length >= 5 && allBelowThreshold) {
                            this.resume();
                        }
                    }
                }
            } catch (err) {
                logger.error({ err }, 'CPU watchdog error');
            }

            await sleep(CHECK_INTERVAL_MS);
        }
    }

    /**
     * Sample CPU usage since last sample.
     * @returns CPU usage as percentage (0-100)
     */
    private sampleCpu(): number {
        const now = Date.now();
        const currentUsage = process.cpuUsage(this.lastCpuUsage ?? undefined);
        const elapsedMs = now - this.lastSampleTime;

        // Calculate CPU percentage
        // cpuUsage returns microseconds, elapsed is milliseconds
        const totalCpuMicros = currentUsage.user + currentUsage.system;
        const elapsedMicros = elapsedMs * 1000;
        const cpuPercent = elapsedMicros > 0 ? (totalCpuMicros / elapsedMicros) * 100 : 0;

        this.lastCpuUsage = process.cpuUsage();
        this.lastSampleTime = now;

        return Math.min(100, Math.round(cpuPercent * 10) / 10);
    }
}

/**
 * Global CPU watchdog singleton.
 */
let globalWatchdog: CpuWatchdog | null = null;

export const getCpuWatchdog = (config?: CpuWatchdogConfig): CpuWatchdog => {
    if (!globalWatchdog) {
        globalWatchdog = new CpuWatchdog(config);
    }
    return globalWatchdog;
};

/**
 * Start the global CPU watchdog with a callback.
 */
export const startCpuWatchdog = (onThresholdExceeded?: () => void | Promise<void>): CpuWatchdog => {
    const config: CpuWatchdogConfig = onThresholdExceeded ? { onThresholdExceeded } : {};
    const watchdog = getCpuWatchdog(config);
    watchdog.start();
    return watchdog;
};

/**
 * Check if trading should proceed (CPU not paused).
 * @returns true if trading is allowed
 */
export const isCpuHealthy = (): boolean => {
    if (!globalWatchdog) return true;
    return !globalWatchdog.isPaused();
};
