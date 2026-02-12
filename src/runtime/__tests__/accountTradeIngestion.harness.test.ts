import { describe, expect, it, vi } from 'vitest';

const getXrplClientSpy = vi.fn();

vi.mock('../../xrpl/sharedClient', () => ({
    getXrplClient: getXrplClientSpy,
}));

vi.mock('../../analytics/tradeHistory', () => ({
    tradeHistory: {
        hasTradeHash: vi.fn(() => false),
        recordTrade: vi.fn((trade: Record<string, unknown>) => ({ ...trade, id: 'x', timestamp: Date.now() })),
    },
}));

import { AccountTradeIngestionService } from '../../analytics/accountTradeIngestion';

function makeTx(hash: string): any {
    return {
        validated: true,
        transaction: {
            TransactionType: 'OfferCreate',
            Account: 'rBotWallet11111111111111111111111111',
            hash,
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

describe('Account ingestion harness', () => {
    it('handles tx ingestion while N ticks execute without slowdown and without new XRPL clients', async () => {
        const svc = new AccountTradeIngestionService({
            baseCurrency: 'XRP',
            quoteCurrency: 'RLUSD',
            baseIssuer: '',
            quoteIssuer: 'rQuoteIssuer1111111111111111111111111',
            issuer: 'rQuoteIssuer1111111111111111111111111',
        }, 'rBotWallet11111111111111111111111111');

        const tickDurations: number[] = [];
        const TICKS = 120;

        for (let i = 0; i < TICKS; i++) {
            const start = Date.now();
            svc.processTransaction(makeTx(`HASH_${i}`));
            await Promise.resolve();
            tickDurations.push(Date.now() - start);
        }

        const maxTickMs = Math.max(...tickDurations);
        expect(maxTickMs).toBeLessThan(25);
        expect(getXrplClientSpy).not.toHaveBeenCalled();
    });
});
