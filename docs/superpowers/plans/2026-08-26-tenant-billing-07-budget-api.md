# Tenant Budget and Forecast API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a per-tenant CNY monthly budget and return an explainable spend forecast with role-aware updates.

**Architecture:** Store budget settings in a small SQLite table keyed by Tenant. The service combines the persisted budget with ledger estimates for the current calendar month and returns a discriminated forecast state.

**Tech Stack:** TypeScript, Node.js SQLite, existing estimator/ledger modules, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Budget currency is CNY; it never changes Token credit.
- Tenant manager may update only its own Tenant budget.
- Forecast failure is explicit and never represented as `0`.

---

### Task 1: Budget repository and forecast service

**Files:**
- Create: `plugins/dsh-openmeter/src/budget.ts`
- Test: `plugins/dsh-openmeter/tests/budget.spec.ts`

- [ ] **Step 1:** Write tests for absent budget, create/update, month boundary, insufficient history, and computed overage.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Implement `BudgetStore.get(tenantId)`, `set(tenantId, amountCny)`, and `forecast(tenantId, month)` with integer minor-unit storage and explicit status values.
- [ ] **Step 4:** Run tests and typecheck.
- [ ] **Step 5:** Commit `feat: add tenant budget forecast service`.

### Task 2: Budget routes

**Files:**
- Modify: `plugins/dsh-openmeter/src/routes.ts`
- Modify: `plugins/dsh-openmeter/src/client/api.ts`
- Test: `plugins/dsh-openmeter/tests/routes.spec.ts`

- [ ] **Step 1:** Add failing tests for GET member access, PUT manager access, member PUT 403, invalid amount, and cross-tenant input.
- [ ] **Step 2:** Run focused route tests and verify failure.
- [ ] **Step 3:** Mount `GET/PUT /api/openmeter/me/budget`, derive Tenant from policy, validate `0 < amountCny <= 100000000`, and add typed client methods.
- [ ] **Step 4:** Run tests, typecheck, and package build.
- [ ] **Step 5:** Commit `feat: expose tenant budget api`.
