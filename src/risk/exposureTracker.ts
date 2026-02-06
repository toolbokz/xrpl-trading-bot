/**
 * Exposure Tracker — Lightweight Open Position Tracking
 *
 * Tracks notional exposure and inventory skew from executed fills.
 * Designed to feed the HardRiskGuard with real data instead of the
 * placeholder `inventorySkewPct: 0` / `currentExposure: 0`.
 *
 * Model:
 *   - Net position = sum of fill sizes (buys positive, sells negative)
 *   - Notional exposure = |netPosition| × lastMidPrice
 *   - Inventory skew pct = netPosition / maxPosition × 100
 *     (clamped −100..+100, where +100 = fully long, −100 = fully short)
 *
 * Limitations (documented, not hidden):
 *   - In-memory only; resets on restart. Acceptable because the bot
 *     cancels all open offers on shutdown.
 *   - Ignores fills from other accounts or out-of-band transactions.
 *   - Paper-mode fills are tracked identically to real fills.
 *
 * @module risk/exposureTracker
 */

import { riskLog as logger } from '../analytics/logger';

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

    constructor(config: Partial<ExposureTrackerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ─── Mutation ────────────────────────────────────────────────────────

    /**
     * Set the active pair key. Resets tracking on pair change.
     */
    setPairKey(pairKey: string): void {
        if (pairKey !== this.pairKey) {
            this.reset();
            this.pairKey = pairKey;
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
     */
    recordFill(side: 'buy' | 'sell', sizeBase: number, pairKey: string): void {
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
