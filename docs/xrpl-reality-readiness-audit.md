# XRPL Trading Reality Audit (Data-Learning Stage)

This audit evaluates the current codebase against a **data-learning-stage** mandate (not production alpha), with focus order:
1. Data quality
2. Risk safety
3. Execution stability
4. Churn reduction
5. Edge measurement

## Executive verdict (current branch)

- **Can repo measure real edge?** **YES (infrastructure present), but edge quality depends on operational coverage.**
- **Is reject churn controllable?** **PARTIALLY YES.** Multiple controls exist, but they are config-dependent and not all are hard-blocking by default.
- **Is reserve failure possible?** **YES in principle, mitigated by dynamic reserve checks and emergency shutdown.**
- **Is post-fill measurement reliable?** **YES at code-path level (scheduled + persisted + tested), but runtime coverage still depends on feed continuity.**
- **Can runtime survive 7-day run?** **PARTIALLY YES.** There are strong guards for reconnect/recovery/state gating, but durability is still an operational outcome that must be proven in soak metrics.
- **Is data statistically usable?** **Potentially YES** once post-fill capture and reject/churn rates stay within targets.

---

## 1) Data quality and edge-measurement capability

### Required per-fill fields
The repository stores and updates all core edge-learning fields required for entry/post comparisons:
- entry context: `entryMid`, `entrySpreadBps`, `entrySignalStrength`, `entryLocalExtreme`
- post context: `postMid1s`, `postMid3s`, `postSignal1s`, `postSignal3s`

These exist in the trade event type and SQL schema, and are persisted/updated by DB functions. This satisfies the minimum schema requirement for 1s/3s post-entry drift analysis.

### Post-fill capture pipeline
`OfferExecutor` schedules deterministic 1s and 3s snapshot captures after a fill, then writes them back via feedback DB update functions. Unit tests verify this scheduling and persistence path.

### Bucket analysis support
A dedicated bucket script groups fills by spread bucket, signal bucket, and imbalance regime (`local_extreme` vs `global`) and computes net 1s/3s drift in bps. This directly supports early-stage edge validation and churn diagnostics.

**Assessment:** The repo has the right primitives for **measurable edge learning**, including both schema and analysis tooling.

---

## 2) Reject churn controllability

### Controls present
- Entry gate has configurable reject-rate throttle (`rejectThrottleMaxRate`, lookback window, cooldown, minimum spread uplift), with optional hard block mode.
- Strategy layer already has cooldown hooks.
- Repricing policy and execution-quality analytics exist for diagnosing replace/reject behavior.

### Practical caveat
Default entry-gate reject throttle is disabled unless explicitly turned on via env. That means reject churn control is available, but not guaranteed unless configured and monitored.

**Assessment:** Churn is **controllable in architecture**, but operationally only if reject throttle + spread discipline + cooldown settings are actively enforced.

---

## 3) Reserve safety under micro-account constraints

### Safeguards present
- Dynamic reserve calculation uses live XRPL `server_state` reserve parameters plus account `OwnerCount` to compute required reserve.
- `RiskEngine.checkReserves()` enforces `reserveFloorXRP` and can trigger emergency shutdown when reserves are inadequate.
- Reserve config supports additional bps/XRP safety buffer.

### Residual risk
Reserve breach is still possible due to trustline/offer churn and balance drift; current behavior is to halt safely rather than continue trading.

**Assessment:** Reserve failure is **possible but defended**, with fail-safe shutdown behavior suitable for small-balance survival.

---

## 4) Execution stability and 7-day survivability posture

### Runtime protections present
- `ExecutionGate` blocks execution on non-ready runtime states, reconnecting/disconnected feed, pair-switch phases, stall recovery in progress, stale balances/ledger, invalid snapshots, and poor health score.
- Feed-stall recovery escalates from soft reconnect to hard resubscribe to full client rebuild.
- Risk kill-switch hooks (consecutive failures / daily loss) exist in risk and protection layers.

### What this means
The code is aligned with survival-first operation, but “7-day stable run” remains a runtime SLO to prove via production-like soak data (event-loop lag, reconnect counts, snapshot continuity, etc.).

**Assessment:** **Strong defensive runtime design**, pending statistical validation through sustained live operation.

---

## 5) Readiness framing for current stage

Given current stage is **data learning**, this repo should prioritize:
1. Keeping post-fill coverage high and observable.
2. Forcing reject-rate throttles when churn exceeds threshold.
3. Preserving reserve headroom by limiting object churn.
4. Running bucket/post-entry drift analysis continuously.

Short-term recommendation: treat this as **instrumentation hardening + execution hygiene** phase, not alpha optimization.

