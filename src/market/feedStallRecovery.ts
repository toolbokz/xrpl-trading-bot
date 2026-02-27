/**
 * Feed Stall Recovery — Staged Reconnection for Market Data Feeds
 *
 * Monitors trade-tape and order-book event flow. When events stop arriving
 * for longer than configurable thresholds, escalates through three recovery stages:
 *
 *   Stage 1 — Soft reconnect:  re-subscribe to streams on the existing connection
 *   Stage 2 — Hard resubscribe: disconnect and reconnect the WebSocket
 *   Stage 3 — Full client rebuild: destroy the shared client and rebuild from scratch
 *
 * Each stage has a cooldown; if the feed resumes, the stage counter resets.
 * The recovery is cooperative — it exposes state so ExecutionGate can block
 * trading while recovery is in progress.
 */

import { runtimeLog as logger } from '../analytics/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type StallRecoveryStage = 'HEALTHY' | 'STAGE_1' | 'STAGE_2' | 'STAGE_3';

export interface FeedStallConfig {
    /** Time without events before entering Stage 1 (default 30 000 ms) */
    stage1ThresholdMs: number;
    /** Time without events before escalating to Stage 2 (default 60 000 ms) */
    stage2ThresholdMs: number;
    /** Time without events before escalating to Stage 3 (default 120 000 ms) */
    stage3ThresholdMs: number;
    /** Minimum time between recovery attempts at the same stage (default 15 000 ms) */
    cooldownMs: number;
}

export const DEFAULT_STALL_CONFIG: FeedStallConfig = {
    stage1ThresholdMs: 30_000,
    stage2ThresholdMs: 60_000,
    stage3ThresholdMs: 120_000,
    cooldownMs: 15_000,
};

export interface FeedStallEvent {
    event: string;
    stage: StallRecoveryStage;
    silenceDurationMs: number;
    timestamp: number;
    detail?: string | undefined;
}

export interface FeedStallState {
    /** Current recovery stage. */
    stage: StallRecoveryStage;
    /** Whether recovery is currently executing (async). */
    recovering: boolean;
    /** Timestamp of the last received tape event (ms epoch). */
    lastTapeEventMs: number;
    /** Timestamp of the last received book update (ms epoch). */
    lastBookEventMs: number;
    /** Timestamp of the last recovery attempt (ms epoch). */
    lastRecoveryAttemptMs: number;
    /** Total number of recovery attempts since last healthy state. */
    recoveryAttempts: number;
}

/**
 * Callbacks the recovery system uses to interact with the XRPL connection.
 * The runtime wires these to the actual client/subscription methods.
 */
export interface FeedStallActions {
    /** Stage 1: re-subscribe streams on existing connection. */
    softReconnect: () => Promise<void>;
    /** Stage 2: disconnect and reconnect WebSocket. */
    hardResubscribe: () => Promise<void>;
    /** Stage 3: destroy shared client and rebuild from scratch. */
    fullClientRebuild: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// FeedStallRecovery
// ─────────────────────────────────────────────────────────────────────────────

export class FeedStallRecovery {
    private stage: StallRecoveryStage = 'HEALTHY';
    private recovering = false;
    private lastTapeEventMs = 0;
    private lastBookEventMs = 0;
    private lastRecoveryAttemptMs = 0;
    private recoveryAttempts = 0;
    private readonly config: FeedStallConfig;
    private readonly actions: FeedStallActions;

    constructor(actions: FeedStallActions, config: FeedStallConfig = DEFAULT_STALL_CONFIG) {
        this.actions = actions;
        this.config = config;
    }

    // ─── Event ingestion (called by runtime on every received event) ─────

    /** Call when a new trade-tape event arrives. */
    recordTapeEvent(nowMs: number = Date.now()): void {
        this.lastTapeEventMs = nowMs;
        this.tryResetToHealthy(nowMs);
    }

    /** Call when a new order-book update arrives. */
    recordBookEvent(nowMs: number = Date.now()): void {
        this.lastBookEventMs = nowMs;
        this.tryResetToHealthy(nowMs);
    }

    /** If at least one feed has recent events, reset to HEALTHY. */
    private tryResetToHealthy(nowMs: number): void {
        if (this.stage === 'HEALTHY') return;
        const tapeSilence = this.lastTapeEventMs > 0 ? nowMs - this.lastTapeEventMs : Infinity;
        const bookSilence = this.lastBookEventMs > 0 ? nowMs - this.lastBookEventMs : Infinity;
        // Reset if EITHER signal is within the Stage 1 threshold.
        // The previous BOTH requirement created a deadlock: the book signal
        // would never update while the tracker returned false for staleness,
        // so recovery never completed and kept escalating destructive reconnects.
        // For XRP/RLUSD the trade tape can be legitimately quiet for minutes
        // while the book is alive — that's normal, not a stall.
        const eitherAlive = tapeSilence < this.config.stage1ThresholdMs ||
            bookSilence < this.config.stage1ThresholdMs;
        if (eitherAlive) {
            this.emitEvent('FEED_STALL_RECOVERED', nowMs, Math.min(tapeSilence, bookSilence));
            this.stage = 'HEALTHY';
            this.recoveryAttempts = 0;
        }
    }

    // ─── Evaluation (called once per tick) ───────────────────────────────

    /**
     * Evaluate current feed silence and trigger recovery if needed.
     * Returns the current stage and whether recovery is in progress.
     * This is cooperative: the caller (tick loop) should skip trading
     * while `recovering` is true.
     */
    async evaluate(nowMs: number = Date.now()): Promise<FeedStallState> {
        // Compute max silence across both signals
        const tapeSilence = this.lastTapeEventMs > 0 ? nowMs - this.lastTapeEventMs : Infinity;
        const bookSilence = this.lastBookEventMs > 0 ? nowMs - this.lastBookEventMs : Infinity;
        const maxSilence = Math.min(tapeSilence, bookSilence) === Infinity
            ? Infinity
            : Math.max(tapeSilence, bookSilence);

        // Determine target stage
        const targetStage = this.classifyStage(maxSilence);

        // Escalate if needed
        if (this.stageOrdinal(targetStage) > this.stageOrdinal(this.stage)) {
            this.stage = targetStage;
        }

        // Attempt recovery if not already in progress and cooldown has elapsed
        if (this.stage !== 'HEALTHY' && !this.recovering) {
            const sinceLastAttempt = nowMs - this.lastRecoveryAttemptMs;
            if (sinceLastAttempt >= this.config.cooldownMs) {
                await this.executeRecovery(nowMs, maxSilence === Infinity ? 0 : maxSilence);
            }
        }

        return this.getState();
    }

    /** Get current state snapshot (for ExecutionGate). */
    getState(): FeedStallState {
        return {
            stage: this.stage,
            recovering: this.recovering,
            lastTapeEventMs: this.lastTapeEventMs,
            lastBookEventMs: this.lastBookEventMs,
            lastRecoveryAttemptMs: this.lastRecoveryAttemptMs,
            recoveryAttempts: this.recoveryAttempts,
        };
    }

    /** Is recovery currently in progress? */
    isRecovering(): boolean {
        return this.recovering;
    }

    /** Reset all state (for pair switch or shutdown). */
    reset(): void {
        this.stage = 'HEALTHY';
        this.recovering = false;
        this.lastTapeEventMs = 0;
        this.lastBookEventMs = 0;
        this.lastRecoveryAttemptMs = 0;
        this.recoveryAttempts = 0;
    }

    // ─── Private ─────────────────────────────────────────────────────────

    private classifyStage(silenceMs: number): StallRecoveryStage {
        if (silenceMs >= this.config.stage3ThresholdMs) return 'STAGE_3';
        if (silenceMs >= this.config.stage2ThresholdMs) return 'STAGE_2';
        if (silenceMs >= this.config.stage1ThresholdMs) return 'STAGE_1';
        return 'HEALTHY';
    }

    private stageOrdinal(stage: StallRecoveryStage): number {
        switch (stage) {
            case 'HEALTHY': return 0;
            case 'STAGE_1': return 1;
            case 'STAGE_2': return 2;
            case 'STAGE_3': return 3;
        }
    }

    private async executeRecovery(nowMs: number, silenceDurationMs: number): Promise<void> {
        this.recovering = true;
        this.lastRecoveryAttemptMs = nowMs;
        this.recoveryAttempts++;

        try {
            switch (this.stage) {
                case 'STAGE_1':
                    this.emitEvent('FEED_STALL_STAGE_1', nowMs, silenceDurationMs, 'soft-reconnect');
                    await this.actions.softReconnect();
                    break;
                case 'STAGE_2':
                    this.emitEvent('FEED_STALL_STAGE_2', nowMs, silenceDurationMs, 'hard-resubscribe');
                    await this.actions.hardResubscribe();
                    break;
                case 'STAGE_3':
                    this.emitEvent('FEED_STALL_STAGE_3', nowMs, silenceDurationMs, 'full-client-rebuild');
                    await this.actions.fullClientRebuild();
                    break;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.emitEvent('FEED_STALL_RECOVERY_FAILED', nowMs, silenceDurationMs, msg);
            logger.error({ err, stage: this.stage }, 'Feed stall recovery failed');
        } finally {
            this.recovering = false;
        }
    }

    private emitEvent(event: string, nowMs: number, silenceDurationMs: number, detail?: string): void {
        const evt: FeedStallEvent = {
            event,
            stage: this.stage,
            silenceDurationMs,
            timestamp: nowMs,
            detail,
        };
        logger.info(evt, `FEED_STALL: ${event}`);
    }
}
