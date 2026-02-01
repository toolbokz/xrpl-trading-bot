export type CurrencySide = {
    currency: string;
    issuer?: string;
    issuerEnv?: string;
};

export type TradingPairOption = {
    key: string; // human-readable key like XRP/RLUSD
    base: CurrencySide;
    quote: CurrencySide;
    description: string;
    liquidity?: 'high' | 'medium' | 'low';
    network?: 'mainnet' | 'testnet' | 'both'; // Which network this pair works on
};

// TESTNET pairs - use testnet faucet-created tokens or well-known testnet issuers
const testnetPairs: TradingPairOption[] = [
    {
        key: 'XRP/USD (Testnet)',
        base: { currency: 'XRP' },
        // Using a common testnet gateway - you may need to adjust this issuer
        quote: { currency: 'USD', issuer: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe' },
        description: 'Testnet USD - from .env TRADE_ISSUER',
        liquidity: 'low',
        network: 'testnet',
    },
    {
        key: 'XRP/NZD (Testnet)',
        base: { currency: 'XRP' },
        quote: { currency: 'NZD', issuer: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe' },
        description: 'Testnet NZD - from .env TRADE_ISSUER',
        liquidity: 'low',
        network: 'testnet',
    },
];

// MAINNET pairs - real issuers with actual liquidity
const mainnetPairs: TradingPairOption[] = [
    {
        key: 'XRP/RLUSD',
        base: { currency: 'XRP' },
        quote: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
        description: 'Native Ripple USD - High Liquidity (MAINNET)',
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: 'XRP/USDT',
        base: { currency: 'XRP' },
        quote: { currency: 'USDT', issuer: 'rPTr8H5QG74Q63yDq47t4T55jD1g7m7g6' },
        description: 'Tether via GateHub (MAINNET)',
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: 'XRP/USDC',
        base: { currency: 'XRP' },
        quote: { currency: 'USDC', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' },
        description: 'Native Circle USDC (MAINNET)',
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: 'XRP/XAUT',
        base: { currency: 'XRP' },
        quote: { currency: 'XAUT', issuer: 'rGk4Rmwv3Mfj484aA9ZJmD4k4P1J1T5B5g' },
        description: 'Tether Gold via GateHub (MAINNET)',
        liquidity: 'medium',
        network: 'mainnet',
    },
    {
        key: 'XRP/SOLO',
        base: { currency: 'XRP' },
        quote: { currency: 'SOLO', issuer: 'rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz' },
        description: 'Sologenic Ecosystem Token (MAINNET)',
        liquidity: 'medium',
        network: 'mainnet',
    },
    {
        key: 'XRP/CORE',
        base: { currency: 'XRP' },
        quote: { currency: 'CORE', issuer: 'rcoreNywaueY4Z8y5f5YpPzKxWv816z5Y' },
        description: 'Coreum Ecosystem Token (MAINNET)',
        liquidity: 'medium',
        network: 'mainnet',
    },
    {
        key: 'XRP/xSPECTAR',
        base: { currency: 'XRP' },
        quote: { currency: 'xSPECTAR', issuer: 'rh5jzTCdMRCVjQ7LT6zucjezC47KATkuEw' },
        description: 'xSPECTAR Metaverse Token (MAINNET)',
        liquidity: 'low',
        network: 'mainnet',
    },
    {
        key: 'RLUSD/USDT',
        base: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
        quote: { currency: 'USDT', issuer: 'rPTr8H5QG74Q63yDq47t4T55jD1g7m7g6' },
        description: 'Stable-to-Stable Arbitrage (MAINNET)',
        liquidity: 'medium',
        network: 'mainnet',
    },
];

// Combine all pairs - testnet first for visibility when on testnet
export const tradingPairs: TradingPairOption[] = [...testnetPairs, ...mainnetPairs];

export const findTradingPair = (key: string): TradingPairOption | undefined => tradingPairs.find((p) => p.key === key);

export type BotTradingPair = {
    baseCurrency: string;
    baseIssuer?: string;
    quoteCurrency: string;
    quoteIssuer?: string;
    issuer?: string; // legacy fallback
    description?: string;
};

export const toBotTradingPair = (option: TradingPairOption): BotTradingPair => ({
    baseCurrency: option.base.currency,
    quoteCurrency: option.quote.currency,
    baseIssuer: option.base.issuer,
    quoteIssuer: option.quote.issuer,
    issuer: option.quote.issuer || option.base.issuer,
    description: option.description,
});
