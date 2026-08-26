# Operator API Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move customer, grant, block, and preset-binding APIs behind the operator boundary and retire unsafe global access.

**Architecture:** Keep operator handlers in a dedicated route group that requires `TenantPolicy.isOperator`. Tenant routes use `/me/*`; operator routes require an explicit target and audit metadata. Old global paths become stable 404/403 responses during migration.

**Tech Stack:** TypeScript, Node.js HTTP routes, existing `OperatorStore`, OpenMeter client, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Ordinary tenant members never receive customer lists or internal-house data.
- Operator actions remain explicit, auditable, and idempotent where applicable.
- Authentication and authorization errors do not reveal customer existence.

---

### Task 1: Operator guard and route split

**Files:**
- Modify: `plugins/dsh-openmeter/src/routes.ts`
- Test: `plugins/dsh-openmeter/tests/operator-routes.spec.ts`

- [ ] **Step 1:** Write tests for operator success, member 403, anonymous 401, cross-tenant target rejection, and legacy global route rejection.
- [ ] **Step 2:** Run focused tests and verify failure.
- [ ] **Step 3:** Add `requireOperator` and `requireTarget` helpers; place customer/grant/block/binding handlers under `/api/openmeter/operator/*` while returning a deterministic migration error from old paths.
- [ ] **Step 4:** Run focused tests and typecheck.
- [ ] **Step 5:** Commit `refactor: isolate operator billing routes`.

### Task 2: Client and audit contract

**Files:**
- Modify: `plugins/dsh-openmeter/src/client/api.ts`
- Modify: `plugins/dsh-openmeter/src/client/panel.tsx`
- Test: `plugins/dsh-openmeter/tests/client-api.spec.ts`

- [ ] **Step 1:** Add failing tests that tenant API methods cannot call operator paths without an operator capability.
- [ ] **Step 2:** Run the focused tests and verify failure.
- [ ] **Step 3:** Update typed client methods and include actor/target/audit event fields in successful operator responses.
- [ ] **Step 4:** Run tests and build.
- [ ] **Step 5:** Commit `feat: align client with operator api boundary`.
