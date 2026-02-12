import { beforeEach, describe, expect, it, vi } from 'vitest';

const recorded: Array<Record<string, unknown>> = [];
const { hasExecutionQualityTxHash, hasEdgeAttributionTxHash, recordExecutionQualityEvent, recordEdgeAttributionEvent } = vi.hoisted(() => ({
    hasExecutionQualityTxHash: vi.fn(() => false),
    hasEdgeAttributionTxHash: vi.fn(() => false),
    recordExecutionQualityEvent: vi.fn(),
    recordEdgeAttributionEvent: vi.fn(),
}));

vi.mock('../tradeHistory', () => ({
    tradeHistory: {
        hasTradeHash: vi.fn((hash: string) => recorded.some((t) => t.hash === hash)),
        recordTrade: vi.fn((trade: Record<string, unknown>) => {
            const fullTrade = { ...trade, id: `id-${recorded.length}`, timestamp: Date.now() };
            recorded.push(fullTrade);
            return fullTrade;
        }),
    },
}));

vi.mock('../feedbackDb', () => ({
    hasExecutionQualityTxHash,
    hasEdgeAttributionTxHash,
}));

vi.mock('../feedbackEngine', () => ({
    feedbackEngine: {
        recordExecutionQualityEvent,
        recordEdgeAttributionEvent,
    },
}));

import { AccountTradeIngestionService } from '../accountTradeIngestion';

const PAIR = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    baseIssuer: '',
    quoteIssuer: 'rQuoteIssuer1111111111111111111111111',
    issuer: 'rQuoteIssuer1111111111111111111111111',
};

function makeOfferFillTx(opts: {
    hash: string;
    account?: string;
    validated?: boolean;
}): any {
    return {
        validated: opts.validated ?? true,
        ledger_index: 1234,
        transaction: {
            TransactionType: 'OfferCreate',
            Account: opts.account ?? 'rBotWallet11111111111111111111111111',
            hash: opts.hash,
            TakerGets: '1000000',
            TakerPays: {
                currency: 'RLUSD',
                issuer: 'rQuoteIssuer1111111111111111111111111',
                value: '2',
            },
        },
        meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
                {
                    DeletedNode: {
                        LedgerEntryType: 'Offer',
                        FinalFields: {
                            Account: 'rMaker111111111111111111111111111',
                            TakerGets: '2000000',
                            TakerPays: {
                                currency: 'RLUSD',
                                issuer: 'rQuoteIssuer1111111111111111111111111',
                                value: '4',
                            },
                        },
                        PreviousFields: {
                            TakerGets: '3000000',
                            TakerPays: {
                                currency: 'RLUSD',
                                issuer: 'rQuoteIssuer1111111111111111111111111',
                                value: '6',
                            },
                        },
                    },
                },
            ],
        },
    };
}

describe('AccountTradeIngestionService', () => {
    beforeEach(() => {
        recorded.length = 0;
        vi.clearAllMocks();
        hasExecutionQualityTxHash.mockReturnValue(false);
        hasEdgeAttributionTxHash.mockReturnValue(false);
    });

    it('ingests external wallet fill with source=manual', () => {
        const svc = new AccountTradeIngestionService(PAIR, 'rBotWallet11111111111111111111111111');
        svc.processTransaction(makeOfferFillTx({ hash: 'MANUAL_HASH' }));

        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.source).toBe('manual');
        expect(recorded[0]?.side).toBe('BUY');
        expect(recorded[0]?.filled).toBeCloseTo(1, 8);
        expect(recordExecutionQualityEvent).toHaveBeenCalledTimes(1);
        expect(recordEdgeAttributionEvent).toHaveBeenCalledTimes(1);
    });

    it('tags bot-submitted hash as source=bot', () => {
        const svc = new AccountTradeIngestionService(PAIR, 'rBotWallet11111111111111111111111111');
        svc.registerBotTxHash('BOT_HASH');
        svc.processTransaction(makeOfferFillTx({ hash: 'BOT_HASH' }));

        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.source).toBe('bot');
    });

    it('deduplicates repeated transaction hashes', () => {
        const svc = new AccountTradeIngestionService(PAIR, 'rBotWallet11111111111111111111111111');
        const tx = makeOfferFillTx({ hash: 'DUP_HASH' });
        svc.processTransaction(tx);
        svc.processTransaction(tx);

        expect(recorded).toHaveLength(1);
    });

    it('ignores transactions from another account', () => {
        const svc = new AccountTradeIngestionService(PAIR, 'rBotWallet11111111111111111111111111');
        svc.processTransaction(makeOfferFillTx({
            hash: 'OTHER_ACCOUNT_HASH',
            account: 'rSomeoneElse11111111111111111111111',
        }));

        expect(recorded).toHaveLength(0);
    });
});
