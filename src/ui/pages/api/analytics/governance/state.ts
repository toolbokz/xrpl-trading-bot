import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../../lib/localApi';
import { getRuntime } from '../../../../lib/runtimeHooks';

export const config = {
    api: { bodyParser: false },
};

/**
 * Governance state as exposed by the API.
 */
export interface GovernanceStateResponse {
    requestId: string;
    timestamp: string;
    available: boolean;
    state: {
        mode: 'ALLOW' | 'THROTTLE' | 'PAUSE' | 'SHUTDOWN';
        reasons: string[];
        metrics: {
            tradesCount: number;
            profitFactor: number;
            expectancyBps: number;
            drawdownPct: number;
            drawdownConfidence: boolean;
            peakEquity: number;
            equityNow: number;
            avgSlippageBps: number;
            partialFillRate: number;
            winRate: number;
            consecutiveFailures: number;
        } | null;
        thresholds: {
            minTrades: number;
            maxDrawdownPct: number;
            minProfitFactor: number;
            minExpectancyBps: number;
            maxAvgSlippageBps: number;
            maxPartialFillRate: number;
            consecFailShutdown: number;
        } | null;
        sizeMultiplier: number;
        cooldownMs: number;
        evaluatedAt: string | null;
    } | null;
}

/**
 * GET /api/analytics/governance/state
 * 
 * Returns the current Capital Protection governance state, including:
 * - Current mode (ALLOW, THROTTLE, PAUSE, SHUTDOWN)
 * - Reasons for current mode
 * - Rolling risk metrics
 * - Configured thresholds
 * - Size multiplier and cooldown (if throttled)
 * 
 * Returns available: false if bot is not running or governance not initialized.
 */
function handler(req: LocalRequest, res: NextApiResponse<GovernanceStateResponse | { error: string }>) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Get governance status from runtime via runtimeHooks
        // The runtime exposes getGovernanceStatus() which returns the last decision
        const runtime = getRuntime();

        if (!runtime) {
            return res.status(200).json({
                requestId: req.requestId,
                timestamp: new Date().toISOString(),
                available: false,
                state: null,
            });
        }

        const govStatus = runtime.getGovernanceStatus?.();

        if (!govStatus) {
            return res.status(200).json({
                requestId: req.requestId,
                timestamp: new Date().toISOString(),
                available: false,
                state: null,
            });
        }

        // Map the internal decision to API response
        const { decision, config } = govStatus;

        const response: GovernanceStateResponse = {
            requestId: req.requestId,
            timestamp: new Date().toISOString(),
            available: true,
            state: {
                mode: decision?.mode ?? 'ALLOW',
                reasons: decision?.reasons ?? [],
                metrics: decision?.metrics ? {
                    tradesCount: decision.metrics.tradesCount,
                    profitFactor: decision.metrics.profitFactor,
                    expectancyBps: decision.metrics.expectancyBps,
                    drawdownPct: decision.metrics.drawdownPct,
                    drawdownConfidence: decision.metrics.drawdownConfidence ?? false,
                    peakEquity: decision.metrics.peakEquity ?? 0,
                    equityNow: decision.metrics.equityNow ?? 0,
                    avgSlippageBps: decision.metrics.avgSlippageBps,
                    partialFillRate: decision.metrics.partialFillRate,
                    winRate: decision.metrics.winRate,
                    consecutiveFailures: decision.metrics.consecutiveFailures ?? 0,
                } : null,
                thresholds: config ? {
                    minTrades: config.minTrades,
                    maxDrawdownPct: config.maxRollingDrawdownPct,
                    minProfitFactor: config.minProfitFactor,
                    minExpectancyBps: config.minExpectancyBps,
                    maxAvgSlippageBps: config.maxAvgSlippageBps,
                    maxPartialFillRate: config.maxPartialFillRate,
                    consecFailShutdown: config.consecFailShutdown,
                } : null,
                sizeMultiplier: decision?.sizeMultiplier ?? 1.0,
                cooldownMs: decision?.cooldownMs ?? 0,
                evaluatedAt: decision?.timestamp ? new Date(decision.timestamp).toISOString() : null,
            },
        };

        return res.status(200).json(response);
    } catch (error) {
        console.error('[governance/state] Error:', error);
        return res.status(500).json({
            error: error instanceof Error ? error.message : 'Failed to get governance state',
        });
    }
}

export default withLocalApi(handler);
