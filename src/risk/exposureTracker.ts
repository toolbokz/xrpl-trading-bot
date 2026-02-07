/**
 * Exposure Tracker — Durable Open Position Tracking
 *
 * Tracks notional exposure and inventory skew from executed fills.
 * Designed to feed the HardRiskGuard with real data.
 *
 * Model:
 *   - Net position = sum of fill sizes (buys positive, sells negative)
 *   - Notional exposure = |netPosition| × lastMidPrice
 *   - Inventory skew pct = netPosition / maxPosition × 100
 *     (clamped −100..+100, where +100 = fully long, −100 = fully short)
 *
 * Persistence:
 *   - Fills and aggregate state are persisted to SQLite via exposureStore.
 *   - On startup, rehydrate() loads the last-known state from disk.
 *   - Paper-mode fills are tracked identically to real fills.
 *
 * @module risk/exposureTracker
 */

import { riskLog as logger } from '../analytics/logger';
import {
    persistFillAndState,
    loadExposureState,
    saveExposureState,
    closeExposureDb,
    type ExposureStateRecord,
} from '../persistence/exposureStore';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ExposureSnapshot {
    /** Net position in base currency (positive = long, negative = short). */
    netPositionBase: number;
    /** Absolute notional exposure = |netPosition| × lastMidPrice. */
    notionalExposure: number;
    /** Inventory skew percentage (−100 to +100). */
    inventorySkewPct: number;
    /** Last known mid-price used for notional calculation. */
    lastMidPrice: number;
    /** Number of fills tracked since last reset. */
    fillCount: number;
    /** Total bought quantity (base). */
    totalBought: number;
    /** Total sold quantity (base). */
    totalSold: number;
    /** Timestamp of last fill (ms epoch). */
    lastFillMs: number;
    /** Active pair key. */
    pairKey: string;
}

export interface ExposureTrackerConfig {
    /** Maximum base position size for skew calculation (default: from POSITION_SIZE_XRP × 20). */
    maxPositionBase: number;
}

const DEFAULT_CONFIG: ExposureTrackerConfig = {
    maxPositionBase: 100, // 20× default position size of 5 XRP
};

// ─────────────────────────────────────────────────────────────────────────────
// Tracker
// ─────────────────────────────────────────────────────────────────────────────

export class ExposureTracker {
    private netPositionBase = 0;
    private totalBought = 0;
    private totalSold = 0;
    private lastMidPrice = 0;
    private fillCount = 0;
    private lastFillMs = 0;
    private pairKey = '';
    private readonly config: ExposureTrackerConfig;
    /** Whether persistence is enabled (disabled in tests or when DB unavailable). */
    private persistenceEnabled: boolean;

    constructor(config: Partial<ExposureTrackerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.persistenceEnabled = process.env.EXPOSURE_PERSISTENCE !== 'false'
            && process.env.NODE_ENV !== 'test';
    }

    /**
     * Enable or disable persistence (for testing).
     */
    setPersistence(enabled: boolean): void {
        this.persistenceEnabled = enabled;
    }

    // ─── Mutation ────────────────────────────────────────────────────────

    /**
     * Set the active pair key. Resets tracking on pair change,
     * then rehydrates from durable storage.
     */
    setPairKey(pairKey: string): void {
        if (pairKey !== this.pairKey) {
            this.reset();
            this.pairKey = pairKey;
            // Rehydrate from disk if available
            this.rehydrate();
        }
    }

    /**
     * Update the max position size (e.g. when strategy config changes).
     */
    setMaxPositionBase(maxPositionBase: number): void {
        if (Number.isFinite(maxPositionBase) && maxPositionBase > 0) {
            this.config.maxPositionBase = maxPositionBase;
        }
    }

    /**
     * Update the mid-price for notional exposure calculation.
     * Should be called every tick with the current mid-price.
     */
    updateMidPrice(midPrice: number): void {
        if (Number.isFinite(midPrice) && midPrice > 0) {
            this.lastMidPrice = midPrice;
        }
    }

    /**
     * Record a fill event.
     *
     * @param side  'buy' or 'sell'
     * @param sizeBase  Filled quantity in base currency
     * @param pairKey  Pair this fill belongs to (cross-pair guard)
     * @param price  Fill price (for persistence)
     * @param correlationId  Optional trace correlation ID
     */
    recordFill(side: 'buy' | 'sell', sizeBase: number, pairKey: string, price?: number, correlationId?: string): void {
        // Cross-pair guard
        if (pairKey !== this.pairKey) {
            return;
        }
        if (!Number.isFinite(sizeBase) || sizeBase <= 0) {
            return;
        }

        if (side === 'buy') {
            this.netPositionBase += sizeBase;
            this.totalBought += sizeBase;
        } else {
            this.netPositionBase -= sizeBase;
            this.totalSold += sizeBase;
        }

        this.fillCount += 1;
        this.lastFillMs = Date.now();

        logger.debug({
            side,
            sizeBase,
            netPositionBase: this.netPositionBase,
            fillCount: this.fillCount,
        }, 'ExposureTracker: fill recorded');

        // Persist to SQLite
        if (this.persistenceEnabled) {
            try {
                const fillId = `${this.lastFillMs}-${this.fillCount}-${Math.random().toString(36).slice(2, 8)}`;
                persistFillAndState(
                    {
                        id: fillId,
                        ts: this.lastFillMs,
                        pairKey: this.pairKey,
                        side,
                        sizeBase,
                        price: price ?? this.lastMidPrice,
                        netPositionAfter: this.netPositionBase,
                        correlationId: correlationId ?? null,
                    },
                    this.toStateRecord(),
                );
            } catch (err) {
                logger.warn({ err }, 'ExposureTracker: failed to persist fill');
            }
        }
    }

    // ─── Queries ─────────────────────────────────────────────────────────

    /**
     * Get the current exposure snapshot.
     */
    getSnapshot(): ExposureSnapshot {
        const absPosition = Math.abs(this.netPositionBase);
        const notionalExposure = absPosition * (this.lastMidPrice || 0);

        // Compute inventory skew: position / maxPosition × 100, clamped to ±100
        const maxPos = this.config.maxPositionBase;
        const rawSkew = maxPos > 0 ? (this.netPositionBase / maxPos) * 100 : 0;
        const inventorySkewPct = Math.max(-100, Math.min(100, rawSkew));

        return {
            netPositionBase: this.netPositionBase,
            notionalExposure,
            inventorySkewPct,
            lastMidPrice: this.lastMidPrice,
            fillCount: this.fillCount,
            totalBought: this.totalBought,
            totalSold: this.totalSold,
            lastFillMs: this.lastFillMs,
            pairKey: this.pairKey,
        };
    }

    /**
     * Get notional exposure (shortcut for HardRiskInput).
     */
    getNotionalExposure(): number {
        return Math.abs(this.netPositionBase) * (this.lastMidPrice || 0);
    }

    /**
     * Get inventory skew percentage (shortcut for HardRiskInput).
     */
    getInventorySkewPct(): number {
        const maxPos = this.config.maxPositionBase;
        if (maxPos <= 0) return 0;
        const raw = (this.netPositionBase / maxPos) * 100;
        return Math.max(-100, Math.min(100, raw));
    }

    // ─── Persistence helpers ────────────────────────────────────────────

    /**
     * Build a persistence state record from current in-memory state.
     */
    private toStateRecord(): ExposureStateRecord {
        return {
            pairKey: this.pairKey,
            netPositionBase: this.netPositionBase,
            totalBought: this.totalBought,
            totalSold: this.totalSold,
            fillCount: this.fillCount,
            lastFillMs: this.lastFillMs,
            lastMidPrice: this.lastMidPrice,
            updatedAt: Date.now(),
        };
    }

    /**
     * Rehydrate in-memory state from durable storage.
     * Called automatically when pair key changes.
     * Safe to call multiple times (idempotent).
     */
    private rehydrate(): void {
        if (!this.persistenceEnabled || !this.pairKey) return;

        try {
            const state = loadExposureState(this.pairKey);
            if (!state) {
                logger.debug({ pairKey: this.pairKey }, 'ExposureTracker: no persisted state found, starting fresh');
                return;
            }
            this.netPositionBase = state.netPositionBase;
            this.totalBought = state.totalBought;
            this.totalSold = state.totalSold;
            this.fillCount = state.fillCount;
            this.lastFillMs = state.lastFillMs;
            this.lastMidPrice = state.lastMidPrice;
            logger.info({
                pairKey: this.pairKey,
                netPositionBase: this.netPositionBase,
                fillCount: this.fillCount,
                lastFillMs: this.lastFillMs,
            }, 'ExposureTracker: rehydrated from persistent storage');
        } catch (err) {
            logger.warn({ err, pairKey: this.pairKey }, 'ExposureTracker: rehydration failed, starting fresh');
        }
    }

    /**
     * Reconcile in-memory position with an externally observed balance.
     * If a discrepancy is detected, the net position is corrected and
     * a warning is logged.  This is a "trust-but-verify" last-resort
     * correction — the normal fill path should keep things in sync.
     *
     * @param observedNetPosition  Net position as computed from on-ledger balances.
     * @param toleranceBase        Allowed discrepancy before correction (default 0.001).
     * @returns Whether a correction was applied.
     */
    reconcile(observedNetPosition: number, toleranceBase = 0.001): boolean {
        const delta = observedNetPosition - this.netPositionBase;
        if (Math.abs(delta) <= toleranceBase) return false;

        logger.warn({
            pairKey: this.pairKey,
            tracked: this.netPositionBase,
            observed: observedNetPosition,
            delta,
        }, 'ExposureTracker: reconciliation correction applied');

        this.netPositionBase = observedNetPosition;

        // Persist the corrected state
        if (this.persistenceEnabled) {
            try {
                saveExposureState(this.toStateRecord());
            } catch (err) {
                logger.warn({ err }, 'ExposureTracker: failed to persist reconciliation');
            }
        }

        return true;
    }

    /**
     * Flush current in-memory state to persistent storage.
     * Called on clean shutdown to avoid data loss.
     */
    flush(): void {
        if (!this.persistenceEnabled || !this.pairKey) return;
        try {
            saveExposureState(this.toStateRecord());
            logger.debug({ pairKey: this.pairKey }, 'ExposureTracker: flushed to disk');
        } catch (err) {
            logger.warn({ err }, 'ExposureTracker: flush failed');
        }
    }

    /**
     * Close the persistence store (call on process shutdown).
     */
    async closePersistence(): Promise<void> {
        this.flush();
        try {
            closeExposureDb();
        } catch (err) {
            logger.warn({ err }, 'ExposureTracker: failed to close exposure DB');
        }
    }

    /**
     * Reset all tracking state.
     */
    reset(): void {
        this.netPositionBase = 0;
        this.totalBought = 0;
        this.totalSold = 0;
        this.lastMidPrice = 0;
        this.fillCount = 0;
        this.lastFillMs = 0;
        // Don't reset pairKey — caller manages that
    }
}
