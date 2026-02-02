import { Strategy, StrategyContext } from './types';
import { AMMService } from '../market/amm';
import { StrategyConfig, TradingPair } from '../config';
import { OfferExecutor } from '../execution/offerExecutor';
import { logger } from '../analytics/logger';

export class AMMArbitrageStrategy implements Strategy {
    name = 'amm-arbitrage';
    private lastLedger = 0;

    constructor(
        private readonly amm: AMMService,
        private readonly config: StrategyConfig,
        private readonly pair: TradingPair,
        private readonly executor: OfferExecutor
    ) { }

    async tick(ctx: StrategyContext): Promise<void> {
        if (ctx.ledgerIndex === this.lastLedger) return;
        this.lastLedger = ctx.ledgerIndex;
        const { orderBook } = ctx;
        if (!orderBook.bids.length || !orderBook.asks.length) return;

        const firstBid = orderBook.bids[0];
        const firstAsk = orderBook.asks[0];
        if (!firstBid || !firstAsk) return;

        const bestBid = firstBid.price;
        const bestAsk = firstAsk.price;

        const baseIssuer = this.pair.baseCurrency.toUpperCase() === 'XRP'
            ? undefined
            : (this.pair.baseIssuer ?? this.pair.issuer);
        const quoteIssuer = this.pair.quoteCurrency.toUpperCase() === 'XRP'
            ? undefined
            : (this.pair.quoteIssuer ?? this.pair.issuer);

        const ammInfo = await this.amm.fetchAMMInfo(
            baseIssuer ? { currency: this.pair.baseCurrency, issuer: baseIssuer } : { currency: 'XRP' },
            quoteIssuer ? { currency: this.pair.quoteCurrency, issuer: quoteIssuer } : { currency: 'XRP' }
        );
        if (!ammInfo || !ammInfo.tradingFee || !Number.isFinite(ammInfo.tradingFee)) return;
        if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return;

        const ammPrice = ammInfo.price ?? (bestBid + bestAsk) / 2;
        const bookMid = (bestBid + bestAsk) / 2;
        const diffBps = ((bookMid - ammPrice) / ammPrice) * 10_000;

        if (Math.abs(diffBps) < this.config.ammArbMinProfitBps) return;

        const side: 'buy' | 'sell' = diffBps > 0 ? 'buy' : 'sell';
        const price = side === 'buy' ? bestBid : bestAsk;
        const res = await this.executor.placeOffer({ side, price, amount: this.config.positionSize, flags: { immediateOrCancel: true } });
        if (res.accepted) {
            logger.info({ side, price, diffBps }, 'Executed AMM arbitrage leg');
        }
    }
}
