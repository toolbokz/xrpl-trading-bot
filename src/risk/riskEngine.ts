import { Client } from 'xrpl';
import { RiskConfig, TradingPair } from '../config';
import { logger } from '../analytics/logger';
import { hasAdequateReserves, loadReserveConfig, type ReserveConfig } from '../xrpl/reserve';

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

    constructor(private readonly risk: RiskConfig, private readonly client: Client) {
        // Initialize to current UTC date
        this.lastResetDate = this.getCurrentDateUTC();
        // Load reserve buffer config from env
        this.reserveConfig = loadReserveConfig();
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
        // Use dynamic reserve calculation accounting for owner count
        const { adequate, requirement, skipped } = await hasAdequateReserves(
            this.client,
            account,
            this.risk.reserveFloorXRP, // Use config value as minimum available balance
            this.reserveConfig
        );

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
            return false;
        }
        return true;
    }

    approveIntent(intent: TradeIntent, pair: TradingPair): boolean {
        if (this.risk.emergencyShutdown) return false;
        if (this.risk.issuerBlacklist.has(intent.issuer)) return false;
        if (intent.size > this.risk.maxTradeSize) return false;
        if (intent.potentialLoss > this.risk.maxDailyLoss) return false;
        const allowedIssuers = new Set([pair.baseIssuer, pair.quoteIssuer, pair.issuer].filter(Boolean) as string[]);
        if (!allowedIssuers.has(intent.issuer)) return false;
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
            currentExposure: 0, // TODO: track open position value
            dailyLossLimit: this.risk.maxDailyLoss,
            dailyLossCurrent: this.dailyLoss,
            killSwitch: this.risk.emergencyShutdown,
            consecutiveFailures: this.consecutiveFailures,
            maxTradeSize: this.risk.maxTradeSize,
            reserveFloorXRP: this.risk.reserveFloorXRP,
        };
    }
}
