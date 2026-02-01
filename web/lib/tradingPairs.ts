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
        key: 'XRP/RLUSD',
        base: { currency: 'XRP' },
        // Using a common testnet gateway - you may need to adjust this issuer
        quote: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
        description: 'Testnet',
        liquidity: 'low',
        network: 'testnet',
    },
    {
        key: "XRP/BTC",
        base: { "currency": "XRP" },
        quote: { "currency": "BTC", "issuer": "rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL" },
        description: "Testnet",
        liquidity: 'high',
        network: 'testnet',
    }
];

// MAINNET pairs - real issuers with actual liquidity
const mainnetPairs: TradingPairOption[] = [
    {
        key: 'XRP/RLUSD',
        base: { currency: 'XRP' },
        quote: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
        description: 'Native Ripple USD',
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: 'XRP/USDT',
        base: { currency: 'XRP' },
        quote: { currency: 'USDT', issuer: 'rPTr8H5QG74Q63yDq47t4T55jD1g7m7g6' },
        description: 'Tether',
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: 'XRP/USDC',
        base: { currency: 'XRP' },
        quote: { currency: 'USDC', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' },
        description: 'USDC',
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: "XRP/EUR",
        base: { "currency": "XRP" },
        quote: { "currency": "EUR", issuer: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq" },
        description: "GateHub EUR",
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: "XRP/BTC",
        base: { "currency": "XRP" },
        quote: { "currency": "BTC", "issuer": "rchGBxcD1A1C2tdxF6papQYZ8kjRKMYcL" },
        description: "GateHub BTC",
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: "XRP/ETH",
        base: { "currency": "XRP" },
        quote: { "currency": "ETH", "issuer": "rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h" },
        description: "GateHub ETH",
        liquidity: 'high',
        network: 'mainnet',
    },
    {
        key: 'RLUSD/USDT',
        base: { currency: 'RLUSD', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' },
        quote: { currency: 'USDT', issuer: 'rPTr8H5QG74Q63yDq47t4T55jD1g7m7g6' },
        description: 'STABLECOIN',
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
