# Cross-Tenant Acceptance and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove two-tenant isolation and operator boundaries end to end, then align documentation and package quality gates with the shipped behavior.

**Architecture:** Add a deterministic integration fixture with Tenant A, Tenant B, and an operator identity. Exercise gateway-authenticated HTTP and browser-facing routes, then record the evidence in a release checklist and update domain/API docs.

**Tech Stack:** Node.js, Vitest, existing smoke scripts, Playwright/browser harness if available, Markdown documentation.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Tenant A/B data must remain mutually invisible across API and UI.
- Operator access is explicit and role-gated.
- Unavailable services show honest degraded states; tests never treat health checks as full acceptance.
- No new payment channel or billing mode is introduced.

---

### Task 1: Cross-tenant integration fixture

**Files:**
- Create: `plugins/dsh-openmeter/tests/tenant-billing.integration.spec.ts`
- Modify: `plugins/dsh-openmeter/scripts/smoke.mjs`

- [ ] **Step 1:** Write failing integration cases for A/B summary, usage, budget, operator action, and unauthorized access.
- [ ] **Step 2:** Run the focused integration command and verify failure or missing fixture output.
- [ ] **Step 3:** Build isolated identities, mappings, ledger rows, and budget records; assert response bodies contain only the requesting tenant's values.
- [ ] **Step 4:** Run the integration suite twice to prove deterministic cleanup and idempotent seed behavior.
- [ ] **Step 5:** Commit `test: add cross-tenant billing acceptance fixture`.

### Task 2: Docs and quality-gate record

**Files:**
- Modify: `plugins/dsh-openmeter/README.md`
- Modify: `plugins/dsh-openmeter/CONTEXT.md`
- Create: `docs/superpowers/plans/2026-08-26-tenant-billing-self-service-acceptance.md`
- Test: `plugins/dsh-openmeter/tests/documentation-contract.spec.ts`

- [ ] **Step 1:** Add a documentation-contract test requiring the Tenant/Subject, Token/CNY, role matrix, and degraded-state terms.
- [ ] **Step 2:** Run it and verify the current docs fail on any missing contract.
- [ ] **Step 3:** Update README/context with the final `/api/openmeter/me/*` surface, operator boundary, migration notes, and exact verification commands.
- [ ] **Step 4:** Run `pnpm --dir plugins/dsh-openmeter lint` if available, `pnpm --dir plugins/dsh-openmeter typecheck`, tests, build, and the integration fixture; record each result and any environment blocker.
- [ ] **Step 5:** Commit `docs: close tenant billing acceptance and runbook`.
