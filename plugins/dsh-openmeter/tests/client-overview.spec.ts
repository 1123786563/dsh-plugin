import { describe, expect, it } from 'vitest'
import { buildOverviewModel, forecastRunwayDays, LOW_CREDIT_RUNWAY_DAYS } from '../src/client/overview.ts'
import type { ModelRow } from '../src/client/overview.ts'
import type { SummaryPayload } from '../src/client/api.ts'

const NOW = Date.parse('2026-08-30T12:00:00.000Z')

function makeSummary(overrides: {
  availability?: 'ready' | 'unavailable'
  availableTokens?: number
  hasAccess?: boolean
  usageTokens7d?: number
  estimatedCny7d?: number
} = {}): SummaryPayload {
  return {
    ok: true,
    availability: overrides.availability ?? 'ready',
    tenantId: 'tenant-a',
    subject: 'cust-a',
    ...(overrides.availableTokens === undefined ? {} : { availableTokens: overrides.availableTokens }),
    ...(overrides.hasAccess === undefined ? {} : { hasAccess: overrides.hasAccess }),
    usageTokens7d: overrides.usageTokens7d ?? 1400,
    estimatedCny7d: overrides.estimatedCny7d ?? 12.5,
    asOf: NOW,
  }
}

function makeModelRow(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    model: overrides.model ?? 'deepseek-chat',
    calls: overrides.calls ?? 10,
    tokens: overrides.tokens ?? 1000,
    amountCny: overrides.amountCny ?? 1,
  }
}

describe('forecastRunwayDays', () => {
  it('derives runway from the seven-day burn rate: 8000 tokens at 1400 tokens/7d is 40 days', () => {
    expect(forecastRunwayDays(8000, 1400)).toBe(40)
  })

  it('rounds to one decimal place', () => {
    // 1000 / (3000 / 7) = 2.3333… -> 2.3
    expect(forecastRunwayDays(1000, 3000)).toBe(2.3)
  })

  it('returns null when the seven-day usage is zero or negative: no estimable burn rate', () => {
    expect(forecastRunwayDays(8000, 0)).toBeNull()
    expect(forecastRunwayDays(8000, -1400)).toBeNull()
  })

  it('returns null when the balance is absent: unknown is not zero', () => {
    expect(forecastRunwayDays(undefined, 1400)).toBeNull()
  })
})

describe('buildOverviewModel (ready)', () => {
  it('passes balance, access, and local aggregates through and derives the runway', () => {
    const model = buildOverviewModel(makeSummary({ availableTokens: 8000, hasAccess: true }), [])
    expect(model).toEqual({
      unavailable: false,
      availableTokens: 8000,
      hasAccess: true,
      runwayDays: 40,
      lowCredit: false,
      usageTokens7d: 1400,
      estimatedCny7d: 12.5,
      asOf: NOW,
      models: [],
    })
  })

  it('keeps an absent balance absent and the runway unknown instead of fabricating zeros', () => {
    const model = buildOverviewModel(makeSummary({ hasAccess: false }), [])
    expect(model.availableTokens).toBeUndefined()
    expect(model.hasAccess).toBe(false)
    expect(model.runwayDays).toBeNull()
    expect(model.lowCredit).toBe(false)
  })

  it('flags low credit strictly below LOW_CREDIT_RUNWAY_DAYS (7.0 stays clear, 6.9 is low)', () => {
    expect(LOW_CREDIT_RUNWAY_DAYS).toBe(7)
    // 700 / (700 / 7) = exactly 7.0 days; 690 / 100 = 6.9 days.
    const atThreshold = buildOverviewModel(makeSummary({ availableTokens: 700, usageTokens7d: 700 }), [])
    const below = buildOverviewModel(makeSummary({ availableTokens: 690, usageTokens7d: 700 }), [])
    expect(atThreshold.runwayDays).toBe(7)
    expect(atThreshold.lowCredit).toBe(false)
    expect(below.runwayDays).toBe(6.9)
    expect(below.lowCredit).toBe(true)
  })
})

describe('buildOverviewModel (unavailable)', () => {
  it('flags unavailable, keeps the local aggregates, and exposes no balance, access, or runway even if the payload carries them', () => {
    const model = buildOverviewModel(
      makeSummary({
        availability: 'unavailable',
        availableTokens: 999,
        hasAccess: true,
        usageTokens7d: 1200,
        estimatedCny7d: 3.5,
      }),
      [
        makeModelRow({ model: 'deepseek-chat', calls: 4, tokens: 700, amountCny: 5 }),
        makeModelRow({ model: 'deepseek-reasoner', calls: 3, tokens: 500, amountCny: 3 }),
      ],
    )
    expect(model).toEqual({
      unavailable: true,
      availableTokens: undefined,
      hasAccess: undefined,
      runwayDays: null,
      lowCredit: false,
      usageTokens7d: 1200,
      estimatedCny7d: 3.5,
      asOf: NOW,
      models: [
        { model: 'deepseek-chat', calls: 4, tokens: 700, amountCny: 5, percent: 62.5 },
        { model: 'deepseek-reasoner', calls: 3, tokens: 500, amountCny: 3, percent: 37.5 },
      ],
    })
  })
})

describe('buildOverviewModel (model normalization)', () => {
  it('sorts models by amountCny descending and breaks ties by model name ascending', () => {
    const model = buildOverviewModel(makeSummary(), [
      makeModelRow({ model: 'deepseek-chat', amountCny: 2 }),
      makeModelRow({ model: 'deepseek-reasoner', amountCny: 5 }),
      makeModelRow({ model: 'deepseek-coder', amountCny: 5 }),
      makeModelRow({ model: 'deepseek-vlm', amountCny: 1 }),
    ])
    expect(model.models.map(row => row.model)).toEqual(['deepseek-coder', 'deepseek-reasoner', 'deepseek-chat', 'deepseek-vlm'])
  })

  it('expresses each model share of the total CNY as a percentage rounded to one decimal', () => {
    const model = buildOverviewModel(makeSummary(), [
      makeModelRow({ model: 'deepseek-chat', amountCny: 2 }),
      makeModelRow({ model: 'deepseek-reasoner', amountCny: 1 }),
    ])
    expect(model.models.map(row => [row.model, row.percent])).toEqual([['deepseek-chat', 66.7], ['deepseek-reasoner', 33.3]])
  })

  it('clamps shares into [0,100] when a negative amount shrinks the total', () => {
    const model = buildOverviewModel(makeSummary(), [
      makeModelRow({ model: 'deepseek-chat', amountCny: 10 }),
      makeModelRow({ model: 'deepseek-reasoner', amountCny: -5 }),
    ])
    expect(model.models.map(row => [row.model, row.percent])).toEqual([['deepseek-chat', 100], ['deepseek-reasoner', 0]])
  })

  it('reports every share as 0 when the total amount is 0', () => {
    const model = buildOverviewModel(makeSummary(), [
      makeModelRow({ model: 'deepseek-chat', amountCny: 0 }),
      makeModelRow({ model: 'deepseek-reasoner', amountCny: 0 }),
    ])
    expect(model.models.map(row => row.percent)).toEqual([0, 0])
  })
})
