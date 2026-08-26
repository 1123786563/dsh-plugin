# Tenant Navigation Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present a clean SaaS navigation that exposes self-service billing only and keeps operator controls outside the tenant surface.

**Architecture:** Define navigation entries from the authenticated capability set. Tenant entries point to overview, usage detail, and budget; operator entries are rendered only in the operator shell and are backed by Issue #9 server guards.

**Tech Stack:** React 18, TypeScript, existing dsh settings slot registry, locale dictionaries, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Hiding a menu item never replaces server authorization.
- Platform configuration, customer management, and cashier terminology stay out of tenant copy.
- Tenant and operator information architectures remain visibly distinct.

---

### Task 1: Capability-aware navigation model

**Files:**
- Create: `plugins/dsh-openmeter/src/client/navigation.ts`
- Test: `plugins/dsh-openmeter/tests/client-navigation.spec.ts`

- [ ] **Step 1:** Write tests for member, manager, operator, and missing-capability entry sets.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Implement `buildBillingNavigation(capabilities)` returning overview/detail/budget for tenants and operator entries only for operators.
- [ ] **Step 4:** Run tests and typecheck.
- [ ] **Step 5:** Commit `feat: add capability-aware billing navigation`.

### Task 2: Wire routes and regression coverage

**Files:**
- Modify: `plugins/dsh-openmeter/src/client/index.tsx`
- Modify: `plugins/dsh-openmeter/src/client/panel.tsx`
- Modify: `plugins/dsh-openmeter/src/client/locales.ts`
- Test: `plugins/dsh-openmeter/tests/client-panel.spec.tsx`

- [ ] **Step 1:** Add failing tests for hidden cashier/customer/config entries and direct-route authorization fallback.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Register the capability-aware navigation and remove tenant-facing cashier tabs; retain operator shell mounting only when authorized.
- [ ] **Step 4:** Run UI tests and package build.
- [ ] **Step 5:** Commit `refactor: clean tenant billing navigation`.
