# Tenant Identity and Billing Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the authenticated Tenant/Principal to exactly one OpenMeter Subject and enforce tenant-manager versus operator permissions.

**Architecture:** Add a small policy resolver at the dsh-openmeter boundary. It consumes the verified Casdoor identity supplied by the host and an explicit tenant-to-subject mapping; routes receive the resolved policy instead of trusting query/body tenant identifiers.

**Tech Stack:** TypeScript, Node.js, Vitest, existing `dsh-casdoor-auth` identity types, `dsh-openmeter` route seams.

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

## Global Constraints

- Tenant identity comes from Casdoor; client input never selects a tenant.
- The explicit tenant-to-OpenMeter Subject mapping is the only billing attribution source.
- Token quantities and CNY quote amounts remain separate concepts.
- No payment provider or new billing mode is introduced.

---

### Task 1: Policy resolver

**Files:**
- Create: `plugins/dsh-openmeter/src/tenant-policy.ts`
- Test: `plugins/dsh-openmeter/tests/tenant-policy.spec.ts`

**Interfaces:**
- Consumes: `CasdoorIdentity`-compatible `{ tenantId, userId, roles }` and a readonly `Record<string, string>` mapping.
- Produces: `resolveTenantPolicy(identity, mapping): TenantPolicy | PolicyError`, where `TenantPolicy` contains `tenantId`, `principal`, `subject`, `isTenantManager`, and `isOperator`.

- [x] **Step 1: Write the failing tests** for a mapped tenant, missing mapping, empty mapping value, cross-tenant identity, manager role, and operator role.
- [x] **Step 2: Run `pnpm --dir plugins/dsh-openmeter exec vitest run tests/tenant-policy.spec.ts`;** confirm the resolver module is missing and tests fail.
- [x] **Step 3: Implement deterministic validation**: trim identifiers, require non-empty tenant/user, resolve only `mapping[tenantId]`, and return typed error codes (`unauthenticated`, `tenant-unmapped`, `forbidden`).
- [x] **Step 4: Run the focused test again;** all policy cases must pass without network calls.
- [x] **Step 5: Commit** `feat: add tenant billing policy resolver`.

### Task 2: Route authorization seam

**Files:**
- Modify: `plugins/dsh-openmeter/src/routes.ts`
- Modify: `plugins/dsh-openmeter/src/index.ts`
- Test: `plugins/dsh-openmeter/tests/routes.spec.ts`

**Interfaces:**
- Consumes: `TenantPolicy` from Task 1 and the host identity provider.
- Produces: route guards that return 401 for absent identity, 403 for insufficient role, and never accept a tenant from query/body data.

- [x] **Step 1: Add failing route tests** for absent identity, mapped member, tenant manager, and cross-tenant request bodies.
- [x] **Step 2: Run the focused route tests** and verify the new cases fail.
- [x] **Step 3: Inject the identity/policy provider into `RouteDeps`** and gate tenant-facing handlers before OpenMeter calls; keep operator handlers behind `isOperator`.
- [x] **Step 4: Run `pnpm --dir plugins/dsh-openmeter test -- tests/routes.spec.ts`** and then `pnpm --dir plugins/dsh-openmeter typecheck`.
- [x] **Step 5: Record the policy rules in the domain glossary** — add entries to `plugins/dsh-openmeter/CONTEXT.md` covering: 租户计费主体映射 (tenantId -> subject is the only billing attribution source, operator-provisioned, never inferred from client input, never house), 策略解析 (identity comes only from the verified Casdoor identity; unknown subjects fail closed), and the error semantics (unauthenticated 401 / tenant-unmapped & forbidden 403, no fallback to other tenants). *(Amendment: required by the issue's acceptance criterion “规则、未知主体处理和错误语义记录在领域文档中”; issue #11 later does the full doc closure.)*
- [x] **Step 6: Commit** `feat: enforce tenant policy at billing routes`.
