import { describe, expect, it } from 'vitest';
import {
    extractLiquidityEdges,
    fetchXrpscanTokens,
    generatePairsFromEdges,
    normalizeXrpscanTokens,
    type DiscoveryToken,
} from '../xrplDiscoveryService';

describe('xrplDiscoveryService', () => {
    it('ingests token universe from xrpscan with pagination', async () => {
        const pageA = [
            { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
            { currency: 'USDC', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' },
        ];
        const pageB = [
            { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' },
        ];

        const calls: string[] = [];
        const tokens = await fetchXrpscanTokens({
            pageSize: 2,
            fetchJson: async (url: string) => {
                calls.push(url);
                if (url.includes('offset=0')) return pageA;
                if (url.includes('offset=2')) return pageB;
                return [];
            },
        });

        expect(calls.length).toBe(2);
        expect(tokens).toEqual([
            { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
            { currency: 'USDC', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' },
            { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' },
        ]);
    });

    it('filters pools by liquidity and volume thresholds', () => {
        const tokenUniverse: DiscoveryToken[] = [
            { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
            { currency: 'USDC', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' },
        ];

        const payload = {
            data: [
                {
                    id: 'pool-1',
                    attributes: { reserve_in_usd: '150000', volume_usd_24h: '25000' },
                    relationships: {
                        base_token: { data: { id: 'token-xrp' } },
                        quote_token: { data: { id: 'token-rlusd' } },
                    },
                },
                {
                    id: 'pool-2',
                    attributes: { reserve_in_usd: '1000', volume_usd_24h: '5' },
                    relationships: {
                        base_token: { data: { id: 'token-xrp' } },
                        quote_token: { data: { id: 'token-usdc' } },
                    },
                },
            ],
            included: [
                { id: 'token-xrp', attributes: { symbol: 'XRP' } },
                { id: 'token-rlusd', attributes: { symbol: 'RLUSD' } },
                { id: 'token-usdc', attributes: { symbol: 'USDC' } },
            ],
        };

        const edges = extractLiquidityEdges(payload, tokenUniverse, {
            minLiquidityUsd: 50_000,
            minVolumeUsd: 10_000,
        });

        expect(edges).toHaveLength(1);
        expect(edges[0]?.base.currency).toBe('XRP');
        expect(edges[0]?.quote.currency).toBe('RLUSD');
    });

    it('generates XRP-base trading pairs from active liquidity edges', () => {
        const edges = [
            {
                base: { currency: 'XRP' as const },
                quote: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
                liquidityUsd: 200_000,
                volumeUsd24h: 100_000,
                source: 'test',
            },
            {
                base: { currency: 'USDC', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' },
                quote: { currency: 'XRP' as const },
                liquidityUsd: 150_000,
                volumeUsd24h: 75_000,
                source: 'test',
            },
        ];

        const pairs = generatePairsFromEdges(edges);
        expect(pairs.map((p) => p.key)).toEqual(['XRP/RLUSD', 'XRP/USDC']);
        expect(pairs[0]?.base.currency).toBe('XRP');
        expect(pairs[0]?.quote.issuer).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
    });

    it('normalizes xrpscan token rows safely', () => {
        const tokens = normalizeXrpscanTokens([
            { currency: 'rlusd', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
            { currency: 'bad', issuer: 'invalid' },
        ]);
        expect(tokens).toEqual([
            { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
        ]);
    });
});

