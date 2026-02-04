import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { FlowMetrics, FlowRegime, getRegimeDescription } from '../../../../src/market/flowMetrics';

export const config = {
    api: { bodyParser: false },
};

/**
 * Flow metrics response shape
 */
export interface FlowResponse {
    requestId: string;
    timestamp: string;
    hasMetrics: boolean;
    metrics: FlowMetrics | null;
    regime: {
        current: FlowRegime | null;
        description: string;
        safeForMM: boolean;
        safeForArb: boolean;
    };
    signals: {
        imbalance: number;
        depthImbalance: number;
        combinedSignal: number;
        signalStrength: number;
    } | null;
    prices: {
        bestBid: number;
        bestAsk: number;
        midPrice: number;
        spreadBps: number;
        vwap: number | null;
        vwapDeviationBps: number;
    } | null;
    depth: {
        bidDepthBase: number;
        askDepthBase: number;
        totalDepth: number;
    } | null;
}

/**
 * GET /api/bot/flow
 * 
 * Returns current flow metrics computed from trade tape and order book.
 * Used by UI to display market regime, imbalance gauges, and depth charts.
 */
function handler(req: LocalRequest, res: NextApiResponse<FlowResponse>) {
    try {
        const runtime = ensureRuntimeHooks();
        const flowMetrics = runtime.getFlowMetrics();

        const response: FlowResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            hasMetrics: flowMetrics !== null,
            metrics: flowMetrics,
            regime: {
                current: flowMetrics?.regime ?? null,
                description: flowMetrics ? getRegimeDescription(flowMetrics.regime) : 'No data available',
                safeForMM: flowMetrics ? (flowMetrics.regime === 'quiet' || flowMetrics.regime === 'normal') : false,
                safeForArb: flowMetrics ? (flowMetrics.regime !== 'illiquid' && flowMetrics.regime !== 'chaotic') : false,
            },
            signals: flowMetrics ? {
                imbalance: flowMetrics.imbalance,
                depthImbalance: flowMetrics.depthImbalance,
                combinedSignal: flowMetrics.combinedSignal,
                signalStrength: flowMetrics.signalStrength,
            } : null,
            prices: flowMetrics ? {
                bestBid: flowMetrics.bestBid,
                bestAsk: flowMetrics.bestAsk,
                midPrice: flowMetrics.midPrice,
                spreadBps: flowMetrics.spreadBps,
                vwap: flowMetrics.vwap,
                vwapDeviationBps: flowMetrics.vwapDeviationBps,
            } : null,
            depth: flowMetrics ? {
                bidDepthBase: flowMetrics.bidDepthBase,
                askDepthBase: flowMetrics.askDepthBase,
                totalDepth: flowMetrics.bidDepthBase + flowMetrics.askDepthBase,
            } : null,
        };

        res.status(200).json(response);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            hasMetrics: false,
            metrics: null,
            regime: {
                current: null,
                description: `Error: ${message}`,
                safeForMM: false,
                safeForArb: false,
            },
            signals: null,
            prices: null,
            depth: null,
        });
    }
}

export default withLocalApi(handler, { methods: ['GET'], skipAudit: true });
