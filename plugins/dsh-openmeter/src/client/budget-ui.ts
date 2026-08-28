/**
 * Pure view model for the tenant budget warning (issue #8): classify one
 * budget payload into its visual state and render-ready money strings.
 *
 * Invariants:
 * - Pure functions only: no fetch, no clock, no locale; the panel owns
 *   loading, error, and rendering decisions and interpolates the strings
 *   into its own `budget.*` locale keys.
 * - No fabricated projection: `insufficient-history` offers no forecast,
 *   so it renders as `unavailable`, never as near or over.
 * - No budget, no ratio: `unconfigured` carries no budget to compare
 *   against, projection present or not.
 * - Progress is capped at 1: over-budget renders a full bar, never 120%.
 * - The client-optional `monthToDateCny` displays as ¥0.00 when absent
 *   (display-only defense); every other absent field stays null.
 *
 * @module dsh-openmeter/client/budget-ui
 */

import type { BudgetPayload } from './api.ts'
import { formatCny } from './usage-detail.ts'

/** A projection at or above this share of the monthly budget is `near`. */
export const BUDGET_NEAR_THRESHOLD_RATIO = 0.8

/** The five visual states of the budget warning. */
export type BudgetTone = 'under' | 'near' | 'over' | 'unconfigured' | 'unavailable'

/** Render-ready budget warning values. */
export interface BudgetCopyModel {
  /** Visual state from `budgetTone`. */
  readonly tone: BudgetTone
  /** `monthToDateCny / monthlyBudgetCny` clamped to [0,1]; null when the payload carries no budget. */
  readonly progress: number | null
  /** Formatted monthly budget; null when absent (unconfigured or failed fetch). */
  readonly budget: string | null
  /** Formatted month-to-date spend; ¥0.00 when the client-optional field is absent. */
  readonly spent: string
  /** Formatted month-end projection; null when absent (no metered calls). */
  readonly projected: string | null
  /** Formatted projected overage; null when absent (only `ready` carries it). */
  readonly overage: string | null
}

/**
 * Classify one budget payload into the five visual states of the warning.
 * @param payload - the tenant budget forecast; undefined when the fetch failed.
 * @returns `unavailable` on a failed fetch or `insufficient-history`;
 * `unconfigured` when no budget exists; on `ready`, `over` when the
 * projected overage is positive, else `near` at or above
 * `BUDGET_NEAR_THRESHOLD_RATIO` of the budget (boundary inclusive), else
 * `under` — an absent projection coalesces to 0 and stays `under`.
 */
export function budgetTone(payload: BudgetPayload | undefined): BudgetTone {
  if (payload === undefined) return 'unavailable'
  if (payload.availability === 'insufficient-history') return 'unavailable'
  if (payload.availability === 'unconfigured') return 'unconfigured'
  if ((payload.projectedOverageCny ?? 0) > 0) return 'over'
  if ((payload.projectedMonthEndCny ?? 0) >= (payload.monthlyBudgetCny ?? 0) * BUDGET_NEAR_THRESHOLD_RATIO) return 'near'
  return 'under'
}

/**
 * Build the budget warning view model from one payload. Money strings reuse
 * `formatCny`; absent optional fields stay null except the always-rendered
 * `spent`, which defends the client-optional `monthToDateCny` as ¥0.00.
 * Never mutates the input.
 * @param payload - the tenant budget forecast; undefined when the fetch failed.
 * @returns the render-ready copy model with its tone.
 */
export function budgetCopy(payload: BudgetPayload | undefined): BudgetCopyModel {
  const budget = payload?.monthlyBudgetCny
  const spent = payload?.monthToDateCny ?? 0
  return {
    tone: budgetTone(payload),
    progress: budget !== undefined && budget > 0 ? Math.min(1, Math.max(0, spent / budget)) : null,
    budget: budget === undefined ? null : formatCny(budget),
    spent: formatCny(spent),
    projected: payload?.projectedMonthEndCny === undefined ? null : formatCny(payload.projectedMonthEndCny),
    overage: payload?.projectedOverageCny === undefined ? null : formatCny(payload.projectedOverageCny),
  }
}
