# 🔍 XRPL Trading Bot – Principal Engineer Audit Report

## 1. System Map

| Module | Path | Responsibility |
|--------|------|----------------|
| **API Layer** | `web/pages/api/bot/*` | Next.js API routes with HMAC auth for bot control |
| **Bot Controller** | `web/lib/botController.ts` | State machine (RUNNING/PAUSED/STOPPED) |
| **Runtime Hooks** | `web/lib/runtimeHooks.ts` | Bridges API to TradingRuntime |
| **Trading Runtime** | `src/runtime/tradingRuntime.ts` | Core orchestrator: strategies, risk, XRPL |
| **XRPL Client** | `src/xrpl/client.ts` | WebSocket wrapper, reconnect, order book polling |
| **Wallet** | `src/xrpl/wallet.ts` | Seed/secret numbers → Wallet object |
| **Signer** | `src/xrpl/signer.ts` | Signer interface (seed/xumm/ledger/kms stubs) |
| **Order Book Tracker** | `src/market/orderBookTracker.ts` | Normalizes bid/ask data |
| **Offer Executor** | `src/execution/offerExecutor.ts` | Builds & submits OfferCreate/Cancel |
| **Transaction Engine** | `src/xrpl/transactionEngine.ts` | Retry logic, sequence management |
| **Risk Engine** | `src/risk/riskEngine.ts` | Daily loss, reserve floor, kill switch |
| **Scalper Strategy** | `src/strategies/scalper.ts` | Market-making strategy |
| **Path Arbitrage** | `src/strategies/pathArbitrage.ts` | ripple_path_find arbitrage |
| **AMM Arbitrage** | `src/strategies/ammArbitrage.ts` | AMM price discrepancy detection |
| **Config** | `src/config/index.ts` | Env parsing, defaults |
| **Auth** | `web/lib/botAuth/*` | HMAC, nonce, rate-limit, RBAC |

---

## 2. Trust Boundaries & Secrets Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  External Request                                                           │
│    ↓                                                                        │
│  Next.js API Route  ←─── withBotAuth() ←─── X-API-KEY, X-SIGNATURE headers  │
│    ↓ (if auth passes)                                                       │
│  botController.run()/pause()/kill()                                         │
│    ↓                                                                        │
│  TradingRuntime.start()                                                     │
│    ├─→ initWallet(config) ←── process.env.XRPL_SEED / XRPL_SECRET_NUMBERS   │
│    │        ↓                                                               │
│    │   Wallet object stored in module-level `ctx`                           │
│    │                                                                        │
│    ├─→ XRPLWebSocket.connect()                                              │
│    ├─→ OfferExecutor.placeOffer()                                           │
│    │        ↓                                                               │
│    │   wallet.sign(tx) → client.submitAndWait()                             │
│    │                                                                        │
│    └─→ RiskEngine.checkReserves() / approveIntent()                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Secret Locations:**
- `.env` (XRPL_SEED, XRPL_SECRET_NUMBERS, BOT_API_KEYS)
- `vercel.json` → env section (non-sensitive only, but wallet secrets must be in Vercel dashboard)

---

## 3. Top 10 P0/P1 Issues

1. **P0** – BOT_API_KEYS stored as raw hex in `.env`, not JSON array → auth fails silently
2. **P0** – `orders.ts` directly loads wallet seed to sign cancel tx, bypassing Signer abstraction
3. **P0** – `submitAndWait` can block up to ledger timeout (~4s × 4) with no wrapper timeout
4. **P0** – No idempotency key on `/api/bot/run` – double-click can corrupt state
5. **P1** – `orders.ts` opens new XRPL Client per request instead of shared client
6. **P1** – `req.body` used after `bodyParser: false` → always `undefined` (broken POST handlers)
7. **P1** – Circuit breaker in PathArbitrage only tracks PnL in memory – lost on restart
8. **P1** – `TransactionEngine` sequence cache is per-instance – stale on multi-worker
9. **P1** – No graceful shutdown – SIGTERM doesn't cancel pending offers
10. **P1** – Daily loss reset never happens (`dailyLoss` accumulates forever)

---

## 4. Findings Table

| # | Title | Severity | Where | Why It Matters | Minimal Fix | Robust Fix | Complexity |
|---|-------|----------|-------|----------------|-------------|------------|------------|
| 1 | **BOT_API_KEYS parse failure** | P0 | `web/lib/botAuth/env.ts#L67` | Keys stored as raw hex, not JSON array → all API auth fails | Fix `.env` to use JSON array format | Add startup validation that logs error & exits if invalid | S |
| 2 | **Wallet seed in orders.ts API route** | P0 | `web/pages/api/bot/orders.ts#L76-L80` | Creates wallet in API route, bypasses Signer, plaintext in memory | Use shared signer from TradingRuntime | Route cancel through botController/executor | M |
| 3 | **No timeout on submitAndWait** | P0 | `src/execution/offerExecutor.ts#L239` | Can block 16+ seconds, causes API timeout & ambiguous state | Wrap in `Promise.race` with 10s timeout | Use `submit` + poll ledger for validation | M |
| 4 | **No idempotency on /run** | P0 | `web/pages/api/bot/run.ts` | Double-submit corrupts state, throws "already running" | Check state before calling `run()` | Add idempotency key in request, store in Redis | S |
| 5 | **New XRPL Client per orders request** | P1 | `web/pages/api/bot/orders.ts#L71-L72` | Rate-limited by XRPL nodes, connection leak risk | Use `getSharedClient()` from xrplClient.ts | Pool connections with health checks | S |
| 6 | **req.body undefined with bodyParser:false** | P1 | `web/pages/api/bot/orders.ts#L41`, `web/pages/api/bot/position-size.ts#L15` | POST body never parsed → all mutations broken | Use `authReq.parsedBody` or `req.parsedBody` | Unify body access via AuthenticatedRequest | S |
| 7 | **Circuit breaker state not persisted** | P1 | `src/strategies/pathArbitrage.ts#L36-L40` | Restart resets breaker → can resume losing trades | Persist to file/Redis | Use Redis with TTL | M |
| 8 | **Stale sequence number** | P1 | `src/xrpl/transactionEngine.ts#L125-L131` | Cached sequence wrong after external tx → `tefPAST_SEQ` | Always fetch before first tx per session | Fetch sequence per-tx batch | S |
| 9 | **No graceful shutdown** | P1 | `src/runtime/tradingRuntime.ts` | SIGTERM leaves open orders, no cleanup | Cancel all pending offers in `kill()` | Implement signal handlers in index.ts | M |
| 10 | **dailyLoss never resets** | P1 | `src/risk/riskEngine.ts#L20` | Accumulates forever → permanent shutdown | Add daily reset logic | Schedule reset at UTC midnight | S |
| 11 | **Testnet seed committed in .env** | P0 | `.env#L14` | Seed `sEd755...` visible in repo | Remove from repo, add to `.env.example` placeholder | Move all secrets to Vercel env vars | S |
| 12 | **Missing input validation on API routes** | P1 | `web/pages/api/bot/position-size.ts` | No schema validation → type confusion | Add zod schema | Centralized validation middleware | M |
| 13 | **Order book staleness check weak** | P1 | `src/strategies/scalper.ts#L36` | 15s threshold too long for volatile markets | Reduce to 5s | Make configurable, add staleness metric | S |
| 14 | **No request correlation ID in logs** | P2 | All API routes | Can't trace errors across services | Add `requestId` to all handlers | Use pino with request context | S |
| 15 | **console.log instead of logger** | P2 | `web/lib/botController.ts`, `web/pages/api/bot/orders.ts` | Unstructured logs, no levels | Replace with `logger.info()` | Adopt pino everywhere | S |
| 16 | **No tests for API routes** | P2 | `web/pages/api/bot/*` | Regressions undetected | Add vitest tests with mocks | Integration tests with test XRPL client | L |
| 17 | **Partial fill not properly handled** | P2 | `src/execution/offerExecutor.ts#L287` | Assumes IOC fills fully or not at all | Parse AffectedNodes for actual fill | Track open orders, reconcile fills | M |
| 18 | **`any` type usage widespread** | P2 | Multiple files | Type safety lost | Add proper types | Enable strict mode in tsconfig | M |
| 19 | **No CI pipeline** | P3 | `/` | No automated checks | Add GitHub Actions workflow | Add lint, test, type-check stages | S |
| 20 | **No health check endpoint** | P3 | `web/pages/api/` | Can't monitor service status | Add `/api/health` route | Include XRPL connection status | S |

---

## 5. P0/P1 Edit Checklist

### P0-1: Fix BOT_API_KEYS format in .env

**File:** `.env`  
**Change:** Replace raw hex with JSON array

```diff
-BOT_API_KEYS=52ed1386f306c1a6633eec87fd9863c52ff3700732da58cf6ca1388c28f87955
+BOT_API_KEYS='[{"id":"admin-key-01","secret":"52ed1386f306c1a6633eec87fd9863c52ff3700732da58cf6ca1388c28f87955","role":"admin"}]'
```

---

### P0-2: Remove wallet creation from orders.ts

**File:** `web/pages/api/bot/orders.ts`  
**Function:** `handler()` (lines 71-85) and `cancelOffer()` (lines 205-232)  
**Change:** Use shared runtime instead of creating wallet inline

```diff
-// Get wallet
-let wallet: Wallet | null = null;
-if (cfg.walletSeed) {
-    wallet = Wallet.fromSeed(cfg.walletSeed);
-} else if (cfg.walletSecretNumbers) {
-    const secretNums = cfg.walletSecretNumbers.split(',').map(n => n.trim());
-    wallet = walletFromSecretNumbers(secretNums);
-}
+// Use shared client - wallet operations should go through botController/executor
+import { getSharedClient } from '../../../lib/xrplClient';
+import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
+
+const client = await getSharedClient(cfg.xrpl.endpoint);
+const runtime = ensureRuntimeHooks();
```

For DELETE, route through executor:
```diff
-async function cancelOffer(config, sequence) { ... wallet.sign() ... }
+// In handler DELETE block:
+const runtime = ensureRuntimeHooks();
+const result = await runtime.cancelOffer(sequence); // Add this method to TradingRuntime
```

---

### P0-3: Add timeout wrapper to submitAndWait

**File:** `src/execution/offerExecutor.ts`  
**Function:** `submitWithGuards()` (line 239)  
**Change:** Wrap in timeout

```diff
+const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
+    Promise.race([
+        promise,
+        new Promise<never>((_, reject) =>
+            setTimeout(() => reject(new Error('Transaction timeout')), ms)
+        ),
+    ]);

-const res = await this.client.submitAndWait(signed.tx_blob);
+const res = await withTimeout(this.client.submitAndWait(signed.tx_blob), 12_000);
```

---

### P0-4: Add idempotency check to /run

**File:** `web/pages/api/bot/run.ts`  
**Function:** `handler()` (line 13)  
**Change:** Return success if already running instead of throwing

```diff
async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
+   // Idempotent: if already running, return success
+   const currentState = botController.getState();
+   if (currentState === 'RUNNING') {
+       return res.status(200).json({ state: currentState, message: 'Bot already running' });
+   }
    try {
        ensureRuntimeHooks();
        const state = await botController.run();
```

---

### P0-5: Remove testnet seed from .env

**File:** `.env`  
**Change:** Remove seed, use placeholder

```diff
-XRPL_SEED=sEd755ezAnMofCL3qD7JrMZC9N1JzFB
+# XRPL_SEED=your-testnet-seed-here
```

---

### P1-1: Fix req.body access in authenticated routes

**File:** `web/pages/api/bot/orders.ts`, `position-size.ts`, `trading-pair.ts`  
**Function:** All handlers using `req.body`  
**Change:** Use parsed body from auth wrapper

```diff
-const { autoManageEnabled, stalenessThresholdSec } = req.body;
+const { autoManageEnabled, stalenessThresholdSec } = (req as AuthenticatedRequest).parsedBody ?? {};
```

**File:** `web/pages/api/bot/position-size.ts`
```diff
-const { size } = req.body as { size?: number };
+const body = (req as AuthenticatedRequest).parsedBody as { size?: number } | null;
+const { size } = body ?? {};
```

---

### P1-2: Use shared XRPL client in orders.ts

**File:** `web/pages/api/bot/orders.ts`  
**Function:** `handler()` GET block (line 71)  
**Change:** Use getSharedClient

```diff
-const client = new Client(cfg.xrpl.endpoint);
-await client.connect();
+import { getSharedClient } from '../../../lib/xrplClient';
+const client = await getSharedClient(cfg.xrpl.endpoint);
```

Remove disconnect calls (shared client manages lifecycle):
```diff
-await client.disconnect();
```

---

### P1-3: Add daily loss reset

**File:** `src/risk/riskEngine.ts`  
**Function:** Add method and call site  
**Change:** Add reset method

```diff
+private lastResetDate: string = new Date().toISOString().split('T')[0];

+checkAndResetDaily(): void {
+    const today = new Date().toISOString().split('T')[0];
+    if (today !== this.lastResetDate) {
+        logger.info({ previousLoss: this.dailyLoss }, 'Resetting daily loss counter');
+        this.dailyLoss = 0;
+        this.lastResetDate = today;
+    }
+}
```

Call in `TradingRuntime.tick()`:
```diff
async tick(): Promise<void> {
+   this.risk?.checkAndResetDaily();
    if (!this.started || !this.xrpl || !this.tracker || !this.risk) {
```

---

### P1-4: Fix sequence stale cache

**File:** `src/xrpl/transactionEngine.ts`  
**Function:** `ensureSequence()` (line 125)  
**Change:** Always fetch fresh sequence on first tx of session

```diff
-private sequence: number | null = null;
+private sequence: number | null = null;
+private sequenceFetchedAt: number = 0;
+private readonly SEQUENCE_TTL_MS = 30_000; // Refresh after 30s

private async ensureSequence(account: string): Promise<void> {
-   if (this.sequence !== null) return;
+   const now = Date.now();
+   if (this.sequence !== null && (now - this.sequenceFetchedAt) < this.SEQUENCE_TTL_MS) return;
    const info = await this.opts.client.request({
        command: 'account_info',
        account,
        ledger_index: 'current',
    });
    this.sequence = info.result.account_data.Sequence;
+   this.sequenceFetchedAt = now;
}
```

---

## 6. Proposed Fix Plan

### Sprint 1 (Week 1-2): Critical Security & Stability

| Task | Files | Est |
|------|-------|-----|
| Fix BOT_API_KEYS format | `.env`, `env.ts` | 0.5d |
| Remove seed from .env | `.env` | 0.5d |
| Add timeout to submitAndWait | `offerExecutor.ts` | 0.5d |
| Fix req.body access (parsedBody) | `orders.ts`, `position-size.ts`, `trading-pair.ts` | 0.5d |
| Add idempotency to /run | `run.ts` | 0.5d |
| Remove wallet creation from orders.ts | `orders.ts` | 1d |
| Use shared XRPL client everywhere | `orders.ts`, `wallet.ts` | 0.5d |
| Add daily loss reset | `riskEngine.ts`, `tradingRuntime.ts` | 0.5d |
| Fix sequence cache TTL | `transactionEngine.ts` | 0.5d |

**Sprint 1 Total: ~5.5 days**

---

### Sprint 2 (Week 3-4): Reliability & Observability

| Task | Files | Est |
|------|-------|-----|
| Add graceful shutdown | `tradingRuntime.ts`, `index.ts` | 1d |
| Persist circuit breaker state | `pathArbitrage.ts` | 1d |
| Add input validation (zod) | All API routes | 1.5d |
| Replace console.log with logger | `botController.ts`, `orders.ts`, etc | 0.5d |
| Add request correlation IDs | `withBotAuth.ts`, all handlers | 1d |
| Add /api/health endpoint | New file | 0.5d |
| Reduce order book staleness to 5s | `scalper.ts`, config | 0.5d |
| Add startup env validation | `config/index.ts` | 0.5d |

**Sprint 2 Total: ~6.5 days**

---

### Sprint 3 (Week 5-6): Testing & Quality

| Task | Files | Est |
|------|-------|-----|
| Add API route tests | `web/__tests__/` | 2d |
| Add risk engine tests | `src/__tests__/` | 1d |
| Add offer executor tests | `src/__tests__/` | 1d |
| Add CI pipeline | `.github/workflows/` | 0.5d |
| Enable strict TypeScript | `tsconfig.json` | 1d |
| Fix `any` types | Multiple | 2d |
| Partial fill handling | `offerExecutor.ts` | 1d |

**Sprint 3 Total: ~8.5 days**

---

## 7. Quick Wins (≤1 day)

1. Fix `.env` BOT_API_KEYS format → **30 min**
2. Remove testnet seed from `.env` → **10 min**
3. Add idempotency to `/run` → **1 hour**
4. Fix `req.body` → `req.parsedBody` in routes → **1 hour**
5. Use `getSharedClient()` in orders.ts → **30 min**
6. Add daily loss reset → **2 hours**
7. Reduce staleness threshold → **15 min**
8. Replace console.log → logger → **2 hours**

---

## 8. Files to Change First (Ordered)

1. `.env` – Fix BOT_API_KEYS format, remove seed
2. `web/pages/api/bot/run.ts` – Idempotency
3. `web/pages/api/bot/orders.ts` – Shared client, remove wallet, fix body
4. `web/pages/api/bot/position-size.ts` – Fix body
5. `web/pages/api/bot/trading-pair.ts` – Fix body
6. `src/execution/offerExecutor.ts` – Add timeout
7. `src/risk/riskEngine.ts` – Daily reset
8. `src/xrpl/transactionEngine.ts` – Sequence TTL
9. `src/runtime/tradingRuntime.ts` – Graceful shutdown
10. `src/strategies/pathArbitrage.ts` – Persist circuit breaker

---

## Summary

**Critical (P0):** 5 issues – All must be fixed before any production use  
**Serious (P1):** 9 issues – Should be addressed within 2 weeks  
**Maintainability (P2):** 5 issues – Address in sprint 3  
**Nice-to-have (P3):** 2 issues – Backlog

The most dangerous issues are:
1. **Auth completely broken** due to BOT_API_KEYS format
2. **Wallet seed in API route** creates unnecessary exposure
3. **No timeout on transactions** can hang the entire system
4. **req.body always undefined** means mutations don't work
