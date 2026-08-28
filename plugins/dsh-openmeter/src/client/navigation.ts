/**
 * Pure navigation model for the billing section (issue #10): derive the
 * section's navigation entries from the authenticated capability set —
 * tenants always get the three self-service entries (概览, 用量明细, 预算),
 * and the operator surfaces (收银台, 运营者设置) appear only for operators.
 *
 * Invariants:
 * - Pure data only: no React, no fetch, no locale dictionaries. The panel
 *   (Task 2) renders these entries and owns every runtime decision.
 * - Hiding an operator entry NEVER replaces the server-side operator
 *   authorization on /api/openmeter/operator/* (issue #9); direct-route
 *   access stays guarded regardless of what this model returns.
 * - Total function: a missing capability set (identity still loading, or
 *   the capability probe failed) reads as a plain tenant — the safe default
 *   that never leaks operator surfaces.
 * - `manager` affects budget editability (the budget card's editor), not
 *   navigation: managers and members see the same three tenant entries.
 *
 * @module dsh-openmeter/client/navigation
 */

/** What the authenticated user can do in the billing section. */
export interface BillingCapabilities {
  /** The caller passed the server's operator policy gate (operator status probe succeeded). */
  readonly operator: boolean
  /**
   * The caller's policy grants budget writes (tenant-manager role). Optional:
   * it affects the budget editor, never the navigation itself, and the panel
   * may not know it yet when the navigation first renders.
   */
  readonly manager?: boolean
}

/** The panel views a navigation entry can switch to. */
export type BillingView = 'overview' | 'detail' | 'budget' | 'cashier' | 'settings'

/** One navigation entry of the billing section. */
export interface BillingNavigationEntry {
  /** Stable entry id; doubles as the panel view it switches to. */
  readonly id: BillingView
  /** The panel view the entry activates. */
  readonly view: BillingView
  /** Locale key the panel renders the entry label with. */
  readonly labelKey: string
  /** True only for operator surfaces; tenant entries are always present. */
  readonly operatorOnly: boolean
}

/** The three self-service entries every tenant sees, in display order. */
const TENANT_ENTRIES: readonly BillingNavigationEntry[] = [
  { id: 'overview', view: 'overview', labelKey: 'panel.overview', operatorOnly: false },
  { id: 'detail', view: 'detail', labelKey: 'detail.title', operatorOnly: false },
  { id: 'budget', view: 'budget', labelKey: 'budget.title', operatorOnly: false },
]

/** The operator entries, rendered after the tenant entries, operators only. */
const OPERATOR_ENTRIES: readonly BillingNavigationEntry[] = [
  { id: 'cashier', view: 'cashier', labelKey: 'panel.cashier', operatorOnly: true },
  { id: 'settings', view: 'settings', labelKey: 'panel.settings', operatorOnly: true },
]

/**
 * Derive the billing navigation from the capability set.
 * @param capabilities - the authenticated capabilities; undefined or partial
 * reads as a plain tenant (no operator surfaces, never throws).
 * @returns the navigation entries in display order.
 */
export function buildBillingNavigation(capabilities: BillingCapabilities | undefined): readonly BillingNavigationEntry[] {
  const operator = capabilities?.operator === true
  return operator ? [...TENANT_ENTRIES, ...OPERATOR_ENTRIES] : TENANT_ENTRIES
}
