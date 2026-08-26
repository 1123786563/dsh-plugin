# Budget Warning and Editing UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add budget progress, overage warnings, and manager-only budget editing to the tenant overview.

**Architecture:** The UI consumes the budget API from Issue #7 and maps forecast status to stable visual states. Editing is a controlled form; authorization remains server-side and the UI only reflects the role capability.

**Tech Stack:** React 18, TypeScript, existing inline-style component system, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Budget and forecast are CNY; Token balance remains a separate card.
- Warning copy includes budget, forecast, and overage values.
- Ordinary members have a read-only view; managers get an edit action.

---

### Task 1: Budget presentation model

**Files:**
- Create: `plugins/dsh-openmeter/src/client/budget-ui.ts`
- Test: `plugins/dsh-openmeter/tests/client-budget-ui.spec.ts`

- [ ] **Step 1:** Write tests for under-budget, near-threshold, over-budget, unconfigured, and unavailable forecast states.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Implement `budgetTone` and `budgetCopy` pure functions with capped progress and localized numeric values.
- [ ] **Step 4:** Run tests and typecheck.
- [ ] **Step 5:** Commit `feat: add budget warning view model`.

### Task 2: Overview card and editor

**Files:**
- Modify: `plugins/dsh-openmeter/src/client/panel.tsx`
- Modify: `plugins/dsh-openmeter/src/client/api.ts`
- Modify: `plugins/dsh-openmeter/src/client/locales.ts`
- Test: `plugins/dsh-openmeter/tests/client-panel.spec.tsx`

- [ ] **Step 1:** Add failing tests for role read-only state, manager edit form, validation, save failure, and success refresh.
- [ ] **Step 2:** Run focused UI tests and verify failure.
- [ ] **Step 3:** Render the progress card and controlled CNY editor; call `api.updateBudget` only after client validation and refresh on success.
- [ ] **Step 4:** Run tests and package build.
- [ ] **Step 5:** Commit `feat: add tenant budget warning and editor`.
