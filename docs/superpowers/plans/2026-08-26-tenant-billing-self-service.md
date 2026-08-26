# Tenant Billing Self-Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the operator-oriented OpenMeter page with a fail-closed, tenant-scoped billing experience showing Token credit, CNY budget risk, model cost drivers, and a drill-down usage journal.

**Architecture:** A verified Casdoor identity is resolved server-side to an explicitly provisioned OpenMeter subject. A SQLite-backed tenant billing store holds idempotent usage ledger rows and per-tenant budgets; OpenMeter remains authoritative for Token credit and access. Tenant routes live under `/api/openmeter/me/*`; operator routes are relocated under `/api/openmeter/admin/*` and role-guarded.

**Tech Stack:** TypeScript, React 18, Vitest, Node `node:sqlite`, Cordis, Casdoor identity service, OpenMeter HTTP APIs.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Every `/api/openmeter/me/*` request must verify `casdoorAuth.identityFromRequest(req)` and fail closed when absent or invalid.
- Resolve a subject only through an operator-provisioned `tenantId -> subject` map; never accept it in tenant input or fall back to `house`.
- Display entitlement credit in Tokens; show CNY only for estimated cost and monthly budget.
- Never return customer lists, preset bindings, grant/block controls, WAL/gate details, endpoints, keys, or raw internal errors to tenants.
- Do not build payment, invoice, order, or auto-recharge behavior. Recharge is an external configured link only.
- The local ledger starts at feature activation and is a single-node presentation read model, not an OpenMeter replacement or backfill.
- Use TDD for every production behavior; preserve unrelated worktree changes.

---

## File Map

- `src/tenant-billing.ts`: policy parsing, SQLite ledger, budget persistence, range/model/forecast projections.
- `src/tenant-billing-routes.ts`: authenticated tenant route handlers and redacted DTOs.
- `src/routes.ts`: role-protected operator route family.
- `src/config.ts`: tenant subject map, role-list, and recharge portal config.
- `src/index.ts`: wires optional Casdoor identity plus tenant store into pipeline/routes.
- `src/pipeline.ts`: stores a committed metering event in the ledger once.
- `src/client/api.ts`, `panel.tsx`, `locales.ts`: tenant client contract and fused overview/detail views.
- `tests/tenant-billing.spec.ts`, `tenant-billing-routes.spec.ts`, `pipeline.spec.ts`, `client-panel.spec.tsx`: focused regressions.

## Task 1: Tenant policy and SQLite billing store

**Files:**
- Create: `plugins/dsh-openmeter/src/tenant-billing.ts`
- Create: `plugins/dsh-openmeter/tests/tenant-billing.spec.ts`
- Modify: `plugins/dsh-openmeter/src/config.ts`

**Interfaces:**
- Produces `TenantIdentity`, `TenantBillingPolicy`, `TenantLedgerEntry`, `TenantUsageSummary`, `TenantBillingStore`.
- `TenantBillingPolicy.resolveSubject(tenantId: string): string | undefined` is the only tenant-subject seam.
- `TenantBillingStore.recordUsage(entry: TenantLedgerEntry): void` is idempotent by `eventId`.

- [ ] **Step 1: Write failing policy and store tests**

```ts
it('resolves only a provisioned subject and never house', () => {
  const policy = createTenantBillingPolicy({ tenantSubjectMapJson: '{"acme":"cust-acme"}', houseSubject: 'house' })
  expect(policy.resolveSubject('acme')).toBe('cust-acme')
  expect(policy.resolveSubject('globex')).toBeUndefined()
})

it('deduplicates ledger entries by event id', () => {
  const store = openTestStore()
  store.recordUsage(entry({ eventId: 'evt-1', subject: 'cust-acme' }))
  store.recordUsage(entry({ eventId: 'evt-1', subject: 'cust-acme' }))
  expect(store.listUsage('cust-acme', range()).items).toHaveLength(1)
})

it('keeps Token credit separate from CNY forecast', () => {
  const summary = summarizeUsage([entry({ tokens: 1_000_000, estimatedAmount: 100 })], budgetInput({ entitlementBalanceTokens: 2_000_000 }))
  expect(summary.remainingCreditTokens).toBe(2_000_000)
  expect(summary.predictedMonthSpendCny).toBeGreaterThan(100)
})
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter dsh-openmeter test -- tests/tenant-billing.spec.ts`

Expected: `FAIL` because `tenant-billing.ts` does not exist.

- [ ] **Step 3: Implement config, policy, and store**

```ts
export interface TenantIdentity { tenantId: string; userId: string; displayName: string; roles: readonly string[] }
export interface TenantLedgerEntry {
  eventId: string; subject: string; capturedAt: number; provider: string; model: string
  tokens: number; estimatedAmount: number; currency: string; unpriced: boolean
}
export interface TenantBillingPolicy {
  resolveSubject(tenantId: string): string | undefined
  canManageBudget(identity: TenantIdentity): boolean
  canOperate(identity: TenantIdentity): boolean
  rechargePortalUrl?: string
}
```

Add `tenantSubjectMapJson`, `tenantBillingManagerRolesJson`, `operatorRolesJson`, and `rechargePortalUrl` to `Config`, defaults, Schema, and normalization. Invalid JSON parses to an empty map/list.

Use `node:sqlite` with:

```sql
CREATE TABLE usage_ledger (
  event_id TEXT PRIMARY KEY, subject TEXT NOT NULL, captured_at INTEGER NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, tokens INTEGER NOT NULL,
  estimated_amount REAL NOT NULL, currency TEXT NOT NULL, unpriced INTEGER NOT NULL
);
CREATE INDEX usage_ledger_subject_time ON usage_ledger(subject, captured_at DESC);
CREATE TABLE tenant_budgets (tenant_id TEXT PRIMARY KEY, monthly_budget_cny REAL NOT NULL);
```

- [ ] **Step 4: Verify green**

Run: `pnpm --filter dsh-openmeter test -- tests/tenant-billing.spec.ts`

Expected: `PASS` for map isolation, malformed config, entry idempotency, date range, budget validation, forecast, and unit separation.

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-openmeter/src/config.ts plugins/dsh-openmeter/src/tenant-billing.ts plugins/dsh-openmeter/tests/tenant-billing.spec.ts
git commit -m "feat(openmeter): add tenant billing read model"
```

## Task 2: Record committed usage in the durable ledger

**Files:**
- Modify: `plugins/dsh-openmeter/src/pipeline.ts`
- Modify: `plugins/dsh-openmeter/src/index.ts`
- Modify: `plugins/dsh-openmeter/tests/pipeline.spec.ts`

**Interfaces:**
- Consumes `TenantBillingStore.recordUsage` from Task 1.
- Produces one ledger record per successfully-built WAL CloudEvent, while preserving current gate, WAL, and forwarder behavior.

- [ ] **Step 1: Write the failing pipeline test**

```ts
it('writes one durable tenant ledger record for a committed assistant message', async () => {
  const { pipeline, billingStore } = await build({ header: { agentPreset: 'preset-a' }, bind: { preset: 'preset-a', customer: 'cust-acme' } })
  pipeline.onSessionEvent('s1', assistantMessage({ seq: 1 }))
  await eventually(() => expect(billingStore.listUsage('cust-acme', range()).items).toHaveLength(1))
  expect(billingStore.listUsage('cust-acme', range()).items[0]?.tokens).toBe(150)
})
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter dsh-openmeter test -- tests/pipeline.spec.ts -t "durable tenant ledger"`

Expected: `FAIL` because the pipeline has no ledger dependency.

- [ ] **Step 3: Implement the dependency and write point**

```ts
constructor(deps: { /* existing dependencies */ tenantBillingStore?: Pick<TenantBillingStore, 'recordUsage'> })

this.tenantBillingStore?.recordUsage({
  eventId: record.event.id, subject: call.subject, capturedAt: call.capturedAt,
  provider: call.provider, model: call.model,
  tokens: billedInputTokens(call.usage) + call.usage.outputTokens,
  estimatedAmount: estimate.amount, currency: estimate.currency, unpriced: estimate.unpriced,
})
```

Instantiate/load the store once in `apply()` and pass it to pipeline and tenant route mounting. The in-memory ring remains operator diagnostic state only.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter dsh-openmeter test -- tests/pipeline.spec.ts`

Expected: `PASS`, including all existing metering, attribution, dedupe, subagent, and gate cases.

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-openmeter/src/index.ts plugins/dsh-openmeter/src/pipeline.ts plugins/dsh-openmeter/tests/pipeline.spec.ts
git commit -m "feat(openmeter): persist tenant usage ledger"
```

## Task 3: Fail-closed tenant summary, journal, and budget APIs

**Files:**
- Create: `plugins/dsh-openmeter/src/tenant-billing-routes.ts`
- Create: `plugins/dsh-openmeter/tests/tenant-billing-routes.spec.ts`
- Modify: `plugins/dsh-openmeter/src/index.ts`

**Interfaces:**
- Produces `mountTenantBillingRoutes(webServer, deps)` for `/api/openmeter/me/summary`, `/usage`, `/budget`.
- `RequestIdentityService.identityFromRequest(req)` is duck typed to avoid a package dependency on Casdoor.

- [ ] **Step 1: Write failing route tests**

```ts
it('returns only the verified tenant summary without internal fields', async () => {
  const response = await request('GET', '/api/openmeter/me/summary', identity('acme', ['member']))
  expect(response.status).toBe(200)
  expect(response.body.subject).toBeUndefined()
  expect(JSON.stringify(response.body)).not.toContain('wal')
  expect(response.body.models.map((row: { model: string }) => row.model)).toEqual(['gpt-4.1'])
})

it('rejects no identity and an unprovisioned tenant', async () => {
  await expect(request('GET', '/api/openmeter/me/summary')).resolves.toMatchObject({ status: 401 })
  await expect(request('GET', '/api/openmeter/me/summary', identity('globex', ['member']))).resolves.toMatchObject({ status: 403 })
})

it('lets only a budget manager update their own budget', async () => {
  await expect(request('PUT', '/api/openmeter/me/budget', identity('acme', ['member']), { monthlyBudgetCny: 8000 })).resolves.toMatchObject({ status: 403 })
  await expect(request('PUT', '/api/openmeter/me/budget', identity('acme', ['owner']), { monthlyBudgetCny: 8000 })).resolves.toMatchObject({ status: 200 })
})
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter dsh-openmeter test -- tests/tenant-billing-routes.spec.ts`

Expected: `FAIL` because no tenant route family is registered.

- [ ] **Step 3: Implement redacted DTO handlers**

```ts
export interface RequestIdentityService {
  identityFromRequest(req: IncomingMessage): Promise<TenantIdentity | undefined>
}
export interface TenantRouteDeps {
  identity?: RequestIdentityService; policy: TenantBillingPolicy; billingStore: TenantBillingStore
  client: () => OpenMeterClient; getConfig: () => Config
}
```

Authenticate first, resolve subject second, and then query only that subject. Summary returns `credit: { balanceTokens, hasAccess, forecastDays? }`, budget, model aggregates, `service: 'healthy' | 'degraded'`, and optional configured recharge URL. It never serializes subject, customer key, raw exceptions, or operational status structs. Validate date ranges/cursors and reject a request body/query subject key.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter dsh-openmeter test -- tests/tenant-billing-routes.spec.ts`

Expected: `PASS` for two-tenant separation, no subject spoofing, redaction, authorization, range validation, and external recharge URL omission.

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-openmeter/src/tenant-billing-routes.ts plugins/dsh-openmeter/src/index.ts plugins/dsh-openmeter/tests/tenant-billing-routes.spec.ts
git commit -m "feat(openmeter): add tenant billing api"
```

## Task 4: Lock down operator APIs and tenant navigation

**Files:**
- Modify: `plugins/dsh-openmeter/src/routes.ts`
- Modify: `plugins/dsh-openmeter/src/index.ts`
- Modify: `plugins/dsh-openmeter/src/client/index.tsx`
- Modify: `plugins/dsh-openmeter/src/client/card.tsx`
- Modify: `plugins/dsh-openmeter/src/client/form.ts`
- Test: `plugins/dsh-openmeter/tests/tenant-billing-routes.spec.ts`

**Interfaces:**
- Consumes `RequestIdentityService` and `TenantBillingPolicy.canOperate()` from Task 3.
- Produces `/api/openmeter/admin/*`; old global operator URLs return 404 and cannot be invoked from tenant client code.

- [ ] **Step 1: Write failing operator-boundary tests**

```ts
it('does not mount the old grant route for a tenant', async () => {
  await expect(request('POST', '/api/openmeter/grants', identity('acme', ['member']), { customerKey: 'cust-globex', amount: 1 })).resolves.toMatchObject({ status: 404 })
})

it('requires an operator role for relocated writes', async () => {
  await expect(request('POST', '/api/openmeter/admin/grants', identity('acme', ['member']), { customerKey: 'cust-acme', amount: 1 })).resolves.toMatchObject({ status: 403 })
})
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter dsh-openmeter test -- tests/tenant-billing-routes.spec.ts -t "old grant|operator role"`

Expected: `FAIL` because current global routes are registered without role checks.

- [ ] **Step 3: Move and guard the operator family**

Relocate status, customers, grants, block, and bindings to `/api/openmeter/admin/*`. Require verified identity plus `canOperate()` for every method, including reads. Remove `CashierView` and `OpenMeterSettingsCard` from tenant client registration; profile-level plugin configuration remains an operator deployment concern and is not mounted in tenant navigation.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter dsh-openmeter test -- tests/tenant-billing-routes.spec.ts && pnpm --filter dsh-openmeter typecheck`

Expected: `PASS`; the old endpoint is absent and tenant source does not render cashier/config controls.

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-openmeter/src/routes.ts plugins/dsh-openmeter/src/index.ts plugins/dsh-openmeter/src/client/index.tsx plugins/dsh-openmeter/src/client/card.tsx plugins/dsh-openmeter/src/client/form.ts plugins/dsh-openmeter/tests/tenant-billing-routes.spec.ts
git commit -m "feat(openmeter): isolate operator controls"
```

## Task 5: Tenant API client and fused billing UI

**Files:**
- Modify: `plugins/dsh-openmeter/src/client/api.ts`
- Modify: `plugins/dsh-openmeter/src/client/panel.tsx`
- Modify: `plugins/dsh-openmeter/src/client/locales.ts`
- Create: `plugins/dsh-openmeter/tests/client-panel.spec.tsx`

**Interfaces:**
- Consumes `TenantSummaryPayload`, `TenantUsagePayload`, `api.tenantSummary()`, `api.tenantUsage()`, and `api.updateBudget()`.
- Produces overview-first navigation with an interactive chronological detail state; no method or component accepts a customer key/subject.

- [ ] **Step 1: Write failing UI tests**

```tsx
it('shows Token credit and CNY budget without mixing units', async () => {
  render(<BillingPanel />)
  expect(await screen.findByText('可用 Token 额度')).toBeVisible()
  expect(screen.getByText('本月预算')).toBeVisible()
  expect(screen.queryByText(/WAL|内部户|客户与余额/)).not.toBeInTheDocument()
})

it('opens the chronological journal from the overview', async () => {
  render(<BillingPanel />)
  await userEvent.click(await screen.findByRole('button', { name: '查看用量明细' }))
  expect(await screen.findByRole('heading', { name: '用量明细' })).toBeVisible()
})
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter dsh-openmeter test -- tests/client-panel.spec.tsx`

Expected: `FAIL` because the current panel loads global usage/status and renders cashier tabs.

- [ ] **Step 3: Implement the tenant client**

```ts
export interface TenantSummaryPayload {
  ok: true
  credit: { balanceTokens?: number; hasAccess: boolean; forecastDays?: number }
  budget: { monthlyBudgetCny?: number; spentCny: number; predictedMonthSpendCny?: number; writable: boolean }
  models: Array<{ model: string; calls: number; tokens: number; estimatedAmount: number; currency: string; share: number }>
  service: 'healthy' | 'degraded'
  rechargePortalUrl?: string
}
```

Render, in order: Token-credit hero and optional external recharge link; CNY budget progress with predicted-over-budget warning; model cost table; safe service sentence; detail action. The detail state supports date range and cursor paging. Render the budget editor only when `budget.writable` is true; client validation is UX-only and server authorization remains authoritative.

- [ ] **Step 4: Verify green**

Run: `pnpm --filter dsh-openmeter test -- tests/client-panel.spec.tsx && pnpm --filter dsh-openmeter typecheck`

Expected: `PASS` for overview, over-budget warning, read-only budget, absent/available recharge CTA, empty journal, detail transition, pagination, and error state.

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-openmeter/src/client/api.ts plugins/dsh-openmeter/src/client/panel.tsx plugins/dsh-openmeter/src/client/locales.ts plugins/dsh-openmeter/tests/client-panel.spec.tsx
git commit -m "feat(openmeter): add tenant billing experience"
```

## Task 6: Documentation and full verification

**Files:**
- Modify: `plugins/dsh-openmeter/README.md`
- Modify: `plugins/dsh-openmeter/CONTEXT.md`
- Modify: `plugins/dsh-openmeter/docs/adr/0004-preset-is-billing-attribution-key.md`
- Create: `plugins/dsh-openmeter/docs/adr/0006-tenant-billing-read-model.md`

- [ ] **Step 1: Add a two-tenant non-leakage regression**

```ts
expect(JSON.stringify(acmeSummary.body)).not.toContain('globex')
expect(JSON.stringify(globexUsage.body)).not.toContain('cust-acme')
```

- [ ] **Step 2: Verify it guards the subject filter**

Run: `pnpm --filter dsh-openmeter test -- tests/tenant-billing-routes.spec.ts -t "two tenants"`

Expected: `PASS`; during code review, temporarily removing subject filtering must fail this test, then restore the correct implementation before continuing.

- [ ] **Step 3: Document the shipped authority contract**

Document Casdoor gateway identity forwarding, explicit tenant provisioning, Token-versus-CNY semantics, no-payment scope, operator route separation, and the local SQLite ledger's single-node limitation. Update ADR-0004 to state that preset attribution is never tenant authorization.

- [ ] **Step 4: Run package quality gates**

Run:

```bash
pnpm --filter dsh-openmeter test
pnpm --filter dsh-openmeter typecheck
pnpm --filter dsh-openmeter build
```

Expected: every command exits `0`. Report them as package automated verification, not live SaaS acceptance.

- [ ] **Step 5: Run browser acceptance with two identities**

Start the configured Casdoor gateway plus private DSH Web, sign in as two provisioned tenants, and verify overview, budget warning, journal drill-down, role-gated budget edit, absent operator controls, and data isolation. If environment dependencies prevent it, report browser acceptance as blocked rather than passed.

- [ ] **Step 6: Commit**

```bash
git add plugins/dsh-openmeter/README.md plugins/dsh-openmeter/CONTEXT.md plugins/dsh-openmeter/docs/adr/0004-preset-is-billing-attribution-key.md plugins/dsh-openmeter/docs/adr/0006-tenant-billing-read-model.md plugins/dsh-openmeter/tests/tenant-billing-routes.spec.ts
git commit -m "docs(openmeter): document tenant billing boundary"
```
