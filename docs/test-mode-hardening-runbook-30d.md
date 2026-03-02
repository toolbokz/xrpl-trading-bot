# XRPL Test-Mode Hardening Runbook (30 Days)

Owner: Trading Systems Reliability
Start Date: ____________________
Bot Version/Commit: ____________________
Environment: XRPL Mainnet (test-mode controls active)

---

## 1) Purpose and Operating Rules

This runbook is for structured hardening of an existing XRPL trading bot before broad live operation.

Non-goals:
- No production strategy expansion.
- No alpha tuning.
- No risk-boundary relaxation without explicit phase gate approval.

Execution rules:
- Use this document as the system of record for each shift.
- Check every box, even if N/A (mark N/A and explain).
- Open an incident ticket for every Tier 2+ event.
- Do not advance phases unless gate criteria are met.

Automation commands:
- One-command shift orchestration (scenario set -> score -> gate -> handoff report):
  - `npm run hardening:day -- --target phase2 --date YYYY-MM-DD --shift shift-A`
- Scenario capture:
  - `npm run hardening:scenario -- --scenario S3 --durationSec 300`
  - Optional injection hook:
    - `npm run hardening:scenario -- --scenario S5 --durationSec 300 --inject-command "sudo systemctl restart xrpl-bot" --inject-at-sec 20`
- Daily score:
  - `npm run hardening:score -- --date YYYY-MM-DD`
- Phase gate:
  - `npm run hardening:gate -- --target phase2 --date YYYY-MM-DD`
  - `npm run hardening:gate -- --target phase3 --date YYYY-MM-DD`
  - `npm run hardening:gate -- --target phase4 --date YYYY-MM-DD`
  - `npm run hardening:gate -- --target latency-capable --date YYYY-MM-DD`

Output locations:
- Scenario outputs: `data/hardening/YYYY-MM-DD/Sx-*.json`
- Daily score: `data/hardening/YYYY-MM-DD/daily-score.json`
- Manual metrics input template: `data/hardening/YYYY-MM-DD/manual-metrics.json`
- Handoff reports (single-shift output):
  - `data/hardening/YYYY-MM-DD/handoff-*.json`
  - `data/hardening/YYYY-MM-DD/handoff-*.md`

---

## 2) Test Mode Definitions

## Mode A: Paper Simulation Mode

Enabled:
- Signal generation and event-sourced intent creation
- Full lifecycle state transitions in simulation
- Reconciliation loop against simulated fills
- Dashboard/telemetry and kill-switch dry-run path

Disabled:
- Real XRPL transaction submission/signing
- Real sequence/ticket consumption
- Any real balance movement

Risk boundaries:
- Enforce synthetic caps exactly as if live

Capital limits:
- Real capital at risk: 0 XRP
- Synthetic per-trade notional: <= 10 XRP
- Synthetic daily loss cap: <= 50 XRP

Reconciliation cadence:
- Every ledger close equivalent
- Full snapshot parity check every 60 seconds

Logging requirements:
- intent_ts, submit_ts(sim), inclusion_ts(sim), fill_ts(sim), reconcile_ts
- idempotency key hits
- deterministic replay hash per cycle

---

## Mode B: Simulated Execution Mode

Enabled:
- Real market data ingestion (orderbook/AMM)
- Real intent lifecycle and state machine
- Simulated submit/ack/fill timing mapped to XRPL close cadence
- Real reconciliation logic against simulated outcomes

Disabled:
- Real OfferCreate/OfferCancel
- Real wallet signing

Risk boundaries:
- Full hard risk caps enabled (position, daily loss, outstanding exposure, staleness)

Capital limits:
- Real capital at risk: 0 XRP
- Synthetic per-trade notional: <= 5 XRP
- Synthetic daily notional cap: <= 150 XRP

Reconciliation cadence:
- Every ledger close
- Drift scan every 30 seconds
- Restart-rebuild test daily

Logging requirements:
- All Mode A logs
- Modeled inclusion ledger index and delay
- cancel/replace collision resolution lineage

---

## Mode C: Micro-Capital Live Mode

Enabled:
- Real XRPL submits and signing
- Real fills and deterministic finality handling
- Full reconciliation and kill-switch in live path

Disabled:
- Any strategy path above cap policy
- Latency-sensitive strategy variants until final Go gate

Risk boundaries:
- Hard exposure cap, slippage cap, staleness cap, drift cap
- Immediate pause on Tier 4+

Capital limits:
- Total test wallet allocation: <= 150 XRP
- Per-trade notional: <= 3 XRP
- Max concurrent open orders: 2
- Max outstanding order exposure: <= 6 XRP
- Daily realized loss cap: <= 10 XRP

Reconciliation cadence:
- At every validated ledger close
- Immediate on fill/cancel
- Full account parity check every 15 seconds

Logging requirements:
- tx_hash, ledger_index, last_ledger_sequence
- submit attempt count and final result
- fill fragments and post-trade exposure delta

---

## 3) Mandatory Daily Metrics and Thresholds

Record these metrics every shift and aggregate daily.

Latency metrics:
- Intent timestamp
- Submission timestamp
- Ledger inclusion timestamp
- Fill timestamp
- Reconciliation timestamp
- End-to-end lifecycle duration

Market metrics:
- Spread at submission
- Book depth at submission
- Expected vs realized slippage
- Fill ratio

Risk metrics:
- Exposure before/after trade
- Outstanding order exposure
- Drift incidents
- Reconciliation correction frequency

Operational metrics:
- Restart recovery duration
- State rebuild time
- Kill-switch trigger time
- Feed staleness detection time

Phase thresholds:
- Gate to Phase 2:
  - Missing/duplicate terminal transitions = 0
  - Replay divergence = 0
  - Kill-switch trigger-to-halt <= 1 ledger
  - Data Integrity score >= 16/20
- Gate to Phase 3:
  - Lifecycle completion >= 99.9%
  - Persistent drift incidents = 0
  - Intent drop rate = 0
  - Execution Determinism >= 16/20
  - Reconciliation Reliability >= 16/20
- Gate to Phase 4:
  - All XRPL edge scenarios pass
  - Unresolved Tier 3+ incidents = 0
  - Stale-feed false negatives = 0
  - Kill-switch halt + neutralization <= 2 ledgers
  - Risk Enforcement Timing >= 17/20
- Exit as Latency-Capable:
  - 7 consecutive days with no Tier 4/5
  - Unmatched on-ledger transaction/state = 0
  - p95 submit-to-inclusion <= 2 ledgers
  - Total readiness score >= 88/100 and no category < 16/20

---

## 4) Failure Classification and Required Response

Tier 1: Logging anomaly
- Response: fix telemetry/schema within 24h
- Phase reset: No
- Micro-cap pause: No (unless risk visibility compromised)

Tier 2: Minor accounting drift (auto-corrected)
- Response: same-day root cause + regression test
- Phase reset: Repeat current day if unresolved by end-of-day
- Micro-cap pause: No, if converges within 2 cycles

Tier 3: Execution state mismatch
- Response: immediate trading pause + replay audit
- Phase reset: Yes (phase checkpoint reset)
- Micro-cap pause: Yes

Tier 4: Risk breach
- Response: immediate kill-switch + freeze phase
- Phase reset: Yes
- Micro-cap pause: Yes (mandatory)

Tier 5: Capital endangerment
- Response: emergency halt + formal postmortem + control redesign
- Phase reset: Full reset to Phase 1
- Micro-cap pause: Yes (mandatory)

---

## 5) Readiness Scoring Model (0-100)

Data Integrity (20)
- Event completeness 8
- Replay determinism 6
- Timestamp chain integrity 6

Execution Determinism (20)
- Idempotent lifecycle under duplicates 8
- Boundary timing correctness 6
- Cancel/replace collision correctness 6

Reconciliation Reliability (20)
- Drift-free parity 8
- Convergence speed 6
- Restart parity restoration 6

Risk Enforcement Timing (20)
- Kill-switch speed 8
- Staleness detection correctness/speed 6
- Exposure-cap enforcement latency 6

Operational Stability (20)
- Restart MTTR 8
- State rebuild stability 6
- Incident-free endurance 6

Movement thresholds:
- Phase 1 -> 2: >= 72/100, Data Integrity >= 16
- Phase 2 -> 3: >= 78/100, Execution Determinism >= 16, Reconciliation >= 16
- Phase 3 -> 4: >= 84/100, Risk Enforcement Timing >= 17
- Exit Phase 4: >= 88/100, no category < 16

---

## 6) XRPL-Specific Stress Scenario Cards

### Scenario S1: Partial fill bursts in one ledger window
How to simulate:
- Emit one intent with many fill fragments mapped to same validated ledger index.
Expected correct behavior:
- Single economic action, correct cumulative filled qty/value, deterministic terminal state.
Observable failure signatures:
- Over/under-counted fill, duplicate terminal transition, negative residual.
Required metrics:
- fill_fragment_count, fill_agg_error, reconcile_lag_ms, terminalization_delay_ms.

### Scenario S2: Cancel/replace collision before ledger close
How to simulate:
- Dispatch cancel + replace near close boundary with randomized order.
Expected correct behavior:
- One active successor only, intact lineage, no ghost orders.
Observable failure signatures:
- Old + new both active, orphaned intent, stale active map.
Required metrics:
- collision_resolution_rate, orphan_order_count, active_order_parity_errors.

### Scenario S3: Network jitter near submission boundary
How to simulate:
- Inject 200-1200ms jitter around expected close time.
Expected correct behavior:
- Inclusion ledger may vary, but lifecycle remains deterministic and reconciled.
Observable failure signatures:
- timeout false positives, boundary misclassification causing wrong state.
Required metrics:
- submit_to_include_ledgers, boundary_misclass_rate, timeout_false_positive_rate.

### Scenario S4: Ledger close variance spikes
How to simulate:
- Run close intervals from 2s to 8s with bursty spikes.
Expected correct behavior:
- Correct staleness detection, no stale trading, no halt thrash.
Observable failure signatures:
- stale-feed trading, excessive false halts, missed stale detection.
Required metrics:
- staleness_detect_ms, staleness_false_negative_count, halt_toggle_count.

### Scenario S5: Restart during open exposure
How to simulate:
- Force process restart with open intents + pending reconciliation.
Expected correct behavior:
- Event replay restores exact exposure and open-order map.
Observable failure signatures:
- exposure mismatch after restart, duplicate replay effects.
Required metrics:
- restart_recovery_ms, exposure_parity_error, duplicate_replay_count.

### Scenario S6: Reconciliation mismatch during volatility
How to simulate:
- Rapid spread/depth shocks with delayed fill visibility.
Expected correct behavior:
- Drift corrected deterministically within bounded cycles.
Observable failure signatures:
- non-convergent correction loop, oscillating drift, cap breach.
Required metrics:
- correction_cycles_to_converge, max_drift_notional, correction_frequency.

---

## 7) Shift Execution Packet (use every shift)

Shift ID: ____________________
Date: ____________________
Phase/Day: ____________________
Mode: [ ] Mode A  [ ] Mode B  [ ] Mode C
Operator: ____________________
Reviewer: ____________________

Pre-shift checks:
- [ ] Config hash matches approved baseline
- [ ] Kill-switch endpoint/path tested (non-destructive check)
- [ ] Reconciliation loop healthy
- [ ] Dashboard panel freshness within threshold
- [ ] Incident queue reviewed from prior shift

Shift tasks completed:
- [ ] Execute planned scenario/task for day
- [ ] Collect mandatory metrics snapshot 1
- [ ] Collect mandatory metrics snapshot 2
- [ ] Validate terminal-state completeness
- [ ] Validate exposure parity and open-order parity

Shift outcome:
- [ ] PASS
- [ ] PASS with exceptions (ticket required)
- [ ] FAIL (phase/day repeat)

Handoff summary:
- Key observations:
  - _______________________________________________
  - _______________________________________________
- Outstanding risks:
  - _______________________________________________
- Required next-shift actions:
  - _______________________________________________

---

## 8) Incident Ticket Template (mandatory for Tier 2+)

Ticket ID: INC-____________________
Date/Time (UTC): ____________________
Detected by Shift: ____________________
Phase/Day: ____________________
Mode: ____________________

Classification:
- Severity Tier: [ ] 1 [ ] 2 [ ] 3 [ ] 4 [ ] 5
- Category: [ ] Data Integrity [ ] Execution [ ] Reconciliation [ ] Risk [ ] Operations

Incident details:
- Trigger condition:
  - _______________________________________________
- XRPL context (ledger range, close variance, network state):
  - _______________________________________________
- Affected intents/orders/tx hashes:
  - _______________________________________________

Timeline:
- T0 detection: ____________________
- T1 containment started: ____________________
- T2 containment complete: ____________________
- T3 service restored: ____________________

Impact:
- Exposure impact: ____________________
- Capital impact: ____________________
- Reconciliation impact: ____________________

Actions:
- Immediate containment:
  - _______________________________________________
- Root cause:
  - _______________________________________________
- Corrective fix:
  - _______________________________________________
- Regression test added:
  - _______________________________________________

Decision controls:
- Phase reset required: [ ] Yes [ ] No
- Micro-cap pause required: [ ] Yes [ ] No
- Approval to resume: ____________________

---

## 9) 30-Day Daily Checklist (Printable)

Legend:
- Objective: what must be proven that day
- Stop conditions are hard stops

### Phase 1: Observability & Determinism Validation

Day 1 - Event determinism baseline
- [ ] Validate unique intent IDs and idempotency keys
- [ ] Validate complete lifecycle transitions
- [ ] Record replay hash baseline
- [ ] Verify missing terminal transitions = 0
- [ ] Stop if Tier 3+

Day 2 - Timestamp chain integrity
- [ ] Validate monotonic ordering: intent -> submit -> inclusion -> fill -> reconcile
- [ ] Record monotonicity violation count
- [ ] Verify violations = 0
- [ ] Stop if Tier 2+ critical ambiguity

Day 3 - Replay determinism
- [ ] Run 2 independent replays from same event log
- [ ] Compare end-state checksums
- [ ] Verify replay divergence = 0
- [ ] Stop if Tier 3

Day 4 - Duplicate input resilience
- [ ] Inject duplicate market/intention inputs
- [ ] Verify dedupe path on idempotency keys
- [ ] Verify no duplicated exposure
- [ ] Stop if Tier 4

Day 5 - Kill-switch timing (dry-run)
- [ ] Trigger synthetic risk breach path
- [ ] Measure trigger-to-halt in ledgers and ms
- [ ] Verify halt <= 1 ledger and no post-halt intents
- [ ] Stop if Tier 4

Day 6 - Restart parity
- [ ] Restart during simulated open exposure
- [ ] Measure rebuild time
- [ ] Verify exposure/open-order parity after recovery
- [ ] Stop if Tier 3+

Day 7 - Gate review
- [ ] Compute readiness score
- [ ] Verify all Phase 1 thresholds
- [ ] Approve/deny move to Phase 2
- [ ] Stop if gate fails

### Phase 2: Execution & Reconciliation Stress Testing

Day 8 - Simulated execution activation
- [ ] Enable Mode B timing realism
- [ ] Validate modeled inclusion delays (1-3 ledgers)
- [ ] Verify lifecycle completion >= 99.9%
- [ ] Stop if Tier 3

Day 9 - Burst throughput
- [ ] Execute 5x intent-rate burst
- [ ] Record queue depth and drops
- [ ] Verify drop rate = 0
- [ ] Stop if Tier 3+

Day 10 - Burst fill reconciliation
- [ ] Simulate fragmented fill storms
- [ ] Measure reconcile lag p95
- [ ] Verify persistent drift = 0
- [ ] Stop if Tier 3

Day 11 - Cancel/replace race
- [ ] Execute collision matrix near close boundary
- [ ] Verify single active successor
- [ ] Verify orphan order count = 0
- [ ] Stop if Tier 4

Day 12 - Boundary jitter
- [ ] Inject 200-1200ms boundary jitter
- [ ] Measure boundary misclassification rate
- [ ] Verify misclassification <= 0.1%
- [ ] Stop if Tier 3

Day 13 - Close variance spikes
- [ ] Simulate close interval spikes 2s-8s
- [ ] Verify stale-feed false negatives = 0
- [ ] Verify false-positive halt rate < 1%
- [ ] Stop if Tier 4 stale-trading breach

Day 14 - Combined stress
- [ ] Run burst + jitter + collision + restart in one test
- [ ] Record MTTR and unresolved incidents
- [ ] Verify unresolved Tier 3+ = 0
- [ ] Stop if Tier 4+

Day 15 - Gate review
- [ ] Compute readiness score
- [ ] Verify all Phase 2 thresholds
- [ ] Approve/deny move to Phase 3
- [ ] Stop if gate fails

### Phase 3: XRPL Edge Case Simulation

Day 16 - S1 partial fill bursts
- [ ] Execute S1 scenario card
- [ ] Verify fill aggregation error = 0
- [ ] Stop if Tier 3

Day 17 - S2 cancel/replace pre-close collision
- [ ] Execute S2 scenario card
- [ ] Verify orphan orders = 0
- [ ] Stop if Tier 4

Day 18 - Deterministic finality
- [ ] Validate provisional vs validated transitions
- [ ] Verify premature finality assertions = 0
- [ ] Stop if Tier 3

Day 19 - Sequence continuity and resubmission
- [ ] Simulate transient submit failures + retries
- [ ] Verify duplicate economic actions = 0
- [ ] Stop if Tier 4

Day 20 - Restart during open exposure
- [ ] Execute S5 scenario card
- [ ] Verify exposure parity = 0 error
- [ ] Verify rebuild time < 90s
- [ ] Stop if Tier 3+

Day 21 - Volatility mismatch convergence
- [ ] Execute S6 scenario card
- [ ] Verify convergence <= 2 reconcile cycles
- [ ] Stop if Tier 4 (cap breach)

Day 22 - Kill-switch under compound stress
- [ ] Trigger mismatch + staleness + latency spike
- [ ] Verify halt + neutralization <= 2 ledgers
- [ ] Stop if Tier 5

Day 23 - Gate review
- [ ] Compute readiness score
- [ ] Verify unresolved Tier 3+ = 0
- [ ] Approve/deny move to Phase 4
- [ ] Stop if gate fails

### Phase 4: Controlled Micro-Capital Live Trial

Day 24 - Initial micro-live run
- [ ] Enable Mode C with strict caps
- [ ] Run 60 minutes at minimum notional
- [ ] Verify unmatched on-ledger tx/state = 0
- [ ] Stop if Tier 4+

Day 25 - Extended micro-live
- [ ] Run 3 hours, max 1 open order
- [ ] Verify drift incidents = 0
- [ ] Stop if Tier 3 repeated > 2/day

Day 26 - Controlled concurrency
- [ ] Enable max 2 concurrent open orders
- [ ] Verify open-order map parity = 100%
- [ ] Stop if Tier 4

Day 27 - Live restart drill
- [ ] Restart during active order state
- [ ] Verify parity restored < 120s
- [ ] Stop if Tier 4

Day 28 - Boundary timing live drill
- [ ] Submit near close boundaries under cap
- [ ] Verify reconciliation mismatches = 0
- [ ] Stop if Tier 3 repeated > 3 events

Day 29 - Endurance run
- [ ] Run 6 hours with no config changes
- [ ] Verify zero manual safety intervention
- [ ] Stop if Tier 4+

Day 30 - Final decision day
- [ ] Compute final readiness score
- [ ] Run Go/No-Go decision tree
- [ ] Record approval or rollback plan
- [ ] Stop if gate fails

---

## 10) Micro-Capital Live Config Template (fill before Day 24)

Wallet/Test Allocation:
- TOTAL_TEST_XRP: __________ (max 150)

Trade Caps:
- MAX_NOTIONAL_PER_TRADE_XRP: __________ (max 3)
- MAX_CONCURRENT_OPEN_ORDERS: __________ (max 2)
- MAX_OUTSTANDING_EXPOSURE_XRP: __________ (max 6)

Loss and Slippage Controls:
- DAILY_REALIZED_LOSS_CAP_XRP: __________ (max 10)
- MAX_SLIPPAGE_BPS: __________
- MAX_ENTRY_SPREAD_BPS: __________

Operational Safeguards:
- AUTO_PAUSE_AFTER_TIER3_COUNT: __________ (recommended 3)
- RECONCILE_INTERVAL_SECONDS: __________ (recommended 15)
- KILL_SWITCH_ENFORCED: [ ] Yes
- LAST_LEDGER_SEQUENCE_ENFORCED: [ ] Yes

Approval:
- Reliability Lead: ____________________
- Risk Owner: ____________________
- Date: ____________________

---

## 11) Go / No-Go Decision Tree (Latency-Sensitive Strategies)

1) Any Tier 4/5 in last 7 days?
- Yes -> NO-GO
- No -> continue

2) Any unresolved Tier 3?
- Yes -> NO-GO
- No -> continue

3) Readiness score >= 88 and each category >= 16?
- No -> NO-GO
- Yes -> continue

4) p95 submit-to-inclusion <= 2 ledgers for last 3 days?
- No -> NO-GO
- Yes -> continue

5) Reconciliation parity errors over last 72h = 0?
- No -> NO-GO
- Yes -> continue

6) Kill-switch trigger-to-halt <= 1 ledger in latest drill?
- No -> NO-GO
- Yes -> GO (7-day probation with micro-cap caps retained)

Decision Record:
- Decision: [ ] GO  [ ] NO-GO
- Approved by: ____________________
- Date/Time (UTC): ____________________
- Notes: _______________________________________________
