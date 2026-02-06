# XRPL Trading Bot — Agent Notes

## Architecture (big picture)
- **Single-process runtime**: the bot backend and Next.js dashboard run in one process. No dual-process mode.
- Backend loop lives in [src/index.ts](../../src/index.ts) and [src/runtime/tradingRuntime.ts](../src/runtime/tradingRuntime.ts): connect XRPL → refresh order book → run strategies → execute offers. Data flow: `XRPLWebSocket` → `OrderBookTracker` → strategies in [src/strategies/](../src/strategies/) → `OfferExecutor` → `RiskEngine`.
- Strategies are wired in `TradingRuntime.start()` (Scalper, AMM arb, Path arb). When adding a new strategy, register it there and respect `Strategy` interface in [src/strategies/types.ts](../src/strategies/types.ts).
- Risk controls are centralized in [src/risk/riskEngine.ts](../src/risk/riskEngine.ts): daily loss reset, reserve checks, issuer allowlist/blacklist. Use it before sending any on-ledger action.
- Order book normalization/price logic is in [src/market/orderBookTracker.ts](../src/market/orderBookTracker.ts); it converts XRP drops vs issued currency amounts and computes spread bps.

## Localhost-only security (do not bypass by default)
- Multiple enforced gates: CLI startup [src/index.ts](../src/index.ts), runtime construction [src/runtime/tradingRuntime.ts](../src/runtime/tradingRuntime.ts), Next server [server.js](../server.js), and API middleware [src/ui/lib/localApi/withLocalApi.ts](../src/ui/lib/localApi/withLocalApi.ts).
- Environment flags: `BOT_LOCAL_ONLY=true` required for production-like runs; `BOT_ALLOW_REMOTE=true` is a dangerous override. See [src/security/localOnly.ts](../src/security/localOnly.ts) for policy.
- **Dev mode**: Set `BOT_API_DEV_MODE=true` to skip proxy header checks in development (Next.js dev server adds `x-forwarded-for`). Never use in production.

## Frontend/API shape
- Next.js UI lives under [src/ui/](../src/ui/); App Router in [src/ui/app/](../src/ui/app/), API routes in [src/ui/pages/api/](../src/ui/pages/api/), components in [src/ui/components/](../src/ui/components/), shared libs in [src/ui/lib/](../src/ui/lib/).
- API handlers are wrapped with `withLocalApi` for localhost-only + `requestId` injection (examples: [src/ui/pages/api/health.ts](../src/ui/pages/api/health.ts), [src/ui/pages/api/bot/run.ts](../src/ui/pages/api/bot/run.ts)).
- The dashboard controls the in-process bot via `botController` and `runtimeHooks` (see [src/ui/lib/botController.ts](../src/ui/lib/botController.ts)). This is not a separate service.
- Client fetches use typed Zod validation + caching in [src/ui/lib/apiClient.ts](../src/ui/lib/apiClient.ts). Keep response DTOs in sync with API handlers.

## Config & conventions
- `.env` is loaded in [src/config/index.ts](../src/config/index.ts) (root and CWD). XRP must have no issuer; issued currencies must include an issuer. Allowed pairs are constrained by [src/config/tradingPairs.ts](../src/config/tradingPairs.ts).
- Trading pair validation happens at runtime startup; do not skip `validateTradingPair` and `assertAllowedPair` in `TradingRuntime`.
- Root `tsconfig.json` is for backend (CommonJS); `tsconfig.web.json` is for Next.js UI (ESNext/bundler).
- Root `tailwind.config.ts` scans `./src/ui/` for content.
- Root `next.config.mjs` points `typescript.tsconfigPath` at `tsconfig.web.json`.

## Workflows (from scripts)
- Dev (bot + dashboard): `npm run dev`
- Prod build: `npm run build` (backend tsc + Next build)
- Start: `npm run start` (localhost-only server via server.js)
- Tests: `npm run test` (Vitest, examples: [src/runtime/__tests__/shutdown.test.ts](../src/runtime/__tests__/shutdown.test.ts), [src/ui/lib/__tests__/withLocalApi.test.ts](../src/ui/lib/__tests__/withLocalApi.test.ts))
- Lint: `npm run lint`
- Testnet wallet: `npm run faucet`

## Persistence & ops
- Path-arb breaker state persists via Redis or file storage (see [src/persistence/breakerStore.ts](../src/persistence/breakerStore.ts)); data files live under [data/](../data/).
- Graceful shutdown cancels offers and disconnects XRPL; see shutdown flow in [src/index.ts](../src/index.ts) and [src/runtime/tradingRuntime.ts](../src/runtime/tradingRuntime.ts).