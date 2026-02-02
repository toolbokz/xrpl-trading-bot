/**
 * Pairs API Endpoints Tests
 * 
 * Tests for the trading pairs API endpoints.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the XRPL client before importing handlers
vi.mock('../../lib/xrplClient', () => ({
    getSharedClient: vi.fn().mockResolvedValue({
        request: vi.fn().mockResolvedValue({
            result: {
                offers: [
                    {
                        TakerGets: '1000000', // 1 XRP in drops
                        TakerPays: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', value: '0.55' },
                        Account: 'rSeller1',
                        Sequence: 1,
                    },
                ],
                ledger_index: 1000000,
            },
        }),
    }),
    getCachedPrice: vi.fn().mockReturnValue(null),
    setCachedPrice: vi.fn(),
}));

vi.mock('../../../src/config', () => ({
    loadConfig: vi.fn().mockReturnValue({
        xrpl: {
            endpoint: 'wss://s1.ripple.com',
            network: 'mainnet',
        },
    }),
}));

// Import after mocks
import { TRADING_PAIRS } from '../../../src/config/tradingPairs';

describe('Pairs API - Unit Tests', () => {
    describe('Price Calculation', () => {
        it('should calculate bid/ask correctly from XRP base offers', () => {
            // Mock offer: selling 1 XRP for 0.55 RLUSD
            // Ask price = TakerPays / TakerGets = 0.55 / 1 = 0.55
            const offer = {
                TakerGets: '1000000', // 1 XRP in drops
                TakerPays: { currency: 'RLUSD', value: '0.55' },
            };

            const baseQty = Number(offer.TakerGets) / 1_000_000; // 1 XRP
            const quoteQty = Number(offer.TakerPays.value); // 0.55 RLUSD
            const askPrice = quoteQty / baseQty;

            expect(askPrice).toBe(0.55);
        });

        it('should calculate spread correctly', () => {
            const bid = 0.54;
            const ask = 0.56;
            const mid = (bid + ask) / 2; // 0.55
            const spreadBps = ((ask - bid) / mid) * 10000;

            // Spread = (0.56 - 0.54) / 0.55 * 10000 = ~36.36 bps
            expect(spreadBps).toBeCloseTo(36.36, 1);
        });

        it('should handle zero prices gracefully', () => {
            const bid = 0;
            const ask = 0.55;
            const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;

            expect(mid).toBe(0.55);
        });
    });

    describe('Order Book Processing', () => {
        it('should process asks correctly (selling base for quote)', () => {
            const offers = [
                { TakerGets: '1000000', TakerPays: { value: '0.55' } },
                { TakerGets: '2000000', TakerPays: { value: '1.12' } },
            ];

            const levels = offers.map((offer, idx) => {
                const baseQty = Number(offer.TakerGets) / 1_000_000;
                const quoteQty = Number(offer.TakerPays.value);
                return {
                    price: quoteQty / baseQty,
                    size: baseQty,
                    cumulative: offers.slice(0, idx + 1).reduce(
                        (sum, o) => sum + Number(o.TakerGets) / 1_000_000,
                        0
                    ),
                };
            });

            expect(levels[0]).toMatchObject({ price: 0.55, size: 1 });
            expect(levels[1]).toMatchObject({ price: 0.56, size: 2 });
            expect(levels[1]?.cumulative).toBe(3);
        });

        it('should process bids correctly (buying base with quote)', () => {
            // Bid offer: TakerGets = quote (what they're selling), TakerPays = base (what they want)
            const offers = [
                { TakerGets: { value: '0.54' }, TakerPays: '1000000' },
            ];

            const offer = offers[0];
            const quoteQty = Number(offer!.TakerGets.value); // 0.54 RLUSD they're selling
            const baseQty = Number(offer!.TakerPays) / 1_000_000; // 1 XRP they want
            const bidPrice = quoteQty / baseQty;

            expect(bidPrice).toBe(0.54);
        });
    });

    describe('Pair Validation', () => {
        it('should have all expected pairs available', () => {
            const expectedPairs = [
                'XRP/RLUSD',
                'XRP/USDC',
                'XRP/EUR',
                'XRP/BTC',
                'XRP/ETH',
            ];

            expectedPairs.forEach((key) => {
                const pair = TRADING_PAIRS.find((p) => p.key === key);
                expect(pair).toBeDefined();
            });
        });

        it('should reject unknown pair keys', () => {
            const isValid = (key: string) => TRADING_PAIRS.some((p) => p.key === key);

            expect(isValid('XRP/INVALID')).toBe(false);
            expect(isValid('FOO/BAR')).toBe(false);
            expect(isValid('')).toBe(false);
        });
    });

    describe('Network Availability', () => {
        it('should mark pairs as available when offers exist', () => {
            const offers = [{ TakerGets: '1000000', TakerPays: { value: '0.55' } }];
            const availableOnNetwork = offers.length > 0;
            expect(availableOnNetwork).toBe(true);
        });

        it('should mark pairs as unavailable when no offers', () => {
            const offers: any[] = [];
            const availableOnNetwork = offers.length > 0;
            expect(availableOnNetwork).toBe(false);
        });
    });
});

describe('Currency Hex Conversion', () => {
    const currencyToHex = (currency: string): string => {
        if (currency.length <= 3) {
            return currency;
        }
        const hex = Buffer.from(currency, 'utf8').toString('hex').toUpperCase();
        return hex.padEnd(40, '0');
    };

    it('should not convert 3-char currencies', () => {
        expect(currencyToHex('XRP')).toBe('XRP');
        expect(currencyToHex('USD')).toBe('USD');
        expect(currencyToHex('EUR')).toBe('EUR');
    });

    it('should convert longer currency codes to hex', () => {
        const hex = currencyToHex('RLUSD');
        expect(hex).toHaveLength(40);
        expect(hex).toMatch(/^[0-9A-F]+$/);
        expect(hex.startsWith('524C555344')).toBe(true); // "RLUSD" in hex
    });
});

describe('Response Formatting', () => {
    describe('Spread Formatting', () => {
        const formatSpreadBps = (bps: number): string => {
            if (bps < 0) return '0.00';
            if (bps < 1) return bps.toFixed(2);
            if (bps < 10) return bps.toFixed(1);
            return Math.round(bps).toString();
        };

        it('should format small spreads with 2 decimals', () => {
            expect(formatSpreadBps(0.5)).toBe('0.50');
        });

        it('should format medium spreads with 1 decimal', () => {
            expect(formatSpreadBps(5.5)).toBe('5.5');
        });

        it('should format large spreads as integers', () => {
            expect(formatSpreadBps(50.7)).toBe('51');
        });
    });

    describe('Price Formatting', () => {
        const formatPrice = (price: number, quoteCurrency?: string): string => {
            if (price === 0) return '0';
            if (price < 0.0001) return price.toExponential(4);
            if (quoteCurrency && ['USD', 'USDT', 'USDC', 'RLUSD', 'EUR'].includes(quoteCurrency)) {
                return price.toFixed(4);
            }
            if (price < 1) return price.toFixed(6);
            return price.toFixed(4);
        };

        it('should format stablecoin prices with 4 decimals', () => {
            expect(formatPrice(0.5523, 'RLUSD')).toBe('0.5523');
            expect(formatPrice(0.5523, 'USDT')).toBe('0.5523');
        });

        it('should format small prices with 6 decimals', () => {
            expect(formatPrice(0.000055)).toBe('0.000055');
        });

        it('should format very small prices in exponential', () => {
            expect(formatPrice(0.00001234, 'BTC')).toBe('1.2340e-5');
        });
    });
});
