# Small-Balance Survival Playbook (≤ 30 XRP)

This bot enforces a reserve floor and risk gates that are **aggressive for small accounts** by default. The recommendations below are tuned for **capital preservation and slow compounding**, not frequency. They are based on the runtime guardrails in `RiskEngine`, `ScalperStrategy`, and flow-regime logic. 【F:src/risk/riskEngine.ts†L9-L157】【F:src/strategies/scalper.ts†L35-L220】【F:src/market/flowMetrics.ts†L12-L451】

---

## 1) Position sizing (core survival lever)

**Runtime behavior:**  
`positionSize` is the *base* trade size and is further scaled by the flow-regime multiplier (0 for illiquid/chaotic, 0.5 for quiet, 1.0 for normal). 【F:src/strategies/scalper.ts†L136-L154】【F:src/market/flowMetrics.ts†L386-L414】  
Risk engine also rejects intents that exceed `maxTradeSize` or violate reserve checks. 【F:src/risk/riskEngine.ts†L84-L153】

**Recommendation (≤ 30 XRP):**
- **POSITION_SIZE_XRP:** `0.25`–`0.75` (start at `0.5`).  
  This keeps individual trade risk tiny and respects reserve constraints.
- **MAX_TRADE_SIZE:** `1.0` XRP (hard cap for safety).  
  Ensures no size spikes from strategy or regime multipliers.
- **RESERVE_FLOOR_XRP:** `28` XRP.  
  Leaves a narrow but safer margin; the bot will stop if the free balance dips. 【F:src/risk/riskEngine.ts†L84-L106】
- **STOP_LOSS_BPS:** `75`–`100` (to avoid tight stops that churn fees).

> **Why so small?** With a 30 XRP balance and a 25 XRP reserve floor default, only 5 XRP is practically deployable. A 0.5 XRP size with tight trade limits avoids forced shutdown from reserve checks.

---

## 2) Minimum spread thresholds (avoid fee bleed)

**Runtime behavior:**  
The scalper bails out when `spreadBps < minSpreadBps`. 【F:src/strategies/scalper.ts†L171-L201】

**Recommendation (≤ 30 XRP):**
- **MIN_SPREAD_BPS:** `20`–`35` bps.  
  Small accounts cannot tolerate fee drag + micro-slippage at tiny size; a higher threshold prioritizes quality.

> This is deliberately conservative. If your fill metrics show consistently low slippage/fees, you can trim to 15–20 bps later.

---

## 3) Maximum acceptable cancel / rejection rate (IOC failure proxy)

**Runtime behavior:**  
IOC orders are used for entries (scalper BUY). Frequent rejects burn fees without building edge. 【F:src/strategies/scalper.ts†L206-L220】

**Recommendation (≤ 30 XRP):**
- **Target rejection/cancel rate:** **≤ 40%**.  
  Above this, fees dominate. Increase `MIN_SPREAD_BPS`, `COOLDOWN_MS`, or minimum signal strength.

---

## 4) Maximum trades per hour (throttle to survive)

**Runtime behavior:**  
Scalper uses `cooldownMs` to avoid immediate re-entries after exits. 【F:src/strategies/scalper.ts†L106-L121】【F:src/strategies/scalper.ts†L270-L283】

**Recommendation (≤ 30 XRP):**
- **COOLDOWN_MS:** `10–20 minutes` (600k–1,200k ms).  
  **Expected max trades/hour:** **3–6** (and often lower due to regime filters).

---

## 5) Minimum signal strength (avoid noisy microstructure)

**Runtime behavior:**  
Regime classification depends on flow signal strength and thresholds like `quietThreshold` and `trendingThreshold`. 【F:src/market/flowMetrics.ts†L129-L220】【F:src/market/flowMetrics.ts†L301-L354】

**Recommendation (≤ 30 XRP):**
- **FLOW_QUIET_THRESHOLD:** `0.20`–`0.25`  
  Forces “quiet” classification unless signals are meaningfully strong, reducing trade churn.
- **FLOW_TRENDING_THRESHOLD:** `0.40`  
  Avoids trading during directional pressure; scalper already avoids trending via regime filter.

---

## Suggested `.env` overrides (starter set)

```
# Capital preservation profile
RESERVE_FLOOR_XRP=28
POSITION_SIZE_XRP=0.5
MAX_TRADE_SIZE=1
MIN_SPREAD_BPS=25
STOP_LOSS_BPS=100
COOLDOWN_MS=900000

# Flow sensitivity
FLOW_QUIET_THRESHOLD=0.2
FLOW_TRENDING_THRESHOLD=0.4
```

---

## Operational notes

- **Daily loss limit:** set **MAX_DAILY_LOSS_XRP** to `1`–`2` XRP.  
  The bot hard-stops after this threshold. 【F:src/risk/riskEngine.ts†L62-L78】
- **Risk gate:** `RiskEngine.approveIntent` blocks large sizes and issuer violations. Keep issuers tight on small balance. 【F:src/risk/riskEngine.ts†L111-L125】
- **Regime filters:** The scalper only trades `quiet`/`normal` regimes. Raising `FLOW_QUIET_THRESHOLD` reduces trades and improves survival. 【F:src/market/flowMetrics.ts†L337-L354】【F:src/strategies/scalper.ts†L72-L103】

