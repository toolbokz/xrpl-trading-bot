import EventEmitter from 'events';
import { TradingPair } from '../config';
import { marketLog as logger } from '../analytics/logger';
import { XRPLWebSocket } from '../xrpl/client';
import { OrderBookState, BookOffer as NormalizedOffer } from '../utils/types';

export type OrderBookEvents = {
    update: (state: OrderBookState) => void;
};

type EventKey = keyof OrderBookEvents;

export class OrderBookTracker extends EventEmitter {
    private state: OrderBookState = { bids: [], asks: [], spread: 0, lastUpdated: 0 };

    constructor(private readonly client: XRPLWebSocket, private readonly pair: TradingPair) {
        super();
    }

    getState(): OrderBookState {
        return this.state;
    }

    async refresh(): Promise<void> {
        try {
            const { bids: rawBids, asks: rawAsks } = await this.client.getOrderBook(this.pair);
            const bids: NormalizedOffer[] = [];
            const asks: NormalizedOffer[] = [];

            // For bids: someone wants to buy base (TakerGets=base) by paying quote (TakerPays=quote)
            // Price = quote/base = TakerPays / TakerGets
            for (const offer of rawBids) {
                const takerGets = this.toAmount(offer.TakerGets); // base amount
                const takerPays = this.toAmount(offer.TakerPays); // quote amount
                if (takerGets <= 0 || takerPays <= 0) continue;
                const price = takerPays / takerGets; // quote per base
                const quantity = takerGets;
                if (!Number.isFinite(price) || price <= 0) continue;
                bids.push({ price, quantity, quality: Number(offer.quality), isBuy: true, raw: offer });
            }

            // For asks: someone wants to sell base (TakerPays=base) for quote (TakerGets=quote)
            // Price = quote/base = TakerGets / TakerPays
            for (const offer of rawAsks) {
                const takerGets = this.toAmount(offer.TakerGets); // quote amount
                const takerPays = this.toAmount(offer.TakerPays); // base amount
                if (takerGets <= 0 || takerPays <= 0) continue;
                const price = takerGets / takerPays; // quote per base
                const quantity = takerPays;
                if (!Number.isFinite(price) || price <= 0) continue;
                asks.push({ price, quantity, quality: Number(offer.quality), isBuy: false, raw: offer });
            }

            bids.sort((a, b) => b.price - a.price);
            asks.sort((a, b) => a.price - b.price);

            const bestBid = bids[0]?.price ?? 0;
            const bestAsk = asks[0]?.price ?? 0;
            const spread = bestAsk > 0 ? ((bestAsk - bestBid) / bestAsk) * 10_000 : 0;

            this.state = {
                bids,
                asks,
                spread,
                lastUpdated: Date.now(),
            };

            logger.debug({ spread, bids: bids.length, asks: asks.length }, 'Order book updated');
            this.emitEvent('update', this.state);
        } catch (err) {
            logger.error({ err }, 'Order book refresh failed');
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
