# XRPL Trading Bot — Agent Notes

## Architecture (big picture)
- Backend loop lives in [src/index.ts](src/index.ts) and [src/runtime/tradingRuntime.ts](src/runtime/tradingRuntime.ts): connect XRPL → refresh order book → run strategies → execute offers. Data flow: `XRPLWebSocket` → `OrderBookTracker` → strategies in [src/strategies/](src/strategies/) → `OfferExecutor` → `RiskEngine`.
- Strategies are wired in `TradingRuntime.start()` (Scalper, AMM arb, Path arb). When adding a new strategy, register it there and respect `Strategy` interface in [src/strategies/types.ts](src/strategies/types.ts).
- Risk controls are centralized in [src/risk/riskEngine.ts](src/risk/riskEngine.ts): daily loss reset, reserve checks, issuer allowlist/blacklist. Use it before sending any on-ledger action.
- Order book normalization/price logic is in [src/market/orderBookTracker.ts](src/market/orderBookTracker.ts); it converts XRP drops vs issued currency amounts and computes spread bps.

## Localhost-only security (do not bypass by default)
- Multiple enforced gates: CLI startup [src/index.ts](src/index.ts), runtime construction [src/runtime/tradingRuntime.ts](src/runtime/tradingRuntime.ts), Next server [web/server.js](web/server.js), and API middleware [web/lib/localApi/withLocalApi.ts](web/lib/localApi/withLocalApi.ts).
- Environment flags: `BOT_LOCAL_ONLY=true` required for production-like runs; `BOT_ALLOW_REMOTE=true` is a dangerous override. See [src/security/localOnly.ts](src/security/localOnly.ts) for policy.
- **Dev mode**: Set `BOT_API_DEV_MODE=true` to skip proxy header checks in development (Next.js dev server adds `x-forwarded-for`). Never use in production.

## Frontend/API shape
- Next.js app is under [web/](web/); UI in [web/app/](web/app/) and API routes in [web/pages/api/](web/pages/api/).
- API handlers are wrapped with `withLocalApi` for localhost-only + `requestId` injection (examples: [web/pages/api/health.ts](web/pages/api/health.ts), [web/pages/api/bot/run.ts](web/pages/api/bot/run.ts)).
- The dashboard controls the in-process bot via `botController` and `runtimeHooks` (see [web/lib/botController.ts](web/lib/botController.ts)). This is not a separate service.
- Client fetches use typed Zod validation + caching in [web/lib/apiClient.ts](web/lib/apiClient.ts). Keep response DTOs in sync with API handlers.

## Config & conventions
- `.env` is loaded in [src/config/index.ts](src/config/index.ts) (root and CWD). XRP must have no issuer; issued currencies must include an issuer. Allowed pairs are constrained by [src/config/tradingPairs.ts](src/config/tradingPairs.ts).
- Trading pair validation happens at runtime startup; do not skip `validateTradingPair` and `assertAllowedPair` in `TradingRuntime`.

## Workflows (from scripts)
- Dev (bot + dashboard): `npm run dev`
- Prod build: `npm run build` (backend tsc + Next build)
- Start: `npm run start` (localhost-only server)
- Tests: `npm run test` (Vitest, examples: [src/runtime/__tests__/shutdown.test.ts](src/runtime/__tests__/shutdown.test.ts), [web/lib/__tests__/withLocalApi.test.ts](web/lib/__tests__/withLocalApi.test.ts))
- Lint: `npm run lint`
- Testnet wallet: `npm run faucet`

## Persistence & ops
- Path-arb breaker state persists via Redis or file storage (see [src/persistence/breakerStore.ts](src/persistence/breakerStore.ts)); data files live under [data/](data/).
- Graceful shutdown cancels offers and disconnects XRPL; see shutdown flow in [src/index.ts](src/index.ts) and [src/runtime/tradingRuntime.ts](src/runtime/tradingRuntime.ts).