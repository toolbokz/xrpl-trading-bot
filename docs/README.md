# Docs Index: Purpose and Function of Each File

This folder mixes **architecture references**, **operational runbooks**, and **status/audit artifacts**. Use this index to quickly find the right document.

## `docs/architecture-full.mmd`
- **Purpose:** Source-of-truth Mermaid diagram for the full system architecture.
- **Function:** Visualizes component boundaries and data/control flow across UI, runtime, market, execution, risk, XRPL, observability, analytics, persistence, and strategy layers. It is the best starting point for onboarding and dependency tracing.

## `docs/institutional-upgrade-blueprint.md`
- **Purpose:** Planning blueprint for institutional-grade execution and market-data upgrades.
- **Function:** Defines what files to create/modify, implementation sequence, and validation metrics (execution quality, cost control, safety determinism, and runtime performance). This is a roadmap/spec document, not a runtime artifact.

## `docs/institution-grade-status.md`
- **Purpose:** Implementation status report for the institutional upgrade work.
- **Function:** Records what was completed (A–E workstreams), where it is wired into runtime, test coverage, env vars, and file inventory. Use this to verify shipped scope against the blueprint.

## `docs/security-api-auth.md`
- **Purpose:** Security architecture spec for bot API authentication and authorization.
- **Function:** Documents the implemented localhost-only model, optional `LOCAL_API_TOKEN`, operational hardening guidance, and explicit non-implemented status for HMAC/RBAC.

## `docs/security-key-rotation.md`
- **Purpose:** Legacy runbook for a previously planned `BOT_API_KEYS` model.
- **Function:** Retained as historical/reference material only; current runtime authentication is documented in `security-api-auth.md`.

## `docs/small-balance-survival.md`
- **Purpose:** Practical risk profile guide for micro accounts (≤30 XRP).
- **Function:** Recommends conservative `.env` ranges (size, spread, cooldown, reserve floor, thresholds) and explains why they fit reserve and churn constraints. Use this for safe initial deployment posture.

## `docs/xrpl-reality-readiness-audit.md`
- **Purpose:** Current-stage readiness audit focused on data learning rather than alpha claims.
- **Function:** Evaluates whether the repo can measure edge quality, control reject churn, protect reserves, sustain runtime stability, and produce statistically usable trade data with post-fill coverage.

---

## Suggested reading order
1. `architecture-full.mmd` (system map)
2. `institutional-upgrade-blueprint.md` (target design)
3. `institution-grade-status.md` (implemented state)
4. `xrpl-reality-readiness-audit.md` (current readiness posture)
5. `small-balance-survival.md` (operating profile)
6. `security-api-auth.md` + `security-key-rotation.md` (security operations)
