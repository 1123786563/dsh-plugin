import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  BudgetAmountError,
  BudgetClosedError,
  BudgetStore,
  loadBudgetForecast,
} from '../src/budget.ts'
import type {
  BudgetForecast,
  BudgetForecastInsufficientHistory,
  BudgetForecastReady,
  BudgetForecastUnconfigured,
  BudgetSpendSnapshot,
} from '../src/budget.ts'
import { UsageLedger } from '../src/ledger.ts'
import type { LedgerRow } from '../src/ledger.ts'

/** ms per day; matches the forecast's documented day arithmetic. */
const DAY_MS = 86_400_000
/** 2026-08-15T12:00:00.000Z: mid-month noon, so daysElapsed is 15 of 31. */
const NOW_AUG_15 = Date.UTC(2026, 7, 15, 12)
/** 2026-08-10T00:00:00.000Z: exact day boundary, so daysElapsed is 10 of 31. */
const NOW_AUG_10 = Date.UTC(2026, 7, 10)
/** UTC start of the month containing the pinned clocks (2026-08-01T00:00:00.000Z). */
const AUG_START = Date.UTC(2026, 7, 1)
/** Inclusive UTC month end: 2026-09-01T00:00:00.000Z minus 1 ms. */
const AUG_END = Date.UTC(2026, 8, 1) - 1

let dir: string | undefined

afterEach(async () => {
  if (dir === undefined) return
  // Tests that revoke directory write access restore it here so the
  // recursive cleanup below can always run.
  await chmod(dir, 0o700).catch(() => {})
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (error) {
    // Known macOS ENOTEMPTY tmpdir flake (repo-wide); one forced retry clears it.
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
    await rm(dir, { recursive: true, force: true })
  }
  dir = undefined
})

async function openBudget(): Promise<BudgetStore> {
  dir = await mkdtemp(join(tmpdir(), 'ombudget-'))
  return BudgetStore.open(dir)
}

/** monthSpend double: records every (subject, from, to) call, returns `snapshot`. */
function fakeMonthSpend(snapshot: BudgetSpendSnapshot) {
  const calls: Array<{ subject: string, from: number, to: number }> = []
  const monthSpend = (subject: string, from: number, to: number): BudgetSpendSnapshot => {
    calls.push({ subject, from, to })
    return snapshot
  }
  return { monthSpend, calls }
}

/** Discriminator-narrowing accessors: throw (fail the test) on a mismatch. */
function asUnconfigured(result: BudgetForecast): BudgetForecastUnconfigured {
  if (result.availability !== 'unconfigured') {
    throw new Error(`expected unconfigured, got ${result.availability}`)
  }
  return result
}

function asInsufficientHistory(result: BudgetForecast): BudgetForecastInsufficientHistory {
  if (result.availability !== 'insufficient-history') {
    throw new Error(`expected insufficient-history, got ${result.availability}`)
  }
  return result
}

function asReady(result: BudgetForecast): BudgetForecastReady {
  if (result.availability !== 'ready') {
    throw new Error(`expected ready, got ${result.availability}`)
  }
  return result
}

describe('BudgetStore', () => {
  it('get returns null for an absent budget', async () => {
    const store = await openBudget()
    try {
      expect(store.get('acme')).toBeNull()
    } finally {
      store.close()
    }
  })

  it('creates, overwrites, and round-trips 分 precision through reopen', async () => {
    const store = await openBudget()
    try {
      store.set('acme', 100.5)
      expect(store.get('acme')).toEqual({ amountCny: 100.5 })
      store.set('acme', 200)
      expect(store.get('acme')).toEqual({ amountCny: 200 })
      store.set('acme', 12.34)
      store.set('rounding', 10.999)
      // 10.999 CNY cannot be stored below 分 precision: 1099.9 分 rounds to 1100.
      expect(store.get('rounding')).toEqual({ amountCny: 11 })
      store.close()
      const reopened = BudgetStore.open(dir!)
      try {
        expect(reopened.get('acme')).toEqual({ amountCny: 12.34 })
      } finally {
        reopened.close()
      }
      // Pin integer minor-unit storage through a raw second connection.
      const probe = new DatabaseSync(join(dir!, 'budget.sqlite'))
      try {
        const row = probe
          .prepare('SELECT amount_minor FROM tenant_budget WHERE tenant_id = ?')
          .get('acme') as { amount_minor: number }
        expect(row.amount_minor).toBe(1234)
      } finally {
        probe.close()
      }
    } finally {
      store.close()
    }
  })

  it('accepts the upper bound 100000000 CNY as the 1e10 minor cap', async () => {
    const store = await openBudget()
    try {
      store.set('acme', 100_000_000)
      expect(store.get('acme')).toEqual({ amountCny: 100_000_000 })
    } finally {
      store.close()
    }
  })

  it('rejects invalid amounts and tenantIds with BudgetAmountError before any write', async () => {
    const store = await openBudget()
    try {
      // Opens the database (tables, migrations) without writing any row.
      expect(store.get('acme')).toBeNull()
      const invalidAmounts = [
        0,
        -5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        100_000_000.01,
        '100' as unknown as number,
        undefined as unknown as number,
      ]
      for (const amountCny of invalidAmounts) {
        try {
          store.set('acme', amountCny)
          expect.unreachable(`expected BudgetAmountError for ${String(amountCny)}`)
        } catch (error) {
          expect(error).toBeInstanceOf(BudgetAmountError)
          expect((error as BudgetAmountError).message).toContain('amountCny')
        }
      }
      for (const tenantId of ['', '   ', '\t\n']) {
        try {
          store.set(tenantId, 100)
          expect.unreachable(`expected BudgetAmountError for tenantId ${JSON.stringify(tenantId)}`)
        } catch (error) {
          expect(error).toBeInstanceOf(BudgetAmountError)
          expect((error as BudgetAmountError).message).toContain('tenantId')
        }
      }
      const probe = new DatabaseSync(join(dir!, 'budget.sqlite'))
      try {
        const row = probe.prepare('SELECT COUNT(*) AS total FROM tenant_budget').get() as { total: number }
        expect(row.total).toBe(0)
      } finally {
        probe.close()
      }
    } finally {
      store.close()
    }
  })

  it('keeps tenants isolated: one row each, no cross-reads', async () => {
    const store = await openBudget()
    try {
      store.set('acme', 100)
      store.set('dsh-ops', 200)
      expect(store.get('acme')).toEqual({ amountCny: 100 })
      expect(store.get('dsh-ops')).toEqual({ amountCny: 200 })
      const probe = new DatabaseSync(join(dir!, 'budget.sqlite'))
      try {
        const row = probe.prepare('SELECT COUNT(*) AS total FROM tenant_budget').get() as { total: number }
        expect(row.total).toBe(2)
      } finally {
        probe.close()
      }
    } finally {
      store.close()
    }
  })

  it('persists across close and reopen, and use-after-close throws BudgetClosedError', async () => {
    const store = await openBudget()
    store.set('acme', 88.8)
    store.close()
    const reopened = BudgetStore.open(dir!)
    try {
      expect(reopened.get('acme')).toEqual({ amountCny: 88.8 })
    } finally {
      reopened.close()
    }
    for (const operation of [
      () => store.get('acme'),
      () => store.set('acme', 50),
    ]) {
      let failure: unknown
      try {
        operation()
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(BudgetClosedError)
      expect((failure as Error).name).toBe('BudgetClosedError')
    }
  })

  it('close-before-open get/set also throws BudgetClosedError, never opening the database', async () => {
    const store = await openBudget()
    store.close()
    expect(() => store.get('acme')).toThrow(BudgetClosedError)
    expect(() => store.set('acme', 100)).toThrow(BudgetClosedError)
  })

  it('applies the migration exactly once across sequential opens', async () => {
    const target = await mkdtemp(join(tmpdir(), 'ombudget-'))
    dir = target
    BudgetStore.open(target).close()
    const second = BudgetStore.open(target)
    try {
      expect(second.get('acme')).toBeNull()
    } finally {
      second.close()
    }
    const probe = new DatabaseSync(join(target, 'budget.sqlite'))
    try {
      const applied = probe.prepare('SELECT COUNT(*) AS n FROM budget_migrations').get() as { n: number }
      expect(applied.n).toBe(1)
    } finally {
      probe.close()
    }
  })
})

describe('loadBudgetForecast', () => {
  it('unconfigured: no budget row, projection present, never budget/overage fields', async () => {
    const store = await openBudget()
    try {
      const spend = fakeMonthSpend({ estimatedAmountCny: 30, calls: 2, unpricedCalls: 0 })
      const result = loadBudgetForecast(
        { tenantId: 'acme', subject: 'subj-acme' },
        { budgetStore: store, monthSpend: spend.monthSpend, now: () => NOW_AUG_15 },
      )
      const unconfigured = asUnconfigured(result)
      expect(unconfigured.monthToDateCny).toBe(30)
      // 30 CNY over 15 elapsed days scaled to 31 days.
      expect(unconfigured.projectedMonthEndCny).toBeCloseTo(62, 10)
      expect('monthlyBudgetCny' in unconfigured).toBe(false)
      expect('projectedOverageCny' in unconfigured).toBe(false)
      expect(spend.calls).toEqual([{ subject: 'subj-acme', from: AUG_START, to: AUG_END }])
    } finally {
      store.close()
    }
  })

  it('queries monthSpend with the exact inclusive UTC month bounds of now', async () => {
    const store = await openBudget()
    try {
      store.set('acme', 100)
      const spend = fakeMonthSpend({ estimatedAmountCny: 10, calls: 1, unpricedCalls: 0 })
      loadBudgetForecast(
        { tenantId: 'acme', subject: 'subj-acme' },
        { budgetStore: store, monthSpend: spend.monthSpend, now: () => NOW_AUG_15 },
      )
      expect(spend.calls).toHaveLength(1)
      // The pinned constants ARE the UTC month bounds the brief's ISO strings name.
      expect(AUG_START).toBe(Date.parse('2026-08-01T00:00:00.000Z'))
      expect(AUG_END).toBe(Date.parse('2026-09-01T00:00:00.000Z') - 1)
      expect(spend.calls[0]).toEqual({ subject: 'subj-acme', from: AUG_START, to: AUG_END })
    } finally {
      store.close()
    }
  })

  it('composes with a real UsageLedger window: only in-month rows count', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ombudget-'))
    const ledger = UsageLedger.open(dir)
    const budget = BudgetStore.open(dir)
    try {
      const row = (overrides: Partial<LedgerRow>): LedgerRow => ({
        source: 'dsh-openmeter',
        eventId: 'evt-1',
        subject: 'subj-acme',
        capturedAt: AUG_START + 5 * DAY_MS,
        provider: 'deepseek',
        model: 'glm-5.3',
        tokens: 150,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        reasoningTokens: 2,
        estimatedAmount: 0,
        currency: 'CNY',
        unpriced: false,
        ...overrides,
      })
      ledger.append(row({ eventId: 'in-1', estimatedAmount: 10.5 }))
      ledger.append(row({ eventId: 'in-2', capturedAt: AUG_START + 6 * DAY_MS, estimatedAmount: 20.25 }))
      // Prior-month row must fall outside the queried window.
      ledger.append(row({ eventId: 'prior', capturedAt: Date.UTC(2026, 6, 15), estimatedAmount: 999 }))
      budget.set('acme', 100)
      const result = loadBudgetForecast(
        { tenantId: 'acme', subject: 'subj-acme' },
        {
          budgetStore: budget,
          monthSpend: (subject, from, to) =>
            ledger.usagePage({ subject, from, to }).totals,
          now: () => NOW_AUG_15,
        },
      )
      const ready = asReady(result)
      expect(ready.monthToDateCny).toBeCloseTo(30.75, 10)
      expect(ready.monthlyBudgetCny).toBe(100)
      expect(ready.projectedMonthEndCny).toBeCloseTo((30.75 / 15) * 31, 10)
    } finally {
      budget.close()
      ledger.close()
    }
  })

  it('insufficient history: calls 0 means no fabricated projection or overage', async () => {
    const store = await openBudget()
    try {
      store.set('acme', 100)
      const spend = fakeMonthSpend({ estimatedAmountCny: 0, calls: 0, unpricedCalls: 0 })
      const result = loadBudgetForecast(
        { tenantId: 'acme', subject: 'subj-acme' },
        { budgetStore: store, monthSpend: spend.monthSpend, now: () => NOW_AUG_15 },
      )
      const insufficient = asInsufficientHistory(result)
      expect(insufficient.monthlyBudgetCny).toBe(100)
      expect(insufficient.monthToDateCny).toBe(0)
      // 计算失败不伪造 0: absent, never 0.
      expect('projectedMonthEndCny' in insufficient).toBe(false)
      expect('projectedOverageCny' in insufficient).toBe(false)
      expect(insufficient.basis.method).toBe('none')
    } finally {
      store.close()
    }
  })

  it('ready: linear-daily-average projection and computed overage', async () => {
    const store = await openBudget()
    try {
      store.set('acme', 100)
      const spend = fakeMonthSpend({ estimatedAmountCny: 50, calls: 3, unpricedCalls: 0 })
      const result = loadBudgetForecast(
        { tenantId: 'acme', subject: 'subj-acme' },
        { budgetStore: store, monthSpend: spend.monthSpend, now: () => NOW_AUG_10 },
      )
      const ready = asReady(result)
      expect(ready.monthlyBudgetCny).toBe(100)
      expect(ready.monthToDateCny).toBe(50)
      // 50 CNY over 10 elapsed days scaled to 31 days = 155; overage 55.
      expect(ready.projectedMonthEndCny).toBeCloseTo(155, 10)
      expect(ready.projectedOverageCny).toBeCloseTo(55, 10)
      expect(ready.basis.method).toBe('linear-daily-average')
      expect(ready.basis.monthStartMs).toBe(AUG_START)
      expect(ready.basis.monthEndMs).toBe(AUG_END)
      expect(ready.basis.daysInMonth).toBe(31)
      expect(ready.basis.daysElapsed).toBe(10)
      expect(ready.basis.dataAsOfMs).toBe(NOW_AUG_10)
      expect(ready.basis.currency).toBe('CNY')
      expect(ready.basis.spendSource).toBe('local-ledger-estimates')
      // A budget above the projection clamps overage at exactly 0.
      store.set('acme', 1000)
      const under = asReady(
        loadBudgetForecast(
          { tenantId: 'acme', subject: 'subj-acme' },
          { budgetStore: store, monthSpend: spend.monthSpend, now: () => NOW_AUG_10 },
        ),
      )
      expect(under.projectedMonthEndCny).toBeCloseTo(155, 10)
      expect(under.projectedOverageCny).toBe(0)
    } finally {
      store.close()
    }
  })

  it('is pure over its deps: two loads deep-equal, monthSpend once per load', async () => {
    const store = await openBudget()
    try {
      store.set('acme', 100)
      const spend = fakeMonthSpend({ estimatedAmountCny: 50, calls: 3, unpricedCalls: 0 })
      const deps = { budgetStore: store, monthSpend: spend.monthSpend, now: () => NOW_AUG_15 }
      const first = loadBudgetForecast({ tenantId: 'acme', subject: 'subj-acme' }, deps)
      const second = loadBudgetForecast({ tenantId: 'acme', subject: 'subj-acme' }, deps)
      expect(first).toEqual(second)
      expect(spend.calls).toHaveLength(2)
      expect(spend.calls[0]).toEqual(spend.calls[1])
    } finally {
      store.close()
    }
  })
})
