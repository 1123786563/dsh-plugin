import { describe, expect, it } from 'vitest'
import { loadTenantSummary } from '../src/tenant-summary.ts'
import type { TenantSummaryDeps } from '../src/tenant-summary.ts'
import type { PolicyError, TenantPolicy } from '../src/tenant-policy.ts'
import type { EntitlementValue } from '../src/openmeter.ts'
import type { UsageRow } from '../src/pipeline.ts'
import type { CallUsage } from '../src/cloudevent.ts'

const NOW = Date.parse('2026-08-30T12:00:00.000Z')
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function makePolicy(overrides: { subject?: string, tenantId?: string } = {}): TenantPolicy {
  return {
    ok: true,
    tenantId: overrides.tenantId ?? 'tenant-a',
    principal: 'user-1',
    subject: overrides.subject ?? 'cust-a',
    isTenantManager: false,
    isOperator: false,
  }
}

function makeUsage(overrides: Partial<CallUsage> = {}): CallUsage {
  return { inputTokens: 1000, outputTokens: 200, ...overrides }
}

function makeRow(overrides: {
  subject?: string
  usage?: CallUsage
  estimatedAmount?: number
  currency?: string
  at?: number
} = {}): UsageRow {
  return {
    sessionId: 'session-1',
    subject: overrides.subject ?? 'cust-a',
    provider: 'deepseek',
    model: 'deepseek-chat',
    usage: overrides.usage ?? makeUsage(),
    estimatedAmount: overrides.estimatedAmount ?? 1,
    currency: overrides.currency ?? 'CNY',
    unpriced: false,
    at: overrides.at ?? NOW - 3_600_000,
  }
}

/** Deps factory that records which subjects the entitlement seam was asked for. */
function makeDeps(options: {
  rows?: readonly UsageRow[]
  entitlement?: (subject: string) => Promise<EntitlementValue>
} = {}): TenantSummaryDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    entitlement: (subject: string) => {
      calls.push(subject)
      if (options.entitlement !== undefined) return options.entitlement(subject)
      return Promise.resolve({ hasAccess: true, balance: 8000 })
    },
    recentRows: () => options.rows ?? [],
    now: () => NOW,
  }
}

describe('loadTenantSummary (ready)', () => {
  it('resolves a mapped subject to a ready summary scoped to that subject', async () => {
    const row = makeRow({
      usage: makeUsage({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 50 }),
      estimatedAmount: 12.5,
    })
    const deps = makeDeps({ rows: [row] })
    const summary = await loadTenantSummary(makePolicy(), deps)
    expect(summary).toEqual({
      availability: 'ready',
      tenantId: 'tenant-a',
      subject: 'cust-a',
      availableTokens: 8000,
      hasAccess: true,
      usageTokens7d: 1550,
      estimatedCny7d: 12.5,
      asOf: NOW,
    })
    expect(deps.calls).toEqual(['cust-a'])
  })

  it('keeps the Token balance and the CNY estimate as distinct fields with their own values', async () => {
    const deps = makeDeps({
      rows: [makeRow({ usage: makeUsage({ inputTokens: 500, outputTokens: 100 }), estimatedAmount: 0.05 })],
      entitlement: () => Promise.resolve({ hasAccess: true, balance: 600 }),
    })
    const summary = await loadTenantSummary(makePolicy(), deps)
    expect(summary.availability).toBe('ready')
    if (summary.availability !== 'ready') return
    expect(summary.availableTokens).toBe(600)
    expect(summary.estimatedCny7d).toBe(0.05)
    expect(summary.availableTokens).not.toBe(summary.estimatedCny7d)
  })

  it('reports a known zero balance as 0, distinct from an absent balance', async () => {
    const deps = makeDeps({ entitlement: () => Promise.resolve({ hasAccess: true, balance: 0 }) })
    const summary = await loadTenantSummary(makePolicy(), deps)
    expect(summary.availability).toBe('ready')
    if (summary.availability !== 'ready') return
    expect(summary.availableTokens).toBe(0)
  })
})

describe('loadTenantSummary (missing entitlement)', () => {
  it('omits availableTokens entirely when the entitlement reports no balance', async () => {
    const deps = makeDeps({ entitlement: () => Promise.resolve({ hasAccess: false }) })
    const summary = await loadTenantSummary(makePolicy(), deps)
    expect(summary).toEqual({
      availability: 'ready',
      tenantId: 'tenant-a',
      subject: 'cust-a',
      hasAccess: false,
      usageTokens7d: 0,
      estimatedCny7d: 0,
      asOf: NOW,
    })
    expect(Object.hasOwn(summary, 'availableTokens')).toBe(false)
  })
})

describe('loadTenantSummary (OpenMeter rejection)', () => {
  it('returns a safe unavailable state with no balance, no access flag, and no exception details', async () => {
    const deps = makeDeps({
      rows: [makeRow({ estimatedAmount: 3.5 })],
      entitlement: () => Promise.reject(new Error('openmeter GET /api/v2/entitlements -> 503: boom')),
    })
    const summary = await loadTenantSummary(makePolicy(), deps)
    expect(summary).toEqual({
      availability: 'unavailable',
      tenantId: 'tenant-a',
      subject: 'cust-a',
      usageTokens7d: 1200,
      estimatedCny7d: 3.5,
      asOf: NOW,
    })
    expect(Object.hasOwn(summary, 'availableTokens')).toBe(false)
    expect(Object.hasOwn(summary, 'hasAccess')).toBe(false)
    expect(JSON.stringify(summary)).not.toContain('503')
    expect(JSON.stringify(summary)).not.toContain('boom')
  })

  it('treats any rejection reason (not just Error) as unavailable', async () => {
    const deps = makeDeps({ entitlement: () => Promise.reject(new Error('network timeout')) })
    const summary = await loadTenantSummary(makePolicy(), deps)
    expect(summary.availability).toBe('unavailable')
  })
})

describe('loadTenantSummary (unmapped policy)', () => {
  it('maps an unresolved PolicyError to the unmapped marker with the code passed through', async () => {
    for (const code of ['unauthenticated', 'tenant-unmapped', 'forbidden'] as const) {
      const deps = makeDeps()
      const error: PolicyError = { ok: false, code }
      expect(await loadTenantSummary(error, deps)).toEqual({ availability: 'unmapped', code })
      expect(deps.calls).toEqual([])
    }
  })
})

describe('loadTenantSummary (7-day window and subject scoping)', () => {
  it("aggregates only this subject's rows inside the 7-day window (boundary inclusive)", async () => {
    const rows = [
      makeRow({ at: NOW - 3_600_000, usage: makeUsage({ inputTokens: 1000, outputTokens: 200 }), estimatedAmount: 1.5 }),
      makeRow({ at: NOW - WINDOW_MS, usage: makeUsage({ inputTokens: 100, outputTokens: 50 }), estimatedAmount: 0.25 }),
      makeRow({ at: NOW - WINDOW_MS - 1, usage: makeUsage({ inputTokens: 999, outputTokens: 999 }), estimatedAmount: 9 }),
      makeRow({ subject: 'cust-b', at: NOW - 60_000, usage: makeUsage({ inputTokens: 500, outputTokens: 500 }), estimatedAmount: 5 }),
    ]
    const deps = makeDeps({ rows, entitlement: () => Promise.resolve({ hasAccess: true, balance: 42 }) })
    const summary = await loadTenantSummary(makePolicy(), deps)
    expect(summary.availability).toBe('ready')
    if (summary.availability !== 'ready') return
    expect(summary.usageTokens7d).toBe(1350)
    expect(summary.estimatedCny7d).toBe(1.75)
  })

  it('excludes non-CNY rows from the CNY estimate while still counting their tokens', async () => {
    const rows = [
      makeRow({ usage: makeUsage({ inputTokens: 100, outputTokens: 100 }), estimatedAmount: 2, currency: 'CNY' }),
      makeRow({ usage: makeUsage({ inputTokens: 400, outputTokens: 100 }), estimatedAmount: 7, currency: 'USD' }),
    ]
    const deps = makeDeps({ rows, entitlement: () => Promise.resolve({ hasAccess: true, balance: 42 }) })
    const summary = await loadTenantSummary(makePolicy(), deps)
    expect(summary.availability).toBe('ready')
    if (summary.availability !== 'ready') return
    expect(summary.usageTokens7d).toBe(700)
    expect(summary.estimatedCny7d).toBe(2)
  })
})
