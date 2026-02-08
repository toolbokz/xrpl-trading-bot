/**
 * TradeTapeService Unit Tests
 * 
 * Tests for:
 * - Trade normalization from XRPL transaction metadata
 * - XRP/issued currency pair matching
 * - Issued/issued currency pair matching
 * - Fill calculation for partial and full fills
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TradeTapeService } from '../tradeTapeService';
import { TradeTape } from '../tradeTape';
import { TransactionStream } from 'xrpl';

// Mock trading pairs
const xrpRlusdPair = {
    baseCurrency: 'XRP',
    quoteCurrency: 'RLUSD',
    quoteIssuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
};

const usdEurPair = {
    baseCurrency: 'USD',
    baseIssuer: 'rUsdIssuer123456789012345678901234',
    quoteCurrency: 'EUR',
    quoteIssuer: 'rEurIssuer123456789012345678901234',
};

/**
 * Create a mock XRPL transaction stream for OfferCreate with crossed offers.
 */
function createMockOfferCreateTx(options: {
    txHash: string;
    ledgerIndex: number;
    takerAccount: string;
    affectedNodes: any[];
}): TransactionStream {
    return {
        transaction: {
            TransactionType: 'OfferCreate',
            Account: options.takerAccount,
            hash: options.txHash,
        },
        validated: true,
        ledger_index: options.ledgerIndex,
        meta: {
            AffectedNodes: options.affectedNodes,
        },
    } as unknown as TransactionStream;
}

/**
 * Create a DeletedNode for a fully filled offer.
 * XRPL always sets PreviousFields when an offer is consumed (TakerGets/TakerPays
 * changed from their original value to zero). A DeletedNode WITHOUT PreviousFields
 * is a cancelled offer, not a trade.
 */
function createDeletedOfferNode(options: {
    account: string;
    takerGets: string | { currency: string; issuer: string; value: string };
    takerPays: string | { currency: string; issuer: string; value: string };
}): any {
    // FinalFields shows the depleted state (zero remaining)
    const zeroGets = typeof options.takerGets === 'string'
        ? '0'
        : { ...options.takerGets, value: '0' };
    const zeroPays = typeof options.takerPays === 'string'
        ? '0'
        : { ...options.takerPays, value: '0' };

    return {
        DeletedNode: {
            LedgerEntryType: 'Offer',
            FinalFields: {
                Account: options.account,
                TakerGets: zeroGets,
                TakerPays: zeroPays,
            },
            PreviousFields: {
                TakerGets: options.takerGets,
                TakerPays: options.takerPays,
            },
        },
    };
}

/**
 * Create a DeletedNode for a CANCELLED offer (e.g. via OfferSequence replacement).
 * Cancelled offers have no PreviousFields for TakerGets/TakerPays because
 * those fields didn't change — the offer was just removed.
 */
function createCancelledOfferNode(options: {
    account: string;
    takerGets: string | { currency: string; issuer: string; value: string };
    takerPays: string | { currency: string; issuer: string; value: string };
}): any {
    return {
        DeletedNode: {
            LedgerEntryType: 'Offer',
            FinalFields: {
                Account: options.account,
                TakerGets: options.takerGets,
                TakerPays: options.takerPays,
            },
        },
    };
}

/**
 * Create a ModifiedNode for a partially filled offer.
 */
function createModifiedOfferNode(options: {
    account: string;
    previousTakerGets: string | { currency: string; issuer: string; value: string };
    previousTakerPays: string | { currency: string; issuer: string; value: string };
    finalTakerGets: string | { currency: string; issuer: string; value: string };
    finalTakerPays: string | { currency: string; issuer: string; value: string };
}): any {
    return {
        ModifiedNode: {
            LedgerEntryType: 'Offer',
            FinalFields: {
                Account: options.account,
                TakerGets: options.finalTakerGets,
                TakerPays: options.finalTakerPays,
            },
            PreviousFields: {
                TakerGets: options.previousTakerGets,
                TakerPays: options.previousTakerPays,
            },
        },
    };
}

describe('TradeTapeService', () => {
    let tape: TradeTape;
    let service: TradeTapeService;

    beforeEach(() => {
        tape = new TradeTape(xrpRlusdPair);
        service = new TradeTapeService(tape, xrpRlusdPair, null);
    });

    describe('XRP/Issued Currency Trade Normalization', () => {
        it('should extract buy trade from deleted offer (XRP/RLUSD)', () => {
            // Scenario: Taker buys XRP, pays RLUSD
            // Offer on book: TakerGets=XRP (what maker sells), TakerPays=RLUSD (what maker receives)
            // When crossed, taker receives XRP (base) and pays RLUSD (quote) = BUY

            const tx = createMockOfferCreateTx({
                txHash: 'ABC123HASH',
                ledgerIndex: 90000000,
                takerAccount: 'rTakerAddress',
                affectedNodes: [
                    createDeletedOfferNode({
                        account: 'rMakerAddress',
                        // Maker was selling 100 XRP (in drops)
                        takerGets: '100000000', // 100 XRP in drops
                        // Maker was buying 250 RLUSD
                        takerPays: {
                            currency: 'RLUSD',
                            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                            value: '250',
                        },
                    }),
                ],
            });

            service.processTransaction(tx);

            const trades = tape.getAll();
            expect(trades.length).toBe(1);

            const trade = trades[0]!;
            expect(trade.side).toBe('buy'); // Taker bought XRP
            expect(trade.sizeBase).toBe(100); // 100 XRP
            expect(trade.sizeQuote).toBe(250); // 250 RLUSD
            expect(trade.price).toBe(2.5); // 250/100 = 2.5 RLUSD per XRP
            expect(trade.txHash).toBe('ABC123HASH');
        });

        it('should extract sell trade from deleted offer (XRP/RLUSD)', () => {
            // Scenario: Taker sells XRP, receives RLUSD
            // Offer on book: TakerGets=RLUSD (what maker sells), TakerPays=XRP (what maker receives)
            // When crossed, taker receives RLUSD (quote) and pays XRP (base) = SELL

            const tx = createMockOfferCreateTx({
                txHash: 'DEF456HASH',
                ledgerIndex: 90000001,
                takerAccount: 'rTakerAddress',
                affectedNodes: [
                    createDeletedOfferNode({
                        account: 'rMakerAddress',
                        // Maker was selling 500 RLUSD
                        takerGets: {
                            currency: 'RLUSD',
                            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                            value: '500',
                        },
                        // Maker was buying 200 XRP
                        takerPays: '200000000', // 200 XRP in drops
                    }),
                ],
            });

            service.processTransaction(tx);

            const trades = tape.getAll();
            expect(trades.length).toBe(1);

            const trade = trades[0]!;
            expect(trade.side).toBe('sell'); // Taker sold XRP
            expect(trade.sizeBase).toBe(200); // 200 XRP
            expect(trade.sizeQuote).toBe(500); // 500 RLUSD
            expect(trade.price).toBe(2.5); // 500/200 = 2.5 RLUSD per XRP
        });

        it('should handle partial fills from modified offers', () => {
            const tx = createMockOfferCreateTx({
                txHash: 'PARTIAL123',
                ledgerIndex: 90000002,
                takerAccount: 'rTakerAddress',
                affectedNodes: [
                    createModifiedOfferNode({
                        account: 'rMakerAddress',
                        // Originally selling 1000 XRP
                        previousTakerGets: '1000000000',
                        previousTakerPays: {
                            currency: 'RLUSD',
                            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                            value: '2500',
                        },
                        // Now 600 XRP remaining (400 filled)
                        finalTakerGets: '600000000',
                        finalTakerPays: {
                            currency: 'RLUSD',
                            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                            value: '1500',
                        },
                    }),
                ],
            });

            service.processTransaction(tx);

            const trades = tape.getAll();
            expect(trades.length).toBe(1);

            const trade = trades[0]!;
            expect(trade.sizeBase).toBeCloseTo(400, 1); // 400 XRP filled
            expect(trade.sizeQuote).toBeCloseTo(1000, 1); // 1000 RLUSD filled
        });
    });

    describe('Issued/Issued Currency Trade Normalization', () => {
        beforeEach(() => {
            tape = new TradeTape(usdEurPair);
            service = new TradeTapeService(tape, usdEurPair, null);
        });

        it('should extract trade from issued/issued pair (USD/EUR)', () => {
            const tx = createMockOfferCreateTx({
                txHash: 'ISSUED123',
                ledgerIndex: 90000003,
                takerAccount: 'rTakerAddress',
                affectedNodes: [
                    createDeletedOfferNode({
                        account: 'rMakerAddress',
                        // Maker selling 1000 USD
                        takerGets: {
                            currency: 'USD',
                            issuer: 'rUsdIssuer123456789012345678901234',
                            value: '1000',
                        },
                        // Maker buying 900 EUR
                        takerPays: {
                            currency: 'EUR',
                            issuer: 'rEurIssuer123456789012345678901234',
                            value: '900',
                        },
                    }),
                ],
            });

            service.processTransaction(tx);

            const trades = tape.getAll();
            expect(trades.length).toBe(1);

            const trade = trades[0]!;
            expect(trade.pairKey).toBe('USD/EUR');
            expect(trade.side).toBe('buy'); // Taker bought USD (base)
            expect(trade.sizeBase).toBe(1000); // 1000 USD
            expect(trade.sizeQuote).toBe(900); // 900 EUR
            expect(trade.price).toBe(0.9); // 900/1000 = 0.9 EUR per USD
        });
    });

    describe('Edge Cases', () => {
        it('should ignore non-OfferCreate transactions', () => {
            const tx = {
                transaction: {
                    TransactionType: 'Payment',
                    Account: 'rSomeAddress',
                    hash: 'PAYMENT123',
                },
                validated: true,
                ledger_index: 90000004,
                meta: { AffectedNodes: [] },
            } as unknown as TransactionStream;

            service.processTransaction(tx);
            expect(tape.size()).toBe(0);
        });

        it('should ignore unvalidated transactions', () => {
            const tx = createMockOfferCreateTx({
                txHash: 'UNVALIDATED',
                ledgerIndex: 90000005,
                takerAccount: 'rTaker',
                affectedNodes: [
                    createDeletedOfferNode({
                        account: 'rMaker',
                        takerGets: '100000000',
                        takerPays: {
                            currency: 'RLUSD',
                            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                            value: '250',
                        },
                    }),
                ],
            });
            (tx as any).validated = false;

            service.processTransaction(tx);
            expect(tape.size()).toBe(0);
        });

        it('should ignore trades for different pairs', () => {
            // Transaction for XRP/USD but service is tracking XRP/RLUSD
            const tx = createMockOfferCreateTx({
                txHash: 'WRONGPAIR',
                ledgerIndex: 90000006,
                takerAccount: 'rTaker',
                affectedNodes: [
                    createDeletedOfferNode({
                        account: 'rMaker',
                        takerGets: '100000000',
                        takerPays: {
                            currency: 'USD',
                            issuer: 'rSomeOtherIssuer',
                            value: '250',
                        },
                    }),
                ],
            });

            service.processTransaction(tx);
            expect(tape.size()).toBe(0);
        });

        it('should ignore cancelled offers (DeletedNode without PreviousFields)', () => {
            // A market maker reprices by cancelling their old offer via OfferSequence.
            // The cancelled offer appears as a DeletedNode with no PreviousFields
            // for TakerGets/TakerPays — it must NOT be treated as a trade.
            const tx = createMockOfferCreateTx({
                txHash: 'CANCEL123',
                ledgerIndex: 90000010,
                takerAccount: 'rMarketMaker',
                affectedNodes: [
                    createCancelledOfferNode({
                        account: 'rMarketMaker',
                        takerGets: '1000000000000', // 1,000,000 XRP — not a real fill!
                        takerPays: {
                            currency: 'RLUSD',
                            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                            value: '1000000',
                        },
                    }),
                ],
            });

            service.processTransaction(tx);
            expect(tape.size()).toBe(0); // Must not appear as a trade
        });

        it('should handle multiple offer crossings in single transaction', () => {
            const tx = createMockOfferCreateTx({
                txHash: 'MULTI123',
                ledgerIndex: 90000007,
                takerAccount: 'rTaker',
                affectedNodes: [
                    createDeletedOfferNode({
                        account: 'rMaker1',
                        takerGets: '50000000', // 50 XRP
                        takerPays: {
                            currency: 'RLUSD',
                            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                            value: '125',
                        },
                    }),
                    createDeletedOfferNode({
                        account: 'rMaker2',
                        takerGets: '50000000', // 50 XRP
                        takerPays: {
                            currency: 'RLUSD',
                            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                            value: '130',
                        },
                    }),
                ],
            });

            service.processTransaction(tx);

            const trades = tape.getAll();
            expect(trades.length).toBe(2);

            // Both should be buy trades
            expect(trades.every(t => t.side === 'buy')).toBe(true);

            // IDs should be unique (txHash:index)
            expect(trades[0]!.id).toBe('MULTI123:0');
            expect(trades[1]!.id).toBe('MULTI123:1');
        });
    });

    describe('Self-Trade Filtering', () => {
        it('should filter self-trades when bot address is set', () => {
            const botAddress = 'rBotAddress12345';
            service = new TradeTapeService(tape, xrpRlusdPair, botAddress);

            const tx = createMockOfferCreateTx({
                txHash: 'SELFTRADE',
                ledgerIndex: 90000008,
                takerAccount: 'rOtherTaker',
                affectedNodes: [
                    // This offer belongs to the bot and was consumed - should be filtered
                    createDeletedOfferNode({
                        account: botAddress,
                        takerGets: '100000000',
                        takerPays: {
                            currency: 'RLUSD',
                            issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
                            value: '250',
                        },
                    }),
                ],
            });

            service.processTransaction(tx);
            expect(tape.size()).toBe(0); // Filtered out
        });
    });
});
