# XRPL Trading Bot Audit Test Plan

Generated: 2026-02-23

## 1. Objectives
- Verify UI → API → bot runtime → XRPL submission wiring is intact.
- Verify new audit guardrails are safe-by-default and only active behind feature flags.
- Verify execution-path resilience under timeout, stale-book, and XRPL error conditions.
- Verify observability payloads are emitted for execution lifecycle stages.

## 2. Scope
- Frontend wiring: `src/ui/app/page.tsx`, hooks, and API polling.
- API and controller: `src/ui/pages/api/**`, `src/ui/lib/botController.ts`, `src/ui/lib/runtimeHooks.ts`.
- Runtime and execution: `src/runtime/tradingRuntime.ts`, `src/execution/offerExecutor.ts`, `src/execution/offerBuilder.ts`.
- XRPL adapter/reserve: `src/xrpl/client.ts`, `src/xrpl/sharedClient.ts`, `src/xrpl/reserve.ts`.
- Config and startup validation: `src/config/startupValidation.ts`, `src/config/featureFlags.ts`.
- Health and monitoring: `src/ui/pages/api/health/bot-wiring.ts`, `src/ui/lib/health/botWiringHealth.ts`, `/api/runtime/events`.

## 3. Existing Automated Coverage (Added/Updated in this audit)
- `src/config/__tests__/startupValidation.test.ts`
- `src/ui/lib/__tests__/appRouteGuard.test.ts`
- `src/ui/pages/api/health/__tests__/bot-wiring.test.ts`
- `src/xrpl/__tests__/reserve.test.ts`
- `src/execution/__tests__/offerExecutor.idempotency.test.ts`
- `src/ui/lib/__tests__/runtimeBridge.processMode.test.ts`

## 4. Unit Test Plan
### U1: Feature flags and config validation
- Validate `FEATURE_AUDIT_GUARDS`, `FEATURE_STRICT_CONFIG`, `FEATURE_EXEC_TELEMETRY` default OFF behavior.
- Validate strict config fail-fast only in non-production.
- Validate production warning-only mode under strict config.

### U2: Offer submission guardrails
- Verify duplicate fingerprint suppression when `FEATURE_AUDIT_GUARDS=1`.
- Verify no suppression when `FEATURE_AUDIT_GUARDS=0`.
- Verify reserve timeout classification and retryability mapping.

### U3: API security guardrails
- Validate App Router localhost host/IP/token enforcement.
- Validate rejection behavior for forwarded remote sources.

### U4: Health state correctness
- Verify worker/runtime readiness mapping (`runtimeStarted`, `runtimeReady`, `warmingUp`).
- Verify health endpoint 200/503/500 branches.

## 5. Integration Test Plan
### I1: Wiring lifecycle
- Start runtime using `/api/bot/run`.
- Assert `botController` state transitions (`STOPPED -> RUNNING -> PAUSED -> STOPPED`).
- Assert `/api/runtime/events` yields `SUBMIT_ATTEMPT/SUBMIT_SUCCESS/SUBMIT_FAIL` records.

### I2: Execution telemetry schema
- With `FEATURE_EXEC_TELEMETRY=1`, assert lifecycle fields:
  - `lifecycle_stage`
  - `outcome_class`
  - `retryable`
  - `abort_reason`
- With flag OFF, assert fields are absent.

### I3: Health/readiness wiring
- Probe `/api/health/bot-wiring` and verify checks:
  - config
  - db
  - redis (optional)
  - xrpl server_info
  - orderbook
  - worker state

### I4: Runtime cache/reporting path
- Assert `/api/bot/cache` returns cache snapshot in RUNNING mode.
- Assert UI hooks consume latest seq data without polling regressions.

## 6. E2E Test Plan (Localhost)
### E1: Control-plane flow
1. Load dashboard (`/`).
2. Click Run.
3. Verify `/api/bot/run` success.
4. Verify status panel + risk/wallet/trades polling updates.
5. Click Pause then Kill and verify transitions.

### E2: Safety flow
- Set `LOCAL_API_TOKEN` and verify API requests without token fail (401).
- Verify with token succeeds from localhost.

### E3: Paper/live mode boundary
- In paper mode, verify no signed live transaction submit path is used.
- In live mode with missing credentials, verify startup validation behavior per strict flag.

## 7. Failure Injection Test Plan
### F1: XRPL network failures
- Inject timeout in `server_info`, `book_offers`, `account_info`, `tx` calls.
- Expected:
  - reserve classification emits `RESERVE_TIMEOUT`.
  - health endpoint reports degraded checks and warnings.
  - runtime tick does not crash process loop.

### F2: Engine result classes
- Inject `tesSUCCESS`, `ter*`, `tec*`, `tef*`, `tel*` submit outcomes.
- Expected lifecycle mapping:
  - `tes*` => submitted/accepted
  - `ter*` => queued
  - timeout/network/tel => retry class
  - `tec*|tef*` => rejected class

### F3: Orderbook staleness
- Freeze `OrderBookTracker` source ledger progression.
- Expected:
  - stale checks trigger execution gate BLOCK conditions.
  - health endpoint warning flags include orderbook degradation.

### F4: Duplicate submission race
- Fire identical intents inside idempotency window.
- Expected:
  - second submit blocked with `idempotency-duplicate-prevented` when guard enabled.

## 8. Load/Soak and Worker Resiliency
### L1: Tick loop soak
- Run runtime for N ticks (>=10k) in paper mode.
- Metrics:
  - no unhandled rejections
  - no monotonic growth in listener counts
  - tick duration p95 remains under defined threshold.

### L2: API polling pressure
- Simulate concurrent polling for `/api/runtime/events`, `/api/bot/cache`, `/api/market/health`.
- Verify no loop starvation and no websocket reconnect storm.

### L3: Restart idempotency
- Sequence: run → kill → run repeated 100 cycles.
- Verify no stale hook retention and runtime singleton resets cleanly.

### L4: Scheduler/background tasks
- Verify adaptive scheduler, markout scheduler, scanner, and heartbeat-like tasks stop on shutdown.
- Verify no timer leaks after repeated starts/stops.

## 9. Cron/Worker Resiliency (Best-effort, no external queue)
- This repo uses in-process intervals (no external queue + DLQ abstraction).
- Validate:
  - `botController` loop survives route-level errors.
  - background jobs are cancellable on `shutdown()/kill()`.
  - health endpoint reports non-RUNNING worker state explicitly.

## 10. Command Matrix
- Targeted audit tests:
```bash
npm test -- --run \
  src/config/__tests__/startupValidation.test.ts \
  src/ui/lib/__tests__/appRouteGuard.test.ts \
  src/ui/pages/api/health/__tests__/bot-wiring.test.ts \
  src/xrpl/__tests__/reserve.test.ts \
  src/execution/__tests__/offerExecutor.idempotency.test.ts \
  src/ui/lib/__tests__/runtimeBridge.processMode.test.ts
```

- Full suite health check:
```bash
npm test -- --run
```

## 11. Current Status Snapshot
- Targeted audit suite: PASS (6 files, 20 tests).
- Full suite: FAIL (baseline failures unrelated to this audit delta, including `.next` test artifact discovery and pre-existing failing suites).

## 12. Exit Criteria
- Required for merge of this audit change set:
  - Targeted audit tests remain green.
  - Feature-flagged behavior remains OFF by default.
  - No regression in run/pause/kill wiring.
- Required for repo-wide reliability hardening:
  - Full suite stabilized to green.
  - `.next` test contamination removed from Vitest discovery.
