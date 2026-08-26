# Tenant Usage Detail API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return a paginated, filterable, tenant-only usage journal suitable for bill checking.

**Architecture:** Add `/api/openmeter/me/usage` over the persistent ledger. Query parsing is isolated from authorization; the route derives Tenant from the policy and passes a bounded query to the ledger.

**Tech Stack:** TypeScript, Node.js HTTP routes, SQLite ledger, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Tenant comes from the verified request identity, never from query parameters.
- Token dimensions and CNY estimate are returned as separate fields.
- Pagination has a stable order and bounded page size.

---

### Task 1: Query contract

**Files:**
- Modify: `plugins/dsh-openmeter/src/ledger.ts`
- Test: `plugins/dsh-openmeter/tests/ledger-query.spec.ts`

- [ ] **Step 1:** Write tests for date range, model filter, cursor ordering, page-size cap, and tenant isolation.
- [ ] **Step 2:** Run the focused tests and verify failure.
- [ ] **Step 3:** Implement `UsageQuery` and `UsagePage` plus parameterized SQL predicates ordered by `occurredAt DESC, id DESC`.
- [ ] **Step 4:** Run focused tests and typecheck.
- [ ] **Step 5:** Commit `feat: add tenant usage ledger queries`.

### Task 2: HTTP route and client contract

**Files:**
- Modify: `plugins/dsh-openmeter/src/routes.ts`
- Modify: `plugins/dsh-openmeter/src/client/api.ts`
- Test: `plugins/dsh-openmeter/tests/routes.spec.ts`

- [ ] **Step 1:** Add failing tests for 401, valid filters, invalid date range, and cross-tenant query attempts.
- [ ] **Step 2:** Run focused route tests and verify failure.
- [ ] **Step 3:** Mount `GET /api/openmeter/me/usage`, cap `limit` to 100, map ledger rows to the public payload, and add typed `api.usageDetail(query)`.
- [ ] **Step 4:** Run route tests and `pnpm --dir plugins/dsh-openmeter build`.
- [ ] **Step 5:** Commit `feat: expose tenant usage detail api`.
