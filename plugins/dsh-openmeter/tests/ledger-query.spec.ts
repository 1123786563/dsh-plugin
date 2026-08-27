import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LEDGER_LIMIT_DEFAULT, LedgerClosedError, LedgerQueryError, UsageLedger } from '../src/ledger.ts'
import type { LedgerRow, UsagePage, UsageQuery } from '../src/ledger.ts'

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
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    reasoningTokens: 2,
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

/** Event ids of one usage page, in returned order. */
function ids(page: UsagePage): string[] {
  return page.rows.map(r => r.eventId)
}

describe('UsageLedger.usagePage', () => {
  it('applies inclusive from/to bounds, and from-only/to-only variants', async () => {
    const ledger = await openLedger()
    try {
      ledger.append(row({ eventId: 'a1', capturedAt: 100 }))
      ledger.append(row({ eventId: 'a2', capturedAt: 200 }))
      ledger.append(row({ eventId: 'a3', capturedAt: 300 }))
      ledger.append(row({ eventId: 'b1', subject: 'tenant-b', capturedAt: 150 }))
      expect(ids(ledger.usagePage({ subject: 'tenant-a', from: 200, to: 300 }))).toEqual(['a3', 'a2'])
      expect(ids(ledger.usagePage({ subject: 'tenant-a', from: 100, to: 100 }))).toEqual(['a1'])
      expect(ids(ledger.usagePage({ subject: 'tenant-a', to: 200 }))).toEqual(['a2', 'a1'])
      expect(ids(ledger.usagePage({ subject: 'tenant-a', from: 300 }))).toEqual(['a3'])
      expect(ids(ledger.usagePage({ subject: 'tenant-a', from: 301 }))).toEqual([])
      const none = ledger.usagePage({ subject: 'tenant-a', from: 301 })
      expect(none.totals.calls).toBe(0)
      expect(none.totals.tokens).toBe(0)
      expect(none.cursor).toBeUndefined()
    } finally {
      ledger.close()
    }
  })

  it('filters by exact model match only, never by substring', async () => {
    const ledger = await openLedger()
    try {
      ledger.append(row({ eventId: 'a1', capturedAt: 100, model: 'glm-5.3' }))
      ledger.append(row({ eventId: 'a2', capturedAt: 200, model: 'glm-5.3-mini' }))
      ledger.append(row({ eventId: 'a3', capturedAt: 300, model: 'glm-5.3' }))
      const exact = ledger.usagePage({ subject: 'tenant-a', model: 'glm-5.3' })
      expect(ids(exact)).toEqual(['a3', 'a1'])
      expect(exact.totals.calls).toBe(2)
      expect(ids(ledger.usagePage({ subject: 'tenant-a', model: 'glm-5.3-mini' }))).toEqual(['a2'])
      expect(ids(ledger.usagePage({ subject: 'tenant-a', model: 'glm-5.3 ' }))).toEqual([])
    } finally {
      ledger.close()
    }
  })

  it('walks pages by cursor newest-first with event_id DESC tiebreak, every row exactly once', async () => {
    const ledger = await openLedger()
    try {
      // Eight rows, two sharing capturedAt 400 with distinct event ids.
      const events: Array<[number, string]> = [
        [700, 'e7'],
        [600, 'e6'],
        [500, 'e5'],
        [400, 'e4b'],
        [400, 'e4a'],
        [300, 'e3'],
        [200, 'e2'],
        [100, 'e1'],
      ]
      for (const [capturedAt, eventId] of events) {
        ledger.append(row({ eventId, capturedAt }))
      }
      const expected = ['e7', 'e6', 'e5', 'e4b', 'e4a', 'e3', 'e2', 'e1']
      const page1 = ledger.usagePage({ subject: 'tenant-a', limit: 3 })
      expect(ids(page1)).toEqual(['e7', 'e6', 'e5'])
      expect(page1.cursor).toBeDefined()
      // Cursor and limit never shrink totals: they page, they do not filter.
      expect(page1.totals.calls).toBe(8)
      const page2 = ledger.usagePage({ subject: 'tenant-a', limit: 3, cursor: page1.cursor })
      expect(ids(page2)).toEqual(['e4b', 'e4a', 'e3'])
      expect(page2.cursor).toBeDefined()
      expect(page2.cursor).not.toBe(page1.cursor)
      const page3 = ledger.usagePage({ subject: 'tenant-a', limit: 3, cursor: page2.cursor })
      expect(ids(page3)).toEqual(['e2', 'e1'])
      // A partial final page signals "no more rows may exist": no cursor.
      expect(page3.cursor).toBeUndefined()
      expect([...ids(page1), ...ids(page2), ...ids(page3)]).toEqual(expected)
    } finally {
      ledger.close()
    }
  })

  it('clamps limit into 1..1000 and defaults to LEDGER_LIMIT_DEFAULT', async () => {
    expect(LEDGER_LIMIT_DEFAULT).toBe(500)
    const ledger = await openLedger()
    try {
      for (let i = 0; i <= 1000; i++) {
        ledger.append(row({ eventId: `e${i}`, capturedAt: i }))
      }
      expect(ledger.usagePage({ subject: 'tenant-a', limit: 0 }).rows).toHaveLength(1)
      expect(ledger.usagePage({ subject: 'tenant-a', limit: -5 }).rows).toHaveLength(1)
      expect(ledger.usagePage({ subject: 'tenant-a', limit: 1.5 }).rows).toHaveLength(1)
      expect(ledger.usagePage({ subject: 'tenant-a' }).rows).toHaveLength(500)
      const clamped = ledger.usagePage({ subject: 'tenant-a', limit: 5000 })
      expect(clamped.rows).toHaveLength(1000)
      expect(clamped.rows[0]!.eventId).toBe('e1000')
      expect(clamped.rows[999]!.eventId).toBe('e1')
      expect(clamped.cursor).toBeDefined()
      try {
        ledger.usagePage({ subject: 'tenant-a', limit: Number.NaN })
        expect.unreachable('expected LedgerQueryError naming limit')
      } catch (error) {
        expect(error).toBeInstanceOf(LedgerQueryError)
        expect((error as LedgerQueryError).message).toContain('limit')
      }
    } finally {
      ledger.close()
    }
  })

  it('isolates tenants: each subject sees only its own rows and totals', async () => {
    const ledger = await openLedger()
    try {
      ledger.append(row({ eventId: 'a1', capturedAt: 100, tokens: 10 }))
      ledger.append(row({ eventId: 'b1', subject: 'tenant-b', capturedAt: 200, tokens: 200 }))
      ledger.append(row({ eventId: 'a2', capturedAt: 300, tokens: 30 }))
      ledger.append(row({ eventId: 'b2', subject: 'tenant-b', capturedAt: 400, tokens: 400 }))
      ledger.append(row({ eventId: 'a3', capturedAt: 500, tokens: 50 }))
      const pageA = ledger.usagePage({ subject: 'tenant-a' })
      expect(ids(pageA)).toEqual(['a3', 'a2', 'a1'])
      expect(pageA.rows.every(r => r.subject === 'tenant-a')).toBe(true)
      expect(pageA.totals.calls).toBe(3)
      expect(pageA.totals.tokens).toBe(90)
      const pageB = ledger.usagePage({ subject: 'tenant-b' })
      expect(ids(pageB)).toEqual(['b2', 'b1'])
      expect(pageB.totals.calls).toBe(2)
      expect(pageB.totals.tokens).toBe(600)
    } finally {
      ledger.close()
    }
  })

  it('keeps page stats on the returned page, totals on the whole filtered set, CNY-only money', async () => {
    const ledger = await openLedger()
    try {
      ledger.append(
        row({
          eventId: 'e1',
          capturedAt: 100,
          tokens: 10,
          inputTokens: 7,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          estimatedAmount: 0.1,
        }),
      )
      ledger.append(
        row({
          eventId: 'e2',
          capturedAt: 200,
          tokens: 20,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          estimatedAmount: 9.9,
          currency: 'USD',
        }),
      )
      ledger.append(
        row({
          eventId: 'e3',
          capturedAt: 300,
          tokens: 30,
          inputTokens: 5,
          outputTokens: 5,
          cacheReadTokens: 5,
          cacheWriteTokens: 5,
          reasoningTokens: 5,
          estimatedAmount: 0.2,
        }),
      )
      ledger.append(
        row({
          eventId: 'e4',
          capturedAt: 400,
          tokens: 40,
          inputTokens: 0,
          outputTokens: 40,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          estimatedAmount: 0,
          unpriced: true,
        }),
      )
      ledger.append(
        row({
          eventId: 'e5',
          capturedAt: 500,
          tokens: 50,
          inputTokens: 10,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 40,
          estimatedAmount: 0.3,
        }),
      )
      const page1 = ledger.usagePage({ subject: 'tenant-a', limit: 2 })
      expect(ids(page1)).toEqual(['e5', 'e4'])
      // page: only the two returned rows; unpriced e4 counts, never prices.
      expect(page1.page).toEqual({
        calls: 2,
        tokens: 90,
        inputTokens: 10,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 40,
        estimatedAmountCny: 0.3,
        unpricedCalls: 1,
      })
      // totals: all five filtered rows; USD e2 and unpriced e4 never price.
      expect(page1.totals.calls).toBe(5)
      expect(page1.totals.tokens).toBe(150)
      expect(page1.totals.inputTokens).toBe(22)
      expect(page1.totals.outputTokens).toBe(48)
      expect(page1.totals.cacheReadTokens).toBe(5)
      expect(page1.totals.cacheWriteTokens).toBe(5)
      expect(page1.totals.reasoningTokens).toBe(45)
      expect(page1.totals.estimatedAmountCny).toBeCloseTo(0.6, 10)
      expect(page1.totals.unpricedCalls).toBe(1)
      expect(page1.cursor).toBeDefined()
      const page2 = ledger.usagePage({ subject: 'tenant-a', limit: 2, cursor: page1.cursor })
      expect(ids(page2)).toEqual(['e3', 'e2'])
      // e2 is priced but not CNY: excluded from money on the page path too.
      expect(page2.page.estimatedAmountCny).toBeCloseTo(0.2, 10)
      expect(page2.page.unpricedCalls).toBe(0)
      const page3 = ledger.usagePage({ subject: 'tenant-a', limit: 2, cursor: page2.cursor })
      expect(ids(page3)).toEqual(['e1'])
      expect(page3.cursor).toBeUndefined()
    } finally {
      ledger.close()
    }
  })

  it('migrates a legacy 0001 database on open and reads legacy rows with zero dimensions', async () => {
    const target = await mkdtemp(join(tmpdir(), 'omledger-'))
    dir = target
    // Build a pre-0002 database by hand: 0001's schema literal, a legacy
    // row written with the old column set, and no ledger_migrations table.
    const legacy = new DatabaseSync(join(target, 'usage-ledger.sqlite'))
    try {
      legacy.exec(`
        CREATE TABLE IF NOT EXISTS usage_ledger (
          source TEXT NOT NULL,
          event_id TEXT NOT NULL,
          subject TEXT NOT NULL,
          captured_at INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          tokens INTEGER NOT NULL,
          estimated_amount REAL NOT NULL,
          currency TEXT NOT NULL,
          unpriced INTEGER NOT NULL,
          PRIMARY KEY (source, event_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS usage_ledger_subject_time ON usage_ledger(subject, captured_at DESC);
      `)
      legacy
        .prepare(
          `INSERT INTO usage_ledger
             (source, event_id, subject, captured_at, provider, model, tokens, estimated_amount, currency, unpriced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('dsh-openmeter', 'legacy-1', 'tenant-a', 1_700_000_000_000, 'deepseek', 'glm-5.3', 500, 0.007, 'CNY', 0)
    } finally {
      legacy.close()
    }
    const ledger = UsageLedger.open(target)
    try {
      const page = ledger.usagePage({ subject: 'tenant-a' })
      expect(ids(page)).toEqual(['legacy-1'])
      expect(page.rows[0]!.tokens).toBe(500)
      expect(page.rows[0]!.inputTokens).toBe(0)
      expect(page.rows[0]!.outputTokens).toBe(0)
      expect(page.rows[0]!.cacheReadTokens).toBe(0)
      expect(page.rows[0]!.cacheWriteTokens).toBe(0)
      expect(page.rows[0]!.reasoningTokens).toBe(0)
      expect(page.totals.calls).toBe(1)
      expect(page.totals.tokens).toBe(500)
      expect(page.totals.inputTokens).toBe(0)
      expect(page.totals.reasoningTokens).toBe(0)
      // A fresh append carries real dimensions alongside the legacy row.
      expect(ledger.append(row({ eventId: 'new-1', capturedAt: 1_700_000_000_001 }))).toBe('inserted')
      const after = ledger.usagePage({ subject: 'tenant-a' })
      expect(after.totals.calls).toBe(2)
      expect(after.totals.tokens).toBe(650)
      expect(after.totals.inputTokens).toBe(100)
      expect(after.totals.outputTokens).toBe(40)
    } finally {
      ledger.close()
    }
    const probe = new DatabaseSync(join(target, 'usage-ledger.sqlite'))
    try {
      const applied = probe.prepare('SELECT name FROM ledger_migrations ORDER BY name').all() as Array<{ name: string }>
      expect(applied.map(m => m.name)).toEqual(['0001-create-usage-ledger', '0002-add-token-dimensions'])
    } finally {
      probe.close()
    }
  })

  it('rejects malformed cursors with LedgerQueryError naming cursor', async () => {
    const ledger = await openLedger()
    try {
      ledger.append(row())
      const malformed = [
        '',
        'not-base64!',
        Buffer.from('not json', 'utf8').toString('base64url'),
        Buffer.from('[1]', 'utf8').toString('base64url'),
        Buffer.from('["a","b","c"]', 'utf8').toString('base64url'),
        Buffer.from('["a","b"]', 'utf8').toString('base64url'),
        Buffer.from('[-1,"evt"]', 'utf8').toString('base64url'),
        Buffer.from('[9007199254740993,"evt"]', 'utf8').toString('base64url'),
      ]
      for (const cursor of malformed) {
        try {
          ledger.usagePage({ subject: 'tenant-a', cursor })
          expect.unreachable(`expected LedgerQueryError for cursor ${JSON.stringify(cursor)}`)
        } catch (error) {
          expect(error).toBeInstanceOf(LedgerQueryError)
          expect((error as LedgerQueryError).message).toContain('cursor')
        }
      }
      // The stored row is untouched by the rejected queries.
      expect(ledger.usagePage({ subject: 'tenant-a' }).totals.calls).toBe(1)
    } finally {
      ledger.close()
    }
  })

  it('rejects invalid usage queries with LedgerQueryError naming every offending field', async () => {
    const ledger = await openLedger()
    try {
      ledger.append(row())
      const invalid: Array<{ field: string, query: UsageQuery }> = [
        { field: 'from', query: { subject: 'tenant-a', from: '1000' as unknown as number } },
        { field: 'from', query: { subject: 'tenant-a', from: Number.NaN } },
        { field: 'to', query: { subject: 'tenant-a', to: Number.NaN } },
        { field: 'limit', query: { subject: 'tenant-a', limit: Number.NaN } },
        { field: 'model', query: { subject: 'tenant-a', model: '   ' } },
        { field: 'subject', query: { subject: '' } },
        { field: 'subject', query: { subject: '   ' } },
      ]
      for (const candidate of invalid) {
        try {
          ledger.usagePage(candidate.query)
          expect.unreachable(`expected LedgerQueryError naming ${candidate.field}`)
        } catch (error) {
          expect(error).toBeInstanceOf(LedgerQueryError)
          expect((error as LedgerQueryError).message).toContain(candidate.field)
        }
      }
      // Several bad fields are named together in one rejection.
      try {
        ledger.usagePage({ subject: '', model: '   ' })
        expect.unreachable('expected LedgerQueryError naming subject and model')
      } catch (error) {
        expect(error).toBeInstanceOf(LedgerQueryError)
        expect((error as LedgerQueryError).message).toContain('subject')
        expect((error as LedgerQueryError).message).toContain('model')
      }
      // The subject contract list() always implied is now explicit there too.
      try {
        ledger.list({ subject: '' })
        expect.unreachable('expected LedgerQueryError naming subject')
      } catch (error) {
        expect(error).toBeInstanceOf(LedgerQueryError)
        expect((error as LedgerQueryError).message).toContain('subject')
      }
      expect(ledger.usagePage({ subject: 'tenant-a' }).totals.calls).toBe(1)
    } finally {
      ledger.close()
    }
  })

  it('honors the closed latch: usagePage throws LedgerClosedError, after validation', async () => {
    const ledger = await openLedger()
    ledger.append(row())
    ledger.close()
    let failure: unknown
    try {
      ledger.usagePage({ subject: 'tenant-a' })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(LedgerClosedError)
    expect((failure as Error).name).toBe('LedgerClosedError')
    // Validation runs before the latch check, so a malformed query on a
    // closed ledger reports the query, not the closure.
    let queryFailure: unknown
    try {
      ledger.usagePage({ subject: 'tenant-a', from: Number.NaN })
    } catch (error) {
      queryFailure = error
    }
    expect(queryFailure).toBeInstanceOf(LedgerQueryError)
  })
})
