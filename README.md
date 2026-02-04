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
> ### Feedback Engine (`src/analytics/feedbackEngine.ts`)
> Production analytics system that records every trade with market context and computes profitability metrics.
> 
> **Data Storage:**
> - SQLite database at `data/feedback.sqlite`
> - WAL mode for reliability
> - Automatic 30-day data pruning
> 
> **Recorded Data:**
> | Table | Contents |
> |-------|----------|
> | `trade_events` | Every trade action (fills, cancels, errors) with strategy, prices, slippage |
> | `market_snapshots` | Order book state + FlowMetrics at time of each trade |
> 
> **Computed Analytics:**
> | Metric | Description |
> |--------|-------------|
> | **Win Rate** | Percentage of profitable trades |
> | **Profit Factor** | Gross profit / Gross loss |
> | **Expectancy** | Expected value per trade |
> | **Avg Slippage (bps)** | Fill price vs mid price deviation |
> | **Max Drawdown** | Largest equity decline from peak |
> | **Edge (bps)** | Fill price vs intent price improvement |
> 
> **Regime Matrix:**
> Performance breakdown by market regime (bullish/bearish/neutral) to identify which conditions are most profitable.
> 
> **Per-Strategy Stats:**
> Separate analytics for each strategy (scalper, AMM arb, path arb) to compare effectiveness.
> 
> **API Endpoint:**
> ```
> GET /api/analytics/summary?hours=24&strategy=scalper
> ```
> 
> **Configuration:**
> ```env
> FEEDBACK_DB_PATH=data/feedback.sqlite  # Database location
> FEEDBACK_RETENTION_DAYS=30             # Days to keep data
> FEEDBACK_DB_VERBOSE=false              # SQL logging
> ```
> 
> ### Adaptive Learning (`src/analytics/adaptiveLearner.ts`)
> Automated parameter tuning system that learns from historical trade performance to optimize strategy behavior over time.
> 
> **How It Works:**
> 1. Analyzes trade outcomes from Feedback Engine (last 24 hours by default)
> 2. Computes performance scores per strategy, pair, and market regime
> 3. Generates bounded parameter adjustments with exponential smoothing
> 4. Applies tunings in real-time without changing core strategy logic
> 
> **Performance Scoring:**
> ```
> score = avgNetEdgeBps - 0.5×slippage - 0.25×spread - 20×partialFillRate
> ```
> 
> **Tunable Parameters:**
> | Parameter | Range | Description |
> |-----------|-------|-------------|
> | `sizeMultiplier` | 0 – 1.5 | Scale position size up/down |
> | `maxSlippageBps` | 10 – 150 | Allowed slippage tolerance |
> | `minEdgeBpsToTrade` | 0 – 30 | Minimum edge required to enter |
> | `coolDownMs` | 0 – 60000 | Pause between trades |
> | `disabledRegimes` | array | Regimes to skip entirely |
> 
> **Heuristics:**
> | Condition | Action |
> |-----------|--------|
> | Negative edge | Reduce size, increase min edge, add cooldown |
> | High partial fills (>30%) | Reduce position size |
> | Strong performance | Increase size multiplier (reward) |
> | Chaotic/illiquid + negative score | Disable regime entirely |
> 
> **Smoothing & Guardrails:**
> - Exponential smoothing (alpha=0.2) prevents sudden swings
> - Max step constraints: size ±0.1, slippage ±10 bps per update
> - All parameters clamped to safe bounds
> - Changes are explainable with human-readable reasons
> 
> **Data Storage:**
> - JSON state at `data/adaptive-state.json`
> - Atomic writes (temp file + rename)
> - Survives restarts
> 
> **API Endpoints:**
> | Endpoint | Method | Description |
> |----------|--------|-------------|
> | `/api/analytics/adaptive/state` | GET | Current tunings and metadata |
> | `/api/analytics/adaptive/recompute` | POST | Trigger immediate update |
> | `/api/analytics/adaptive/toggle` | POST | Enable/disable learning |
> | `/api/analytics/adaptive/explain` | GET | Tuning + performance metrics |
> 
> **Dashboard Panel:**
> The Adaptive Learning panel displays:
> - ON/OFF toggle with status indicator
> - Current market regime
> - Active tuning values (size multiplier, slippage, min edge, cooldown)
> - Reason for current tuning
> - Manual "Recompute" button
> 
> **Configuration (`.env`):**
> ```env
> ADAPTIVE_LEARNING_ENABLED=true    # Master toggle
> ADAPTIVE_LOOKBACK_HOURS=24        # Data window for scoring
> ADAPTIVE_MIN_SAMPLES=25           # Min trades before tuning
> ADAPTIVE_UPDATE_INTERVAL_MIN=15   # Scheduler interval
> ADAPTIVE_ALPHA=0.2                # Smoothing factor (0=slow, 1=fast)
> ADAPTIVE_MAX_SIZE_STEP=0.1        # Max size change per update
> ADAPTIVE_MAX_SLIPPAGE_STEP=10     # Max slippage bps change
> ```
> 
> ### Flow Metrics (`src/market/flowMetrics.ts`)
> Real-time market sentiment analysis using trade flow and order book signals.
> 
> **Data Sources:**
> - **Trade Tape**: Recent executed trades from XRPL transaction stream
> - **Order Book**: Live bid/ask depth from `OrderBookTracker`
> 
> **Computed Metrics:**
> | Metric | Description |
> |--------|-------------|
> | **Trade Flow Imbalance** | Buy vs sell volume ratio (-1 to +1) |
> | **Depth Imbalance** | Bid vs ask liquidity bias (-1 to +1) |
> | **Combined Signal** | Weighted average of flow + depth |
> | **Signal Strength** | Confidence level (0 to 1) |
> | **VWAP** | Volume-weighted average price |
> | **VWAP Deviation** | Current price vs VWAP (basis points) |
> | **Spread (bps)** | Best bid-ask spread |
> 
> **Market Regimes:**
> | Regime | Description | Strategy Impact |
> |--------|-------------|-----------------|
> | **Quiet** | Low volume, tight spreads | Safe for market making |
> | **Normal** | Balanced flow, healthy depth | All strategies active |
> | **Trending Up** | Strong buy pressure | Reduce short exposure |
> | **Trending Down** | Strong sell pressure | Reduce long exposure |
> | **Chaotic** | High volatility, erratic flow | Pause trading |
> | **Illiquid** | Thin order book, wide spreads | Avoid all trades |
> 
> **Strategy Integration:**
> - **Scalper**: Skews quotes toward favorable flow, reduces size in adverse regimes
> - **AMM Arb**: Pauses during chaotic/illiquid conditions
> - **Path Arb**: Reduces position size when regime is unfavorable
> 
> **Dashboard Panel:**
> The Flow Metrics sidebar displays:
> - Current regime badge with color coding
> - Trade flow imbalance gauge (buy/sell pressure)
> - Depth bias indicator
> - Signal strength meter
> - Best bid/ask with spread
> - VWAP and deviation from mid price
> 
> **Configuration (`.env`):**
> ```env
> FLOW_DEPTH_LEVELS=5          # Order book levels to analyze
> FLOW_TRADE_WINDOW_MS=30000   # Trade lookback window
> FLOW_MIN_TRADES=3            # Min trades for valid signal
> FLOW_IMBALANCE_WEIGHT=0.6    # Weight for trade flow vs depth
> FLOW_QUIET_THRESHOLD=0.15    # Below this = quiet regime
> FLOW_TREND_THRESHOLD=0.4     # Above this = trending
> FLOW_CHAOTIC_THRESHOLD=0.7   # Above this = chaotic
> FLOW_MIN_DEPTH_BASE=10       # Min depth for liquid market
> ```
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
> | **Flow Metrics** | Real-time market sentiment & regime |
> | **Analytics Panel** | Win rate, profit factor, expectancy, regime matrix |
> | **Adaptive Learning** | Auto-tuning status, current parameters, recompute |
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
> 
> ## Flow Metrics
> | Variable | Description | Default |
> |----------|-------------|---------|
> | `FLOW_DEPTH_LEVELS` | Order book levels to analyze | `5` |
> | `FLOW_TRADE_WINDOW_MS` | Trade lookback window (ms) | `30000` |
> | `FLOW_MIN_TRADES` | Min trades for valid signal | `3` |
> | `FLOW_IMBALANCE_WEIGHT` | Trade flow vs depth weight | `0.6` |
> | `FLOW_QUIET_THRESHOLD` | Threshold for quiet regime | `0.15` |
> | `FLOW_TREND_THRESHOLD` | Threshold for trending regime | `0.4` |
> | `FLOW_CHAOTIC_THRESHOLD` | Threshold for chaotic regime | `0.7` |
> | `FLOW_MIN_DEPTH_BASE` | Min depth for liquid market | `10` |
> 
> ## Feedback Engine (Analytics)
> | Variable | Description | Default |
> |----------|-------------|---------|
> | `FEEDBACK_DB_PATH` | SQLite database path | `data/feedback.sqlite` |
> | `FEEDBACK_RETENTION_DAYS` | Days to retain analytics data | `30` |
> | `FEEDBACK_DB_VERBOSE` | Enable SQL query logging | `false` |
> 
> ## Adaptive Learning
> | Variable | Description | Default |
> |----------|-------------|---------|
> | `ADAPTIVE_LEARNING_ENABLED` | Enable adaptive parameter tuning | `true` |
> | `ADAPTIVE_LOOKBACK_HOURS` | Hours of data to analyze | `24` |
> | `ADAPTIVE_MIN_SAMPLES` | Minimum trades before tuning | `25` |
> | `ADAPTIVE_UPDATE_INTERVAL_MIN` | Minutes between updates | `15` |
> | `ADAPTIVE_ALPHA` | Smoothing factor (0=slow, 1=fast) | `0.2` |
> | `ADAPTIVE_MAX_SIZE_STEP` | Max size multiplier change per update | `0.1` |
> | `ADAPTIVE_MAX_SLIPPAGE_STEP` | Max slippage bps change per update | `10` |