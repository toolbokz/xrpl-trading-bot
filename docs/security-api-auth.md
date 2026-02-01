# Bot API Security Architecture

## Overview

The bot API uses HMAC-SHA256 authentication with RBAC (Role-Based Access Control) for all endpoints. This document covers:

1. Authentication flow
2. Client-side signing
3. Permission model
4. Environment configuration
5. Path arbitrage safety controls

---

## 1. Authentication Flow

All requests to `/api/bot/*` must include these headers:

| Header | Description |
|--------|-------------|
| `X-API-KEY` | API key identifier (from `BOT_API_KEYS` env) |
| `X-SIGNATURE` | HMAC-SHA256 signature (hex-encoded) |
| `X-TIMESTAMP` | Unix timestamp in milliseconds |
| `X-NONCE` | Unique nonce per request (UUID or random) |

### Signature Computation

The signature is computed over a canonical string:

```
canonical = timestamp + "\n" + nonce + "\n" + method + "\n" + path + "\n" + body
signature = HMAC-SHA256(canonical, apiSecret)
```

Where:
- `timestamp`: Value of `X-TIMESTAMP` header
- `nonce`: Value of `X-NONCE` header  
- `method`: HTTP method (uppercase)
- `path`: Request path including query string (e.g., `/api/bot/status`)
- `body`: Raw request body (empty string for GET)

### Example (TypeScript/Node.js)

```typescript
import crypto from 'crypto';

interface SignedRequestParams {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: object;
    apiKey: string;
    apiSecret: string;
}

function signRequest(params: SignedRequestParams): Record<string, string> {
    const { method, path, body, apiKey, apiSecret } = params;
    
    const timestamp = Date.now().toString();
    const nonce = crypto.randomUUID();
    const bodyStr = body ? JSON.stringify(body) : '';
    
    // Build canonical string
    const canonical = [timestamp, nonce, method, path, bodyStr].join('\n');
    
    // Compute HMAC-SHA256
    const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(canonical, 'utf8')
        .digest('hex');
    
    return {
        'X-API-KEY': apiKey,
        'X-SIGNATURE': signature,
        'X-TIMESTAMP': timestamp,
        'X-NONCE': nonce,
        'Content-Type': 'application/json',
    };
}

// Usage
const headers = signRequest({
    method: 'POST',
    path: '/api/bot/run',
    body: {},
    apiKey: 'my-api-key',
    apiSecret: 'my-secret-key',
});

await fetch('https://your-domain.com/api/bot/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
});
```

### Example (cURL)

```bash
#!/bin/bash
API_KEY="your-api-key"
API_SECRET="your-secret"
METHOD="POST"
PATH="/api/bot/run"
BODY='{}'

TIMESTAMP=$(date +%s%3N)
NONCE=$(uuidgen)
CANONICAL="${TIMESTAMP}\n${NONCE}\n${METHOD}\n${PATH}\n${BODY}"
SIGNATURE=$(echo -en "$CANONICAL" | openssl dgst -sha256 -hmac "$API_SECRET" | awk '{print $2}')

curl -X $METHOD "https://your-domain.com${PATH}" \
  -H "X-API-KEY: $API_KEY" \
  -H "X-SIGNATURE: $SIGNATURE" \
  -H "X-TIMESTAMP: $TIMESTAMP" \
  -H "X-NONCE: $NONCE" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

---

## 2. Permission Model (RBAC)

### Roles

| Role | Description |
|------|-------------|
| `admin` | Full access - can start/stop bot, cancel orders, change settings |
| `operator` | Can manage orders but not start/stop bot |
| `readonly` | Read-only access to status, wallet, trades, prices |

### Permission Map

| Endpoint | Method | Permission | Minimum Role |
|----------|--------|------------|--------------|
| `/api/bot/run` | POST | `bot:run` | admin |
| `/api/bot/pause` | POST | `bot:pause` | admin |
| `/api/bot/kill` | POST | `bot:kill` | admin |
| `/api/bot/position-size` | POST | `bot:position_size` | admin |
| `/api/bot/trading-pair` | POST | `bot:trading_pair` | admin |
| `/api/bot/orders` | GET | `bot:orders_read` | readonly |
| `/api/bot/orders` | POST | `bot:orders_manage` | operator |
| `/api/bot/orders` | DELETE | `bot:orders_cancel` | admin |
| `/api/bot/status` | GET | `bot:status_read` | readonly |
| `/api/bot/wallet` | GET | `bot:wallet_read` | readonly |
| `/api/bot/trades` | GET | `bot:trades_read` | readonly |
| `/api/bot/trades` | DELETE | `bot:orders_cancel` | admin |
| `/api/bot/price` | GET | `bot:price_read` | readonly |

---

## 3. Environment Configuration

Add these variables to your `.env` file:

```bash
# API Keys (JSON array format)
# Each key has: id, secret, role, optional label and allowedIps
BOT_API_KEYS='[{"id":"admin-key","secret":"your-64-char-hex-secret","role":"admin","label":"Admin Key"},{"id":"readonly-key","secret":"another-secret","role":"readonly"}]'

# Security Settings
BOT_AUTH_TIMESTAMP_TOLERANCE_MS=60000    # Max clock skew (default: 60s)
BOT_AUTH_NONCE_TTL_MS=300000             # Nonce expiry (default: 5min)
BOT_AUTH_RATE_LIMIT_WINDOW_MS=60000      # Rate limit window (default: 1min)
BOT_AUTH_RATE_LIMIT_MAX_REQUESTS=100     # Max requests per window

# Optional: IP Allowlist (comma-separated)
BOT_AUTH_IP_ALLOWLIST=127.0.0.1,::1

# Optional: Redis for distributed nonce/rate limiting
BOT_AUTH_REDIS_URL=redis://localhost:6379
```

### Generating a Secret

```bash
# Generate a 64-character hex secret (32 bytes)
openssl rand -hex 32
```

---

## 4. Path Arbitrage Safety Controls

The path arbitrage strategy has multiple safety layers:

### Feature Flags

```bash
# Enable path arbitrage (default: false)
PATH_ARB_ENABLED=true

# Dry-run mode: log opportunities without executing (default: true when enabled)
PATH_ARB_DRY_RUN=true
```

### Circuit Breaker

Automatically halts trading after excessive losses:

```bash
# Max cumulative loss in basis points before halting (default: 500 = 5%)
PATH_ARB_CIRCUIT_BREAKER_MAX_LOSS_BPS=500

# Time window to track losses (default: 300000ms = 5 minutes)
PATH_ARB_CIRCUIT_BREAKER_WINDOW_MS=300000

# Cooldown after circuit breaker trips (default: 600000ms = 10 minutes)
PATH_ARB_CIRCUIT_BREAKER_COOLDOWN_MS=600000
```

### Recommended Rollout

1. **Phase 1**: Set `PATH_ARB_ENABLED=true` and `PATH_ARB_DRY_RUN=true`
   - Monitor logs for opportunity detection
   - Verify circuit breaker is tracking simulated trades

2. **Phase 2**: After validating dry-run results, set `PATH_ARB_DRY_RUN=false`
   - Start with small position sizes
   - Keep circuit breaker settings conservative

3. **Phase 3**: Tune parameters based on live results
   - Adjust `pathArbMinProfitBps` threshold
   - Fine-tune circuit breaker sensitivity

---

## 5. Security Checklist

- [ ] Generate unique, strong API secrets (64 hex chars minimum)
- [ ] Use different API keys for different clients/roles
- [ ] Set appropriate `BOT_AUTH_IP_ALLOWLIST` in production
- [ ] Use Redis for nonce storage in multi-instance deployments
- [ ] Never log API secrets or include in error responses
- [ ] Rotate API keys periodically
- [ ] Monitor audit logs for unauthorized access attempts
- [ ] Keep `PATH_ARB_DRY_RUN=true` until strategy is validated

---

## 6. Error Responses

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `MISSING_HEADER` | Required auth header missing |
| 401 | `INVALID_API_KEY` | API key not found |
| 401 | `INVALID_SIGNATURE` | HMAC signature doesn't match |
| 401 | `TIMESTAMP_EXPIRED` | Timestamp outside tolerance |
| 401 | `REPLAY_DETECTED` | Nonce already used |
| 403 | `IP_BLOCKED` | Client IP not in allowlist |
| 403 | `PERMISSION_DENIED` | Role lacks required permission |
| 405 | `METHOD_NOT_ALLOWED` | HTTP method not supported |
| 429 | `RATE_LIMITED` | Too many requests |
