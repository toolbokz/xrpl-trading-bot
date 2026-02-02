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

## 7) Troubleshooting (in kid words)
- "Invalid parameters" → Something in the message was wrong. Check that XRP has no issuer and issued coins have a real issuer r-address.
- "Issued currency requires a valid classic issuer address" → You forgot the sticker or wrote it wrong. Set `TRADE_ISSUER` to a real r-address.
- If stuck, flip back to paper mode (`PAPER_TRADING=true`) and testnet while you fix things.

## 8) Operations Guide

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

## 9) Environment Variables Reference

### Core Settings
| Variable | Description | Default |
|----------|-------------|---------|
| `XRPL_WSS_URL` | XRPL WebSocket endpoint | `wss://s1.ripple.com` |
| `XRPL_NETWORK` | Network (mainnet/testnet/devnet) | `mainnet` |
| `XRPL_SEED` | Wallet seed (keep secret!) | - |
| `PAPER_TRADING` | Enable paper trading mode | `true` |

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
