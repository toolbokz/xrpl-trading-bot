# XRPL Trading Bot Wiring & Execution Audit Report

Date: 2026-02-23
Scope: Full repository (`frontend/site`, `backend/API`, runtime worker loop, XRPL adapter, config, CI/deploy wiring)

## Executive Verdict
- **Control-plane wiring (UI -> API -> runtime -> execution -> XRPL) is present and functional.**
- **Not fully production-safe as-is** due to several P1/P2 gaps in guard enforcement, documentation parity, and test/CI reliability.
- **Safe-to-land hardening changes were added behind default-OFF feature flags** and validated with targeted tests.

## System Map

### Components and Boundaries
- **UI (browser, local machine)**
  - Dashboard controls/polling: `src/ui/app/page.tsx:355`, `src/ui/app/page.tsx:914`
- **Local API boundary (localhost-only + optional token)**
  - Local API middleware: `src/ui/lib/localApi/withLocalApi.ts:175`
  - Localhost bind: `server.js:22`, `server.js:110`
- **Bot loop / worker (in-process timer worker)**
  - Controller loop: `src/ui/lib/botController.ts:133`
  - Runtime hooks bridge: `src/ui/lib/runtimeHooks.ts:58`
- **Runtime engine (strategy + risk + execution orchestration)**
  - Start: `src/runtime/tradingRuntime.ts:446`
  - Tick: `src/runtime/tradingRuntime.ts:771`
- **Execution + XRPL boundary**
  - OfferCreate construction: `src/execution/offerBuilder.ts:134`
  - Submission guards + validation lookup: `src/execution/offerExecutor.ts:2462`, `src/execution/offerExecutor.ts:2374`
  - Shared XRPL client + timeouts: `src/xrpl/client.ts:57`, `src/xrpl/client.ts:328`, `src/xrpl/sharedClient.ts:343`
- **Storage**
  - Trade history JSON writes in executor flow: `src/execution/offerExecutor.ts:2907`
  - Feedback SQLite used in health probe: `src/ui/lib/health/botWiringHealth.ts:74`
- **Monitoring/observability**
  - Runtime event API: `src/ui/pages/api/runtime/events.ts:66`
  - Lifecycle telemetry classification: `src/runtime/tradingRuntime.ts:1682`
  - Bot wiring health endpoint: `src/ui/pages/api/health/bot-wiring.ts:16`

### Data Flow (End-to-End)
1. UI actions call `/api/bot/{run|pause|kill}` from `callAction`: `src/ui/app/page.tsx:355`.
2. API handlers call `ensureRuntimeHooks()` and `botController` methods: `src/ui/pages/api/bot/run.ts:23`, `src/ui/pages/api/bot/run.ts:24`.
3. `runtimeHooks` wires controller hooks to runtime singleton start/pause/kill/tick: `src/ui/lib/runtimeHooks.ts:59`.
4. Controller interval drives runtime tick every >=4s: `src/ui/lib/botController.ts:137`.
5. Runtime starts XRPL websocket wrapper, risk engine, offer executor, and strategies: `src/runtime/tradingRuntime.ts:446`.
6. Strategies call executor; executor builds OfferCreate and submits: `src/execution/offerBuilder.ts:134`, `src/execution/offerExecutor.ts:2462`.
7. Submission ack + finality lookup + fill parsing update trade history and telemetry: `src/execution/offerExecutor.ts:2336`, `src/execution/offerExecutor.ts:2374`, `src/runtime/tradingRuntime.ts:1736`.
8. UI receives updates via `/api/runtime/events`, `/api/bot/cache`, `/api/bot/status`, `/api/bot/risk`, `/api/bot/wallet`: `src/ui/pages/api/runtime/events.ts:141`, `src/ui/app/api/bot/cache/route.ts:43`, `src/ui/pages/api/bot/status.ts:10`.

## A) Entrypoints Discovery

### Runtime Commands
- Main runtime commands in `package.json`:
  - `start`: `package.json:12`
  - `dev`: `package.json:13`
  - `dashboard`: `package.json:14`
- Legacy CLI entrypoint exits immediately and is not active path: `src/index.ts:8`, `src/index.ts:16`.

### Network/Process Entrypoint
- Custom server entrypoint: `server.js`.
- Enforces localhost bind and cloud detection fail-fast: `server.js:59`, `server.js:110`.

### Deployment Manifests
- No `Dockerfile`, `Procfile`, systemd unit, or k8s manifest found in repo root scan.

## B) End-to-End Wiring Trace (Dead-code check included)

### Confirmed Live Wiring
- UI control triggers are live and bound to routes.
- Routes call runtime hooks and controller functions.
- Bot loop calls runtime tick (not dead code).
- Runtime tick reaches strategy + execution path.
- OfferCreate path constructs XRPL fields and submits.
- Results feed persistence and observability APIs consumed by UI.

### Not Fully Wired/Partially Wired
- `withRuntimeBridge(...)` wrapper exists (`src/ui/lib/runtimeBridge.ts:132`) but is not used by Pages API routes (no route wrappers found via repository search).
- XRPL API context guard (`markApiRouteContext/clearApiRouteContext`) is therefore not consistently active for Pages routes.

## C) Configuration Audit

### Env Surface Enumeration
- Inventory generated from non-test source references: `audits/env_var_inventory.tsv`.
- Total unique env vars discovered: **313**.

### Startup Validation Status
- Validation/reporting module: `src/config/startupValidation.ts:245`.
- Runtime startup integration: `src/runtime/runtimeSingleton.ts:210`.
- Strict behavior:
  - Non-prod + `FEATURE_STRICT_CONFIG=1`: fail-fast on errors.
  - Production + strict flag: warn, do not crash.

### Docs/Code Mismatch
- Docs describe HMAC/RBAC API auth: `docs/security-api-auth.md:5`.
- Implemented model is localhost-only + optional `LOCAL_API_TOKEN`: `src/ui/lib/localApi/withLocalApi.ts:175`, `src/ui/lib/localApi/withLocalApi.ts:196`.

### Env Examples
- Added baseline `.env.example` and updated `.env.example.development` with new feature flags/timeouts.

## D) XRPL Execution Pipeline Audit

### OfferCreate Construction/Flags
- Core mapping uses XRPL taker semantics in builder: `src/execution/offerBuilder.ts:138`.
- Transaction envelope in executor includes `TransactionType: 'OfferCreate'` and `LastLedgerSequence`: `src/execution/offerExecutor.ts:1348`, `src/execution/offerExecutor.ts:1351`.

### Result Parsing and Fill Attribution
- Ack classification (`tes/ter/tec/tef/tel/tem`): `src/execution/offerExecutor.ts:2336`.
- Validation lookup by tx hash with polling/deadline: `src/execution/offerExecutor.ts:2374`.
- Partial fill parsing exists in metadata path (orderbook/AMM handling present in executor flow).

### Guardrails Added (Flag-gated)
- Duplicate submission suppression window: `src/execution/offerExecutor.ts:2514`.
- Timeout/error classification for reserve RPC: `src/xrpl/reserve.ts:61`, `src/xrpl/reserve.ts:115`.

## E) Resiliency Audit

### Positive Findings
- XRPL request timeout wrapper in websocket adapter: `src/xrpl/client.ts:328`.
- Reconnect/backoff logic in XRPL adapter and shared client.
- Tick overlap guard (`tickInFlight`) in runtime loop.

### Gaps
- No external queue/DLQ/visibility-timeout model (in-process worker only).
- Full-suite tests currently not stable; CI quality signal is degraded.

## F) Observability Audit

### Added/Improved
- Feature-flagged execution lifecycle enrichment:
  - classifier: `src/runtime/tradingRuntime.ts:1682`
  - emission payload fields: `src/runtime/tradingRuntime.ts:1778`
- Health/readiness endpoint:
  - route: `src/ui/pages/api/health/bot-wiring.ts:16`
  - probes: `src/ui/lib/health/botWiringHealth.ts:301`

### Correlation IDs
- `withLocalApi` sets request IDs and response header: `src/ui/lib/localApi/withLocalApi.ts:182`.
- Submit telemetry carries `trade_id` and `tx_hash` fields: `src/runtime/tradingRuntime.ts:1751`, `src/runtime/tradingRuntime.ts:1776`.

## G) Safety Audit

### Existing Safety Controls
- Localhost-only execution + cloud blocking: `server.js:59`, `src/security/localOnly.ts`.
- Kill switch and risk checks in runtime/risk engine.
- Paper mode support in executor (`paper` branch exists).

### Added Safety Hardening (Flag-gated)
- Reserve error classification and fail-closed behavior under audit guards.
- App Router host/header/token guard utility.
- Startup config validation with strict mode switch.

## H) Future Inhibitors (Forward-looking)
- XRPL fee/network dynamics can invalidate fixed timeout assumptions.
- Issuer/trustline or instrument seed changes can break route assumptions.
- High env-surface drift without schema expansion will keep misconfig risk elevated.

## Is It Fully Wired? Checklist

- [x] UI actions call backend control routes (`run/pause/kill`).
- [x] Control routes invoke bot controller and runtime hooks.
- [x] Bot loop drives runtime tick repeatedly.
- [x] Runtime reaches strategy/execution path and submits OfferCreate.
- [x] Submission result is persisted and exposed through UI-reporting APIs.
- [x] Health/readiness endpoint exists for bot wiring checks.
- [x] Config validation module exists and is startup-integrated.
- [x] Execution lifecycle telemetry enrichment exists (feature-flagged).
- [ ] API-context guard wiring is fully enforced across Pages API routes.
- [ ] Security auth docs and runtime implementation are aligned.
- [ ] Full repo test suite is green and trusted as a release gate.

**Conclusion:** partially wired end-to-end, with remaining P1/P2 inhibitors listed below.

## Top Issues (Ranked)

### P0
- No active P0 found in this pass.

### P1-1: XRPL direct-call guard not enforced on Pages routes
- Evidence:
  - Wrapper exists: `src/ui/lib/runtimeBridge.ts:132`
  - Routes still call shared client directly: `src/ui/pages/api/bot/price.ts:72`, `src/ui/pages/api/bot/orders.ts:116`
- Repro:
  1. Set `SINGLE_PROCESS_MODE=true`.
  2. Hit `/api/bot/price` repeatedly.
  3. Observe direct XRPL requests still route through shared client path.
- Impacted scenarios: rate-limit pressure, inconsistent runtime-vs-route data paths, harder guard reasoning.

### P1-2: API security documentation mismatch
- Evidence: `docs/security-api-auth.md:5` vs `src/ui/lib/localApi/withLocalApi.ts:175`.
- Repro:
  1. Follow HMAC doc and call route remotely with valid HMAC.
  2. Request still denied unless localhost and optional local token.
- Impacted scenarios: operator error, false confidence in deployed controls.

### P1-3: Test gate reliability is low (full suite red + compiled artifacts discovered)
- Evidence:
  - Compiled tests present under `.next`.
  - Full suite currently fails with many unrelated baseline failures.
  - CI runs tests twice and parses count via grep: `.github/workflows/ci.yml:55`, `.github/workflows/ci.yml:63`.
- Repro:
  1. Run `npm test -- --run`.
  2. Observe failures in runtime/security/registry suites and `.next` artifact errors.
- Impacted scenarios: release confidence and regression detection.

### P1-4: Config validation covers subset vs 313-key env surface
- Evidence: `audits/env_var_inventory.tsv`, `src/config/startupValidation.ts:245`.
- Repro:
  1. Add invalid env in a non-tracked key path.
  2. Startup validation may not flag it.
- Impacted scenarios: latent runtime behavior drift.

### P2-1: Hook registration split between two modules
- Evidence: `src/ui/lib/runtimeHooks.ts:58`, `src/ui/lib/runtimeBridge.ts:78`.
- Repro:
  1. Initialize via different module import order.
  2. Hook source ownership changes by load order.
- Impacted scenarios: maintainability/debugging risk.

### P2-2: App Router guard is optional via feature flag
- Evidence: `src/ui/app/api/bot/cache/route.ts:43`.
- Repro:
  1. Keep `FEATURE_AUDIT_GUARDS=0` (default).
  2. App route guard path is skipped.
- Impacted scenarios: inconsistent request-hardening semantics.

### P2-3: Health worker status remains inference-based
- Evidence: `src/ui/lib/health/botWiringHealth.ts:249`.
- Repro:
  1. Runtime enters odd state without heartbeat metadata.
  2. Health endpoint can only provide best-effort state.
- Impacted scenarios: operational diagnosis latency.

## Safe-to-Land Fixes Implemented (This Audit)

All behavior-changing items are feature-flagged and default OFF.

1. Feature flags module
- `src/config/featureFlags.ts:9`
- Flags: `FEATURE_AUDIT_GUARDS`, `FEATURE_STRICT_CONFIG`, `FEATURE_EXEC_TELEMETRY`

2. Startup config validation (strict fail-fast in non-prod)
- `src/config/startupValidation.ts:245`
- Integrated at runtime startup: `src/runtime/runtimeSingleton.ts:210`

3. Reserve timeout and error classification
- Timeout/classification: `src/xrpl/reserve.ts:55`, `src/xrpl/reserve.ts:61`
- Fail-closed-on-error (guard flag): `src/risk/riskEngine.ts:100`

4. Offer submission idempotency guard
- Duplicate fingerprint suppression: `src/execution/offerExecutor.ts:2514`

5. App Router local guard helper
- Guard evaluator: `src/ui/lib/localApi/appRouteGuard.ts:38`
- Applied to `/api/bot/cache` under audit flag: `src/ui/app/api/bot/cache/route.ts:43`

6. Health/readiness endpoint for bot wiring
- Route: `src/ui/pages/api/health/bot-wiring.ts:16`
- Probe implementation: `src/ui/lib/health/botWiringHealth.ts:301`

7. Structured execution lifecycle telemetry (flag-gated)
- Classifier/emission enrichment: `src/runtime/tradingRuntime.ts:1682`, `src/runtime/tradingRuntime.ts:1736`

8. Runtime process-mode accuracy fix
- `runtimeStarted` now reflects actual runtime instance state: `src/ui/lib/runtimeBridge.ts:292`

## Recommended Fixes, Effort, and Rollback

| Fix | Effort | Rollback Plan |
|---|---|---|
| Enforce API context guard on Pages routes (single wrapper) | M | Revert wrapper adoption and keep current route-local access pattern. |
| Align security docs with implementation (or implement HMAC/RBAC) | S-M | Revert docs change or keep localhost-only model documented. |
| Expand startup schema coverage by domain/mode | M-L | Keep current schema and disable strict mode (`FEATURE_STRICT_CONFIG=0`). |
| Stabilize test discovery (`exclude src/ui/.next/**`) and fail gates | S | Revert Vitest config changes and run targeted-only suites. |
| Consolidate hook ownership to one module | M | Revert to existing dual-registration approach if regressions appear. |
| Promote reserve fail-closed behavior to default after soak | M | Toggle back via `FEATURE_AUDIT_GUARDS=0`. |

## Test Evidence

### Targeted tests (audit changes)
Command:
```bash
npm test -- --run src/config/__tests__/startupValidation.test.ts src/ui/lib/__tests__/appRouteGuard.test.ts src/ui/pages/api/health/__tests__/bot-wiring.test.ts src/xrpl/__tests__/reserve.test.ts src/execution/__tests__/offerExecutor.idempotency.test.ts src/ui/lib/__tests__/runtimeBridge.processMode.test.ts
```
Result:
- **PASS**: 6 files, 20 tests.

### Full suite
Command:
```bash
npm test -- --run
```
Result:
- **FAIL** (pre-existing baseline failures not introduced by this audit change set).
- Included failures from runtime/security/registry suites and `.next` compiled artifact discovery.

## Deliverables Produced
- `AUDIT_REPORT.md`
- `audits/risk_register.json`
- `audits/test_plan.md`
- `audits/env_var_inventory.tsv` (supporting artifact)
