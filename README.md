# XRPL Trading Bot
> 
> A localhost-only automated trading bot for the XRP Ledger decentralized exchange.
> 
> ---
> 
> # Part 1: How the Code Works
> 
> ## Project Structure
> 
> ```
> xrpl-trading-bot/
> ├── src/                    # Backend trading engine
> │   ├── index.ts            # CLI entry point
> │   ├── config/             # Environment config loading
> │   ├── runtime/            # TradingRuntime orchestrator
> │   ├── xrpl/               # XRPL client, wallet, currency utils
> │   ├── market/             # OrderBookTracker, AMM service
> │   ├── strategies/         # Scalper, AMM arb, Path arb
> │   ├── execution/          # OfferExecutor, offer building
> │   ├── risk/               # RiskEngine guardrails
> │   ├── analytics/          # PnL tracking, trade history
> │   ├── persistence/        # Circuit breaker state storage
> │   └── security/           # Localhost-only enforcement
> ├── web/                    # Next.js dashboard
> │   ├── app/                # React pages
> │   ├── components/         # UI components (charts, etc.)
> │   ├── pages/api/          # API routes
> │   └── lib/                # Shared utilities
> └── scripts/                # Helper scripts (faucet, wallet creation)
> ```
> 
> ## Core Components
> 
> ### TradingRuntime (`src/runtime/tradingRuntime.ts`)
> The main orchestrator that:
> - Connects to XRPL WebSocket
> - Initializes wallet and validates network
> - Registers strategies
> - Runs the tick loop (every 4 seconds)
> - Handles graceful shutdown
> 
> ### OrderBookTracker (`src/market/orderBookTracker.ts`)
> - Maintains live order book state (bids/asks)
> - Normalizes XRP drops vs issued currency amounts
> - Calculates spread in basis points
> - Detects stale data
> 
> ### RiskEngine (`src/risk/riskEngine.ts`)
> - Validates trade intents before execution
> - Tracks daily losses (resets at UTC midnight)
> - Monitors consecutive failures
> - Checks reserve requirements
> - Manages issuer blacklist
> 
> ### OfferExecutor (`src/execution/offerExecutor.ts`)
> - Builds XRPL `OfferCreate` transactions
> - Handles paper vs live mode
> - Detects partial fills
> - Calculates slippage
> - Records trade history
> 
> ### Strategies (`src/strategies/`)
> Each strategy implements the `Strategy` interface:
> ```typescript
> interface Strategy {
>   name: string;
>   tick(ctx: StrategyContext): Promise<void>;
> }
> ```
> 
> **Available strategies:**
> 1. **ScalperStrategy** - Spread-based market making
> 2. **AMMArbitrageStrategy** - Order book vs AMM arbitrage
> 3. **PathArbitrageStrategy** - Multi-hop payment path discovery
> 
> ## Data Flow
> 
> ```
> XRPL WebSocket
fety Features

>       │
>       ▼
> OrderBookTracker ──► tick() ──► Strategy.tick()
 match>       │                              │
>       │                              ▼
>       │                        RiskEngine.approveIntent()
>       │                              │
>       │                              ▼
>       │                        OfferExecutor.placeOffer()
>       │                              │
>       │                              ▼
>       └──────────────────────► XRPL (if live mode)
> ```
> 
> ## Trade Execution Pipeline
> 
> 1. **Order Book Monitoring**: `OrderBookTracker` polls bids/asks every tick
> 2. **Strategy Evaluation**: Each strategy analyzes market state
> 3. **Risk Check**: `RiskEngine` validates size, loss limits, reserves
> 4. **Slippage Check**: Compare expected vs actual price
> 5. **Offer Placement**: `OfferExecutor` builds and submits transaction
> 6. **Fill Detection**: Parse transaction metadata for partial fills
> 7. **P&L Recording**: Update trade history and stats
> 
> ## P&L Tracking
> 
 Network
XRPL_NETWORK=mainnet
XRPL_WSS_URL=wss://xrplcluster.com

# Wallet (NEVER share this!)
XRPL_SEED=sYourMainnetSeedHer> | Metric | Description | Storage |
> |--------|-------------|---------|
> | **Total P&L** | Cumulative profit/loss | `trade_history.json` |
> | **Today's P&L** | Current UTC day | Resets at midnight |
> | **Trade P&L** | Per-trade result | `(exit - entry) × qty - fees` |
> 
> ## Position States
> 
> | State | Meaning |
> |-------|---------|
> | **Flat** | No open position |
> | **Long** | Holding base currency |
> | **Short** | Sold base currency |
> 
> ## Win Rate
> 
> ```
> Win Rate = (Winning Trades / Total Trades) × 100%
> ```
> - **Win**: P&L > 0
> - **Loss**: P&L ≤ 0
> 
> ## Risk Guardrails
> 
> | Guardrail | Trigger |
> |-----------|---------|
> | Daily Loss Limit | `dailyLoss >= MAX_DAILY_LOSS_XRP` |
> | Kill Switch | `consecutiveFailures >= 5` |
> | Reserve Floor | `availableXRP < RESERVE_FLOOR_XRP` |
> | Issuer Blacklist | Untrusted issuer detected |
> | Max Trade Size | `tradeSize > MAX_TRADE_SIZE` |
> | Slippage Protection | `slippageBps > maxSlippageBps` |
> | Circuit Breaker | Path arb losing streak |
> 
 > ## Graceful Shutdown
> 
> On `SIGTERM`/`SIGINT`:
> 1. Stop tick processing
> 2. Cancel open offers
> 3. Stop strategies (LIFO order)
> 4. Close persistence stores
> 5. Disconnect XRPL WebSocket
> 6. Exit cleanly
> 
> ---
> 
> # Part 2: How to Run on Testnet (Safe Mode)
> 
> ## Prerequisites
> 
> - Node.js 20+
> - npm
AWS, Heroku, etc.)
-> 
> ## Quick Start
> 
> ```bash
> # Clone and install
> git clone https://github.com/yourname/xrpl-trading-bot.git
> cd xrpl-trading-bot
> npm install
> 
 > # Create .env file
> cp .env.example .env
> ```
> 
> ## Testnet Configuration
> 
> Edit `.env`:
> ```env
> # Network
> XRPL_NETWORK=testnet
> XRPL_WSS_URL=wss://s.altnet.rippletest.net:51233
> 
> # Wallet (testnet only!)
> XRPL_SEED_TESTNET=sYourTestnetSeedHere
> 
-> # Trading pair
> TRADE_BASE_CURRENCY=XRP
> TRADE_QUOTE_CURRENCY=RLUSD
> TRADE_ISSUER=rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De
> 
> # Safety
> PAPER_TRADING=true
> ENABLE_TESTNET_FAUCET=true
> BOT_LOCAL_ONLY=true
> ```
> 
> **Testnet WebSocket endpoints:**
> - `wss://s.altnet.rippletest.net:51233` (primary)
> - `wss://testnet.xrpl-labs.com` (alternative)
> 
> ## Create a Testnet Wallet
> 
> ```bash
> npm run faucet
> ```
> 
> This generates a new testnet wallet and funds it with test XRP.
> 
> ## Fund with Test RLUSD
> 
> ```bash
> npm run fund:rlusd:testnet
> ```
> 
> This creates a trustline and requests RLUSD from the testnet faucet.
> 
> ## Run the Bot
> 
> ```bash
> npm run dev
> ```
> 
> - Dashboard opens at http://localhost:3000
> - Backend connects to XRPL testnet
> - **Paper mode by default** — no real trades
> 
> ## Dashboard Features
> 
> | Section | Description |
> |---------|-------------|
> | **Balance Banner** | XRP and quote currency balances |
> | **Price Chart** | Live candlestick chart |
> | **Stats Cards** | P&L, win rate, position state |
> | **Bot Control** | Start/stop, pair selection |
> | **Active Orders** | Open orders on the DEX |
> | **Recent Trades** | Trade history with P&L |
> | **Risk Dashboard** | Exposure, loss limits, kill switch |
> 
> ## Paper Trading (Simulation)
> 
> With `PAPER_TRADING=true`:
> - Trades are **simulated locally**
> - No transactions sent to XRPL
> - P&L and stats still tracked
> - Perfect for testing strategies
> 
> ## Testnet Safety Features
> 
> 1. **Network mismatch protection**: Bot refuses to start if wallet doesn't match network
> 2. **Faucet enabled**: Can request free test tokens
> 3. **Paper mode default**: Must explicitly enable live trading
> 4. **Localhost only**: Cannot run on cloud platforms
> 
> ## Troubleshooting
> 
> | Error | Solution |
> |-------|----------|
> | "Wallet network mismatch" | Use a testnet wallet, not mainnet |
> | "Invalid issuer address" | Check `TRADE_ISSUER` is valid r-address |
> | "Order book stale" | XRPL connection issue, check WebSocket URL |
> | "Reserve floor" | Get more test XRP from faucet |
> 
> ---
> 
> # Part 3: How to Run on Mainnet (Real Money!)
> 
> ## ⚠️ WARNING: Real Funds at Risk
> 
> Mainnet trading uses **real XRP and tokens**. You can lose money. Make sure you:
> - Fully understand the code and strategies
> - Have tested extensively on testnet
> - Set conservative risk limits
> - Start with small position sizes
> 
5> ## Mainnet Configuration
> 
> Edit `.env`:
> ```env
> # Network
> XRPL_NETWORK=mainnet
> XRPL_WSS_URL=wss://xrplcluster.com
> 
> # Wallet (NEVER share this!)
> XRPL_SEED=sYourMainnetSeedHere
> 
> # Trading pair (use mainnet issuers!)
> TRADE_BASE_CURRENCY=XRP
> TRADE_QUOTE_CURRENCY=USD
> TRADE_ISSUER=rMainnetIssuerAddressHere
> 
> # Safety - START WITH PAPER MODE
> PAPER_TRADING=true
> ENABLE_TESTNET_FAUCET=false
> BOT_LOCAL_ONLY=true
> 
> # Risk controls - BE CONSERVATIVE
> MAX_DAILY_LOSS_XRP=50
> MAX_TRADE_SIZE=100
> RESERVE_FLOOR_XRP=50
> POSITION_SIZE_XRP=10
> ```
> 
> **Mainnet WebSocket endpoints:**
> - `wss://xrplcluster.com` (recommended, load-balanced)
> - `wss://s1.ripple.com` (Ripple-operated)
> - `wss://s2.ripple.com` (Ripple-operated, backup)
> 
> ## Switching from Testnet to Mainnet
> 
> ### Checklist
> 
> - [ ] Set `XRPL_NETWORK=mainnet`
> - [ ] Update `XRPL_WSS_URL` to mainnet endpoint
> - [ ] Use a **mainnet wallet** (different seed!)
> - [ ] Set `ENABLE_TESTNET_FAUCET=false`
> - [ ] Update `TRADE_ISSUER` to mainnet issuer
> - [ ] Review and lower risk limits
> - [ ] Keep `PAPER_TRADING=true` initially
> - [ ] Test with paper mode first
> - [ ] Only set `PAPER_TRADING=false` when ready
> 
> ### Going Live
> 
> Once you've validated config in paper mode:
> 
> ```env
> # Enable live trading (DANGEROUS!)
> PAPER_TRADING=false
> ```
> 
> ## Mainnet Safety Features
> 
> ### Localhost-Only Execution
> 
> The bot is **locked to localhost** by default:
> - Blocked on all cloud platforms (Vercel, AWS, Heroku, etc.)
> - API only accepts requests from 127.0.0.1
> - Dashboard binds to localhost only
> 
> ### Blocked Platforms
> 
> The bot detects and refuses to run on:
> - Vercel, AWS Lambda, Google Cloud
> - Azure Functions, Heroku, Railway
> - Render, Fly.io, DigitalOcean
> - Netlify, Kubernetes
> 
> ### Risk Controls
> 
> | Control | Description | Recommended Mainnet Value |
> |---------|-------------|---------------------------|
> | `MAX_DAILY_LOSS_XRP` | Stop trading after this loss | 50-100 XRP |
> | `MAX_TRADE_SIZE` | Maximum single order | 100 XRP |
> | `RESERVE_FLOOR_XRP` | Minimum balance to keep | 50+ XRP |
> | `POSITION_SIZE_XRP` | Trade size | 10-50 XRP |
> 
> ### Kill Switch
> 
> The bot automatically shuts down if:
> - Daily loss limit reached
> - 5+ consecutive failed trades
> - Balance falls below reserve floor
> 
> ## Running in Production
> 
> ```bash
> # Build for production
> npm run build
> 
> # Start (localhost only)
> npm start
> ```
> 
> ## Monitoring
> 
> ### Health Check
> ```bash
> curl http://localhost:3000/api/health
> ```
> 
> ### Logs
> Watch the terminal for:
> - Trade executions
> - Risk warnings
> - Error messages
> 
> ### Trade History
> - Dashboard shows recent trades
> - `trade_history.json` persists data
> - CSV export available
> 
> ## Emergency Procedures
> 
> ### Stop the Bot
> ```bash
> # Graceful shutdown
> Ctrl+C
> 
> # Or send SIGTERM
> kill -TERM <pid>
> ```
> 
> ### Cancel All Orders
> The bot attempts to cancel open offers on shutdown. If needed manually:
> 1. Stop the bot
> 2. Use XRPL explorer or wallet to cancel remaining offers
> 
> ### Recover from Errors
> 1. Check logs for error messages
> 2. Verify wallet has sufficient balance
> 3. Check XRPL network status
> 4. Review risk settings
> 5. Restart in paper mode to diagnose
> 
> ---
> 
> # Environment Variables Reference
> 
> ## Core Settings
> | Variable | Description | Default |
> |----------|-------------|---------|
> | `XRPL_WSS_URL` | XRPL WebSocket endpoint | `wss://s1.ripple.com` |
> | `XRPL_NETWORK` | Network (mainnet/testnet) | `mainnet` |
> | `XRPL_SEED` | Wallet seed (secret!) | - |
> | `PAPER_TRADING` | Simulate trades | `true` |
> 
> ## Security
> | Variable | Description | Default |
> |----------|-------------|---------|
> | `BOT_LOCAL_ONLY` | Localhost-only execution | `true` |
> | `BOT_ALLOW_REMOTE` | Override localhost (dangerous!) | `false` |
> | `BOT_API_DEV_MODE` | Skip auth in dev | `false` |
> 
> ## Trading
> | Variable | Description | Default |
> |----------|-------------|---------|
> | `TRADE_BASE_CURRENCY` | Base currency | `XRP` |
> | `TRADE_QUOTE_CURRENCY` | Quote currency | `NZD` |
> | `TRADE_ISSUER` | Issuer for non-XRP | - |
> | `POSITION_SIZE_XRP` | Trade size | `5` |
> 
> ## Risk Controls
> | Variable | Description | Default |
> |----------|-------------|---------|
> | `MAX_DAILY_LOSS_XRP` | Daily loss limit | `500` |
> | `MAX_TRADE_SIZE` | Max order size | `1000` |
> | `RESERVE_FLOOR_XRP` | Min balance | `25` |
> 
> ## Strategies
> | Variable | Description | Default |
> |----------|-------------|---------|
> | `PATH_ARB_ENABLED` | Enable path arbitrage | `false` |
> | `PATH_ARB_DRY_RUN` | Log only, don't execute | `true` |
> | `MIN_SPREAD_BPS` | Min spread for scalper | `10` |
> | `AMM_ARB_MIN_PROFIT_BPS` | Min AMM arb profit | `20` |
> 
> ## Persistence
> | Variable | Description | Default |
> |----------|-------------|---------|
> | `REDIS_URL` | Redis for circuit breaker | - |
> | `PATH_ARB_BREAKER_STORE` | Breaker storage (redis/file/auto) | `auto` |