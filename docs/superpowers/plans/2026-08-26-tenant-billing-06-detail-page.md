# Tenant Usage Detail Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a SaaS user drill from the overview into date-grouped usage details with filters, pagination, and bill-checking feedback.

**Architecture:** Add a standalone React `UsageDetailView` that owns query state and calls the tenant-only API from Issue #5. The overview passes an explicit navigation callback; no operator/customer data is reused.

**Tech Stack:** React 18, TypeScript, existing panel styles/locales, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Detail rows are always scoped to the authenticated Tenant.
- Grouping is presentation-only; raw Token dimensions remain inspectable.
- Errors and unavailable settlement states are visible, not silently zeroed.

---

### Task 1: Query state and formatter

**Files:**
- Create: `plugins/dsh-openmeter/src/client/usage-detail.ts`
- Test: `plugins/dsh-openmeter/tests/client-usage-detail.spec.ts`

- [ ] **Step 1:** Write tests for date grouping, model filter serialization, cursor advance, and Token/CNY formatting.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Implement pure `groupUsageRows` and `toUsageQuery` functions with stable local-date labels.
- [ ] **Step 4:** Run tests and typecheck.
- [ ] **Step 5:** Commit `feat: add usage detail view model`.

### Task 2: Render and connect drill-down

**Files:**
- Modify: `plugins/dsh-openmeter/src/client/panel.tsx`
- Modify: `plugins/dsh-openmeter/src/client/locales.ts`
- Test: `plugins/dsh-openmeter/tests/client-panel.spec.tsx`

- [ ] **Step 1:** Add failing tests for the detail CTA, date/model controls, grouped rows, empty state, retry, and next-page action.
- [ ] **Step 2:** Run focused UI tests and verify failure.
- [ ] **Step 3:** Add the view switch and render `UsageDetailView` with back navigation and preserved query state.
- [ ] **Step 4:** Run focused UI tests and `pnpm --dir plugins/dsh-openmeter build`.
- [ ] **Step 5:** Commit `feat: add tenant usage detail page`.
