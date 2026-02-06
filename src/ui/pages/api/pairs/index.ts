/**
 * GET /api/pairs
 * 
 * Returns the list of available trading pairs.
 * Single source of truth from shared config.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { TRADING_PAIRS, listPairs, Network } from '../../../lib/tradingPairs';
import { loadConfig } from '../../../../config';

export const config = {
    api: { bodyParser: false },
};

interface PairListItem {
    key: string;
    description: string;
    liquidity: 'high' | 'medium' | 'low';
    network: 'mainnet' | 'testnet';
    baseCurrency: string;
    quoteCurrency: string;
    baseIssuer?: string | undefined;
    quoteIssuer?: string | undefined;
}

interface PairsResponse {
    pairs: PairListItem[];
    network: Network;
    total: number;
}

export default function handler(
    req: NextApiRequest,
    res: NextApiResponse<PairsResponse | { error: string }>
) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Get current network from config
        const cfg = loadConfig();
        const currentNetwork = (cfg.xrpl.network as Network) || 'mainnet';

        // Filter pairs by network if requested
        const networkFilter = req.query.network as Network | undefined;
        const pairs = listPairs({ network: networkFilter || currentNetwork });

        const response: PairsResponse = {
            pairs: pairs.map((p: typeof pairs[number]) => ({
                key: p.key,
                description: p.description,
                liquidity: p.liquidity,
                network: p.network,
                baseCurrency: p.base.currency,
                quoteCurrency: p.quote.currency,
                baseIssuer: p.base.issuer,
                quoteIssuer: p.quote.issuer,
            })),
            network: currentNetwork,
            total: pairs.length,
        };

        // Cache for 30 seconds (pairs don't change often)
        res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
        return res.status(200).json(response);
    } catch (err) {
        console.error('[API /pairs] Error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
