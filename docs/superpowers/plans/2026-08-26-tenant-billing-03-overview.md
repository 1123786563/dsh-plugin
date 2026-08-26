# Tenant Credit Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current operator-oriented usage tab with a SaaS tenant overview showing balance, runway, model cost distribution, and a drill-down action.

**Architecture:** Keep data fetching in a dedicated overview hook and make the page a presentation component. It consumes only `api.summary()` and the existing tenant-safe aggregates; the detail CTA navigates to the future detail view without exposing operator controls.

**Tech Stack:** React 18, TypeScript, inline styles used by `dsh-openmeter`, Vitest/React DOM test seams.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Tenant pages never render customer lists, Subject IDs, or house-account data.
- Balance is Token credit; monetary estimates are CNY and labeled separately.
- Every loading, empty, error, and low-credit state is actionable and non-blocking.

---

### Task 1: Overview view model

**Files:**
- Create: `plugins/dsh-openmeter/src/client/overview.ts`
- Test: `plugins/dsh-openmeter/tests/client-overview.spec.ts`

- [ ] **Step 1:** Write tests for runway calculation from seven-day usage, zero-usage fallback, unavailable summary, and model percentage normalization.
- [ ] **Step 2:** Run the focused tests and confirm failure.
- [ ] **Step 3:** Implement pure functions `buildOverviewModel(summary, modelRows)` and `forecastRunwayDays` with capped percentages and explicit unavailable flags.
- [ ] **Step 4:** Run the tests and typecheck.
- [ ] **Step 5:** Commit `feat: add billing overview view model`.

### Task 2: Render the overview page

**Files:**
- Modify: `plugins/dsh-openmeter/src/client/panel.tsx`
- Modify: `plugins/dsh-openmeter/src/client/locales.ts`
- Test: `plugins/dsh-openmeter/tests/client-panel.spec.tsx`

- [ ] **Step 1:** Add failing rendering tests for balance, runway, model table, warning state, and detail button.
- [ ] **Step 2:** Run the focused test and verify failure.
- [ ] **Step 3:** Add `OverviewView`, fetch the summary on mount, and route the detail button to the detail callback while leaving operator views out of the tenant surface.
- [ ] **Step 4:** Run focused tests and `pnpm --dir plugins/dsh-openmeter build`.
- [ ] **Step 5:** Commit `feat: render tenant billing overview`.
