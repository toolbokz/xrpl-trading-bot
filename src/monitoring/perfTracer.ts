/**
 * Lightweight per-tick performance tracer.
 *
 * Records per-phase wall-clock durations using process.hrtime.bigint(),
 * tracks Node event-loop delay via perf_hooks.monitorEventLoopDelay,
 * and emits a periodic "PERF_SUMMARY" log line with p50/p95/p99
 * for every phase as well as overall tick latency.
 *
 * Design goals:
 *   • Zero allocation in the hot path (reuses pre-allocated arrays)
 *   • No IO — summary is logged on a timer, never inline
 *   • < 5 µs overhead per phase mark (hrtime.bigint is ~20ns)
 *   • Does NOT change any business logic or safety gates
 */

import { monitorEventLoopDelay } from 'perf_hooks';
import { logger } from '../analytics/logger';

type EventLoopDelayMonitor = ReturnType<typeof monitorEventLoopDelay>;

// ─────────────────────────────────────────────────────────────────────────────
// Phase definitions (order matches tick() call sequence)
// ─────────────────────────────────────────────────────────────────────────────

export const TICK_PHASES = [
    'riskReset',         // checkAndResetDaily
    'reserveCheck',      // checkReserves (XRPL RPC)
    'bookRefresh',       // tracker.refresh() (XRPL RPC)
    'snapshot',          // normalizeOrderBookSnapshot + snapshotValidator
    'feedStall',         // feedStallRecovery.evaluate
    'healthQuorum',      // computeMarketDataHealth + evaluateExecutionGate
    'fsmTransitions',    // runtime FSM state transitions
    'flowMetrics',       // computeFlowMetrics
    'cacheUpdate',       // updateCacheSnapshot
    'feedbackRecord',    // feedbackEngine.recordSnapshot
    'hardRisk',          // hardRiskGuard.evaluate
    'capitalProtection', // capitalProtection.evaluate + governance
    'strategies',        // strategy loop (all strategies combined)
] as const;

export type TickPhase = typeof TICK_PHASES[number];

const PHASE_COUNT = TICK_PHASES.length;

// ─────────────────────────────────────────────────────────────────────────────
// Rolling histogram (fixed-size ring for percentile computation)
// ─────────────────────────────────────────────────────────────────────────────

const HISTOGRAM_SIZE = 200; // last 200 ticks ≈ ~13 min at 4s ticks

class RollingHistogram {
    private buf: Float64Array;
    private pos = 0;
    private count = 0;

    constructor(size: number) {
        this.buf = new Float64Array(size);
    }

    record(val: number): void {
        this.buf[this.pos] = val;
        this.pos = (this.pos + 1) % this.buf.length;
        if (this.count < this.buf.length) this.count++;
    }

    /** Returns [p50, p95, p99] in the same unit as recorded values. */
    percentiles(): [number, number, number] {
        if (this.count === 0) return [0, 0, 0];
        // Copy only the valid portion, sort
        const sorted = new Float64Array(this.count);
        if (this.count < this.buf.length) {
            sorted.set(this.buf.subarray(0, this.count));
        } else {
            sorted.set(this.buf);
        }
        sorted.sort();
        const p = (pct: number) => sorted[Math.min(Math.floor(pct * this.count), this.count - 1)]!;
        return [p(0.5), p(0.95), p(0.99)];
    }

    getCount(): number {
        return this.count;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PerfTracer singleton
// ─────────────────────────────────────────────────────────────────────────────

/** Summary interval (configurable via PERF_SUMMARY_INTERVAL_MS, default 30s) */
const SUMMARY_INTERVAL_MS = Math.max(
    5_000,
    parseInt(process.env.PERF_SUMMARY_INTERVAL_MS ?? '30000', 10) || 30_000,
);

export class PerfTracer {
    // Per-phase histograms (µs)
    private phaseHistograms: RollingHistogram[] = [];
    // Overall tick histogram (µs)
    private tickHistogram = new RollingHistogram(HISTOGRAM_SIZE);
    // Event-loop delay monitor
    private elMonitor: EventLoopDelayMonitor | null = null;
    // Timer handle
    private summaryTimer: ReturnType<typeof setInterval> | null = null;
    // Scratch space for current tick phase timestamps (ns bigint)
    private marks: bigint[] = new Array(PHASE_COUNT + 1).fill(0n);
    private tickActive = false;
    // Total ticks counted
    private tickCount = 0;

    constructor() {
        for (let i = 0; i < PHASE_COUNT; i++) {
            this.phaseHistograms.push(new RollingHistogram(HISTOGRAM_SIZE));
        }
    }

    /** Start the tracer — call once at runtime startup. */
    start(): void {
        // Event-loop delay monitor (20ms resolution)
        try {
            this.elMonitor = monitorEventLoopDelay({ resolution: 20 });
            this.elMonitor.enable();
        } catch {
            // Not available on all platforms
        }

        this.summaryTimer = setInterval(() => this.logSummary(), SUMMARY_INTERVAL_MS);
        // Don't prevent process exit
        if (this.summaryTimer.unref) this.summaryTimer.unref();
    }

    /** Stop the tracer — call on shutdown. */
    stop(): void {
        if (this.summaryTimer) {
            clearInterval(this.summaryTimer);
            this.summaryTimer = null;
        }
        if (this.elMonitor) {
            this.elMonitor.disable();
            this.elMonitor = null;
        }
    }

    // ── Tick instrumentation ────────────────────────────────────────────

    /** Call at the very start of tick(). */
    tickStart(): void {
        this.marks[0] = process.hrtime.bigint();
        this.tickActive = true;
    }

    /** Call between phases. phaseIndex: index into TICK_PHASES of the phase that JUST ENDED. */
    phaseEnd(phaseIndex: number): void {
        if (!this.tickActive) return;
        this.marks[phaseIndex + 1] = process.hrtime.bigint();
    }

    /** Call at the very end of tick() (in finally block). */
    tickEnd(): void {
        if (!this.tickActive) return;
        this.tickActive = false;
        this.tickCount++;

        const tickStartNs = this.marks[0]!;
        const tickEndNs = process.hrtime.bigint();
        const tickUs = Number(tickEndNs - tickStartNs) / 1_000;
        this.tickHistogram.record(tickUs);

        // Record per-phase durations
        for (let i = 0; i < PHASE_COUNT; i++) {
            const startNs = this.marks[i]!;
            const endNs = this.marks[i + 1]!;
            if (endNs > 0n && startNs > 0n) {
                const phaseUs = Number(endNs - startNs) / 1_000;
                this.phaseHistograms[i]!.record(phaseUs);
            }
        }

        // Zero out marks for next tick
        for (let i = 0; i <= PHASE_COUNT; i++) {
            this.marks[i] = 0n;
        }
    }

    // ── Summary ─────────────────────────────────────────────────────────

    private logSummary(): void {
        if (this.tickCount === 0) return;

        const phases: Record<string, { p50: number; p95: number; p99: number }> = {};
        for (let i = 0; i < PHASE_COUNT; i++) {
            const [p50, p95, p99] = this.phaseHistograms[i]!.percentiles();
            phases[TICK_PHASES[i]!] = {
                p50: Math.round(p50),
                p95: Math.round(p95),
                p99: Math.round(p99),
            };
        }

        const [tickP50, tickP95, tickP99] = this.tickHistogram.percentiles();

        // Event-loop delay stats
        let elDelay = { p50: 0, p95: 0, p99: 0, max: 0 };
        if (this.elMonitor) {
            elDelay = {
                p50: Math.round(this.elMonitor.percentile(50) / 1e6), // ns → ms
                p95: Math.round(this.elMonitor.percentile(95) / 1e6),
                p99: Math.round(this.elMonitor.percentile(99) / 1e6),
                max: Math.round(this.elMonitor.max / 1e6),
            };
            this.elMonitor.reset();
        }

        // Memory
        const mem = process.memoryUsage();

        logger.info({
            event: 'PERF_SUMMARY',
            ticks: this.tickCount,
            tickUs: { p50: Math.round(tickP50), p95: Math.round(tickP95), p99: Math.round(tickP99) },
            phases,
            eventLoopDelayMs: elDelay,
            memMB: {
                rss: Math.round(mem.rss / 1e6),
                heap: Math.round(mem.heapUsed / 1e6),
                heapTotal: Math.round(mem.heapTotal / 1e6),
            },
        }, 'PERF_SUMMARY');
    }
}

// Singleton
let globalTracer: PerfTracer | null = null;

export function getPerfTracer(): PerfTracer {
    if (!globalTracer) {
        globalTracer = new PerfTracer();
    }
    return globalTracer;
}

export function stopPerfTracer(): void {
    if (globalTracer) {
        globalTracer.stop();
        globalTracer = null;
    }
}
