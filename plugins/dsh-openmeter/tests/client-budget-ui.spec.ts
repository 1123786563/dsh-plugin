import { describe, expect, it } from 'vitest'
import { BUDGET_NEAR_THRESHOLD_RATIO, budgetCopy, budgetTone } from '../src/client/budget-ui.ts'
import type { BudgetPayload } from '../src/client/api.ts'

const NOW = Date.parse('2026-09-10T12:00:00.000Z')

function makeBudget(overrides: {
  availability?: BudgetPayload['availability']
  monthlyBudgetCny?: number
  monthToDateCny?: number
  projectedMonthEndCny?: number
  projectedOverageCny?: number
} = {}): BudgetPayload {
  return {
    ok: true,
    availability: overrides.availability ?? 'ready',
    basis: {
      method: 'linear-daily-average',
      monthStartMs: Date.parse('2026-09-01T00:00:00.000Z'),
      monthEndMs: Date.parse('2026-09-30T23:59:59.999Z'),
      daysInMonth: 30,
      daysElapsed: 10,
      dataAsOfMs: NOW,
      currency: 'CNY',
      spendSource: 'openmeter',
    },
    ...(overrides.monthlyBudgetCny === undefined ? {} : { monthlyBudgetCny: overrides.monthlyBudgetCny }),
    ...(overrides.monthToDateCny === undefined ? {} : { monthToDateCny: overrides.monthToDateCny }),
    ...(overrides.projectedMonthEndCny === undefined ? {} : { projectedMonthEndCny: overrides.projectedMonthEndCny }),
    ...(overrides.projectedOverageCny === undefined ? {} : { projectedOverageCny: overrides.projectedOverageCny }),
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

describe('budgetTone', () => {
  it("maps a ready projection at half the budget with zero overage to 'under'", () => {
    const payload = makeBudget({ monthlyBudgetCny: 100, monthToDateCny: 40, projectedMonthEndCny: 50, projectedOverageCny: 0 })
    expect(budgetTone(payload)).toBe('under')
  })

  it("stays 'under' when the month has no metered calls yet (no projection, no overage)", () => {
    const payload = makeBudget({ monthlyBudgetCny: 100, monthToDateCny: 0 })
    expect(budgetTone(payload)).toBe('under')
  })

  it("maps a projection at exactly BUDGET_NEAR_THRESHOLD_RATIO of the budget to 'near' (boundary inclusive)", () => {
    expect(BUDGET_NEAR_THRESHOLD_RATIO).toBe(0.8)
    const budget = 100
    const boundary = budget * BUDGET_NEAR_THRESHOLD_RATIO
    const payload = makeBudget({ monthlyBudgetCny: budget, monthToDateCny: 70, projectedMonthEndCny: boundary, projectedOverageCny: 0 })
    expect(budgetTone(payload)).toBe('near')
  })

  it("stays 'under' just below BUDGET_NEAR_THRESHOLD_RATIO of the budget", () => {
    const budget = 100
    const justUnder = budget * BUDGET_NEAR_THRESHOLD_RATIO - 0.01
    const payload = makeBudget({ monthlyBudgetCny: budget, monthToDateCny: 60, projectedMonthEndCny: justUnder, projectedOverageCny: 0 })
    expect(budgetTone(payload)).toBe('under')
  })

  it("maps a positive projected overage to 'over'", () => {
    const payload = makeBudget({ monthlyBudgetCny: 100, monthToDateCny: 120, projectedMonthEndCny: 150, projectedOverageCny: 50 })
    expect(budgetTone(payload)).toBe('over')
  })

  it("maps 'unconfigured' to 'unconfigured' with or without a projection (no budget exists to compare)", () => {
    const withProjection = makeBudget({ availability: 'unconfigured', monthToDateCny: 12.34, projectedMonthEndCny: 40 })
    const withoutProjection = makeBudget({ availability: 'unconfigured', monthToDateCny: 0 })
    expect(budgetTone(withProjection)).toBe('unconfigured')
    expect(budgetTone(withoutProjection)).toBe('unconfigured')
  })

  it("maps 'insufficient-history' to 'unavailable' (the server offers no projection; none is fabricated)", () => {
    const payload = makeBudget({ availability: 'insufficient-history', monthlyBudgetCny: 100, monthToDateCny: 0 })
    expect(budgetTone(payload)).toBe('unavailable')
  })

  it('maps a failed fetch (undefined payload) to unavailable', () => {
    expect(budgetTone(undefined)).toBe('unavailable')
  })
})

describe('budgetCopy progress', () => {
  it('derives spent/budget: 50 of 100 is 0.5', () => {
    const copy = budgetCopy(makeBudget({ monthlyBudgetCny: 100, monthToDateCny: 50, projectedMonthEndCny: 80, projectedOverageCny: 0 }))
    expect(copy.progress).toBe(0.5)
  })

  it('caps progress at 1 when spend exceeds the budget (over-budget shows a full bar, never 120%)', () => {
    const copy = budgetCopy(makeBudget({ monthlyBudgetCny: 100, monthToDateCny: 150, projectedMonthEndCny: 200, projectedOverageCny: 100 }))
    expect(copy.progress).toBe(1)
  })

  it('reports exactly 1 when spend equals the budget', () => {
    const copy = budgetCopy(makeBudget({ monthlyBudgetCny: 100, monthToDateCny: 100, projectedMonthEndCny: 110, projectedOverageCny: 10 }))
    expect(copy.progress).toBe(1)
  })

  it('reports null when no budget exists (unconfigured)', () => {
    const copy = budgetCopy(makeBudget({ availability: 'unconfigured', monthToDateCny: 12.34, projectedMonthEndCny: 40 }))
    expect(copy.progress).toBeNull()
  })

  it('reports null when the fetch failed (undefined payload)', () => {
    expect(budgetCopy(undefined).progress).toBeNull()
  })

  it('reports the honest 0 for insufficient-history (budget present, spend 0), not null', () => {
    const copy = budgetCopy(makeBudget({ availability: 'insufficient-history', monthlyBudgetCny: 100, monthToDateCny: 0 }))
    expect(copy.progress).toBe(0)
  })

  it('treats an absent client-optional monthToDateCny as 0 spend', () => {
    const copy = budgetCopy(makeBudget({ monthlyBudgetCny: 100, monthToDateCny: undefined }))
    expect(copy.progress).toBe(0)
    expect(copy.spent).toBe('¥0.00')
  })
})

describe('budgetCopy strings', () => {
  it('renders money via formatCny: budget, spent, projected, overage', () => {
    const copy = budgetCopy(makeBudget({ monthlyBudgetCny: 100, monthToDateCny: 12.34, projectedMonthEndCny: 87.5, projectedOverageCny: 0 }))
    expect(copy.budget).toBe('¥100.00')
    expect(copy.spent).toBe('¥12.34')
    expect(copy.projected).toBe('¥87.50')
    expect(copy.overage).toBe('¥0.00')
  })

  it("keeps the ready-under overage present as '¥0.00' (the server sends it on ready)", () => {
    const copy = budgetCopy(makeBudget({ monthlyBudgetCny: 100, monthToDateCny: 10, projectedMonthEndCny: 50, projectedOverageCny: 0 }))
    expect(copy.tone).toBe('under')
    expect(copy.overage).toBe('¥0.00')
  })

  it("keeps the near-boundary overage present as '¥0.00'", () => {
    const payload = makeBudget({
      monthlyBudgetCny: 100,
      monthToDateCny: 70,
      projectedMonthEndCny: 100 * BUDGET_NEAR_THRESHOLD_RATIO,
      projectedOverageCny: 0,
    })
    const copy = budgetCopy(payload)
    expect(copy.tone).toBe('near')
    expect(copy.overage).toBe('¥0.00')
  })

  it('renders the over-budget overage as money', () => {
    const copy = budgetCopy(makeBudget({ monthlyBudgetCny: 100, monthToDateCny: 120, projectedMonthEndCny: 156.78, projectedOverageCny: 56.78 }))
    expect(copy.tone).toBe('over')
    expect(copy.overage).toBe('¥56.78')
    expect(copy.projected).toBe('¥156.78')
  })

  it('on unconfigured: budget null, projected rendered when present, overage null', () => {
    const copy = budgetCopy(makeBudget({ availability: 'unconfigured', monthToDateCny: 12.34, projectedMonthEndCny: 40 }))
    expect(copy.budget).toBeNull()
    expect(copy.projected).toBe('¥40.00')
    expect(copy.overage).toBeNull()
  })

  it('on unconfigured without metered calls: projected null and spent renders as ¥0.00', () => {
    const copy = budgetCopy(makeBudget({ availability: 'unconfigured', monthToDateCny: 0 }))
    expect(copy.budget).toBeNull()
    expect(copy.projected).toBeNull()
    expect(copy.overage).toBeNull()
    expect(copy.spent).toBe('¥0.00')
  })

  it('on insufficient-history: budget rendered, projected null, overage null', () => {
    const copy = budgetCopy(makeBudget({ availability: 'insufficient-history', monthlyBudgetCny: 200, monthToDateCny: 0 }))
    expect(copy.budget).toBe('¥200.00')
    expect(copy.projected).toBeNull()
    expect(copy.overage).toBeNull()
  })

  it('on a failed fetch: everything null except the always-rendered spent ¥0.00', () => {
    expect(budgetCopy(undefined)).toEqual({
      tone: 'unavailable',
      progress: null,
      budget: null,
      spent: '¥0.00',
      projected: null,
      overage: null,
    })
  })
})

describe('budgetCopy purity', () => {
  it('never mutates the payload (deep-frozen input) and returns equal output on repeated calls', () => {
    const payload = makeBudget({ monthlyBudgetCny: 100, monthToDateCny: 45.6, projectedMonthEndCny: 123.45, projectedOverageCny: 23.45 })
    deepFreeze(payload)
    const first = budgetCopy(payload)
    expect(() => budgetTone(payload)).not.toThrow()
    expect(() => budgetCopy(payload)).not.toThrow()
    expect(budgetCopy(payload)).toEqual(first)
  })
})
