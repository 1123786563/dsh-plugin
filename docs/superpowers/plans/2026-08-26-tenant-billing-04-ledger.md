# Persistent Usage Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist tenant usage rows durably and idempotently so retries and restarts cannot duplicate or lose the customer-facing ledger.

**Architecture:** Add a SQLite-backed ledger beside the existing operator state. A unique `(source, eventId)` key provides at-least-once idempotency; writes are transactional and retain immutable Tenant/Subject attribution plus Token dimensions and local CNY estimate.

**Tech Stack:** TypeScript, Node.js `node:sqlite` or the repository's existing SQLite adapter, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Event IDs are idempotency keys; duplicate delivery is successful and side-effect free.
- Tenant and Subject attribution is immutable after insertion.
- The ledger is an estimate/display source, not a replacement for OpenMeter's authoritative ledger.

---

### Task 1: Schema and repository

**Files:**
- Create: `plugins/dsh-openmeter/src/ledger.ts`
- Test: `plugins/dsh-openmeter/tests/ledger.spec.ts`

- [ ] **Step 1:** Write tests for insert, duplicate event, tenant-filtered list, and reopen-after-close.
- [ ] **Step 2:** Run `pnpm --dir plugins/dsh-openmeter exec vitest run tests/ledger.spec.ts`; confirm failure.
- [ ] **Step 3:** Implement `UsageLedger.open(dir)`, `append(row)`, and `list(query)` with a unique event index and a migration created on open.
- [ ] **Step 4:** Run tests and inspect the database after a close/reopen cycle.
- [ ] **Step 5:** Commit `feat: add durable usage ledger`.

### Task 2: Pipeline integration

**Files:**
- Modify: `plugins/dsh-openmeter/src/pipeline.ts`
- Modify: `plugins/dsh-openmeter/src/index.ts`
- Test: `plugins/dsh-openmeter/tests/pipeline.spec.ts`

- [ ] **Step 1:** Add failing tests for event append, duplicate retry, and persisted row after a new pipeline instance.
- [ ] **Step 2:** Run focused pipeline tests and verify failure.
- [ ] **Step 3:** Append the fully resolved Tenant/Subject and Token dimensions before forwarding; treat duplicate as an acknowledged event.
- [ ] **Step 4:** Run pipeline tests, package typecheck, and existing WAL tests.
- [ ] **Step 5:** Commit `feat: persist metering events in tenant ledger`.
