/**
 * GET /api/pairs
 *
 * Returns the unified list of trading instruments with:
 * - Static metadata (key, description, liquidity, network)
 * - Live availability verdicts from AvailabilityScanner
 * - Routing confidence from ExecutionPairResolver
 *
 * This is the single source of truth for the InstrumentSelector component.
 */

import type { NextApiResponse } from 'next';
import { getInstruments, type Instrument, type Network } from '../../../../market/instrumentRegistry';
import { loadConfig } from '../../../../config';
import { getRuntime } from '../../../../runtime/runtimeSingleton';
import type { AvailabilityVerdict } from '../../../../market/availabilityScanner';
import { withLocalApi } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import type { LocalRequest } from '../../../lib/localApi';

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
    /** Live availability verdict from scanner (null if not yet probed). */
    availability: AvailabilityVerdict | null;
    /** Human-readable availability detail messages. */
    availabilityDetails: string[];
    /** Whether the pair is the currently active trading pair. */
    active: boolean;
}

interface PairsResponse {
    pairs: PairListItem[];
    network: Network;
    total: number;
    /** Whether availability data is populated (scanner has run at least once). */
    availabilityReady: boolean;
}

function handler(
    req: LocalRequest,
    res: NextApiResponse<PairsResponse | { error: string }>
) {
    try {
        const cfg = loadConfig();
        const currentNetwork = (cfg.xrpl.network as Network) || 'mainnet';

        // Get instruments from the registry
        const instruments = getInstruments();

        // Filter by network if requested
        const networkFilter = req.query.network as Network | undefined;
        const filtered = (networkFilter || currentNetwork) === 'mainnet'
            ? instruments.filter((i) => i.network === 'mainnet')
            : instruments; // testnet shows all

        // Get availability data from runtime (if available)
        const runtime = getRuntime();
        const activePairKey = runtime?.getCurrentPairKey() ?? null;
        let availabilityReady = false;

        const pairs: PairListItem[] = filtered.map((inst: Instrument) => {
            // Live availability from AvailabilityScanner
            const avail = runtime?.getPairAvailability(inst.key) ?? null;
            if (avail) availabilityReady = true;

            return {
                key: inst.key,
                description: inst.description,
                liquidity: inst.liquidity === 'unknown' ? 'low' : inst.liquidity,
                network: inst.network === 'devnet' ? 'testnet' : inst.network,
                baseCurrency: inst.base.currency,
                quoteCurrency: inst.quote.currency,
                baseIssuer: inst.base.issuer,
                quoteIssuer: inst.quote.issuer,
                availability: avail?.verdict ?? null,
                availabilityDetails: avail?.details ?? [],
                active: inst.key === activePairKey,
            };
        });

        const response: PairsResponse = {
            pairs,
            network: currentNetwork,
            total: pairs.length,
            availabilityReady,
        };

        // Cache for 5 seconds (availability data changes with scans)
        res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=15');
        return res.status(200).json(response);
    } catch (err) {
        console.error('[API /pairs] Error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET'], skipAudit: true });
