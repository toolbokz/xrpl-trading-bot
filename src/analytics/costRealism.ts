/**
 * Cost Realism Calculator
 *
 * Computes cost-related metrics for trade execution analysis:
 * - edge = intent vs mid (quoting skill)
 * - spreadPaid = fill vs mid (execution cost)
 * - netEdge = edge - spreadPaid - fees (what you actually keep)
 */

import { computeCanonicalSlippageBps } from './slippageMath';

export interface CostRealismInput {
    side: "buy" | "sell";
    intentPrice: number;
    fillPrice: number;
    midPriceAtDecision?: number | null;
    ammFeeBps?: number | null;
}

export interface CostRealismOutput {
    slippageBpsVsIntent: number;
    slippageBpsVsMid: number | null;
    spreadPaidBps: number | null;
    edgeBpsVsMid: number | null;
    netEdgeBpsVsMid: number | null;
}

/**
 * Compute cost realism metrics for a trade fill.
 *
 * @param args - Input parameters
 * @param args.side - "buy" or "sell"
 * @param args.intentPrice - The price we intended to trade at (our quote/limit)
 * @param args.fillPrice - The actual execution price
 * @param args.midPriceAtDecision - Mid price at time of decision (optional)
 * @param args.ammFeeBps - AMM fee in basis points (optional)
 *
 * @returns Cost realism metrics
 *
 * Metric definitions:
 * - slippageBpsVsIntent: (fillPrice - intentPrice) / intentPrice * 10000, sign-adjusted for side
 * - slippageBpsVsMid: (fillPrice - midPrice) / midPrice * 10000, sign-adjusted for side
 * - edgeBpsVsMid: (intentPrice - midPrice) / midPrice * 10000, sign-adjusted for side (quoting skill)
 * - spreadPaidBps: |fillPrice - midPrice| / midPrice * 10000 (unsigned cost of crossing spread)
 * - netEdgeBpsVsMid: edgeBpsVsMid - spreadPaidBps - (ammFeeBps ?? 0) (what you actually keep)
 *
 * Sign convention:
 * - For BUYS: positive slippage = paid more than expected (bad)
 * - For SELLS: positive slippage = received less than expected (bad)
 * - Edge: positive = good (intent was favorable vs mid)
 * - netEdge: positive = profitable after costs
 */
export function computeCostRealism(args: CostRealismInput): CostRealismOutput {
    const { side, intentPrice, fillPrice, midPriceAtDecision, ammFeeBps } = args;

    // Slippage vs intent follows canonical side-aware sign convention.
    const slippageBpsVsIntent =
        computeCanonicalSlippageBps(side, intentPrice, fillPrice)
        ?? 0;

    // Without mid price, we can only compute slippage vs intent
    if (midPriceAtDecision == null || midPriceAtDecision <= 0) {
        return {
            slippageBpsVsIntent,
            slippageBpsVsMid: null,
            spreadPaidBps: null,
            edgeBpsVsMid: null,
            netEdgeBpsVsMid: null,
        };
    }

    const mid = midPriceAtDecision;

    // Slippage vs Mid: how much did fill deviate from mid?
    // For buys: positive = paid more than mid (bad)
    // For sells: positive = received less than mid (bad)
    const slippageBpsVsMid = computeCanonicalSlippageBps(side, mid, fillPrice);

    // Spread paid: absolute cost of crossing the spread (always positive = cost)
    const spreadPaidBps = Math.abs(fillPrice - mid) / mid * 10000;

    // Edge vs Mid: how good was our intent relative to mid?
    // For buys: positive = intended to pay less than mid (good)
    // For sells: positive = intended to receive more than mid (good)
    const rawEdgeVsMid = (intentPrice - mid) / mid;
    const edgeBpsVsMid =
        side === "buy"
            ? -rawEdgeVsMid * 10000 // buy: lower intent = better
            : rawEdgeVsMid * 10000; // sell: higher intent = better

    // Net edge: what we actually keep after costs
    // edge (skill) - spread (execution cost) - AMM fee
    const netEdgeBpsVsMid = edgeBpsVsMid - spreadPaidBps - (ammFeeBps ?? 0);

    return {
        slippageBpsVsIntent,
        slippageBpsVsMid,
        spreadPaidBps,
        edgeBpsVsMid,
        netEdgeBpsVsMid,
    };
}

/**
 * Helper to format basis points for display
 */
export function formatBps(bps: number | null | undefined): string {
    if (bps == null) return "—";
    const sign = bps >= 0 ? "+" : "";
    return `${sign}${bps.toFixed(1)} bps`;
}

/**
 * Helper to determine if a cost metric is favorable
 */
export function isFavorable(
    metric: "slippage" | "edge" | "netEdge",
    value: number
): boolean {
    switch (metric) {
        case "slippage":
            // Lower slippage is better (negative is good)
            return value <= 0;
        case "edge":
        case "netEdge":
            // Higher edge/netEdge is better (positive is good)
            return value >= 0;
    }
}
