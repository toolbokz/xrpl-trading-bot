# AGENTS.md — XRPL Trading Bot Coding Rules (Non-negotiable)

## Safety & Capital Preservation
- Never change execution semantics of ExecutionGate / HardRiskGuard / CapitalProtection unless explicitly requested.
- Prefer false negatives over false positives: when uncertain, BLOCK execution.
- No new trading logic may bypass OfferExecutor.
- No new network endpoints or remote access. Localhost-only must remain enforced.

## Reliability
- The runtime tick loop must never be blocked by background tasks.
- All new background tasks must be cancellable and idempotent on shutdown.
- Any external call must be rate-limited and have timeouts.
- Errors must be handled; no unhandled promise rejections.

## Architecture
- Do not create additional XRPL websocket clients; reuse sharedClient singleton.
- All state must be pair-scoped and avoid cross-pair contamination.
- All new features must write through RuntimeCacheRegistry for UI/API visibility.

## Testing
- Add unit tests for new logic, especially pricing/fair-value/filters.
- Add at least one integration test/harness ensuring the bot runs N ticks without regression.
- Tests must validate: no new XRPL clients created; no tick-loop slowdown beyond threshold.

## Code Quality
- TypeScript strict; no `any` unless justified.
- Prefer pure functions; keep side effects at edges.
- Add structured logs/events for all important state changes.
