import { Amount, Client } from 'xrpl';
import { Strategy, StrategyContext } from './types';
import { StrategyConfig, TradingPair } from '../config';
import { OfferExecutor } from '../execution/offerExecutor';
import { logger } from '../analytics/logger';
import { toXrplCurrency } from '../xrpl/currency';

export class PathArbitrageStrategy implements Strategy {
    name = 'pathfinding-arbitrage';
    private lastLedger = 0;

    constructor(
        private readonly client: Client,
        private readonly config: StrategyConfig,
        private readonly pair: TradingPair,
        private readonly executor: OfferExecutor,
        private readonly paperTrading: boolean
    ) { }

    async tick(ctx: StrategyContext): Promise<void> {
        if (ctx.ledgerIndex === this.lastLedger) return;
        this.lastLedger = ctx.ledgerIndex;
        if (!ctx.orderBook.bids.length || !ctx.orderBook.asks.length) return;
        if (Date.now() - ctx.orderBook.lastUpdated > 15_000) return;
        if (!this.paperTrading && !ctx.orderBook.bids[0]?.price) return; // avoid live execution until path payment leg is hardened

        const base = toXrplCurrency({
            currency: this.pair.baseCurrency,
            issuer: this.pair.baseCurrency.toUpperCase() === 'XRP' ? undefined : (this.pair.baseIssuer ?? this.pair.issuer)
        });
        const quote = toXrplCurrency({
            currency: this.pair.quoteCurrency,
            issuer: this.pair.quoteCurrency.toUpperCase() === 'XRP' ? undefined : (this.pair.quoteIssuer ?? this.pair.issuer)
        });
        const baseIssued = base.currency === 'XRP' ? null : (base as Extract<typeof base, { issuer: string }>);
        const quoteIssued = quote.currency === 'XRP' ? null : (quote as Extract<typeof quote, { issuer: string }>);
        const issuer = quoteIssued ? quoteIssued.issuer : baseIssued ? baseIssued.issuer : null;
        if (!issuer) return;

        const destAmount = quoteIssued
            ? { currency: quoteIssued.currency, issuer: quoteIssued.issuer, value: this.config.positionSize.toString() }
            : this.config.positionSize.toString(); // XRP as string drops

        // source_currency must be full currency object for issued currencies
        const sourceCurrency = baseIssued
            ? { currency: baseIssued.currency, issuer: baseIssued.issuer }
            : { currency: 'XRP' };

        const paths: any = await this.client.request({
            command: 'ripple_path_find',
            source_currencies: [sourceCurrency],
            source_account: issuer,
            destination_account: issuer,
            destination_amount: destAmount,
        });

        if (!paths.result?.alternatives?.length) return;
        const best = paths.result.alternatives[0] as any;
        const sourceValue = this.amountToNumber(best.source_amount as Amount | string | undefined);
        const destValue = this.config.positionSize; // requested destination amount
        if (!Number.isFinite(sourceValue) || sourceValue <= 0 || destValue <= 0) return;
        const computedRate = sourceValue / destValue;
        const bestBid = ctx.orderBook.bids[0]?.price ?? 0;
        const bestAsk = ctx.orderBook.asks[0]?.price ?? 0;
        const bookMid = (bestBid + bestAsk) / 2;
        const edgeBps = ((bookMid - computedRate) / computedRate) * 10_000;
        if (edgeBps < this.config.pathArbMinProfitBps) return;

        const side: 'buy' | 'sell' = edgeBps > 0 ? 'buy' : 'sell';
        const price = side === 'buy' ? ctx.orderBook.bids[0]?.price ?? 0 : ctx.orderBook.asks[0]?.price ?? 0;
        if (!price) return;

        if (!this.paperTrading) {
            logger.info({ side, edgeBps, skip: true }, 'Path arbitrage in observe-only mode for safety');
            return;
        }

        const res = await this.executor.placeOffer({ side, price, amount: this.config.positionSize, flags: { immediateOrCancel: true } });
        if (res.accepted) {
            logger.info({ side, price, edgeBps }, 'Executed path arbitrage leg');
        }
    }

    private amountToNumber(value: Amount | string | undefined): number {
        if (!value) return NaN;
        if (typeof value === 'string') return Number(value);
        return Number((value as any).value ?? NaN);
    }
}
