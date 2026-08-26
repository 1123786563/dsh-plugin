/**
 * Tenant credit summary service: compose one tenant-scoped read of the mapped
 * subject's OpenMeter entitlement with the local pipeline's recent estimates.
 *
 * Invariants (spec sections 访问与归属边界 / 错误、降级与兼容性, issue #2):
 * - Tenant-scoped by construction: the subject comes only from the RESOLVED
 *   TenantPolicy (the operator-maintained mapping); client input never picks
 *   a subject and no other tenant's rows are ever read or summed.
 * - Token is not money: `availableTokens` is the entitlement's Token balance;
 *   `estimatedCny7d` is a CNY estimate from local rows. They are never
 *   conflated or converted into each other.
 * - Unknown is not zero: an entitlement that reports no balance yields an
 *   ABSENT `availableTokens` (never a fabricated 0; a reported 0 stays 0),
 *   and an entitlement read that throws yields the safe `unavailable` state
 *   carrying no balance, no access flag, and no exception details.
 * - A PolicyError input maps to the `unmapped` marker with the original code
 *   passed through, so routes keep their 401/403 mapping; nothing is read
 *   from OpenMeter in that case.
 *
 * Contract decisions (documented once, pinned by tests):
 * - The service accepts `TenantPolicy | PolicyError` so all three availability
 *   states live in ONE discriminated union; the route does not have to
 *   pre-split the policy result, but may map `unmapped` to 401/403 via `code`.
 * - `asOf` is epoch milliseconds captured from the injected clock BEFORE the
 *   entitlement read (same convention as pipeline `UsageRow.at`).
 * - `usageTokens7d` / `estimatedCny7d` come from the LOCAL ring, which is
 *   independent of OpenMeter availability: they stay present on `unavailable`.
 *   An empty window is a known zero (a computed sum over a known row set),
 *   which is honest, unlike an unknown remote balance.
 * - Non-CNY rows (estimator fallback pricing): their tokens still count toward
 *   `usageTokens7d`, but only `currency === 'CNY'` rows sum into
 *   `estimatedCny7d` — mixing currencies into one figure would be a lie.
 * - 7-day window: rows with `at >= now - 7*24h` (boundary inclusive), filtered
 *   to the policy subject; `usageTokens7d` follows pipeline.aggregates()'s
 *   convention, billedInputTokens(usage) + usage.outputTokens.
 *
 * Pure orchestration: entitlement accessor, recent-rows accessor, and clock
 * are injected, so tests need no HTTP. No logging, no identity values in
 * errors, no console output.
 *
 * @module dsh-openmeter/tenant-summary
 */

import { billedInputTokens } from './cloudevent.ts'
import type { EntitlementValue } from './openmeter.ts'
import type { UsageRow } from './pipeline.ts'
import type { PolicyError, PolicyErrorCode, TenantPolicy } from './tenant-policy.ts'

/** 7-day window length in milliseconds. */
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000

/** Injected collaborators: entitlement seam, local rows, and clock. */
export interface TenantSummaryDeps {
  /**
   * Entitlement snapshot seam for one subject. The route closes over
   * config.featureKey here (OpenMeterClient.entitlementValue); the service
   * itself is ignorant of which feature key names the balance.
   */
  readonly entitlement: (subject: string) => Promise<EntitlementValue>
  /** Recent local pipeline rows (the usage panel's ring). */
  readonly recentRows: () => readonly UsageRow[]
  /** Clock seam so the 7-day window and asOf are deterministic in tests. */
  readonly now: () => number
}

/** The entitlement read resolved; every field is known as stated. */
export interface TenantSummary {
  readonly availability: 'ready'
  readonly tenantId: string
  readonly subject: string
  /** Token balance; ABSENT when the entitlement reports no balance (never a fabricated 0). */
  readonly availableTokens?: number | undefined
  /** Whether the subject currently has access to the feature. */
  readonly hasAccess: boolean
  /**
   * Billed tokens (billed input + output) over the last 7 days, local rows.
   * Best-effort over the local ring: totals are capped by the ring limit and
   * the caller-provided row limit, so a busy subject may see a lower bound.
   */
  readonly usageTokens7d: number
  /**
   * CNY estimate over the last 7 days; CNY-currency local rows only.
   * Same ring-bound best-effort caveat as usageTokens7d.
   */
  readonly estimatedCny7d: number
  /** Epoch ms of the read attempt, from the injected clock. */
  readonly asOf: number
}

/**
 * The entitlement read failed (outage, timeout, any error). Safe state: no
 * balance, no access flag, no exception details. Local 7-day aggregates are
 * still present because the local ring is independent of OpenMeter.
 */
export interface TenantSummaryUnavailable {
  readonly availability: 'unavailable'
  readonly tenantId: string
  readonly subject: string
  readonly usageTokens7d: number
  readonly estimatedCny7d: number
  readonly asOf: number
}

/** The policy did not resolve; the original PolicyErrorCode passes through. */
export interface TenantSummaryUnmapped {
  readonly availability: 'unmapped'
  readonly code: PolicyErrorCode
}

/** One summary read: ready, safely unavailable, or unmapped. */
export type TenantSummaryResult = TenantSummary | TenantSummaryUnavailable | TenantSummaryUnmapped

/**
 * Sum this subject's rows inside the 7-day window into token and CNY totals.
 * Tokens follow pipeline.aggregates()'s convention; only CNY-currency rows
 * contribute to the CNY estimate.
 *
 * Totals are best-effort over the local ring: capped by the ring limit and
 * the caller-provided row limit, so a busy subject may see a lower bound.
 * Subject match is exact and case-sensitive; a non-empty trimmed subject is
 * guaranteed by resolveTenantPolicy.
 * @param rows - recent local pipeline rows.
 * @param subject - the one subject to aggregate.
 * @param now - epoch ms from the injected clock.
 */
function aggregate7d(rows: readonly UsageRow[], subject: string, now: number): { tokens: number, cny: number } {
  const floor = now - WINDOW_7D_MS
  let tokens = 0
  let cny = 0
  for (const row of rows) {
    if (row.subject !== subject) continue
    if (row.at < floor) continue
    tokens += billedInputTokens(row.usage) + row.usage.outputTokens
    if (row.currency === 'CNY') cny += row.estimatedAmount
  }
  return { tokens, cny }
}

/**
 * Load the tenant-scoped credit summary for one resolved policy (or map a
 * PolicyError to the unmapped marker without touching OpenMeter).
 * @param policy - the resolved TenantPolicy, or the PolicyError to pass through.
 * @param deps - entitlement seam, recent local rows, and clock.
 * @returns the discriminated summary result; never throws for OpenMeter
 * failures, and never converts an exception or missing value into 0.
 */
export async function loadTenantSummary(
  policy: TenantPolicy | PolicyError,
  deps: TenantSummaryDeps,
): Promise<TenantSummaryResult> {
  if (!policy.ok) return { availability: 'unmapped', code: policy.code }
  const asOf = deps.now()
  const { tokens, cny } = aggregate7d(deps.recentRows(), policy.subject, asOf)
  try {
    const value = await deps.entitlement(policy.subject)
    return {
      availability: 'ready',
      tenantId: policy.tenantId,
      subject: policy.subject,
      ...(value.balance === undefined ? {} : { availableTokens: value.balance }),
      hasAccess: value.hasAccess,
      usageTokens7d: tokens,
      estimatedCny7d: cny,
      asOf,
    }
  } catch {
    // OpenMeter outage/timeout: a safe state with no balance and no exception
    // details. Local aggregates stay — the ring does not depend on OpenMeter.
    return {
      availability: 'unavailable',
      tenantId: policy.tenantId,
      subject: policy.subject,
      usageTokens7d: tokens,
      estimatedCny7d: cny,
      asOf,
    }
  }
}
