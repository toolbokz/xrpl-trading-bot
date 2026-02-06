import { Client, SubscribeRequest, BookOffer, LedgerStreamResponse, TransactionStream, Currency, RippledError, isValidClassicAddress } from 'xrpl';
import EventEmitter from 'events';
import { XRPLConfig, TradingPair } from '../config';
import { xrplLog as logger } from '../analytics/logger';
import { nextBackoffWithJitter, BackoffState } from '../utils/backoff';
import { sleep } from '../utils/sleep';
import { getWalletAddress } from './wallet';
import { toXrplCurrency } from './currency';
import { getXrplClient, getConnectionState, isConnected as isSharedConnected } from './sharedClient';

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
    private client: Client | null = null;
    private backoff: BackoffState = { attempt: 0, delayMs: 0 };
    private reconnects = 0;
    private connected = false;
    private currentLedgerIndex = 0;
    private reconnecting = false;
    private handlersAttached = false;

    constructor(private readonly cfg: XRPLConfig) {
        super();
        // Client is now obtained from shared singleton on connect()
    }

    async connect(): Promise<void> {
        await this.establish();
    }

    async disconnect(): Promise<void> {
        if (this.connected) {
            // Don't disconnect shared client - just mark as disconnected locally
            // The shared client is managed globally
            this.connected = false;
            this.handlersAttached = false;
            // Remove our listeners from the shared client
            if (this.client) {
                this.client.removeAllListeners('ledgerClosed');
                this.client.removeAllListeners('transaction');
            }
        }
    }

    isConnected(): boolean {
        return this.connected && (this.client?.isConnected() ?? false);
    }

    /** Whether the client is currently attempting to reconnect. */
    isReconnecting(): boolean {
        return this.reconnecting;
    }

    getClient(): Client {
        if (!this.client) {
            throw new Error('XRPL client not connected - call connect() first');
        }
        return this.client;
    }

    getLedgerIndex(): number {
        return this.currentLedgerIndex;
    }

    /** Get connection state from the shared client */
    getConnectionState() {
        return getConnectionState();
    }

    async subscribe(_pair?: TradingPair): Promise<void> {
        // Note: Most public XRPL servers (xrplcluster.com, s1.ripple.com, etc.)
        // do NOT allow book subscriptions. We only subscribe to ledger stream
        // and use polling (book_offers) for order book data during each tick.
        //
        // Trade tape: Subscribe to transactions stream to capture executed trades.
        // This is supported by most public servers.

        const streams: ('ledger' | 'transactions')[] = ['ledger'];

        // Enable transactions stream for trade tape (configurable)
        if (process.env.TRADE_TAPE_ENABLED !== 'false') {
            streams.push('transactions');
        }

        const req: SubscribeRequest = {
            id: 'xrpl-subscribe',
            command: 'subscribe',
            streams,
        };
        logger.info({ req, streams }, 'Subscribing to XRPL streams');
        try {
            await this.safeRequest(req);
            logger.info({ streams }, 'XRPL subscription acknowledged - using polling for order book data');
        } catch (err: any) {
            // Log but don't throw - we can still poll
            logger.warn({ err: err?.message || err }, 'XRPL subscription failed');
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
        await this.ensureConnected();
        const assetReq = toBookCurrency(asset.currency, asset.issuer);
        const asset2Req = toBookCurrency(asset2.currency, asset2.issuer);
        const res = await this.client!.request({
            command: 'amm_info',
            asset: assetReq,
            asset2: asset2Req,
        });
        return res.result;
    }

    private async establish(): Promise<void> {
        try {
            // Use the shared client singleton instead of creating a new one
            this.client = await getXrplClient();
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
                const state = getConnectionState();
                logger.info({ endpoint: state.endpoint }, 'Subscribed to ledger stream - order book data will be polled');
            } catch (err) {
                logger.warn({ err }, 'Failed to subscribe to ledger stream - will continue anyway');
            }

            const state = getConnectionState();
            logger.info({ endpoint: state.endpoint }, 'XRPL websocket connected via shared client');
        } catch (err) {
            logger.error({ err }, 'Initial XRPL connect failed');
            await this.handleReconnect();
        }
    }

    private attachHandlers(): void {
        if (!this.client || this.handlersAttached) return;

        // Don't remove all listeners - other code may be using the shared client
        // Just add our specific listeners
        this.handlersAttached = true;

        this.client.on('ledgerClosed', (ledger: LedgerStreamResponse) => {
            this.currentLedgerIndex = ledger.ledger_index;
            this.emitEvent('ledger', ledger);
        });
        this.client.on('transaction', (tx: TransactionStream) => {
            this.emitEvent('transaction', tx);
        });

        // Monitor for disconnection - the shared client handles reconnection automatically
        // but we need to update our local state
        this.client.on('disconnected', () => {
            this.connected = false;
            this.handlersAttached = false;
            logger.warn('XRPL shared client disconnected - will reconnect automatically');
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
        // Use jittered backoff to prevent reconnect storms (cap at 15s)
        this.backoff = nextBackoffWithJitter(
            this.backoff,
            this.cfg.initialReconnectDelayMs,
            Math.min(this.cfg.maxReconnectDelayMs, 15_000),
            0.2 // ±20% jitter
        );
        this.emit('reconnect', this.reconnects);
        logger.warn({ reconnects: this.reconnects, delay: this.backoff.delayMs }, 'XRPL reconnecting with jittered backoff');
        await sleep(this.backoff.delayMs);

        // Use shared client - it handles endpoint rotation and cooldowns internally
        this.handlersAttached = false;
        this.reconnecting = false;
        await this.establish();
    }

    private async ensureConnected(): Promise<void> {
        // Check if shared client is connected
        if (this.connected && isSharedConnected()) return;

        // Re-establish connection via shared client
        await this.establish();
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
            return await this.client!.request(request);
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
            logger.warn({ pair }, '[subscribeOrderBooks] Skipping pair with invalid issuer');
            continue;
        }
        if ((baseNeedsIssuer || quoteNeedsIssuer) && botAddress && issuer === botAddress) {
            logger.warn({ pair, botAddress }, '[subscribeOrderBooks] Skipping pair because issuer is bot wallet');
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

            logger.info({ pair }, '[subscribeOrderBooks] Prepared books for pair');
        } catch (err) {
            logger.warn({ pair, err }, '[subscribeOrderBooks] Skipping pair due to formatting error');
        }
    }

    const streams: ('ledger' | 'transactions')[] = ['ledger', 'transactions'];

    // Build request - only include books if we have some to subscribe to
    let req: SubscribeRequest;
    if (books.length > 0) {
        req = {
            command: 'subscribe',
            streams,
            books: books as NonNullable<SubscribeRequest['books']>,
        };
    } else {
        req = {
            command: 'subscribe',
            streams,
        };
    }

    try {
        logger.info({ booksCount: books.length, streams: req.streams }, '[subscribeOrderBooks] Subscribing');
        const result = await client.request(req);
        logger.info('[subscribeOrderBooks] Subscription acknowledged');
        return result;
    } catch (err) {
        if (err instanceof RippledError) {
            logger.error({ error: (err as RippledError).data || (err as Error).message }, '[subscribeOrderBooks] RippledError');
        } else {
            logger.error({ err }, '[subscribeOrderBooks] Subscription failed');
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
