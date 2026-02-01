import { Client } from 'xrpl';
import { RiskConfig, TradingPair } from '../config';
import { logger } from '../analytics/logger';

export interface TradeIntent {
    issuer: string;
    size: number;
    potentialLoss: number;
}

export class RiskEngine {
    private consecutiveFailures = 0;
    private dailyLoss = 0;

    constructor(private readonly risk: RiskConfig, private readonly client: Client) { }

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
        const info = await this.client.request({
            command: 'account_info',
            account,
            ledger_index: 'validated',
        });
        const balance = Number(info.result.account_data.Balance) / 1_000_000;
        if (balance < this.risk.reserveFloorXRP) {
            logger.warn({ balance }, 'Below reserve floor; halting');
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
}
