# Tenant Credit Summary API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a tenant-scoped summary of Token credit, access state, recent trend inputs, and service freshness for the SaaS UI.

**Architecture:** Build a read-only summary service behind `/api/openmeter/me/summary`. It obtains the tenant policy from Issue #1, reads the mapped Subject entitlement, and returns explicit stale/unavailable states rather than synthetic zeros.

**Tech Stack:** TypeScript, Node.js HTTP routes, existing OpenMeter client, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Responses are always scoped to the authenticated Tenant.
- Token balances are not CNY amounts.
- OpenMeter failure is represented as a safe unavailable state.
- No payment action is exposed by this API.

---

### Task 1: Summary contract and service

**Files:**
- Create: `plugins/dsh-openmeter/src/tenant-summary.ts`
- Test: `plugins/dsh-openmeter/tests/tenant-summary.spec.ts`

**Interfaces:**
- Consumes: `TenantPolicy`, `OpenMeterClient.entitlementValue(subject, featureKey)`, and local pipeline aggregates.
- Produces: `TenantSummary { tenantId, subject, availableTokens, hasAccess, usageTokens7d, estimatedCny7d, asOf, availability }`.

- [x] **Step 1:** Write tests for mapped subject success, OpenMeter rejection, missing entitlement, and Token/CNY field separation.
- [x] **Step 2:** Run the focused test and record the expected missing-module failure.
- [x] **Step 3:** Implement `loadTenantSummary` with a discriminated `availability: 'ready' | 'unavailable' | 'unmapped'` result; never convert exceptions to zero.
- [x] **Step 4:** Run the focused tests and typecheck the package.
- [x] **Step 5:** Commit `feat: add tenant credit summary service`.

### Task 2: Mount `/me/summary`

**Files:**
- Modify: `plugins/dsh-openmeter/src/routes.ts`
- Modify: `plugins/dsh-openmeter/src/client/api.ts`
- Test: `plugins/dsh-openmeter/tests/routes.spec.ts`

- [ ] **Step 1:** Add failing HTTP tests asserting 401 without identity and 200 with only the current tenant's summary.
- [ ] **Step 2:** Run the focused route tests and verify failure.
- [ ] **Step 3:** Register `GET /api/openmeter/me/summary`, call the service with the resolved policy, and add a typed `api.summary()` client method.
- [ ] **Step 4:** Run focused tests plus `pnpm --dir plugins/dsh-openmeter typecheck`.
- [ ] **Step 5:** Commit `feat: expose tenant credit summary api`.
