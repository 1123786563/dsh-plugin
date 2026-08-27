process.env.TZ = 'Asia/Shanghai'
import { describe, expect, it } from 'vitest'
import { formatClock, formatCny, formatTokens, groupUsageRows, toUsageQuery } from '../src/client/usage-detail.ts'
import type { UsageDetailRow } from '../src/client/api.ts'

/**
 * Shanghai is UTC+8 with no DST, so every expected label below is the
 * explicit UTC constructor shifted by a fixed 8 hours.
 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/** UTC epoch ms of the given Shanghai local wall-clock time. */
function shanghai(year: number, monthIndex: number, day: number, hours = 0, minutes = 0, seconds = 0, ms = 0): number {
  return Date.UTC(year, monthIndex, day, hours, minutes, seconds, ms) - SHANGHAI_OFFSET_MS
}

const DAY_MS = 86_400_000

function makeRow(overrides: Partial<UsageDetailRow> = {}): UsageDetailRow {
  return {
    at: overrides.at ?? shanghai(2026, 7, 30, 9, 30, 15, 123),
    provider: overrides.provider ?? 'deepseek',
    model: overrides.model ?? 'deepseek-chat',
    tokens: overrides.tokens ?? 1000,
    inputTokens: overrides.inputTokens ?? 700,
    outputTokens: overrides.outputTokens ?? 300,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    reasoningTokens: overrides.reasoningTokens ?? 0,
    estimatedAmount: overrides.estimatedAmount ?? 1,
    currency: overrides.currency ?? 'CNY',
    unpriced: overrides.unpriced ?? false,
  }
}

describe('groupUsageRows', () => {
  it('groups reverse-chron rows into newest-first day groups keyed by stable zero-padded YYYY-MM-DD local labels', () => {
    const rows = [
      makeRow({ at: shanghai(2026, 7, 30, 9, 30) }),
      makeRow({ at: shanghai(2026, 7, 29, 23, 0) }),
      makeRow({ at: shanghai(2026, 7, 28, 8, 0) }),
      makeRow({ at: shanghai(2026, 7, 28, 7, 0) }),
    ]
    const groups = groupUsageRows(rows)
    expect(groups.map(group => group.key)).toEqual(['2026-08-30', '2026-08-29', '2026-08-28'])
  })

  it('accumulates same-day rows into one group keeping arrival order, with per-day calls and tokens', () => {
    const rows = [
      makeRow({ at: shanghai(2026, 7, 30, 9, 0), model: 'deepseek-chat', tokens: 1200 }),
      makeRow({ at: shanghai(2026, 7, 30, 8, 0), model: 'deepseek-reasoner', tokens: 300 }),
      makeRow({ at: shanghai(2026, 7, 30, 7, 0), model: 'deepseek-coder', tokens: 500 }),
      makeRow({ at: shanghai(2026, 7, 29, 21, 0), model: 'deepseek-chat', tokens: 800 }),
    ]
    const [day30, day29] = groupUsageRows(rows)
    expect(day30.key).toBe('2026-08-30')
    expect(day30.calls).toBe(3)
    expect(day30.tokens).toBe(2000)
    expect(day30.rows.map(row => row.model)).toEqual(['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'])
    expect(day29.key).toBe('2026-08-29')
    expect(day29.calls).toBe(1)
    expect(day29.tokens).toBe(800)
  })

  it('sums estimatedAmountCny over CNY rows only, never mixing in non-CNY amounts', () => {
    const groups = groupUsageRows([
      makeRow({ estimatedAmount: 2.5, currency: 'CNY' }),
      makeRow({ estimatedAmount: 0.75, currency: 'USD' }),
      makeRow({ estimatedAmount: 1.25, currency: 'CNY' }),
    ])
    expect(groups[0]?.estimatedAmountCny).toBe(3.75)
  })

  it('counts unpriced rows into unpricedCalls but never into the money sum', () => {
    const groups = groupUsageRows([
      makeRow({ estimatedAmount: 2, currency: 'CNY', unpriced: false }),
      makeRow({ estimatedAmount: 9, currency: 'CNY', unpriced: true }),
      makeRow({ estimatedAmount: 1, currency: 'CNY', unpriced: false }),
    ])
    expect(groups[0]?.estimatedAmountCny).toBe(3)
    expect(groups[0]?.unpricedCalls).toBe(1)
    expect(groups[0]?.calls).toBe(3)
  })

  it('splits two timestamps 1 ms apart across local midnight into different day groups', () => {
    const groups = groupUsageRows([
      makeRow({ at: shanghai(2026, 7, 30, 0, 0, 0, 0) }),
      makeRow({ at: shanghai(2026, 7, 29, 23, 59, 59, 999) }),
    ])
    expect(groups.map(group => group.key)).toEqual(['2026-08-30', '2026-08-29'])
  })

  it('never mutates the input array or its rows', () => {
    const rows = [
      makeRow({ at: shanghai(2026, 7, 30, 9, 0) }),
      makeRow({ at: shanghai(2026, 7, 29, 9, 0) }),
    ]
    const snapshot = structuredClone(rows)
    groupUsageRows(rows)
    expect(rows).toEqual(snapshot)
    expect(rows.length).toBe(2)
  })
})

describe('toUsageQuery', () => {
  it('maps local day strings to inclusive epoch-ms bounds: from at 00:00:00.000, to at 23:59:59.999', () => {
    const query = toUsageQuery({ from: '2026-08-01', to: '2026-08-01' })
    expect(query.from).toBe(shanghai(2026, 7, 1))
    expect(query.to).toBe(shanghai(2026, 7, 1) + DAY_MS - 1)
  })

  it('omits empty or unparseable date strings instead of yielding NaN', () => {
    expect(toUsageQuery({})).toEqual({})
    expect(toUsageQuery({ from: '', to: '' })).toEqual({})
    expect(toUsageQuery({ from: 'not-a-date', to: '2026-13-01' })).toEqual({})
    expect(toUsageQuery({ from: '2026-02-30' })).toEqual({})
  })

  it('trims the model filter and omits it when empty after trimming', () => {
    expect(toUsageQuery({ model: '  deepseek-chat  ' })).toEqual({ model: 'deepseek-chat' })
    expect(toUsageQuery({ model: '   ' })).toEqual({})
  })

  it('passes a non-empty cursor through unchanged and drops an empty one', () => {
    expect(toUsageQuery({}, 'opaque-token')).toEqual({ cursor: 'opaque-token' })
    expect(toUsageQuery({}, '')).toEqual({})
  })

  it('never sets limit', () => {
    const queries = [
      toUsageQuery({}),
      toUsageQuery({ from: '2026-08-01', to: '2026-08-02', model: 'deepseek-chat' }, 'cursor-1'),
      toUsageQuery({ from: '', model: '  ' }, 'cursor-2'),
    ]
    for (const query of queries) expect('limit' in query).toBe(false)
  })

  it('advancing the cursor preserves from, to, and model exactly and only adds cursor', () => {
    const filters = { from: '2026-08-01', to: '2026-08-31', model: 'deepseek-chat' }
    const first = toUsageQuery(filters)
    const next = toUsageQuery(filters, 'opaque-token')
    expect(next.from).toBe(first.from)
    expect(next.to).toBe(first.to)
    expect(next.model).toBe(first.model)
    expect(next.cursor).toBe('opaque-token')
    expect(first.cursor).toBeUndefined()
  })
})

describe('formatters', () => {
  it('formatCny renders a deterministic two-decimal amount with the currency sign', () => {
    expect(formatCny(0)).toBe('¥0.00')
    expect(formatCny(1.5)).toBe('¥1.50')
    expect(formatCny(1234.567)).toBe('¥1234.57')
  })

  it('formatTokens renders deterministic en-US grouping', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(1234567)).toBe('1,234,567')
  })

  it('formatClock renders zero-padded local HH:mm:ss under the pinned timezone', () => {
    expect(formatClock(shanghai(2026, 7, 30, 9, 5, 3))).toBe('09:05:03')
    expect(formatClock(shanghai(2026, 7, 30, 23, 59, 59))).toBe('23:59:59')
    expect(formatClock(shanghai(2026, 7, 30, 0, 0, 0))).toBe('00:00:00')
  })
})
