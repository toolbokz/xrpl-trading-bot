import { Client, Currency, IssuedCurrency } from 'xrpl';
import { toXrplCurrency } from '../xrpl/currency';
import { AMMInfo } from '../utils/types';

export class AMMService {
    constructor(private readonly client: Client) { }

    async fetchAMMInfo(asset: { currency: string; issuer?: string }, asset2: { currency: string; issuer?: string }): Promise<AMMInfo | null> {
        try {
            const res = await this.client.request({
                command: 'amm_info',
                asset: this.toCurrency(asset),
                asset2: this.toCurrency(asset2),
            });
            if (!res.result || typeof res.result !== 'object') return null;
            const { trading_fee, lp_token } = res.result as any;
            return {
                tradingFee: trading_fee,
                poolContributions: [lp_token],
            } as AMMInfo;
        } catch (err) {
            // AMM may not exist yet; do not treat as fatal
            return null;
        }
    }

    private toCurrency(input: { currency: string; issuer?: string }): Currency {
        const normalized = toXrplCurrency(input);
        if (normalized.currency === 'XRP') {
            return 'XRP' as unknown as Currency;
        }
        const issued = normalized as Extract<typeof normalized, { issuer: string }>;
        return { currency: issued.currency, issuer: issued.issuer } as IssuedCurrency;
    }
}
