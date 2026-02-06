# Institutional Upgrade Blueprint (Execution + Market Data)

## Files to create
- `src/market/models.ts`
- `src/execution/qualityGate.ts`
- `src/execution/repricePolicy.ts`
- `src/execution/executionTrace.ts`
- `src/monitoring/eventLoopLag.ts`
- `src/analytics/slippageAttribution.ts`
- `test/unit/execution/qualityGate.test.ts`
- `test/unit/execution/repricePolicy.test.ts`
- `test/unit/market/models-normalization.test.ts`
- `test/unit/monitoring/eventLoopLag.test.ts`

## Files to modify
- `src/runtime/tradingRuntime.ts`
- `src/index.ts`
- `src/market/orderBookTracker.ts`
- `src/market/tradeTape.ts`
- `src/market/tradeTapeService.ts`
- `src/market/amm.ts`
- `src/market/flowMetrics.ts`
- `src/execution/offerBuilder.ts`
- `src/execution/offerExecutor.ts`
- `src/xrpl/client.ts`
- `src/xrpl/sharedClient.ts`
- `src/xrpl/transactionEngine.ts`
- `src/xrpl/signer.ts`
- `src/risk/riskEngine.ts`
- `src/analytics/costRealism.ts`
- `src/analytics/pnl.ts`
- `src/analytics/tradeHistory.ts`
- `src/analytics/feedbackEngine.ts`
- `src/monitoring/cpuWatchdog.ts`
- `src/utils/cpuSafety.ts`
- `src/persistence/breakerStore.ts`
- `web/pages/api/analytics/*`
- `web/pages/api/market/*`
- `web/components/AdaptivePanel.tsx`
- `web/components/MarketDataHealthPanel.tsx`
- `web/components/LogsPanel.tsx`

## New types / interfaces
- `NormalizedTrade`
  - `id: string`
  - `pairKey: string`
  - `price: number`
  - `baseAmount: number`
  - `quoteAmount: number`
  - `side: 'buy' | 'sell'`
  - `source: 'tape' | 'xrpl' | 'db'`
  - `eventTimeMs: number`
  - `ingestTimeMs: number`
  - `isDuplicate: boolean`
  - `stalenessMs: number`
- `OrderBookSnapshot`
  - `pairKey: string`
  - `sequence: number`
  - `eventTimeMs: number`
  - `ingestTimeMs: number`
  - `bids: Array<{ price: number; size: number }>`
  - `asks: Array<{ price: number; size: number }>`
  - `bestBid: number`
  - `bestAsk: number`
  - `spreadBps: number`
  - `depthNotional1Pct: number`
  - `stalenessMs: number`
  - `healthScore: number`
- `AMMSnapshot`
  - `pairKey: string`
  - `eventTimeMs: number`
  - `ingestTimeMs: number`
  - `poolBase: number`
  - `poolQuote: number`
  - `impliedMid: number`
  - `feeBps: number`
  - `stalenessMs: number`
  - `healthScore: number`
- `ExecutionTrace`
  - `correlationId: string`
  - `pairKey: string`
  - `strategy: string`
  - `decisionTimeMs: number`
  - `buildTimeMs?: number`
  - `submitTimeMs?: number`
  - `ledgerAcceptedTimeMs?: number`
  - `fillTimeMs?: number`
  - `expectedPrice: number`
  - `arrivalMid: number`
  - `postFillMid?: number`
  - `fillPrice?: number`
  - `slippageBps?: number`
  - `spreadCostBps?: number`
  - `impactProxyBps?: number`
- `QualityGateInput`
  - `pairKey: string`
  - `side: 'buy' | 'sell'`
  - `urgency: 'low' | 'normal' | 'high'`
  - `spreadBps: number`
  - `expectedImpactBps: number`
  - `feedStalenessMs: number`
  - `volatilityBps: number`
  - `depthNotional: number`
  - `slippageBudgetBps: number`
  - `expectedEdgeBps: number`
  - `feesBps: number`
- `QualityGateDecision`
  - `action: 'ALLOW' | 'DEFER' | 'REPRICE' | 'SKIP'`
  - `reason: string`
  - `targetPrice?: number`
  - `ttlMs?: number`
- `RepriceDecision`
  - `action: 'KEEP' | 'REPLACE' | 'CANCEL' | 'PAUSE'`
  - `reason: string`
  - `newPrice?: number`
- `InfraSafetyState`
  - `eventLoopLagP95Ms: number`
  - `cpuLoad: number`
  - `unstable: boolean`
  - `autoPaused: boolean`

## New functions (signature + purpose)
- `normalizeTrade(input: RawTrade, nowMs: number, lastEventMs: number): NormalizedTrade`
  - Canonicalize trade fields, enforce monotonic timestamp, compute staleness and duplicate markers.
- `normalizeOrderBook(input: RawOrderBook, nowMs: number, sequence: number): OrderBookSnapshot`
  - Canonicalize book shape, compute spread/depth/staleness/health.
- `normalizeAmm(input: RawAmmState, nowMs: number): AMMSnapshot`
  - Canonicalize AMM state, compute implied mid and health metrics.
- `computeMarketHealth(args: { trade: NormalizedTrade | null; book: OrderBookSnapshot | null; amm: AMMSnapshot | null }): number`
  - Produce deterministic 0-100 health score.
- `makeCorrelationId(seed: { pairKey: string; strategy: string; ts: number; nonce: number }): string`
  - Create deterministic execution correlation ID.
- `startExecutionTrace(ctx: { correlationId: string; pairKey: string; strategy: string; arrivalMid: number; expectedPrice: number; decisionTimeMs: number }): ExecutionTrace`
  - Initialize trace at decision stage.
- `markTraceStage(trace: ExecutionTrace, stage: 'build' | 'submit' | 'ledgerAccepted' | 'fill', ts: number): ExecutionTrace`
  - Stamp lifecycle timestamps.
- `finalizeSlippage(trace: ExecutionTrace, fillPrice: number, postFillMid: number): ExecutionTrace`
  - Compute slippage, spread cost, impact proxy.
- `evaluateQualityGate(input: QualityGateInput): QualityGateDecision`
  - Apply slippage-first gate and maker-first crossing constraints.
- `evaluateRepricePolicy(input: { currentQuote: number; fairQuote: number; driftBps: number; feedStalenessMs: number; spreadRegimeChanged: boolean; queueDeterioration: number; replaceRatePerMin: number; churnLimitPerMin: number }): RepriceDecision`
  - Evidence-based replace/cancel/pause decisions with churn breaker.
- `computeMakerQuote(args: { mid: number; side: 'buy' | 'sell'; spreadBps: number; volBps: number; stalenessMs: number; minTick: number }): number`
  - Derive passive quote width scaling by spread/volatility/staleness.
- `shouldCrossSpread(args: { expectedEdgeBps: number; feesBps: number; slippageBudgetBps: number }): boolean`
  - Permit taker action only when edge exceeds fees + budget.
- `recordInfraLagSample(nowMs: number): number`
  - Measure event-loop lag sample for watchdog.
- `shouldAutoPauseTrading(input: { eventLoopLagP95Ms: number; cpuLoad: number; lagLimitMs: number; cpuLimit: number }): boolean`
  - Determine infra-triggered pause condition.

## Test cases to add
- `qualityGate.test.ts`
  - ALLOW when spread+impact+fees <= edge and staleness/depth healthy.
  - DEFER when feed staleness exceeds threshold.
  - REPRICE when spread regime widens but edge remains positive.
  - SKIP when slippage budget breached or depth insufficient.
- `repricePolicy.test.ts`
  - KEEP when drift below threshold.
  - REPLACE when drift above threshold with healthy replace rate.
  - CANCEL on hard staleness breach.
  - PAUSE when churn breaker trips.
- `models-normalization.test.ts`
  - Monotonic timestamp enforcement.
  - Duplicate trade detection by id/hash.
  - Health score degradation on stale inputs.
- `eventLoopLag.test.ts`
  - Deterministic lag sampling with fake timers.
  - Auto pause toggles true on sustained lag p95 breach.
  - Auto pause clears after recovery window.
- Integration tests (existing harness)
  - Correlation ID present from runtime decision through fill persistence.
  - Slippage attribution persisted in analytics records.
  - Maker-first logic avoids crossing when edge <= fees+budget.

## Migration steps
1. Add canonical market models and normalizers; wire into `tradeTapeService`, `orderBookTracker`, `amm`, `flowMetrics` behind feature flag `MD_NORMALIZATION_V1` default ON.
2. Add `ExecutionTrace` lifecycle in runtime/executor/transactionEngine/signer/fill pipeline; persist in analytics DB with nullable new columns.
3. Introduce `qualityGate` and enforce in `offerExecutor` before submit; add risk-engine hard reject when projected slippage exceeds budget.
4. Implement maker-first quote computation in `offerBuilder`; gate taker crossing via `shouldCrossSpread`.
5. Add `repricePolicy` to replace/cancel loop with churn counters persisted via `breakerStore`.
6. Add event-loop lag tracker + auto-pause integration (`cpuWatchdog`, `cpuSafety`, `tradingRuntime`), include recovery hysteresis.
7. Extend analytics persistence (`tradeHistory`, `pnl`, `costRealism`) for arrival/fill/post-fill metrics and attribution fields.
8. Expose new metrics and trace endpoints in `web/pages/api/*`; surface in monitoring panels.
9. Backfill defaults for old rows (`NULL` tolerated); run one-time migration script via existing DB migration flow.
10. Roll out in phases: shadow-mode logging -> enforce quality gate -> enforce auto-pause and churn breaker.

## Validation metrics
- Execution quality
  - Median slippage bps
  - P95 slippage bps
  - Fill-to-arrival spread cost bps
  - Impact proxy bps
- Cost control
  - Fee bps per filled notional
  - Maker ratio (%)
  - Replace-to-fill ratio
- Safety / determinism
  - % orders with complete `ExecutionTrace`
  - Correlation ID continuity rate (decision→fill)
  - Auto-pause trigger count and mean pause duration
- Market data health
  - Trade/book/amm staleness p50/p95
  - Health score p50/p95
  - Duplicate event drop rate
- Runtime performance
  - Event loop lag p95/p99
  - CPU watchdog breach rate
  - API/UI metrics freshness lag
