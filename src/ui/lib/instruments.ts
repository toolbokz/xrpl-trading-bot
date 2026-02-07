/**
 * Client-Safe Instrument Lookups
 *
 * Provides pure, browser-safe instrument lookup functions backed by the
 * static SEED_INSTRUMENTS array from the registry schema.
 *
 * Client components ("use client") MUST import from this module — never
 * from tradingPairs.ts or instrumentRegistry, which pull in better-sqlite3.
 *
 * Server-side API routes can continue using tradingPairs.ts or the full
 * instrumentRegistry (they run in Node.js where SQLite is available).
 *
 * @module lib/instruments
 */

import {
    SEED_INSTRUMENTS,
    type Instrument,
    type CurrencySide,
    type LiquidityLevel,
    type Network,
} from '../../market/instrumentRegistry/schema';

// ── Re-export types (zero-cost, erased at compile time) ─────────────────────
export type { Instrument, CurrencySide, LiquidityLevel, Network };

// ── Static lookup map (built once, used for O(1) lookups) ───────────────────
const instrumentMap = new Map<string, Instrument>(
    SEED_INSTRUMENTS.map((i) => [i.key, i]),
);

/**
 * Find an instrument by key. Returns undefined if not found.
 * Safe for use in client components — no SQLite / Node.js dependency.
 */
export function findInstrument(key: string): Instrument | undefined {
    return instrumentMap.get(key);
}

/**
 * Check if a pair key is valid (exists in the seed instruments).
 */
export function isValidPairKey(key: string): boolean {
    return instrumentMap.has(key);
}

/**
 * Get all seed instruments.
 */
export function getInstruments(): readonly Instrument[] {
    return SEED_INSTRUMENTS;
}
