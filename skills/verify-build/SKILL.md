---
name: verify-build
description: Runs the full Overgrown Frontier verification suite (typecheck, lint, unit tests, and production build) and reports PASS or FAIL.
---

# Verify Build Workflow

## Trigger Description

Invoke after every single code edit in `overgrown-frontier` (per the single-edit verification rule in `AGENTS.md`) or before declaring any milestone complete.

## Numbered Steps

1. Run `npm run typecheck` to confirm strict TypeScript compilation with zero errors.
2. Run `npm run lint` to confirm zero ESLint violations.
3. Run `npm test` to confirm all Vitest unit tests pass.
4. Run `npm run build` to confirm Vite produces a clean production bundle.
5. Report `PASS` if all four steps succeed, or `FAIL` with the exact failing command and error output.
