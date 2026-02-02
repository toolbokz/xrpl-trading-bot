# Balance Display Fix - Summary

## Problem
Balances were not showing in the UI because the `/api/bot/wallet` endpoint was rejecting all requests with:
```
"error": "Proxied requests not allowed"
"reason": "Request contains x-forwarded-for header indicating proxy"
```

## Root Cause
The Next.js development server automatically adds `x-forwarded-for` headers to all API requests. The `withLocalApi` middleware was treating these headers as evidence of a proxy/remote connection and blocking the requests, even though they were genuinely coming from localhost.

## Solution
Modified `/web/lib/localApi/withLocalApi.ts` to check for `BOT_API_DEV_MODE=true` environment variable and skip proxy header validation in development mode:

```typescript
export function isLocalRequest(req: NextApiRequest): { allowed: true } | { allowed: false; error: string; reason: string } {
    // In dev mode, skip proxy header checks (Next.js dev server adds x-forwarded-for)
    const isDevMode = process.env.BOT_API_DEV_MODE === 'true';
    
    // Check for proxy headers (reject proxied requests in production)
    if (!isDevMode) {
        const proxyCheck = isProxiedRequest(req);
        if (proxyCheck.proxied) {
            return {
                allowed: false,
                error: 'Proxied requests not allowed',
                reason: `Request contains ${proxyCheck.header} header indicating proxy`,
            };
        }
    }
    
    // ... rest of validation
}
```

## Testing
After the fix, the wallet API now returns:
```json
{
  "address": "rf4xMipRD7e3k2oE2hwotWjBRMwwxPDusa",
  "balance": 0,
  "nzdRate": 0.85,
  "network": "TESTNET",
  "tradingPair": {
    "base": "XRP",
    "quote": "RLUSD"
  },
  "baseBalance": 0,
  "quoteBalance": 0,
  "quoteCurrency": "RLUSD"
}
```

## Additional Notes
- The balance shows 0 because the wallet address `rf4xMipRD7e3k2oE2hwotWjBRMwwxPDusa` is a testnet address that hasn't been funded
- The `.env` file has `XRPL_NETWORK=mainnet` but the wallet secret numbers generate a testnet address
- To get balances showing:
  1. **For testnet**: Change `XRPL_NETWORK=testnet` and `XRPL_WSS_URL=wss://s.altnet.rippletest.net:51233`, then fund the wallet with `npm run faucet`
  2. **For mainnet**: Use a mainnet wallet seed/secret numbers instead

## Security Impact
✅ **Safe for development**: The fix only applies when `BOT_API_DEV_MODE=true`, which should never be set in production
✅ **Production unchanged**: Production deployments with `BOT_API_DEV_MODE=false` (or unset) still block proxied requests
✅ **IP validation still active**: Even in dev mode, requests from non-localhost IPs are still blocked
