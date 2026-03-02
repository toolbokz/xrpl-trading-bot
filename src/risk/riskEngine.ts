import { Client } from 'xrpl';
import { RiskConfig, TradingPair } from '../config';
import { ExposureTracker } from './exposureTracker';
import { riskLog as logger } from '../analytics/logger';
import { hasAdequateReserves, loadReserveConfig, type ReserveConfig, classifyReserveError } from '../xrpl/reserve';
import { isAuditGuardsEnabled } from '../config/featureFlags';

export interface TradeIntent {
    issuer: string;
    size: number;
    potentialLoss: number;
}

export class RiskEngine {
    private consecutiveFailures = 0;
    private dailyLoss = 0;
    private lastResetDate: string;
    private reserveConfig: ReserveConfig;
    private exposureTracker: ExposureTracker | null = null;
    /** Last known XRP balance from reserve check (drops → XRP). */
    private _lastXrpBalance: number | null = null;

    constructor(private readonly risk: RiskConfig, private readonly client: Client) {
        // Initialize to current UTC date
        this.lastResetDate = this.getCurrentDateUTC();
        // Load reserve buffer config from env
        this.reserveConfig = loadReserveConfig();
    }

    /**
     * Optionally inject an ExposureTracker so risk checks can account for
     * current notional exposure before approving intents.
     */
    setExposureTracker(tracker: ExposureTracker): void {
        this.exposureTracker = tracker;
    }

    /**
     * Get current UTC date as YYYY-MM-DD string.
     */
    private getCurrentDateUTC(): string {
        const isoString = new Date().toISOString();
        const datePart = isoString.split('T')[0];
        // ISO 8601 format guarantees 'T' separator exists
        return datePart ?? isoString.slice(0, 10);
    }

    /**
     * Check if daily loss counter should be reset (at UTC midnight).
     * Should be called periodically (e.g., from TradingRuntime.tick()).
     */
    checkAndResetDaily(): void {
        const today = this.getCurrentDateUTC();
        if (today !== this.lastResetDate) {
            logger.info({
                previousLoss: this.dailyLoss,
                previousDate: this.lastResetDate,
                newDate: today,
            }, 'Resetting daily loss counter (UTC midnight rollover)');
            this.dailyLoss = 0;
            this.lastResetDate = today;

            // Also clear emergency shutdown if it was triggered by daily loss
            // (but not if triggered by consecutive failures)
            if (this.risk.emergencyShutdown && this.consecutiveFailures < this.risk.consecutiveFailureKillSwitch) {
                logger.info('Clearing daily-loss emergency shutdown for new trading day');
                this.risk.emergencyShutdown = false;
            }
        }
    }

    registerFailure(): void {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.risk.consecutiveFailureKillSwitch) {
            this.risk.emergencyShutdown = true;
            logger.error('Kill-switch triggered from consecutive failures');
        }
    }

    resetFailures(): void {
        this.consecutiveFailures = 0;
    }

    recordLoss(amount: number): void {
        this.dailyLoss += amount;
        if (this.dailyLoss >= this.risk.maxDailyLoss) {
            this.risk.emergencyShutdown = true;
            logger.error({ dailyLoss: this.dailyLoss }, 'Daily loss limit reached');
        }
    }

    async checkReserves(account: string): Promise<boolean> {
        let reserveResult: Awaited<ReturnType<typeof hasAdequateReserves>>;
        try {
            // Use dynamic reserve calculation accounting for owner count
            reserveResult = await hasAdequateReserves(
                this.client,
                account,
                this.risk.reserveFloorXRP, // Use config value as minimum available balance
                this.reserveConfig
            );
        } catch (err) {
            if (!isAuditGuardsEnabled()) {
                throw err;
            }
            const classification = classifyReserveError(err);
            logger.warn({
                account,
                reserveErrorCode: classification.code,
                retryable: classification.retryable,
                message: classification.message,
            }, 'Reserve check failed under audit guard; failing closed for this tick');
            return false;
        }

        const { adequate, requirement, skipped } = reserveResult;

        // If check was skipped (client not connected), allow tick to continue
        // The reconnection logic will handle restoring the connection
        if (skipped) {
            return true;
        }

        if (!adequate && requirement) {
            logger.warn({
                balance: requirement.balanceXRP,
                required: requirement.requiredXRP,
                available: requirement.availableXRP,
                minAvailable: this.risk.reserveFloorXRP,
                ownerCount: requirement.ownerCount,
            }, 'Below dynamic reserve floor; halting');
            this.risk.emergencyShutdown = true;
            this._lastXrpBalance = requirement.balanceXRP;
            return false;
        }
        if (requirement) {
            this._lastXrpBalance = requirement.balanceXRP;
        }
        return true;
    }

    /** Last XRP balance observed during reserve check (null if no check yet). */
    getLastXrpBalance(): number | null {
        return this._lastXrpBalance;
    }

    approveIntent(intent: TradeIntent, pair: TradingPair): boolean {
        if (this.risk.emergencyShutdown) return false;
        if (this.risk.issuerBlacklist.has(intent.issuer)) return false;
        if (intent.size > this.risk.maxTradeSize) return false;
        if (intent.potentialLoss > this.risk.maxDailyLoss) return false;
        const allowedIssuers = new Set([pair.baseIssuer, pair.quoteIssuer, pair.issuer].filter(Boolean) as string[]);
        if (!allowedIssuers.has(intent.issuer)) return false;
        // Conservative exposure guard: if current notional exposure already
        // exceeds configured max, deny new intents.
        try {
            if (this.exposureTracker) {
                const currentNotional = this.exposureTracker.getNotionalExposure();
                if (Number.isFinite(currentNotional) && currentNotional >= this.risk.maxExposurePerIssuer) {
                    logger.warn({ currentNotional }, 'RiskEngine: deny intent due to existing notional exposure');
                    return false;
                }
            }
        } catch (e) {
            // Fail-safe: do not block trading if exposure check errors
            logger.debug({ err: e }, 'RiskEngine: exposure check failed, proceeding');
        }
        return true;
    }

    isShutdown(): boolean {
        return this.risk.emergencyShutdown;
    }

    /**
     * Get current risk status for dashboard/API.
     */
    getStatus(): {
        maxExposure: number;
        currentExposure: number;
        dailyLossLimit: number;
        dailyLossCurrent: number;
        killSwitch: boolean;
        consecutiveFailures: number;
        maxTradeSize: number;
        reserveFloorXRP: number;
    } {
        return {
            maxExposure: this.risk.maxExposurePerIssuer,
            currentExposure: this.exposureTracker ? this.exposureTracker.getNotionalExposure() : 0,
            dailyLossLimit: this.risk.maxDailyLoss,
            dailyLossCurrent: this.dailyLoss,
            killSwitch: this.risk.emergencyShutdown,
            consecutiveFailures: this.consecutiveFailures,
            maxTradeSize: this.risk.maxTradeSize,
            reserveFloorXRP: this.risk.reserveFloorXRP,
        };
    }
}
