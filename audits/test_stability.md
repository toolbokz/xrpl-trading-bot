# Test Stability Guide

Date: 2026-02-23

## Goals
- Keep test discovery deterministic (source tests only).
- Avoid compiled artifact test pickup from directories such as `.next`.
- Keep CI gating based on runner exit code instead of log parsing.

## Commands

### 1) Discovery sanity check
```bash
npm run test:discover
```
- Prints all discovered `src/**/*.test.ts`, `src/**/*.spec.ts` (and `tsx`) files.
- Fails if any discovered path contains `/.next/`.

### 2) Full suite
```bash
npm test -- --run
```
- Runs the full Vitest suite once.
- Use this for release/CI parity.

### 3) Unit-targeted / focused runs
```bash
npm test -- --run src/config/__tests__/startupValidation.test.ts
```
```bash
npm test -- --run src/execution/__tests__
```
- Use targeted paths for faster local iteration.

## Artifact Cleanup

### Standard clean
```bash
npm run clean
```
- Removes `dist`, `src/ui/.next`, and `.next`.

### Optional manual cleanup (if present)
```bash
rm -rf build out coverage .turbo
```

## CI Notes
- CI runs `npm run test:discover` before test execution.
- CI runs `npm test -- --run` exactly once.
- Test pass/fail gate is Vitest exit code only.
