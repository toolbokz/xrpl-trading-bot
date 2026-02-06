/**
 * Pair Switch Orchestrator — Drives the 12-State FSM
 *
 * Coordinates all components during a pair switch:
 *   1. Freeze execution (tick guard)
 *   2. Detach old-pair listeners (conceptual — XRPL streams are pair-agnostic)
 *   3. Destroy old pair context (clear all per-pair state)
 *   4. Reset metrics windows (flow, volatility, health, timestamps)
 *   5. Create new pair context (set pair on all components)
 *   6. Subscribe new feeds (re-subscribe XRPL streams if needed)
 *   7. Wait for first order-book snapshot
 *   8. Wait for first tape event (with timeout)
 *   9. Refresh balances
 *  10. Validate data truth (health quorum, snapshot integrity)
 *
 * The orchestrator does NOT own any components. It receives action callbacks
 * from TradingRuntime and drives the FSM through each phase.
 */

import { runtimeLog as logger } from '../analytics/logger';
import { TradingPair } from '../config';
import {
    PairSwitchFsm,
    PairSwitchPhase,
    PairSwitchEvent,
} from './pairSwitchFsm';

// ─────────────────────────────────────────────────────────────────────────────
// PairContext — per-pair encapsulated state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encapsulates all state that is specific to a single trading pair.
 * When a pair switch occurs, the old context is fully destroyed and
 * a new context is created.
 */
export interface PairContext {
    /** The pair key (e.g. "XRP/RLUSD"). */
    pairKey: string;
    /** The resolved TradingPair config. */
    pair: TradingPair;
    /** When this context was created (ms epoch). */
    createdAt: number;
    /** Whether the first order-book snapshot has been received. */
    hasBook: boolean;
    /** Whether the first tape event has been received (or timed out). */
    hasTape: boolean;
    /** Whether balances have been refreshed for this pair. */
    hasBalances: boolean;
    /** Whether data truth validation passed. */
    dataValid: boolean;
    /** Last order-book update timestamp for this pair. */
    lastBookUpdateMs: number;
    /** Last tape event timestamp for this pair. */
    lastTapeUpdateMs: number;
    /** Last balance refresh timestamp for this pair. */
    lastBalanceRefreshMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action callbacks — injected by TradingRuntime
// ─────────────────────────────────────────────────────────────────────────────

export interface PairSwitchActions {
    /** Detach old-pair-specific listeners (if any). */
    detachOldFeeds: (oldPair: TradingPair) => void;
    /** Destroy all per-pair state: clear tape, reset tracker, clear caches. */
    destroyPairContext: () => void;
    /** Reset all rolling metric windows, timestamps, snapshot validator. */
    resetMetricsWindows: () => void;
    /** Apply the new pair to all components (config, tape, tracker, executor, strategies). */
    applyNewPair: (newPair: TradingPair) => void;
    /** Re-subscribe XRPL streams if needed. */
    subscribeFeeds: (newPair: TradingPair) => Promise<void>;
    /** Poll the order book once for the new pair. Returns true if book is non-empty. */
    refreshOrderBook: () => Promise<boolean>;
    /** Check if a tape event has been received for the new pair. */
    hasTapeEvent: () => boolean;
    /** Fetch both base and quote balances. Returns true if successful. */
    refreshBalances: () => Promise<boolean>;
    /** Run data truth validation. Returns { valid, reasons }. */
    validateDataTruth: () => { valid: boolean; reasons: string[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface PairSwitchOrchestratorConfig {
    /** Max ms to wait for a tape event before proceeding anyway (default 5000). */
    tapeWaitTimeoutMs: number;
    /** Max ms for the entire switch operation before force-failing (default 30000). */
    switchTimeoutMs: number;
}

const DEFAULT_CONFIG: PairSwitchOrchestratorConfig = {
    tapeWaitTimeoutMs: 5_000,
    switchTimeoutMs: 30_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export interface PairSwitchResult {
    success: boolean;
    activePair: string;
    error?: string;
    phases: PairSwitchPhase[];
    durationMs: number;
}

export class PairSwitchOrchestrator {
    readonly fsm: PairSwitchFsm;
    private context: PairContext | null = null;
    private readonly config: PairSwitchOrchestratorConfig;
    private events: PairSwitchEvent[] = [];

    constructor(config: Partial<PairSwitchOrchestratorConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.fsm = new PairSwitchFsm();
        this.fsm.setEventHandler((evt) => {
            this.events.push(evt);
        });
    }

    // ─── Queries ─────────────────────────────────────────────────────────

    /** Whether execution is allowed (FSM in READY). */
    isReady(): boolean {
        return this.fsm.isReady();
    }

    /** Whether a switch is currently in progress. */
    isSwitching(): boolean {
        return this.fsm.isSwitching();
    }

    /** Current phase of the pair-switch FSM. */
    getPhase(): PairSwitchPhase {
        return this.fsm.getPhase();
    }

    /** The current pair context (null before first pair is set). */
    getContext(): PairContext | null {
        return this.context;
    }

    /** Get collected events from the last switch (cleared on next switch). */
    getEvents(): PairSwitchEvent[] {
        return [...this.events];
    }

    // ─── Main Operation ──────────────────────────────────────────────────

    /**
     * Execute a full pair switch from `oldPair` to `newPair`.
     *
     * Drives the FSM through all 12 phases sequentially.
     * On failure at any phase, transitions to FAILED and returns error.
     */
    async executePairSwitch(
        oldPair: TradingPair,
        newPair: TradingPair,
        actions: PairSwitchActions,
    ): Promise<PairSwitchResult> {
        const startMs = Date.now();
        const oldPairKey = `${oldPair.baseCurrency}/${oldPair.quoteCurrency}`;
        const newPairKey = `${newPair.baseCurrency}/${newPair.quoteCurrency}`;
        const phases: PairSwitchPhase[] = [];

        // Clear events from previous switch
        this.events = [];

        try {
            // ── Phase 1: FREEZE_EXECUTION ────────────────────────────────
            this.fsm.beginSwitch(oldPairKey, newPairKey);
            phases.push('FREEZE_EXECUTION');
            logger.info({ from: oldPairKey, to: newPairKey }, 'Pair switch: execution frozen');

            // ── Phase 2: UNSUBSCRIBE_OLD_FEEDS ───────────────────────────
            this.fsm.advance('UNSUBSCRIBE_OLD_FEEDS', 'detaching-old-feeds');
            phases.push('UNSUBSCRIBE_OLD_FEEDS');
            actions.detachOldFeeds(oldPair);
            logger.info({ pair: oldPairKey }, 'Pair switch: old feeds detached');

            // ── Phase 3: DESTROY_PAIR_CONTEXT ────────────────────────────
            this.fsm.advance('DESTROY_PAIR_CONTEXT', 'destroying-old-context');
            phases.push('DESTROY_PAIR_CONTEXT');
            actions.destroyPairContext();
            this.context = null;
            logger.info({ pair: oldPairKey }, 'Pair switch: old context destroyed');

            // ── Phase 4: RESET_PAIR_METRICS_WINDOWS ──────────────────────
            this.fsm.advance('RESET_PAIR_METRICS_WINDOWS', 'resetting-metrics');
            phases.push('RESET_PAIR_METRICS_WINDOWS');
            actions.resetMetricsWindows();
            logger.info('Pair switch: metrics windows reset');

            // ── Phase 5: CREATE_NEW_PAIR_CONTEXT ─────────────────────────
            this.fsm.advance('CREATE_NEW_PAIR_CONTEXT', 'creating-new-context');
            phases.push('CREATE_NEW_PAIR_CONTEXT');
            actions.applyNewPair(newPair);

            this.context = {
                pairKey: newPairKey,
                pair: { ...newPair },
                createdAt: Date.now(),
                hasBook: false,
                hasTape: false,
                hasBalances: false,
                dataValid: false,
                lastBookUpdateMs: 0,
                lastTapeUpdateMs: 0,
                lastBalanceRefreshMs: 0,
            };
            logger.info({ pair: newPairKey }, 'Pair switch: new context created');

            // ── Phase 6: SUBSCRIBE_NEW_FEEDS ─────────────────────────────
            this.fsm.advance('SUBSCRIBE_NEW_FEEDS', 'subscribing-new-feeds');
            phases.push('SUBSCRIBE_NEW_FEEDS');
            await actions.subscribeFeeds(newPair);
            logger.info({ pair: newPairKey }, 'Pair switch: new feeds subscribed');

            // ── Phase 7: WAIT_FIRST_BOOK ─────────────────────────────────
            this.fsm.advance('WAIT_FIRST_BOOK', 'waiting-first-book');
            phases.push('WAIT_FIRST_BOOK');
            const hasBook = await actions.refreshOrderBook();
            if (this.context) {
                this.context.hasBook = hasBook;
                this.context.lastBookUpdateMs = Date.now();
            }
            logger.info({ pair: newPairKey, hasBook }, 'Pair switch: first book received');

            // ── Phase 8: WAIT_FIRST_TAPE ─────────────────────────────────
            this.fsm.advance('WAIT_FIRST_TAPE', 'waiting-first-tape');
            phases.push('WAIT_FIRST_TAPE');

            // Tape events are passive — poll with timeout
            const tapeDeadline = Date.now() + this.config.tapeWaitTimeoutMs;
            let hasTape = actions.hasTapeEvent();
            while (!hasTape && Date.now() < tapeDeadline) {
                await sleep(200);
                hasTape = actions.hasTapeEvent();
            }
            if (this.context) {
                this.context.hasTape = hasTape;
                if (hasTape) this.context.lastTapeUpdateMs = Date.now();
            }
            logger.info({ pair: newPairKey, hasTape, timedOut: !hasTape }, 'Pair switch: tape check complete');

            // ── Phase 9: REFRESH_BALANCES ────────────────────────────────
            this.fsm.advance('REFRESH_BALANCES', 'refreshing-balances');
            phases.push('REFRESH_BALANCES');
            const hasBalances = await actions.refreshBalances();
            if (this.context) {
                this.context.hasBalances = hasBalances;
                this.context.lastBalanceRefreshMs = Date.now();
            }
            logger.info({ pair: newPairKey, hasBalances }, 'Pair switch: balances refreshed');

            // ── Phase 10: VALIDATE_DATA_TRUTH ────────────────────────────
            this.fsm.advance('VALIDATE_DATA_TRUTH', 'validating-data');
            phases.push('VALIDATE_DATA_TRUTH');
            const validation = actions.validateDataTruth();
            if (this.context) {
                this.context.dataValid = validation.valid;
            }
            logger.info({ pair: newPairKey, valid: validation.valid, reasons: validation.reasons },
                'Pair switch: data truth validation complete');

            // ── Phase 11: READY ──────────────────────────────────────────
            // Note: We proceed to READY even if validation returns invalid.
            // The execution gate will block ticks until health quorum is met.
            // This prevents deadlock (no ticks → no data → never valid).
            this.fsm.complete('switch-complete');
            phases.push('READY');

            const durationMs = Date.now() - startMs;
            logger.info({
                from: oldPairKey,
                to: newPairKey,
                durationMs,
                phasesCount: phases.length,
                hasBook,
                hasTape,
                hasBalances,
                dataValid: validation.valid,
            }, 'Pair switch completed successfully');

            return {
                success: true,
                activePair: newPairKey,
                phases,
                durationMs,
            };
        } catch (err) {
            const failedPhase = this.fsm.getPhase();
            const error = err instanceof Error ? err.message : 'unknown error';

            logger.error({
                from: oldPairKey,
                to: newPairKey,
                failedPhase,
                error,
                phases,
            }, 'Pair switch failed');

            // Transition to FAILED (safe from any non-READY state)
            if (!this.fsm.isFailed() && !this.fsm.isReady()) {
                this.fsm.fail(`phase-${failedPhase}:${error}`);
            }
            phases.push('FAILED');

            return {
                success: false,
                activePair: oldPairKey,
                error,
                phases,
                durationMs: Date.now() - startMs,
            };
        }
    }

    /**
     * Recover after a failed switch (rollback completed).
     */
    recoverFromFailure(): void {
        if (this.fsm.isFailed()) {
            this.fsm.recover('rollback-complete');
        }
    }

    /**
     * Reset orchestrator (for runtime shutdown).
     */
    reset(): void {
        this.fsm.reset();
        this.context = null;
        this.events = [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
