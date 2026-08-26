/**
 * Pure view model for the tenant billing overview page: normalize one
 * summary payload plus per-model aggregate rows into render-ready values.
 *
 * Invariants (issue #3 额度概览首页):
 * - Pure functions only: no fetch, no clock, no locale; the page owns the
 *   loading, error, and rendering decisions.
 * - Token is not money: the runway divides the Token balance by the Token
 *   burn rate; the Token balance is never converted into (or compared
 *   against) the CNY estimate.
 * - Unknown is not zero: an absent balance stays absent (`availableTokens`
 *   undefined, `runwayDays` null), never a fabricated 0; a reported 0
 *   balance is a known 0 and forecasts 0 days.
 * - `unavailable` summaries keep the local 7-day aggregates and the model
 *   rows (the local ring is independent of OpenMeter) but carry no balance,
 *   access flag, or runway.
 *
 * @module dsh-openmeter/client/overview
 */

import type { SummaryPayload } from './api.ts'

/** Runway strictly below this many days is flagged as low credit. */
export const LOW_CREDIT_RUNWAY_DAYS = 7

/** One per-model aggregate row from the usage payload, before normalization. */
export interface ModelRow {
  readonly model: string
  readonly calls: number
  readonly tokens: number
  readonly amountCny: number
}

/** A per-model row normalized for display: deterministic order plus a capped share. */
export interface OverviewModelRow {
  readonly model: string
  readonly calls: number
  readonly tokens: number
  readonly amountCny: number
  /** Share of the total `amountCny` in percent, clamped to [0,100], 1 decimal. */
  readonly percent: number
}

/** Render-ready tenant billing overview. */
export interface OverviewModel {
  /** True when the summary is the safe `unavailable` state. */
  readonly unavailable: boolean
  /** Token balance; undefined when absent or unavailable (never a fabricated 0). */
  readonly availableTokens: number | undefined
  /** Feature access flag; undefined when unavailable. */
  readonly hasAccess: boolean | undefined
  /** Estimated days of Token balance left; null when not estimable. */
  readonly runwayDays: number | null
  /** True when `runwayDays` is strictly below LOW_CREDIT_RUNWAY_DAYS. */
  readonly lowCredit: boolean
  readonly usageTokens7d: number
  readonly estimatedCny7d: number
  readonly asOf: number
  /** Cost distribution: sorted by amountCny descending, ties by model ascending. */
  readonly models: readonly OverviewModelRow[]
}

/** Round to one decimal place, the display precision for runway and shares. */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** Order by amountCny descending; equal amounts fall back to model name ascending. */
function compareRows(a: ModelRow, b: ModelRow): number {
  if (a.amountCny !== b.amountCny) return b.amountCny - a.amountCny
  if (a.model < b.model) return -1
  if (a.model > b.model) return 1
  return 0
}

/** Share of the total in percent, clamped to [0,100] and rounded to 1 decimal; a zero total yields 0. */
function percentOf(amountCny: number, totalCny: number): number {
  if (totalCny === 0) return 0
  return round1(Math.min(100, Math.max(0, (amountCny / totalCny) * 100)))
}

/** Normalize rows into display order with capped percentage shares; never mutates the input. */
function buildModelRows(rows: readonly ModelRow[]): readonly OverviewModelRow[] {
  const totalCny = rows.reduce((sum, row) => sum + row.amountCny, 0)
  return [...rows]
    .sort(compareRows)
    .map(row => ({ ...row, percent: percentOf(row.amountCny, totalCny) }))
}

/**
 * Estimate how many days the Token balance still covers at the observed
 * burn rate: balance divided by the mean daily usage over the last 7 days,
 * rounded to 1 decimal. The Token balance is never converted into CNY.
 * @param availableTokens - Token balance; undefined when unknown.
 * @param usageTokens7d - billed tokens over the last 7 days.
 * @returns estimated days remaining, or null when the balance is unknown or the usage is <= 0 (no estimable burn rate).
 */
export function forecastRunwayDays(availableTokens: number | undefined, usageTokens7d: number): number | null {
  if (availableTokens === undefined) return null
  if (usageTokens7d <= 0) return null
  return round1(availableTokens / (usageTokens7d / 7))
}

/**
 * Build the overview view model from one summary payload and per-model rows.
 * On `unavailable`, local aggregates and model rows still render (the local
 * ring is independent of OpenMeter) while balance, access, and runway stay
 * absent; on `ready`, `availableTokens` and `hasAccess` pass through exactly
 * (absent stays absent).
 * @param summary - the tenant credit summary payload.
 * @param modelRows - per-model aggregate rows, any order.
 * @returns the render-ready overview model.
 */
export function buildOverviewModel(summary: SummaryPayload, modelRows: readonly ModelRow[]): OverviewModel {
  const models = buildModelRows(modelRows)
  if (summary.availability !== 'ready') {
    return {
      unavailable: true,
      availableTokens: undefined,
      hasAccess: undefined,
      runwayDays: null,
      lowCredit: false,
      usageTokens7d: summary.usageTokens7d,
      estimatedCny7d: summary.estimatedCny7d,
      asOf: summary.asOf,
      models,
    }
  }
  const runwayDays = forecastRunwayDays(summary.availableTokens, summary.usageTokens7d)
  return {
    unavailable: false,
    availableTokens: summary.availableTokens,
    hasAccess: summary.hasAccess,
    runwayDays,
    lowCredit: runwayDays !== null && runwayDays < LOW_CREDIT_RUNWAY_DAYS,
    usageTokens7d: summary.usageTokens7d,
    estimatedCny7d: summary.estimatedCny7d,
    asOf: summary.asOf,
    models,
  }
}
