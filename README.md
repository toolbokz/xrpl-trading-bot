# XRPL Trading Bot — Explained Like a Playground Game

## 1) Introduction
- Think of XRP as the playground’s main marble. It needs no sticker (no issuer).
- Issued coins (like NZD) are marbles with a sticker showing who printed them (the issuer’s r-address). The bot trades these marbles for you.
- The bot watches the playground trades (order books), then can buy or sell marbles automatically. You can keep it in pretend mode (paper) or let it trade for real.

## 2) What you need
- Node.js 20+ and npm (the tools to run the bot).
- A `.env` file: a secret note that holds your keys and settings. Never show it to anyone.

## 3) Setup (step by step)
1. Clone the bot:
   ```bash
   git clone https://github.com/yourname/xrpl-trading-bot.git
   cd xrpl-trading-bot
   ```
2. Install everything (one time, at the root):
   ```bash
   npm install
   ```
3. Make your secret `.env` file (copy from example if you have one) and fill it:
   ```env
   XRPL_WSS_URL=wss://s.altnet.rippletest.net:51233   # testnet server
   XRPL_NETWORK=testnet                              # use "mainnet" for real XRP world
   XRPL_SEED=put_your_secret_seed_here               # never share this
   TRADE_BASE_CURRENCY=XRP
   TRADE_QUOTE_CURRENCY=NZD
   TRADE_ISSUER=rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe    # issuer for NZD on testnet
   PAPER_TRADING=true                                # "pretend" mode (no real trades)
   ```
   - For **mainnet**, change `XRPL_NETWORK=mainnet`, pick a mainnet WebSocket URL, and set a real issuer for your issued coin.

## 4) How to run the bot
- Start both bot (backend) and dashboard (frontend) together:
  ```bash
  npm run dev
  ```
  - Frontend opens at http://localhost:3000 (your dashboard playground).
  - Backend connects to XRPL and watches the books.
- Build everything for production:
  ```bash
  npm run build
  npm start
  ```
- Paper mode vs real:
  - `PAPER_TRADING=true` → pretend trades only; nothing is sent to XRPL.
  - `PAPER_TRADING=false` → real offers/payments are sent. Be sure you know what you’re doing.

## 5) How the bot trades (playground story)
- The bot looks at two buckets: one for what it gives (`taker_pays`) and one for what it gets (`taker_gets`).
- If it pays XRP, it uses the string "XRP". If it pays/gets a stickered marble (like NZD), it uses `{ currency: 'NZD', issuer: 'r...address' }`.
- Order book = a line of kids shouting prices. The bot listens and decides to buy or sell automatically if the deal looks good.

## 6) Tips & safety
- Never share your XRPL_SEED. It is the key to your marbles.
- Always start on **testnet**. It’s the pretend playground.
- Switch to **mainnet** only when you understand what every setting does and you’re okay trading real marbles.

## 7) Switching Between Mainnet and Testnet

### Testnet Configuration (Safe for Testing)
```env
XRPL_NETWORK=testnet
XRPL_WSS_URL=wss://s.altnet.rippletest.net:51233
PAPER_TRADING=true
ENABLE_TESTNET_FAUCET=true
```

**Testnet WebSocket endpoints:**
- `wss://s.altnet.rippletest.net:51233` (primary)
- `wss://testnet.xrpl-labs.com` (alternative)

### Mainnet Configuration (Real Money!)
```env
XRPL_NETWORK=mainnet
XRPL_WSS_URL=wss://xrplcluster.com
PAPER_TRADING=false
ENABLE_TESTNET_FAUCET=false
```

**Mainnet WebSocket endpoints:**
- `wss://xrplcluster.com` (recommended, load-balanced)
- `wss://s1.ripple.com` (Ripple-operated)
- `wss://s2.ripple.com` (Ripple-operated, backup)

### ⚠️ Critical: Network Safety Checks

The bot has built-in safety guards to prevent accidental misconfigurations:

1. **Wallet network mismatch protection**: A testnet wallet cannot be used on mainnet, and vice versa. The bot will refuse to start if there's a mismatch.

2. **Faucet safety**: `ENABLE_TESTNET_FAUCET=true` is blocked on mainnet to prevent accidents.

3. **Paper trading default**: `PAPER_TRADING` defaults to `true` — you must explicitly set it to `false` to trade real funds.

### Switching Checklist

**Testnet → Mainnet:**
- [ ] Set `XRPL_NETWORK=mainnet`
- [ ] Update `XRPL_WSS_URL` to a mainnet endpoint
- [ ] Use a **mainnet wallet** (different seed/secret numbers!)
- [ ] Set `ENABLE_TESTNET_FAUCET=false`
- [ ] Update `TRADE_ISSUER` to a mainnet issuer address
- [ ] Review `MAX_DAILY_LOSS_XRP` and `RESERVE_FLOOR_XRP` for mainnet values
- [ ] Consider keeping `PAPER_TRADING=true` initially to validate config

**Mainnet → Testnet:**
- [ ] Set `XRPL_NETWORK=testnet`
- [ ] Update `XRPL_WSS_URL` to a testnet endpoint
- [ ] Use a **testnet wallet** (you can use the faucet to fund it)
- [ ] Set `ENABLE_TESTNET_FAUCET=true` (optional, for auto-funding)
- [ ] Update `TRADE_ISSUER` to a testnet issuer address

### Creating a Testnet Wallet
```bash
npm run create-testnet-wallet
```
This generates a new testnet wallet and optionally funds it via the faucet.

## 8) 🔒 Localhost-Only Security

### Why Localhost Only?

**This trading bot is LOCKED to localhost execution by default.** This is a critical security measure:

- **Cloud platforms are dangerous for trading bots** — Your private keys could be exposed through logs, environment variable leaks, or container inspection.
- **Remote access exposes your funds** — Anyone who can reach your dashboard could control your trades.
- **No cloud deployment** — Vercel, AWS Lambda, Heroku, Railway, Render, Fly.io, and other platforms are blocked.

### Security Gates

The bot enforces localhost-only execution at **multiple layers**:

| Gate | Location | Protection |
|------|----------|------------|
| CLI startup | `src/index.ts` | Blocks `npm start` / `npm run dev:backend` on cloud |
| Runtime creation | `src/runtime/tradingRuntime.ts` | Blocks TradingRuntime instantiation on cloud |
| Dashboard startup | `web/server.js` | Custom server binds to 127.0.0.1 only |
| API authentication | `web/lib/botAuth/withBotAuth.ts` | Rejects requests from non-localhost IPs |
| Health endpoint | `web/pages/api/health.ts` | Localhost-only health checks |
| Vercel deployment | `vercel.json` | Returns 403 if somehow deployed |

### Blocked Cloud Platforms

The bot detects and blocks execution on:
- Vercel (`VERCEL`, `VERCEL_ENV`)
- AWS Lambda (`AWS_LAMBDA_FUNCTION_NAME`)
- Google Cloud Run/Functions (`GOOGLE_CLOUD_PROJECT`, `K_SERVICE`)
- Azure Functions (`WEBSITE_SITE_NAME`)
- Heroku (`DYNO`)
- Railway (`RAILWAY_PROJECT_ID`)
- Render (`RENDER`)
- Fly.io (`FLY_APP_NAME`)
- DigitalOcean App Platform (`DIGITALOCEAN_APP_NAME`)
- Netlify (`NETLIFY`)
- Kubernetes (`KUBERNETES_SERVICE_HOST`)

### Request IP Validation

All API requests are validated:
- ✅ Allowed: `127.0.0.1`, `::1`, `localhost`
- ❌ Blocked: Any external IP (192.168.x.x, 10.x.x.x, public IPs)
- ❌ Blocked: Requests with `X-Forwarded-For` header (indicates proxy/load balancer)

### Configuration

```env
# Enable localhost-only enforcement (default: true)
BOT_LOCAL_ONLY=true

# DANGEROUS: Override localhost-only restriction
# Only use if you understand the risks and need to run in Docker/custom environment
# BOT_ALLOW_REMOTE=false
```

### Running Locally

```bash
# Development mode (localhost only)
npm run dev

# Production mode with custom localhost-bound server
npm run dashboard   # Just the dashboard
npm run start       # Bot + dashboard
```

### Docker Considerations

If you need to run in Docker for local development:

```env
# In your .env file
BOT_ALLOW_REMOTE=true
```

⚠️ **Warning**: Only use `BOT_ALLOW_REMOTE=true` when you understand the risks:
- Container must not be exposed to the network
- No port forwarding to external interfaces
- No reverse proxy pointing to the container

### What Happens on Violation

**On startup (CLI/runtime):**
```
🚫 SECURITY: Remote/cloud execution blocked
This bot is locked to localhost for safety.
Set BOT_LOCAL_ONLY=true to run locally, or BOT_ALLOW_REMOTE=true (dangerous) to override.
```
Process exits with code 1.

**On API request from remote IP:**
```json
{
  "error": "Remote access disabled",
  "reason": "Request IP 192.168.1.100 is not localhost. This bot only accepts connections from 127.0.0.1 or ::1.",
  "remoteAddress": "192.168.1.100"
}
```
HTTP 403 Forbidden.

## 9) Troubleshooting (in kid words)
- "Invalid parameters" → Something in the message was wrong. Check that XRP has no issuer and issued coins have a real issuer r-address.
- "Issued currency requires a valid classic issuer address" → You forgot the sticker or wrote it wrong. Set `TRADE_ISSUER` to a real r-address.
- If stuck, flip back to paper mode (`PAPER_TRADING=true`) and testnet while you fix things.

## 10) Operations Guide

### Health Endpoint
The bot exposes a health check endpoint at `/api/health`:
```bash
curl http://localhost:3000/api/health
```
Returns:
```json
{
  "ok": true,
  "timestamp": "2026-02-02T12:00:00Z",
  "uptimeSec": 3600,
  "version": "0.1.0",
  "requestId": "req_abc123",
  "xrpl": { "connected": true, "endpoint": "wss://s.altnet.rippletest.net", "network": "testnet" },
  "bot": { "state": "RUNNING", "paperTrading": true }
}
```

### Graceful Shutdown
The bot handles `SIGTERM` and `SIGINT` signals for clean shutdown:
1. Stops accepting new ticks
2. Cancels all open offers (best-effort)
3. Disconnects XRPL WebSocket cleanly
4. Closes circuit breaker persistence store
5. Exits process with code 0

On deploy/restart, send `SIGTERM` to allow graceful cleanup.

### Circuit Breaker Persistence
Path arbitrage circuit breaker state persists across restarts:
- **With Redis**: Set `REDIS_URL=redis://localhost:6379`
- **Without Redis**: Falls back to file storage in `./data/breaker_*.json`
- **Configure**: Set `PATH_ARB_BREAKER_STORE=redis|file|auto` (default: auto)

This prevents the bot from resuming risky execution immediately after restart.

## 11) Environment Variables Reference

### Core Settings
| Variable | Description | Default |
|----------|-------------|---------|
| `XRPL_WSS_URL` | XRPL WebSocket endpoint | `wss://s1.ripple.com` |
| `XRPL_NETWORK` | Network (mainnet/testnet/devnet) | `mainnet` |
| `XRPL_SEED` | Wallet seed (keep secret!) | - |
| `PAPER_TRADING` | Enable paper trading mode | `true` |

### Security Settings
| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_LOCAL_ONLY` | Enforce localhost-only execution | `true` |
| `BOT_ALLOW_REMOTE` | Override localhost restriction (dangerous!) | `false` |
| `BOT_API_DEV_MODE` | Skip auth for localhost dev (dev only!) | `false` |

### Trading Settings
| Variable | Description | Default |
|----------|-------------|---------|
| `TRADE_BASE_CURRENCY` | Base currency (e.g., XRP) | `XRP` |
| `TRADE_QUOTE_CURRENCY` | Quote currency (e.g., USD) | `NZD` |
| `TRADE_ISSUER` | Issuer address for issued currencies | - |
| `POSITION_SIZE_XRP` | Position size in XRP | `5` |
| `ORDERBOOK_STALE_MS` | Order book staleness threshold | `5000` |

### Risk Controls
| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_DAILY_LOSS_XRP` | Maximum daily loss in XRP | `500` |
| `MAX_TRADE_SIZE` | Maximum single trade size | `1000` |
| `RESERVE_FLOOR_XRP` | Minimum available XRP after reserves | `25` |
| `RESERVE_BUFFER_BPS` | Additional buffer over reserve (basis points) | `0` |
| `RESERVE_BUFFER_XRP` | Additional fixed buffer over reserve | `0` |

### Path Arbitrage
| Variable | Description | Default |
|----------|-------------|---------|
| `PATH_ARB_ENABLED` | Enable path arbitrage strategy | `false` |
| `PATH_ARB_DRY_RUN` | Log opportunities without executing | `true` |
| `PATH_ARB_BREAKER_STORE` | Persistence backend (redis/file/auto) | `auto` |
| `PATH_ARB_CIRCUIT_BREAKER_MAX_LOSS_BPS` | Loss threshold to trip breaker | `500` |

### API Authentication
| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_API_KEYS` | JSON array of API keys with roles | - |
| `BOT_API_TTL_SECONDS` | Request timestamp validity window | `60` |
| `BOT_API_RATE_LIMIT_READ_PER_MIN` | Rate limit for GET requests | `60` |
| `BOT_API_RATE_LIMIT_WRITE_PER_MIN` | Rate limit for POST/PUT/DELETE | `20` |
| `BOT_API_ALLOWED_ORIGINS` | CORS allowlist (comma-separated) | - |
| `BOT_API_ALLOWED_IPS` | IP allowlist (comma-separated) | - |

### Audit Logging
| Variable | Description | Default |
|----------|-------------|---------|
| `AUDIT_LOG_SINK` | Audit log destination (stdout/file/none) | `stdout` (dev), `file` (prod) |
| `AUDIT_LOG_MIN_LEVEL` | Minimum level to log (all/denied/error) | `all` |

### Persistence
| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection URL (optional) | - |

# xrpl-trading-bot
