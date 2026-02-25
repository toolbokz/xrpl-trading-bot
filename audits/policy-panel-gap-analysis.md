# Policy Panel UI — Gap Analysis Audit

**Date:** 2026-02-25  
**Scope:** Policy tab in the diagnostics panel of the main dashboard  
**Files audited:** 30+ source files across UI components, API routes, and backend services

---

## 1. Architecture Overview

The **Policy** diagnostics tab (activated in [src/ui/app/page.tsx](../src/ui/app/page.tsx#L629-L651)) renders three sub-panels in a 3-column grid:

| Panel | Component File | API Route(s) | Poll Interval |
|-------|---------------|--------------|---------------|
| **Regime Heatmap** | [RegimeHeatmapPanel.tsx](../src/ui/components/RegimeHeatmapPanel.tsx) | `/api/analytics/regimes/heatmap`, `/api/analytics/regimes/policy` | 30s |
| **Adaptive** | [AdaptivePanel.tsx](../src/ui/components/AdaptivePanel.tsx) | `/api/analytics/adaptive/state` | 10–15s |
| **Governance (Capital Protection)** | [GovernancePanel.tsx](../src/ui/components/GovernancePanel.tsx) | `/api/analytics/governance/state` | 5s |

---

## 2. Panel-by-Panel: Data Available vs. Rendered

### 2A. RegimeHeatmapPanel

**API calls:**
- `GET /api/analytics/regimes/heatmap` → [src/ui/pages/api/analytics/regimes/heatmap.ts](../src/ui/pages/api/analytics/regimes/heatmap.ts)
- `GET /api/analytics/regimes/policy` → [src/ui/pages/api/analytics/regimes/policy.ts](../src/ui/pages/api/analytics/regimes/policy.ts)
- `POST /api/analytics/regimes/recompute` → [src/ui/pages/api/analytics/regimes/recompute.ts](../src/ui/pages/api/analytics/regimes/recompute.ts)

**Backend source:** [RegimePolicyEngine](../src/analytics/regimePolicy.ts) + [feedbackEngine.getRegimeHeatmap()](../src/analytics/feedbackEngine.ts)

#### Heatmap Response Fields

| Field | Available | Rendered | Notes |
|-------|-----------|----------|-------|
| `global[regime].score` | ✅ | ✅ | Shown in heatmap cell |
| `global[regime].expectancyBps` | ✅ | ✅ | Toggle between score/expectancy |
| `global[regime].trades` | ✅ | ✅ | Shown as "{n}t" in cell |
| `global[regime].winRate` | ✅ | ✅ | Tooltip only |
| `global[regime].profitFactor` | ✅ | ✅ | Tooltip only |
| `global[regime].avgEdgeBps` | ✅ | ❌ | **Available in data, not shown anywhere** |
| `global[regime].avgSlippageBps` | ✅ | ✅ | Tooltip only |
| `global[regime].avgSpreadBps` | ✅ | ✅ | Tooltip only |
| `global[regime].partialFillRate` | ✅ | ✅ | Tooltip only |
| `perStrategy[s][regime].*` | ✅ | ✅ | Same fields as global, per strategy row |
| `meta.lookbackHours` | ✅ | ✅ | Header subtitle |
| `meta.totalTrades` | ✅ | ✅ | Header subtitle |
| `meta.minTrades` | ✅ | ❌ | **Not displayed** |
| `meta.computedAt` | ✅ | ❌ | **Not displayed** |

#### Policy Response Fields

| Field | Available | Rendered | Notes |
|-------|-----------|----------|-------|
| `policy.updatedAt` | ✅ | ✅ | Policy section timestamp |
| `policy.lookbackHours` | ✅ | ❌ | **Not shown** (redundant with heatmap meta) |
| `policy.global.disabledRegimes` | ✅ | ✅ | Red pills + ban icons on cells |
| `policy.global.sizeByRegime[r].multiplier` | ✅ | ✅ | Colored pills (non-1.0 only) |
| `policy.global.sizeByRegime[r].smoothedScore` | ✅ | ❌ | **Not shown (available for explain)** |
| `policy.global.sizeByRegime[r].rawScore` | ✅ | ❌ | **Not shown** |
| `policy.global.sizeByRegime[r].trades` | ✅ | ❌ | **Not shown in policy section** |
| `policy.strategies[s].disabledRegimes` | ✅ | ✅ | Via `getDisabledRegimes()` → ban icons |
| `policy.strategies[s].sizeByRegime` | ✅ | ❌ | **Per-strategy multipliers not shown** |
| `policy.reasons` | ✅ | ✅ | Last 3 shown as bullet points |
| `policy.stats.totalTrades` | ✅ | ❌ | **Not shown** |
| `policy.stats.regimeCounts` | ✅ | ❌ | **Not shown** |
| `policy.stats.computedAt` | ✅ | ❌ | **Not shown** |

### 2B. AdaptivePanel

**API calls:**
- `GET /api/analytics/adaptive/state` → [src/ui/pages/api/analytics/adaptive/state.ts](../src/ui/pages/api/analytics/adaptive/state.ts)
- `POST /api/analytics/adaptive/recompute` → [src/ui/pages/api/analytics/adaptive/recompute.ts](../src/ui/pages/api/analytics/adaptive/recompute.ts)
- `POST /api/analytics/adaptive/toggle` → [src/ui/pages/api/analytics/adaptive/toggle.ts](../src/ui/pages/api/analytics/adaptive/toggle.ts)

**Backend source:** [adaptiveConfig.ts](../src/analytics/adaptiveConfig.ts) + [adaptiveLearner.ts](../src/analytics/adaptiveLearner.ts)

**Unused but available API:**
- `GET /api/analytics/adaptive/explain` → [explain.ts](../src/ui/pages/api/analytics/adaptive/explain.ts) — returns per-combo tuning + performance breakdown. **Never called by any UI component.**

#### AdaptiveTuning Fields (per pairKey/strategy/regime)

| Field | Available | Rendered | Notes |
|-------|-----------|----------|-------|
| `sizeMultiplier` | ✅ | ✅ | "Size ×" row |
| `quoteSkewBps` | ✅ | ❌ | **Not rendered — affects quote skew, invisible to operator** |
| `maxSlippageBps` | ✅ | ✅ | "Max Slip" row |
| `minEdgeBpsToTrade` | ✅ | ✅ | "Min Edge" row |
| `coolDownMs` | ✅ | ✅ | "Cooldown" row (conditional) |
| `disabledRegimes` | ✅ | ✅ | "(disabled)" label on regime |
| `updatedAt` | ✅ | ✅ | Footer timestamp |
| `reason` | ✅ | ✅ | Truncated at bottom |

#### Adaptive State-Level Fields

| Field | Available | Rendered | Notes |
|-------|-----------|----------|-------|
| `enabled` | ✅ | ✅ | ON/OFF toggle button |
| `state.updatedAt` | ✅ | ✅ | Footer |
| Full tunings map | ✅ | ❌ | **Only the current pairKey+strategy+regime combo is shown; no summary of all tunings** |

### 2C. GovernancePanel (Capital Protection)

**API call:**
- `GET /api/analytics/governance/state` → [src/ui/pages/api/analytics/governance/state.ts](../src/ui/pages/api/analytics/governance/state.ts)

**Backend source:** [capitalProtection.ts](../src/risk/capitalProtection.ts) via `runtime.getGovernanceStatus()`

#### GovernanceState Fields

| Field | Available | Rendered | Notes |
|-------|-----------|----------|-------|
| `mode` | ✅ | ✅ | Header badge + color scheme |
| `reasons` | ✅ | ✅ | Alert messages |
| `sizeMultiplier` | ✅ | ✅ | Header "×N%" when <1 |
| `cooldownMs` | ✅ | ✅ | Header "Ns cd" when >0 |
| `evaluatedAt` | ✅ | ✅ | Footer timestamp |

#### Metrics (when available + minTrades met)

| Field | Available | Rendered | Notes |
|-------|-----------|----------|-------|
| `metrics.tradesCount` | ✅ | ✅ | Section header / collecting indicator |
| `metrics.profitFactor` | ✅ | ✅ | Metric bar + grid |
| `metrics.expectancyBps` | ✅ | ✅ | Metric bar + grid |
| `metrics.drawdownPct` | ✅ | ✅ | Metric bar + grid |
| `metrics.drawdownConfidence` | ✅ | ✅ | "qualified"/"low-confidence" label |
| `metrics.peakEquity` | ✅ | ✅ | In expanded mode only |
| `metrics.equityNow` | ✅ | ❌ | **Available but not rendered** |
| `metrics.avgSlippageBps` | ✅ | ✅ | Metric bar + grid |
| `metrics.partialFillRate` | ✅ | ✅ | Grid stat |
| `metrics.winRate` | ✅ | ✅ | Grid stat |
| `metrics.consecutiveFailures` | ✅ | ✅ | Grid stat |

#### Thresholds

| Field | Available | Rendered | Notes |
|-------|-----------|----------|-------|
| `thresholds.minTrades` | ✅ | ✅ | Collecting progress bar |
| `thresholds.maxDrawdownPct` | ✅ | ✅ | Metric bar reference |
| `thresholds.minProfitFactor` | ✅ | ✅ | Metric bar reference |
| `thresholds.minExpectancyBps` | ✅ | ✅ | Metric bar reference |
| `thresholds.maxAvgSlippageBps` | ✅ | ✅ | Metric bar reference |
| `thresholds.maxPartialFillRate` | ✅ | ✅ | Grid stat breach coloring |
| `thresholds.consecFailShutdown` | ✅ | ✅ | Grid stat breach coloring |

---

## 3. Backend Data Sources NOT Surfaced at All in Policy Tab

These are full backend subsystems with policy/config data that have **zero** representation in the Policy tab:

### 3A. Reprice Policy ([src/execution/repricePolicy.ts](../src/execution/repricePolicy.ts))

Active config fields (from env or defaults):

| Config Field | Default | Env Variable | Surfaced in UI |
|-------------|---------|-------------|----------------|
| `driftThresholdBps` | 5 | `REPRICE_DRIFT_THRESHOLD_BPS` | ❌ |
| `hardStalenessLimitMs` | 10,000 | `REPRICE_HARD_STALENESS_MS` | ❌ |
| `softStalenessLimitMs` | 3,000 | — | ❌ |
| `queueDeteriorationThreshold` | 0.3 | — | ❌ |
| `defaultChurnLimitPerMin` | 8 | `REPRICE_CHURN_LIMIT_PER_MIN` | ❌ |

**Impact:** Operators cannot see the 7-step reprice cascade parameters that control order replacement behavior. No API route exists to expose this config.

### 3B. Execution Gate ([src/execution/executionGate.ts](../src/execution/executionGate.ts))

| Config Field | Default | Surfaced in UI |
|-------------|---------|----------------|
| `minHealthScore` | 50 | ❌ |
| `maxLedgerStalenessMs` | 60,000 | ❌ |
| `maxBalanceStalenessMs` | 120,000 | ❌ |

**Current verdict** is in `RuntimeCacheRegistry.executionQuality` and shown in the *Execution* tab, but the **config thresholds** driving it are invisible in the Policy tab.

### 3C. Strategy Configuration ([src/config/index.ts](../src/config/index.ts) → `StrategyConfig`)

| Config Field | Default | Env Variable | Surfaced in UI |
|-------------|---------|-------------|----------------|
| `minSpreadBps` | 10 | `MIN_SPREAD_BPS` | ❌ |
| `maxSpreadBps` | 12 | `SCALPER_MAX_SPREAD_BPS` | ❌ |
| `maxExitSpreadBps` | 15 | `SCALPER_MAX_EXIT_SPREAD_BPS` | ❌ |
| `positionSize` | 5 | `POSITION_SIZE_XRP` | Shown in Risk tab, not Policy |
| `stopLossBps` | 50 | `STOP_LOSS_BPS` | ❌ |
| `cooldownMs` | 60,000 | `COOLDOWN_MS` | ❌ |
| `ammArbMinProfitBps` | 15 | `AMM_ARB_MIN_PROFIT_BPS` | ❌ |
| `ammArbMaxSpreadBps` | 0 | `AMM_ARB_MAX_SPREAD_BPS` | ❌ |
| `ammArbPositionSize` | 0 | `AMM_ARB_POSITION_SIZE` | ❌ |
| `pathArbMinProfitBps` | 20 | `PATH_ARB_MIN_PROFIT_BPS` | ❌ |
| `maxSlippageBps` | 50 | `MAX_SLIPPAGE_BPS` | ❌ |
| `entryCrossBps` | 12 | `SCALPER_ENTRY_CROSS_BPS` | ❌ |
| `exitCrossBps` | 12 | `SCALPER_EXIT_CROSS_BPS` | ❌ |
| `orderBookStaleMs` | 5,000 | `ORDERBOOK_STALE_MS` | ❌ |
| `volatilityStop.*` | varies | `VOL_STOP_*` | Separate panel in Risk tab |

### 3D. Risk Engine Thresholds ([src/risk/riskEngine.ts](../src/risk/riskEngine.ts) → `RiskConfig`)

| Config Field | Default | Env Variable | Surfaced in Policy Tab |
|-------------|---------|-------------|----------------------|
| `maxExposurePerIssuer` | 5,000 | `MAX_EXPOSURE_PER_ISSUER` | ❌ (Risk tab only) |
| `maxTradeSize` | 1,000 | `MAX_TRADE_SIZE` | ❌ (Risk tab only) |
| `maxDailyLoss` | 500 | `MAX_DAILY_LOSS_XRP` | ❌ (Risk tab only) |
| `consecutiveFailureKillSwitch` | 5 | `CONSECUTIVE_FAILURE_KILL_SWITCH` | ❌ |
| `reserveFloorXRP` | 25 | `RESERVE_FLOOR_XRP` | ❌ (Risk tab only) |

### 3E. Hard Risk Guard ([src/risk/hardRiskGuard.ts](../src/risk/hardRiskGuard.ts) → `HardRiskConfig`)

| Config Field | Default | Surfaced in Policy Tab |
|-------------|---------|----------------------|
| `maxExposureNotional` | 5,000 | ❌ (via `/api/bot/risk` → Risk tab) |
| `maxInventorySkewPct` | 80 | ❌ |
| `maxDrawdownPct` | 7 | ❌ |
| `minTradesForDrawdown` | 50 | ❌ |
| `minPeakEquityForDrawdown` | 1.0 | ❌ |
| `maxBalanceStalenessMs` | 120,000 | ❌ |
| `minFeedHealthScore` | 40 | ❌ |
| `warningThresholdRatio` | 0.8 | ❌ |

### 3F. Feature Flags ([src/config/featureFlags.ts](../src/config/featureFlags.ts))

| Flag | Env Variable | Surfaced |
|------|-------------|----------|
| Audit Guards | `FEATURE_AUDIT_GUARDS` | ❌ |
| Strict Config | `FEATURE_STRICT_CONFIG` | ❌ |
| Exec Telemetry | `FEATURE_EXEC_TELEMETRY` | ❌ |
| XRPL Discovery | `FEATURE_XRPL_DISCOVERY_ENABLED` | ❌ |
| Trade Toasts | `FEATURE_TRADE_TOASTS_ENABLED` | ❌ |

### 3G. Flow Config ([src/config/index.ts](../src/config/index.ts) → `FlowConfig`)

| Config Field | Default | Surfaced in Policy Tab |
|-------------|---------|----------------------|
| `flowWindowMs` | 60,000 | ❌ |
| `trendingThreshold` | 0.3 | ❌ |
| `chaoticSpreadBps` | 200 | ❌ |
| `enableRegimeFilter` | true | ❌ |
| `enableAdverseSelectionProtection` | true | ❌ |
| `maxQuoteSkewBps` | 10 | ❌ |

### 3H. Regime Policy Config ([src/analytics/regimePolicy.ts](../src/analytics/regimePolicy.ts) → `RegimePolicyConfig`)

| Config Field | Default | Env Variable | Surfaced |
|-------------|---------|-------------|----------|
| `enabled` | true | `REGIME_POLICY_ENABLED` | ❌ |
| `lookbackHours` | 24 | `REGIME_POLICY_LOOKBACK_HOURS` | ❌ (data shows it, config doesn't) |
| `minTrades` | 30 | `REGIME_POLICY_MIN_TRADES` | ❌ |
| `alpha` (smoothing) | 0.2 | `REGIME_POLICY_ALPHA` | ❌ |
| `disableScoreBps` | -5 | `REGIME_DISABLE_SCORE_BPS` | ❌ |
| `enableScoreBps` | +2 | `REGIME_ENABLE_SCORE_BPS` | ❌ |
| `minSize` | 0.2 | `REGIME_MIN_SIZE` | ❌ |
| `maxSize` | 1.2 | `REGIME_MAX_SIZE` | ❌ |
| `sizeStep` | 0.1 | `REGIME_SIZE_STEP` | ❌ |

### 3I. Adaptive Learner Config ([src/analytics/adaptiveLearner.ts](../src/analytics/adaptiveLearner.ts) → `AdaptiveLearnerConfig`)

| Config Field | Default | Env Variable | Surfaced |
|-------------|---------|-------------|----------|
| `lookbackHours` | 24 | `ADAPTIVE_LOOKBACK_HOURS` | ❌ |
| `minSamples` | 25 | `ADAPTIVE_MIN_SAMPLES` | ❌ |
| `alpha` | 0.2 | `ADAPTIVE_ALPHA` | ❌ |
| `maxSizeStep` | 0.1 | `ADAPTIVE_MAX_SIZE_STEP` | ❌ |
| `maxSlippageStep` | 10 | `ADAPTIVE_MAX_SLIPPAGE_STEP` | ❌ |

### 3J. Active Trading Pair & Network

Available via `RuntimePublicState.tradingPairConfig` and `RuntimePublicState.network`:

| Field | Available | Surfaced in Policy Tab |
|-------|-----------|----------------------|
| Active pair key | ✅ | ❌ (shown in main header, not Policy) |
| Base/quote currencies | ✅ | ❌ |
| Issuer addresses | ✅ | ❌ |
| Network (mainnet/testnet) | ✅ | ❌ |
| Paper trading mode | ✅ | ❌ |

### 3K. Capital Protection Config

The governance API returns `thresholds` but **not** the full `CapitalProtectionConfig`. Missing:

| Config Field | Available in Backend | In API Response | Surfaced |
|-------------|---------------------|----------------|----------|
| `enabled` | ✅ | ❌ | ❌ |
| `lookbackTrades` | ✅ | ❌ | ❌ |
| `throttleCooldownMs` | ✅ | ❌ | ❌ |
| `pauseCooldownMs` | ✅ | ❌ | ❌ |
| `throttleSizeMultiplier` | ✅ | ❌ | ❌ |
| `pauseSizeMultiplier` | ✅ | ❌ | ❌ |
| `minTradesForDrawdown` | ✅ | ❌ | ❌ |
| `minPeakEquityForDrawdown` | ✅ | ❌ | ❌ |

---

## 4. RuntimeCacheRegistry Policy-Related Keys

The [RuntimeCacheRegistry](../src/runtime/runtimeCacheRegistry.ts) snapshot contains:

| Cache Slot | Contents | Used by Policy Tab |
|-----------|---------|-------------------|
| `executionQuality` | allowedTicks, blockedTicks, verdict, healthScore, regime, spreadBps | ❌ (Execution tab) |
| `spreadRegime` | regime, spreadBps, midPrice, bestBid, bestAsk | ❌ |
| `volatilityStop` | enabled, volBps, volReady, stopLossBpsUsed, source | ❌ (Risk tab) |
| `spreadDistribution` | 24h + multi-day medians, percentiles | ❌ |
| `strategyFunnel` | per-strategy evaluated/accepted/rejected counts | ❌ |
| `runtimeState` | FSM state string | ❌ |
| `executionAllowed` | boolean | ❌ |

---

## 5. Gaps Ranked by Severity

### HIGH — Operator-critical policy data completely invisible

| # | Gap | Severity | Impact |
|---|-----|----------|--------|
| H1 | **Strategy parameters not shown** — maxSpreadBps, entryCrossBps, exitCrossBps, stopLossBps, cooldownMs, maxSlippageBps are all invisible. Operator cannot verify active trading parameters. | HIGH | Operator flies blind on the parameters that determine every trade entry/exit. |
| H2 | **Reprice policy cascade not shown** — drift threshold, staleness limits, churn limit are invisible. No API route exists. | HIGH | If reprice is misconfigured (e.g., churn limit too low), operator has no visibility into why orders aren't being replaced. |
| H3 | **Execution gate config not shown** — minHealthScore, staleness thresholds invisible. | HIGH | Operator cannot understand why execution is blocked; config thresholds are hidden. |
| H4 | **AdaptiveTuning.quoteSkewBps not rendered** — the quote skew adjustment is applied to every quote but invisible. | HIGH | Quote pricing can be silently skewed ±25 bps without operator awareness. |
| H5 | **Regime policy config (hysteresis thresholds) not shown** — disableScoreBps, enableScoreBps, alpha, minTrades. | HIGH | Operator cannot understand why regimes flip or stay disabled; tuning knobs are hidden. |
| H6 | **Paper trading / network / active pair** not displayed in Policy tab context | HIGH | No at-a-glance confirmation of whether the bot is in paper/live mode on mainnet/testnet. |

### MEDIUM — Useful operational context missing

| # | Gap | Severity | Impact |
|---|-----|----------|--------|
| M1 | **Feature flags state not shown** — FEATURE_AUDIT_GUARDS, FEATURE_STRICT_CONFIG, FEATURE_EXEC_TELEMETRY, FEATURE_XRPL_DISCOVERY_ENABLED all invisible. | MED | Operator cannot verify which safety features are enabled. |
| M2 | **`/api/analytics/adaptive/explain` never called** — rich per-combo tuning+performance data available but unused. | MED | Deeper insight into why a specific tuning was chosen requires manual API calls. |
| M3 | **Per-strategy regime size multipliers not shown** — only global multipliers get pills; per-strategy multipliers silently dropped. | MED | Strategy may be running at 50% size in a regime but operator only sees the global multiplier. |
| M4 | **Capital protection config (throttle/pause multipliers, cooldowns, lookback)** not in API or UI. | MED | Operator cannot verify THROTTLE means 50% size vs 30% size without reading code or .env. |
| M5 | **`metrics.equityNow`** available but not rendered in GovernancePanel. | MED | Current equity vs peak equity would help diagnose drawdown trajectory. |
| M6 | **Hard risk guard thresholds** (maxInventorySkewPct, warningThresholdRatio) never surfaced in Policy tab. | MED | Available via `/api/bot/risk` in Risk tab, but fragmented—no unified policy view. |
| M7 | **Flow config thresholds** (chaoticSpreadBps, trendingThreshold, enableRegimeFilter) not shown. | MED | Operator cannot verify the regime classification thresholds. |
| M8 | **Adaptive learner config** (lookbackHours, minSamples, alpha, maxSizeStep) not exposed. | MED | Operator cannot verify learning speed or bounds. |
| M9 | **Regime policy `stats.regimeCounts`** not shown — distribution of trades across regimes. | MED | Useful for understanding data bias toward certain regimes. |

### LOW — Nice-to-have context or edge-case visibility

| # | Gap | Severity | Impact |
|---|-----|----------|--------|
| L1 | **Heatmap `meta.computedAt`** and `meta.minTrades`** not displayed. | LOW | Minor; lookbackHours and totalTrades are shown. |
| L2 | **Heatmap `avgEdgeBps`** available in cell data but not in tooltip. | LOW | Edge bps is somewhat redundant with expectancy; nice for specialists. |
| L3 | **Policy smoothedScore and rawScore** per-regime not displayed (only multiplier). | LOW | Would help explain why a regime has a certain multiplier. |
| L4 | **Strategy funnel counters** (evaluated/accepted/rejected per strategy) not in Policy tab. | LOW | Available in cache but more appropriate for Execution tab. |
| L5 | **Spread distribution percentiles** not shown in Policy context. | LOW | Useful but arguably belongs in a market quality panel. |
| L6 | **Full tunings map** for all pairKey/strategy/regime combos not browsable. | LOW | Only current combo shown; a matrix view would help in multi-pair setups. |

---

## 6. Summary Statistics

| Category | Count |
|----------|-------|
| Backend config/policy fields inventoried | ~95 |
| Fields currently rendered in Policy tab | ~35 |
| Fields available in API but not rendered | ~15 |
| Fields in backend with no API route | ~45 |
| **Coverage:** rendered / available | **~37%** |

---

## 7. Recommendations (Priority Order)

1. **Create a `/api/bot/policy-config` aggregation endpoint** that returns all active policy/config in one call:
   - Strategy params (StrategyConfig)
   - Reprice config (RepriceConfig)
   - Execution gate config (ExecutionGateConfig)
   - Regime policy config (RegimePolicyConfig)
   - Adaptive learner config (AdaptiveLearnerConfig)
   - Capital protection config (CapitalProtectionConfig)
   - Feature flags state
   - Flow config (FlowConfig)
   - Active pair + network + paper mode

2. **Add a "Config" row or sub-section** to the Policy tab showing the above parameters in a compact key-value grid. This would address H1–H6 and M1/M4/M7/M8.

3. **Render `quoteSkewBps`** in AdaptivePanel alongside the existing tuning rows (H4).

4. **Show per-strategy multipliers** in RegimeHeatmapPanel policy section (M3).

5. **Add `equityNow`** to GovernancePanel compact mode (M5).

6. **Wire up the adaptive/explain API** in a tooltip or expandable detail on AdaptivePanel (M2).

7. **Show regime trade distribution** (`stats.regimeCounts`) as a mini histogram in the heatmap footer (M9).

---

## 8. File Reference Index

| File | Role | Lines of Interest |
|------|------|-------------------|
| [src/ui/app/page.tsx](../src/ui/app/page.tsx) | Policy tab layout | L629–L651 |
| [src/ui/components/RegimeHeatmapPanel.tsx](../src/ui/components/RegimeHeatmapPanel.tsx) | Heatmap + policy display | L220–L542 |
| [src/ui/components/AdaptivePanel.tsx](../src/ui/components/AdaptivePanel.tsx) | Adaptive tuning display | L1–L280 |
| [src/ui/components/GovernancePanel.tsx](../src/ui/components/GovernancePanel.tsx) | Capital protection display | L1–L408 |
| [src/ui/pages/api/analytics/regimes/policy.ts](../src/ui/pages/api/analytics/regimes/policy.ts) | Regime policy API | L1–L75 |
| [src/ui/pages/api/analytics/regimes/heatmap.ts](../src/ui/pages/api/analytics/regimes/heatmap.ts) | Heatmap API | L1–L92 |
| [src/ui/pages/api/analytics/adaptive/state.ts](../src/ui/pages/api/analytics/adaptive/state.ts) | Adaptive state API | L1–L55 |
| [src/ui/pages/api/analytics/adaptive/explain.ts](../src/ui/pages/api/analytics/adaptive/explain.ts) | Explain API (unused) | L1–L85 |
| [src/ui/pages/api/analytics/governance/state.ts](../src/ui/pages/api/analytics/governance/state.ts) | Governance API | L1–L127 |
| [src/analytics/regimePolicy.ts](../src/analytics/regimePolicy.ts) | Regime policy engine | L27–L102 (types), L108–L131 (config) |
| [src/analytics/adaptiveLearner.ts](../src/analytics/adaptiveLearner.ts) | Adaptive learner | L33–L56 (AdaptiveTuning), L93–L111 (config) |
| [src/analytics/adaptiveConfig.ts](../src/analytics/adaptiveConfig.ts) | Adaptive config singleton | L1–L168 |
| [src/execution/repricePolicy.ts](../src/execution/repricePolicy.ts) | Reprice cascade | L20–L65 (types/config), L79–L145 (cascade) |
| [src/execution/executionGate.ts](../src/execution/executionGate.ts) | Execution gate | L22–L51 (types/config), L97–L185 (evaluator) |
| [src/config/featureFlags.ts](../src/config/featureFlags.ts) | Feature flags | L1–L45 |
| [src/config/index.ts](../src/config/index.ts) | AppConfig definition | L38–L170 (interfaces), L247–L350 (loading) |
| [src/risk/riskEngine.ts](../src/risk/riskEngine.ts) | Risk engine | L38–L47 (config), L159–L189 (getStatus) |
| [src/risk/capitalProtection.ts](../src/risk/capitalProtection.ts) | Capital protection | L78–L113 (config), L557–L587 (loadConfig) |
| [src/risk/hardRiskGuard.ts](../src/risk/hardRiskGuard.ts) | Hard risk guard | L115–L165 (payload/config) |
| [src/runtime/runtimeCacheRegistry.ts](../src/runtime/runtimeCacheRegistry.ts) | Cache registry | L138–L175 (snapshot shape) |
| [src/runtime/runtimeSingleton.ts](../src/runtime/runtimeSingleton.ts) | Runtime singleton | L42–L130 (RuntimePublicState) |
| [src/ui/lib/hooks/useRuntimeCache.tsx](../src/ui/lib/hooks/useRuntimeCache.tsx) | Runtime cache hook | L14–L47 (snapshot shape) |
