/**
 * Instrument Registry — Barrel Export
 *
 * @module market/instrumentRegistry
 */

// Schema types & seed data
export {
    type Instrument,
    type IssuerRecord,
    type CurrencySide,
    type LiquidityLevel,
    type Network,
    type RegistryStatus,
    type IssuerTier,
    type InstrumentFilter,
    type IssuerFilter,
    type LegacyTradingPair,
    toLegacyPair,
    fromLegacyPair,
    SEED_INSTRUMENTS,
    SEED_ISSUERS,
} from './schema';

// Registry API (instruments)
export {
    getInstruments,
    getActiveInstruments,
    findInstrument,
    getInstrument,
    isValidPairKey,
    listInstruments,
    registerInstrument,
    setInstrumentStatus,
    setInstrumentLiquidity,
    removeInstrument,
    validateInstrumentStructure,
    assertAllowedInstrument,
    // Backward compat
    getTradingPairs,
    findPair,
    getPair,
    listPairs,
    assertValidPair,
    validateAllPairs,
    // Lifecycle
    initRegistry,
    closeRegistry,
    resetRegistry,
} from './registry';

// Registry API (issuers)
export {
    getIssuer,
    listIssuers,
    getActiveIssuersForCurrency,
    registerIssuer,
    setIssuerStatus,
    setIssuerTier,
    removeIssuer,
} from './registry';

// DB layer (for testing / advanced usage)
export {
    getRegistryDb,
    closeRegistryDb,
    resetRegistryDb,
} from './db';
