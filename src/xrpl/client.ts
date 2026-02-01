import { Client, SubscribeRequest, BookOffer, LedgerStreamResponse, TransactionStream, Currency, RippledError, isValidClassicAddress } from 'xrpl';
import EventEmitter from 'events';
import { XRPLConfig, TradingPair } from '../config';
import { logger } from '../analytics/logger';
import { nextBackoff, BackoffState } from '../utils/backoff';
import { getWalletAddress } from './wallet';
import { toXrplCurrency } from './currency';

export type XRPLEvents = {
    ledger: (ledger: LedgerStreamResponse) => void;
    transaction: (tx: TransactionStream) => void;
    book: (book: { pair: TradingPair; offers: BookOffer[] }) => void;
    reconnect: (attempt: number) => void;
};

type EventKey = keyof XRPLEvents;

// Unified currency normalization to avoid malformed requests and issuer mistakes.
const toBookCurrency = (code: string, issuer?: string): Currency => toXrplCurrency({ currency: code, issuer: issuer as any }) as unknown as Currency;

const logBookRequest = (label: string, taker_gets: Currency, taker_pays: Currency): void => {
    logger.debug({ label, taker_gets, taker_pays }, 'XRPL book request');
};

export type SubscribePairInput = {
    base: string;
    quote: string;
    issuer?: string;
};

type SubscribeBookInput = Omit<NonNullable<SubscribeRequest['books']>[number], 'taker'> & { taker?: string };

const getBotAddressSafe = (): string | null => {
    try {
        return getWalletAddress();
    } catch {
        return null;
    }
};

export class XRPLWebSocket extends EventEmitter {
    private client: Client;
    private backoff: BackoffState = { attempt: 0, delayMs: 0 };
    private reconnects = 0;
    private connected = false;
    private currentLedgerIndex = 0;
    private reconnecting = false;

    constructor(private readonly cfg: XRPLConfig) {
        super();
        this.client = new Client(cfg.endpoint, { connectionTimeout: 10_000 });
    }

    async connect(): Promise<void> {
        await this.establish();
    }

    async disconnect(): Promise<void> {
        if (this.connected) {
            await this.client.disconnect();
            this.connected = false;
        }
    }

    getClient(): Client {
        return this.client;
    }

    getLedgerIndex(): number {
        return this.currentLedgerIndex;
    }

    async subscribe(_pair?: TradingPair): Promise<void> {
        // Note: Most public XRPL servers (xrplcluster.com, s1.ripple.com, etc.)
        // do NOT allow book subscriptions. We only subscribe to ledger stream
        // and use polling (book_offers) for order book data during each tick.

        const req: SubscribeRequest = {
            id: 'xrpl-subscribe',
            command: 'subscribe',
            streams: ['ledger'],
        };
        logger.info({ req }, 'Subscribing to XRPL ledger stream');
        try {
            await this.safeRequest(req);
            logger.info('Ledger subscription acknowledged - using polling for order book data');
        } catch (err: any) {
            // Log but don't throw - we can still poll
            logger.warn({ err: err?.message || err }, 'Ledger subscription failed');
        }
    }

    async getOrderBook(pair: TradingPair): Promise<{ bids: BookOffer[]; asks: BookOffer[] }> {
        await this.ensureConnected();
        const common = { ledger_index: 'validated' as const, limit: 50 };
        const baseIssuerRaw = pair.baseIssuer ?? pair.issuer ?? '';
        const quoteIssuerRaw = pair.quoteIssuer ?? pair.issuer ?? '';
        const baseIssuer = pair.baseCurrency.toUpperCase() === 'XRP' ? undefined : baseIssuerRaw;
        const quoteIssuer = pair.quoteCurrency.toUpperCase() === 'XRP' ? undefined : quoteIssuerRaw;
        const bidsReq = {
            command: 'book_offers',
            taker_gets: toBookCurrency(pair.baseCurrency, baseIssuer),
            taker_pays: toBookCurrency(pair.quoteCurrency, quoteIssuer),
            ...common,
        } as const;
        const asksReq = {
            command: 'book_offers',
            taker_gets: toBookCurrency(pair.quoteCurrency, quoteIssuer),
            taker_pays: toBookCurrency(pair.baseCurrency, baseIssuer),
            ...common,
        } as const;

        logBookRequest('bids', bidsReq.taker_gets as Currency, bidsReq.taker_pays as Currency);
        logBookRequest('asks', asksReq.taker_gets as Currency, asksReq.taker_pays as Currency);

        const bidsRes = await this.safeRequest(bidsReq);
        const asksRes = await this.safeRequest(asksReq);
        return { bids: (bidsRes?.result?.offers || []) as BookOffer[], asks: (asksRes?.result?.offers || []) as BookOffer[] };
    }

    async getAMMInfo(asset: { currency: string; issuer?: string }, asset2: { currency: string; issuer?: string }): Promise<any> {
        const assetReq = toBookCurrency(asset.currency, asset.issuer);
        const asset2Req = toBookCurrency(asset2.currency, asset2.issuer);
        const res = await this.client.request({
            command: 'amm_info',
            asset: assetReq,
            asset2: asset2Req,
        });
        return res.result;
    }

    private async establish(): Promise<void> {
        try {
            await this.client.connect();
            this.connected = true;
            this.backoff = { attempt: 0, delayMs: 0 };
            this.reconnects = 0;
            this.attachHandlers();

            // Subscribe to ledger stream only
            // Book subscriptions are NOT supported by public servers
            try {
                await this.client.request({
                    command: 'subscribe',
                    streams: ['ledger'],
                });
                logger.info('Subscribed to ledger stream - order book data will be polled');
            } catch (err) {
                logger.warn({ err }, 'Failed to subscribe to ledger stream - will continue anyway');
            }

            logger.info({ endpoint: this.cfg.endpoint }, 'XRPL websocket connected');
        } catch (err) {
            logger.error({ err }, 'Initial XRPL connect failed');
            await this.handleReconnect();
        }
    }

    private attachHandlers(): void {
        this.client.removeAllListeners();
        this.client.on('connected', () => {
            this.connected = true;
        });
        this.client.on('disconnected', async () => {
            this.connected = false;
            await this.handleReconnect();
        });
        this.client.on('ledgerClosed', (ledger: LedgerStreamResponse) => {
            this.currentLedgerIndex = ledger.ledger_index;
            this.emitEvent('ledger', ledger);
        });
        this.client.on('transaction', (tx: TransactionStream) => {
            this.emitEvent('transaction', tx);
        });
        this.client.on('error', async (err) => {
            logger.error({ err }, 'XRPL websocket error');
            await this.handleReconnect();
        });
    }

    private emitEvent<T extends EventKey>(key: T, payload: Parameters<XRPLEvents[T]>[0]): void {
        this.emit(key, payload);
    }

    private async handleReconnect(): Promise<void> {
        if (this.reconnecting) return;
        this.reconnecting = true;
        if (this.reconnects >= this.cfg.maxReconnects) {
            logger.error('XRPL reconnect limit reached');
            this.reconnecting = false;
            return;
        }
        this.reconnects += 1;
        this.backoff = nextBackoff(this.backoff, this.cfg.initialReconnectDelayMs, this.cfg.maxReconnectDelayMs);
        this.emit('reconnect', this.reconnects);
        logger.warn({ reconnects: this.reconnects, delay: this.backoff.delayMs }, 'XRPL reconnecting');
        await new Promise((resolve) => setTimeout(resolve, this.backoff.delayMs));
        this.client = new Client(this.cfg.endpoint, { connectionTimeout: 10_000 });
        this.reconnecting = false;
        await this.establish();
    }

    private async ensureConnected(): Promise<void> {
        if (this.connected) return;
        await this.handleReconnect();
    }

    private async safeRequest(request: SubscribeRequest | Parameters<Client['request']>[0]): Promise<any> {
        // Minimal validation for subscription/book requests to avoid rippled invalidParams.
        if ((request as SubscribeRequest).command === 'subscribe') {
            const sub = request as SubscribeRequest;
            if (sub.books) {
                sub.books.forEach((book, idx) => {
                    if (book.taker && !isValidClassicAddress(book.taker)) {
                        throw new Error(`Invalid taker address in book[${idx}]`);
                    }
                    const validateSide = (side: 'taker_gets' | 'taker_pays') => {
                        const val = (book as any)[side];
                        if (val === 'XRP') return; // legacy string support
                        const code = val?.currency;
                        if (typeof code === 'string' && code.toUpperCase() === 'XRP') return;
                        if (!code || !val?.issuer || !isValidClassicAddress(val.issuer)) {
                            throw new Error(`Invalid ${side} in book[${idx}]`);
                        }
                    };
                    validateSide('taker_gets');
                    validateSide('taker_pays');
                });
            }
        }
        try {
            await this.ensureConnected();
            logger.info({ request }, 'XRPL client.request');
            return await this.client.request(request);
        } catch (err) {
            logger.error({ err, request }, 'XRPL request failed');
            await this.handleReconnect();
            throw err;
        }
    }
}

export const subscribeOrderBooks = async (
    client: Client,
    pairs: SubscribePairInput[],
): Promise<any> => {
    const books: SubscribeBookInput[] = [];
    const botAddress = getBotAddressSafe();

    for (const pair of pairs) {
        const baseNeedsIssuer = pair.base.toUpperCase() !== 'XRP';
        const quoteNeedsIssuer = pair.quote.toUpperCase() !== 'XRP';
        const issuer = (pair.issuer ?? process.env.TRADE_ISSUER ?? '').trim();
        if ((baseNeedsIssuer || quoteNeedsIssuer) && (!issuer || !isValidClassicAddress(issuer))) {
            console.warn('[subscribeOrderBooks] Skipping pair with invalid issuer', pair);
            continue;
        }
        if ((baseNeedsIssuer || quoteNeedsIssuer) && botAddress && issuer === botAddress) {
            console.warn('[subscribeOrderBooks] Skipping pair because issuer is bot wallet', { pair, botAddress });
            continue;
        }

        try {
            const baseCur = toBookCurrency(pair.base, baseNeedsIssuer ? issuer : undefined);
            const quoteCur = toBookCurrency(pair.quote, quoteNeedsIssuer ? issuer : undefined);

            // Note: taker is required by some servers even though it's optional in the xrpl lib types
            // Using a dummy taker address (zero address works)
            books.push(
                {
                    taker_gets: baseCur,
                    taker_pays: quoteCur,
                    taker: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', // Zero address placeholder
                    both: true,
                    snapshot: false,
                },
                {
                    taker_gets: quoteCur,
                    taker_pays: baseCur,
                    taker: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
                    both: true,
                    snapshot: false,
                },
            );

            logBookRequest('subscribe-legacy/bid', baseCur, quoteCur);
            logBookRequest('subscribe-legacy/ask', quoteCur, baseCur);

            console.info('[subscribeOrderBooks] Prepared books for pair', pair);
        } catch (err) {
            console.warn('[subscribeOrderBooks] Skipping pair due to formatting error', { pair, err });
        }
    }

    const req: SubscribeRequest = {
        command: 'subscribe',
        streams: ['ledger', 'transactions'],
        books: books as SubscribeRequest['books'],
    };

    try {
        console.info('[subscribeOrderBooks] Subscribing', { books: books.length, streams: req.streams });
        const result = await client.request(req);
        console.info('[subscribeOrderBooks] Subscription acknowledged');
        return result;
    } catch (err) {
        if (err instanceof RippledError) {
            console.error('[subscribeOrderBooks] RippledError', { error: err.data || err.message });
        } else {
            console.error('[subscribeOrderBooks] Subscription failed', err);
        }
        throw err;
    }
};

/* Example usage (XRP/NZD issued by TRADE_ISSUER)
import { Client } from 'xrpl';
import { subscribeOrderBooks } from './xrpl/client';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
    const client = new Client(process.env.XRPL_WSS_URL || 'wss://s1.ripple.com');
    await client.connect();
    await subscribeOrderBooks(client, [
        { base: 'XRP', quote: 'NZD', issuer: process.env.TRADE_ISSUER },
    ]);
}

main().catch(console.error);
*/
