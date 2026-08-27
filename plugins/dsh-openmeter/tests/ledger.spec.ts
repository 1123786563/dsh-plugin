import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LEDGER_LIMIT_DEFAULT,
  LedgerClosedError,
  LedgerQueryError,
  LedgerRowError,
  UsageLedger,
} from '../src/ledger.ts'
import type { LedgerQuery, LedgerRow } from '../src/ledger.ts'

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

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    source: 'dsh-openmeter',
    eventId: 'evt-1',
    subject: 'tenant-a',
    capturedAt: 1_700_000_000_000,
    provider: 'deepseek',
    model: 'glm-5.3',
    tokens: 150,
    estimatedAmount: 0.0021,
    currency: 'CNY',
    unpriced: false,
    ...overrides,
  }
}

async function openLedger(): Promise<UsageLedger> {
  dir = await mkdtemp(join(tmpdir(), 'omledger-'))
  return UsageLedger.open(dir)
}

describe('UsageLedger', () => {
  it('reports "inserted" and lists the row with every field mapped', async () => {
    const ledger = await openLedger()
    try {
      expect(ledger.append(row())).toBe('inserted')
      expect(ledger.list({ subject: 'tenant-a' })).toEqual([row()])
      expect(ledger.stats().total).toBe(1)
    } finally {
      ledger.close()
    }
  })

  it('reports "duplicate" for the same (source, eventId) and keeps exactly one row', async () => {
    const ledger = await openLedger()
    try {
      expect(ledger.append(row())).toBe('inserted')
      expect(ledger.append(row())).toBe('duplicate')
      expect(ledger.list({ subject: 'tenant-a' })).toEqual([row()])
      expect(ledger.stats().total).toBe(1)
    } finally {
      ledger.close()
    }
  })

  it('never overwrites the original when a duplicate carries a different payload', async () => {
    const ledger = await openLedger()
    try {
      expect(ledger.append(row())).toBe('inserted')
      expect(
        ledger.append(row({ subject: 'tenant-b', tokens: 999, estimatedAmount: 9, unpriced: true })),
      ).toBe('duplicate')
      expect(ledger.list({ subject: 'tenant-a' })).toEqual([row()])
      expect(ledger.list({ subject: 'tenant-b' })).toEqual([])
      expect(ledger.stats().total).toBe(1)
    } finally {
      ledger.close()
    }
  })

  it('rejects invalid rows with LedgerRowError before anything is written', async () => {
    const ledger = await openLedger()
    try {
      const invalid: Array<{ field: string, row: LedgerRow }> = [
        { field: 'subject', row: row({ subject: '   ' }) },
        { field: 'eventId', row: row({ eventId: '' }) },
        { field: 'tokens', row: row({ tokens: -1 }) },
        { field: 'estimatedAmount', row: row({ estimatedAmount: Number.NaN }) },
        { field: 'capturedAt', row: row({ capturedAt: 1_700_000_000_000.5 }) },
        { field: 'capturedAt', row: row({ capturedAt: Number.MAX_SAFE_INTEGER + 1 }) },
      ]
      for (const candidate of invalid) {
        try {
          ledger.append(candidate.row)
          expect.unreachable(`expected LedgerRowError naming ${candidate.field}`)
        } catch (error) {
          expect(error).toBeInstanceOf(LedgerRowError)
          expect((error as LedgerRowError).message).toContain(candidate.field)
        }
      }
      expect(ledger.stats().total).toBe(0)
    } finally {
      ledger.close()
    }
  })

  it('round-trips unpriced: true as true', async () => {
    const ledger = await openLedger()
    try {
      expect(ledger.append(row({ unpriced: true }))).toBe('inserted')
      const rows = ledger.list({ subject: 'tenant-a' })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.unpriced).toBe(true)
    } finally {
      ledger.close()
    }
  })

  it('rejects malformed list queries with LedgerQueryError before SQL runs', async () => {
    const ledger = await openLedger()
    try {
      ledger.append(row())
      const invalid: Array<{ field: string, query: LedgerQuery }> = [
        { field: 'from', query: { subject: 'tenant-a', from: '1000' as unknown as number } },
        { field: 'from', query: { subject: 'tenant-a', from: 'abc' as unknown as number } },
        { field: 'from', query: { subject: 'tenant-a', from: Number.NaN } },
        { field: 'to', query: { subject: 'tenant-a', to: Number.NaN } },
        { field: 'limit', query: { subject: 'tenant-a', limit: Number.NaN } },
      ]
      for (const candidate of invalid) {
        try {
          ledger.list(candidate.query)
          expect.unreachable(`expected LedgerQueryError naming ${candidate.field}`)
        } catch (error) {
          expect(error).toBeInstanceOf(LedgerQueryError)
          expect((error as LedgerQueryError).message).toContain(candidate.field)
        }
      }
      expect(ledger.list({ subject: 'tenant-a' })).toHaveLength(1)
      expect(
        ledger.list({ subject: 'tenant-a', from: 0, to: 2_000_000_000_000, limit: 10 }),
      ).toHaveLength(1)
      expect(ledger.stats().total).toBe(1)
    } finally {
      ledger.close()
    }
  })

  it('filters by subject, applies inclusive from/to, orders DESC, and caps limit', async () => {
    const ledger = await openLedger()
    try {
      ledger.append(row({ eventId: 'a1', capturedAt: 100 }))
      ledger.append(row({ eventId: 'a2', capturedAt: 200 }))
      ledger.append(row({ eventId: 'a3', capturedAt: 300 }))
      ledger.append(row({ eventId: 'b1', subject: 'tenant-b', capturedAt: 250 }))
      const rows = ledger.list({ subject: 'tenant-a' })
      expect(rows.map(r => r.eventId)).toEqual(['a3', 'a2', 'a1'])
      expect(rows.every(r => r.subject === 'tenant-a')).toBe(true)
      expect(ledger.list({ subject: 'tenant-a', from: 200, to: 300 }).map(r => r.eventId)).toEqual(['a3', 'a2'])
      expect(ledger.list({ subject: 'tenant-a', from: 100, to: 100 }).map(r => r.eventId)).toEqual(['a1'])
      expect(ledger.list({ subject: 'tenant-a', to: 200 }).map(r => r.eventId)).toEqual(['a2', 'a1'])
      expect(ledger.list({ subject: 'tenant-a', from: 300 }).map(r => r.eventId)).toEqual(['a3'])
      expect(ledger.list({ subject: 'tenant-a', from: 301 }).map(r => r.eventId)).toEqual([])
      expect(ledger.list({ subject: 'tenant-a', limit: 2 }).map(r => r.eventId)).toEqual(['a3', 'a2'])
      expect(ledger.list({ subject: 'tenant-a', limit: 0 })).toHaveLength(1)
    } finally {
      ledger.close()
    }
  })

  it('pins the default limit at 500 and clamps oversized limits at 1000', async () => {
    expect(LEDGER_LIMIT_DEFAULT).toBe(500)
    const ledger = await openLedger()
    try {
      for (let i = 0; i <= 1000; i++) {
        ledger.append(row({ eventId: `e${i}`, capturedAt: i }))
      }
      expect(ledger.stats().total).toBe(1001)
      expect(ledger.list({ subject: 'tenant-a' })).toHaveLength(500)
      const clamped = ledger.list({ subject: 'tenant-a', limit: 5000 })
      expect(clamped).toHaveLength(1000)
      expect(clamped[0]!.eventId).toBe('e1000')
      expect(clamped[999]!.eventId).toBe('e1')
    } finally {
      ledger.close()
    }
  })

  it('persists rows across close and reopen', async () => {
    const target = await mkdtemp(join(tmpdir(), 'omledger-'))
    dir = target
    const ledger = UsageLedger.open(target)
    expect(ledger.append(row())).toBe('inserted')
    ledger.close()
    ledger.close()
    const file = join(target, 'usage-ledger.sqlite')
    expect((await stat(file)).isFile()).toBe(true)
    const reopened = UsageLedger.open(target)
    try {
      expect(reopened.list({ subject: 'tenant-a' })).toEqual([row()])
      expect(reopened.stats().total).toBe(1)
    } finally {
      reopened.close()
    }
  })

  it('keeps exactly one row across 20 conflicting appends', async () => {
    const ledger = await openLedger()
    try {
      for (let i = 0; i < 20; i++) {
        ledger.append(row({ tokens: 100 + i, subject: i % 2 === 0 ? 'tenant-a' : 'tenant-b' }))
      }
      expect(ledger.stats().total).toBe(1)
      expect(ledger.list({ subject: 'tenant-a' })).toEqual([row({ tokens: 100 })])
      expect(ledger.list({ subject: 'tenant-b' })).toEqual([])
    } finally {
      ledger.close()
    }
  })

  it('applies each migration exactly once across sequential opens', async () => {
    const target = await mkdtemp(join(tmpdir(), 'omledger-'))
    dir = target
    UsageLedger.open(target).close()
    const second = UsageLedger.open(target)
    try {
      expect(second.stats().total).toBe(0)
    } finally {
      second.close()
    }
    const probe = new DatabaseSync(join(target, 'usage-ledger.sqlite'))
    try {
      const applied = probe.prepare('SELECT COUNT(*) AS n FROM ledger_migrations').get() as { n: number }
      expect(applied.n).toBe(1)
    } finally {
      probe.close()
    }
  })

  it('opens lazily: open() touches no filesystem, and a failed first use self-heals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omledger-'))
    dir = root
    const target = join(root, 'ledger')
    await chmod(root, 0o500)
    const ledger = UsageLedger.open(target)
    try {
      // open() only records the directory: neither the directory nor the
      // database file exists yet (MeteringWal/OperatorStore precedent).
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
      let failure: unknown
      try {
        ledger.append(row())
      } catch (error) {
        failure = error
      }
      // An io/sqlite failure, never a row-validation rejection.
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(LedgerRowError)
      await chmod(root, 0o700)
      // No latch: the failed open reset its state, so the next append
      // retries from clean and succeeds once the directory recovers.
      expect(ledger.append(row())).toBe('inserted')
      expect(ledger.list({ subject: 'tenant-a' })).toEqual([row()])
      expect(ledger.stats().total).toBe(1)
    } finally {
      await chmod(root, 0o700).catch(() => {})
    }
  })

  it('close() is a safe no-op on a ledger that never opened its database', async () => {
    const ledger = await openLedger()
    expect(() => ledger.close()).not.toThrow()
    expect(() => ledger.close()).not.toThrow()
  })

  it('append after close-before-open throws LedgerClosedError, never re-opening the database', async () => {
    const ledger = await openLedger()
    ledger.close()
    let failure: unknown
    try {
      ledger.append(row())
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(LedgerClosedError)
    expect((failure as Error).name).toBe('LedgerClosedError')
  })

  it('append after open-then-close throws the same LedgerClosedError, not a finalized statement', async () => {
    const ledger = await openLedger()
    expect(ledger.append(row())).toBe('inserted')
    ledger.close()
    let failure: unknown
    try {
      ledger.append(row({ eventId: 'evt-2' }))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(LedgerClosedError)
    expect((failure as Error).name).toBe('LedgerClosedError')
  })
})
