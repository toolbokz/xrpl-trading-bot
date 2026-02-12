import { isValidClassicAddress } from 'xrpl';
import { logger } from '../analytics/logger';

const classicAddressPattern = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const is160BitHex = /^[A-F0-9]{40}$/i;

export type XrplCurrency = { currency: 'XRP' } | { currency: string; issuer: string };

/**
 * Convert a currency code to hex format if it's a non-standard code (>3 chars).
 * XRPL requires non-standard currency codes to be 40-char hex (160-bit).
 * e.g., "RLUSD" -> "524C555344000000000000000000000000000000"
 */
function currencyToHex(currency: string): string {
    // Standard 3-character codes don't need conversion
    if (currency.length <= 3) {
        return currency.toUpperCase();
    }
    // Already hex-encoded
    if (currency.length === 40 && is160BitHex.test(currency)) {
        return currency.toUpperCase();
    }
    // Convert to hex (padded to 40 chars / 20 bytes)
    const hex = Buffer.from(currency, 'utf8').toString('hex').toUpperCase();
    return hex.padEnd(40, '0');
}

/**
 * Decode a 160-bit hex XRPL currency code to ASCII symbol when possible.
 * Returns uppercase symbol (or the original uppercase input when undecodable).
 */
export function decodeXrplCurrencyCode(currency: string): string {
    const upper = (currency ?? '').trim().toUpperCase();
    if (!upper) return upper;
    if (!is160BitHex.test(upper)) return upper;

    try {
        const decoded = Buffer.from(upper, 'hex')
            .toString('ascii')
            .replace(/\0/g, '')
            .trim()
            .toUpperCase();
        return decoded.length > 0 ? decoded : upper;
    } catch {
        return upper;
    }
}

/**
 * Canonical pair key representation for analytics/trade history.
 * Example: XRP/524C... -> XRP/RLUSD
 */
export function canonicalizePairKey(pairKey: string): string {
    const raw = (pairKey ?? '').trim();
    if (!raw) return raw;
    const [baseRaw, quoteRaw, ...rest] = raw.split('/');
    if (!baseRaw || !quoteRaw || rest.length > 0) {
        return raw.toUpperCase();
    }

    const base = decodeXrplCurrencyCode(baseRaw);
    const quote = decodeXrplCurrencyCode(quoteRaw);
    return `${base}/${quote}`;
}

/**
 * Pair-key aliases accepted for filtering legacy + canonical records.
 */
export function getPairKeyAliases(pairKey: string): string[] {
    const aliases = new Set<string>();
    const canonical = canonicalizePairKey(pairKey);
    if (!canonical) return [];

    aliases.add(canonical);
    aliases.add(canonical.toUpperCase());
    aliases.add((pairKey ?? '').trim());
    aliases.add(((pairKey ?? '').trim()).toUpperCase());

    const [baseRaw, quoteRaw] = canonical.split('/');
    if (baseRaw && quoteRaw) {
        const base = baseRaw === 'XRP' ? 'XRP' : currencyToHex(baseRaw);
        const quote = quoteRaw === 'XRP' ? 'XRP' : currencyToHex(quoteRaw);
        aliases.add(`${base}/${quote}`);
    }

    return Array.from(aliases).filter((v) => v.length > 0);
}

export const normalizeXrplCurrency = (currency: string, issuer?: string): { currency: string; issuer?: string } => {
    if (!currency || typeof currency !== 'string') {
        throw new Error('Currency is required');
    }

    const upper = currency.toUpperCase();
    if (upper === 'XRP') {
        if (issuer) {
            throw new Error('XRP must not include issuer');
        }
        return { currency: 'XRP' };
    }

    if (!issuer || !isValidClassicAddress(issuer) || !classicAddressPattern.test(issuer)) {
        throw new Error('Issued currency requires a valid classic issuer address');
    }

    // Convert non-standard currency codes to hex format
    const currencyCode = currencyToHex(upper);

    if (!(currencyCode.length === 3 || currencyCode.length === 40)) {
        throw new Error('Currency code must be 3 characters or 160-bit hex');
    }

    if (upper.includes('/') || upper.includes('-')) {
        throw new Error('Exchange-style symbols are not allowed in currency codes');
    }

    return { currency: currencyCode, issuer };
};

export const toXrplCurrency = (input: XrplCurrency | { currency: string; issuer?: string }): XrplCurrency => {
    const normalized = normalizeXrplCurrency(input.currency, (input as any).issuer);
    if (normalized.currency === 'XRP') {
        return { currency: 'XRP' };
    }
    if (!normalized.issuer) {
        const msg = `Missing issuer for issued currency: ${normalized.currency}`;
        logger.error({ input }, msg);
        throw new Error(msg);
    }
    return { currency: normalized.currency, issuer: normalized.issuer };
};

export const ensureXRP = (currency: string, issuer?: string): { currency: string } => {
    const upper = currency.toUpperCase();
    if (upper !== 'XRP') {
        throw new Error('Expected XRP currency');
    }
    if (issuer) {
        throw new Error('XRP must not include issuer');
    }
    return { currency: 'XRP' };
};

export const ensureIssued = (currency: string, issuer?: string): { currency: string; issuer: string } => {
    const normalized = normalizeXrplCurrency(currency, issuer);
    if (normalized.currency === 'XRP') {
        throw new Error('Issued asset cannot be XRP');
    }
    if (!normalized.issuer) {
        throw new Error('Issued asset requires issuer');
    }
    return { currency: normalized.currency, issuer: normalized.issuer } as { currency: string; issuer: string };
};
