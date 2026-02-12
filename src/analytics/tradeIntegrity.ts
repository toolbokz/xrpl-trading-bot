import fs from 'fs';
import path from 'path';
import { canonicalizePairKey } from '../xrpl/currency';
import { logger } from './logger';
import type { ExpectedPriceSource } from './slippageMath';

const EPS = 1e-9;
const QUARANTINE_FILE = path.resolve(process.cwd(), 'data', 'quarantine_trades.jsonl');

export interface TradeIntegrityInput {
    pair: string;
    side: 'BUY' | 'SELL';
    status: 'FILLED' | 'PARTIAL' | 'REJECTED' | 'PENDING';
    amountBase: number;
    filledBase: number;
    filledQuote?: number;
    priceQuotePerBase: number;
    expectedPrice?: number;
    txHash?: string;
    source?: 'bot' | 'manual';
}

export interface TradeIntegrityResult {
    ok: boolean;
    canonicalPair: string;
    reasons: string[];
}

function isFiniteNonNegative(value: number): boolean {
    return Number.isFinite(value) && value >= 0;
}

export function validateTradeIntegrity(input: TradeIntegrityInput): TradeIntegrityResult {
    const reasons: string[] = [];
    const canonicalPair = canonicalizePairKey(input.pair);

    if (!Number.isFinite(input.priceQuotePerBase) || input.priceQuotePerBase <= 0) {
        reasons.push('invalid-price-quote-per-base');
    }
    if (!isFiniteNonNegative(input.filledBase)) {
        reasons.push('invalid-filled-base');
    }
    if (!isFiniteNonNegative(input.amountBase)) {
        reasons.push('invalid-amount-base');
    }
    if (input.filledQuote != null && (!Number.isFinite(input.filledQuote) || input.filledQuote < 0)) {
        reasons.push('invalid-filled-quote');
    }

    const isFinal = input.status === 'FILLED';
    if (isFinal && input.amountBase > 0 && input.filledBase > input.amountBase + EPS) {
        reasons.push('filled-base-exceeds-amount-base');
    }

    // XRP/RLUSD-specific reciprocal inversion guard when we have a reference price.
    if (
        canonicalPair === 'XRP/RLUSD'
        && input.side === 'SELL'
        && input.priceQuotePerBase < 1
        && input.expectedPrice != null
        && input.expectedPrice > 1
    ) {
        reasons.push('sell-price-likely-inverted-vs-reference');
    }

    return {
        ok: reasons.length === 0,
        canonicalPair,
        reasons,
    };
}

export function quarantineTradeRecord(payload: Record<string, unknown>): void {
    try {
        const dir = path.dirname(QUARANTINE_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFile(
            QUARANTINE_FILE,
            `${JSON.stringify({ ts: Date.now(), ...payload })}\n`,
            'utf8',
            () => { /* best-effort quarantine sink */ }
        );
    } catch {
        // Quarantine must never crash runtime.
    }
}

export function warnSuspiciousSlippage(input: {
    slippageBps: number | null | undefined;
    baseline: ExpectedPriceSource | 'unknown';
    pair: string;
    side: 'BUY' | 'SELL' | 'buy' | 'sell';
    txHash?: string | null;
    expectedPrice?: number | null;
    fillPrice?: number | null;
    bestBid?: number | null;
    bestAsk?: number | null;
}): void {
    if (input.slippageBps == null || !Number.isFinite(input.slippageBps)) return;
    if (input.slippageBps >= -100 && input.slippageBps <= 500) return;

    logger.warn({
        txHash: input.txHash ?? null,
        pair: canonicalizePairKey(input.pair),
        side: input.side,
        slippageBps: input.slippageBps,
        baseline: input.baseline,
        expectedPrice: input.expectedPrice ?? null,
        fillPrice: input.fillPrice ?? null,
        bestBid: input.bestBid ?? null,
        bestAsk: input.bestAsk ?? null,
    }, 'Suspicious slippage telemetry observed');
}
