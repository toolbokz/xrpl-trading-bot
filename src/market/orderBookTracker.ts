import EventEmitter from 'events';
import { TradingPair } from '../config';
import { marketLog as logger } from '../analytics/logger';
import { XRPLWebSocket } from '../xrpl/client';
import { OrderBookState, BookOffer as NormalizedOffer } from '../utils/types';
import { BOOK_CROSS_EPS_ABS } from './bookValidationEpsilon';

export type OrderBookEvents = {
    update: (state: OrderBookState) => void;
};

type EventKey = keyof OrderBookEvents;

export class OrderBookTracker extends EventEmitter {
    private state: OrderBookState = { bids: [], asks: [], spread: 0, lastUpdated: 0 };
    private pair: TradingPair;

    constructor(private readonly client: XRPLWebSocket, pair: TradingPair) {
        super();
        this.pair = pair;
    }

    getState(): OrderBookState {
        return this.state;
    }

    setPair(pair: TradingPair): void {
        this.pair = pair;
        this.state = { bids: [], asks: [], spread: 0, lastUpdated: Date.now() };
    }

    async refresh(): Promise<boolean> {
        try {
            const { bids: rawBids, asks: rawAsks } = await this.client.getOrderBook(this.pair);
            const bids: NormalizedOffer[] = [];
            const asks: NormalizedOffer[] = [];

            // Bids: offers to BUY base — maker sells quote (TakerGets=quote), wants base (TakerPays=base)
            // Price = quote/base = TakerGets / TakerPays
            // Quantity = base amount = TakerPays
            for (const offer of rawBids) {
                const takerGets = this.toAmount(offer.TakerGets); // quote amount
                const takerPays = this.toAmount(offer.TakerPays); // base amount
                if (takerGets <= 0 || takerPays <= 0) continue;
                const price = takerGets / takerPays; // quote per base
                const quantity = takerPays;
                if (!Number.isFinite(price) || price <= 0) continue;
                bids.push({ price, quantity, quality: Number(offer.quality), isBuy: true, raw: offer });
            }

            // Asks: offers to SELL base — maker sells base (TakerGets=base), wants quote (TakerPays=quote)
            // Price = quote/base = TakerPays / TakerGets
            // Quantity = base amount = TakerGets
            for (const offer of rawAsks) {
                const takerGets = this.toAmount(offer.TakerGets); // base amount
                const takerPays = this.toAmount(offer.TakerPays); // quote amount
                if (takerGets <= 0 || takerPays <= 0) continue;
                const price = takerPays / takerGets; // quote per base
                const quantity = takerGets;
                if (!Number.isFinite(price) || price <= 0) continue;
                asks.push({ price, quantity, quality: Number(offer.quality), isBuy: false, raw: offer });
            }

            bids.sort((a, b) => b.price - a.price);
            asks.sort((a, b) => a.price - b.price);

            const bestBid = bids[0]?.price ?? 0;
            const bestAsk = asks[0]?.price ?? 0;
            const rawDiff = bestAsk - bestBid;
            const diff = rawDiff < 0 && Math.abs(rawDiff) <= BOOK_CROSS_EPS_ABS ? 0 : rawDiff;
            const spread = bestAsk > 0 ? (diff / bestAsk) * 10_000 : 0;

            if (rawDiff < 0 && diff === 0) {
                logger.debug({ bestBid, bestAsk, diff: rawDiff }, 'Order book epsilon cross clamped to zero spread');
            }

            this.state = {
                bids,
                asks,
                spread,
                lastUpdated: Date.now(),
            };

            logger.debug({ spread, bids: bids.length, asks: asks.length }, 'Order book updated');
            this.emitEvent('update', this.state);
            return true;
        } catch (err) {
            logger.error({ err }, 'Order book refresh failed');
            return false;
        }
    }

    private emitEvent<T extends EventKey>(key: T, payload: Parameters<OrderBookEvents[T]>[0]): void {
        this.emit(key, payload);
    }

    private toAmount(value: any): number {
        if (typeof value === 'string') {
            // XRP drops as string -> convert to XRP
            const drops = Number(value);
            return drops / 1_000_000;
        }
        if (typeof value === 'object' && value !== null) {
            return Number((value as any).value || 0);
        }
        return Number(value || 0);
    }
}
