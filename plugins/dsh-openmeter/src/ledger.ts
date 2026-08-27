/**
 * Durable SQLite usage ledger: the customer-facing display and estimate
 * source for tenant billing. Not a replacement for OpenMeter's
 * authoritative ledger — reconciliation authority stays with OpenMeter;
 * this database answers "what has this subject used so far" across
 * restarts.
 *
 * Idempotency: (source, event_id) is the primary key, so a redelivered
 * event appends as a duplicate and never overwrites. Subject is immutable
 * after insertion — a conflicting duplicate leaves the original row
 * untouched.
 *
 * @module dsh-openmeter/ledger
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Default row cap for {@link UsageLedger.list} when no limit is given. */
export const LEDGER_LIMIT_DEFAULT = 500

/** Hard ceiling for {@link UsageLedger.list} limits. */
const LEDGER_LIMIT_MAX = 1000

/** One metered usage event as stored and served for display/estimates. */
export interface LedgerRow {
  source: string
  eventId: string
  subject: string
  capturedAt: number
  provider: string
  model: string
  tokens: number
  estimatedAmount: number
  currency: string
  unpriced: boolean
}

/** Result of one append: a fresh row, or an idempotent no-op. */
export type AppendOutcome = 'inserted' | 'duplicate'

/**
 * Typed rejection for a malformed {@link LedgerRow}: the message names the
 * offending field(s) and carries no field values.
 */
export class LedgerRowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerRowError'
  }
}

/**
 * Typed rejection for a malformed {@link LedgerQuery}: the message names the
 * offending field(s) and carries no field values.
 */
export class LedgerQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerQueryError'
  }
}

/** Tenant-scoped read: one subject's rows, newest first. */
export interface LedgerQuery {
  subject: string
  from?: number
  to?: number
  limit?: number
}

/** usage_ledger row in its SQL column naming. */
interface UsageLedgerSqlRow {
  source: string
  event_id: string
  subject: string
  captured_at: number
  provider: string
  model: string
  tokens: number
  estimated_amount: number
  currency: string
  unpriced: number
}

/** Prepared `node:sqlite` statement, cached on the owning instance. */
type SqlStatement = ReturnType<DatabaseSync['prepare']>

/** Static SELECT column list shared by every {@link UsageLedger.list} variant. */
const LEDGER_COLUMNS =
  'source, event_id, subject, captured_at, provider, model, tokens, estimated_amount, currency, unpriced'

/**
 * Build one static list statement for a fixed WHERE clause; parameters and
 * the LIMIT stay bound values, never string interpolation.
 * @param db - the ledger's own connection the statement is prepared on.
 * @param whereClause - static WHERE clause over bound parameters.
 * @returns the prepared newest-first list statement.
 */
function listStatement(db: DatabaseSync, whereClause: string): SqlStatement {
  return db.prepare(
    `SELECT ${LEDGER_COLUMNS}
     FROM usage_ledger
     WHERE ${whereClause}
     ORDER BY captured_at DESC
     LIMIT ?`,
  )
}

/** Ordered migrations applied by {@link UsageLedger.open}. */
const MIGRATIONS: ReadonlyArray<{ name: string, sql: string }> = [
  {
    name: '0001-create-usage-ledger',
    sql: `
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
    `,
  },
]

/**
 * Throw {@link LedgerRowError} naming every field that fails its shape
 * contract; called before any SQL so a rejected row is never written.
 * @param row - the candidate row.
 */
function validateRow(row: LedgerRow): void {
  const fields: string[] = []
  if (!isNonEmptyString(row.source)) fields.push('source')
  if (!isNonEmptyString(row.eventId)) fields.push('eventId')
  if (!isNonEmptyString(row.subject)) fields.push('subject')
  if (!isNonEmptyString(row.provider)) fields.push('provider')
  if (!isNonEmptyString(row.model)) fields.push('model')
  if (!isNonEmptyString(row.currency)) fields.push('currency')
  if (!Number.isSafeInteger(row.tokens) || row.tokens < 0) fields.push('tokens')
  if (!isFiniteNonNegative(row.estimatedAmount)) fields.push('estimatedAmount')
  if (!Number.isSafeInteger(row.capturedAt)) fields.push('capturedAt')
  if (fields.length > 0) throw new LedgerRowError(`invalid ledger row: ${fields.join(', ')}`)
}

/**
 * Throw {@link LedgerQueryError} naming every query field that fails its
 * shape contract; called before any SQL so a rejected query never reaches
 * the database.
 * @param query - the candidate query.
 */
function validateQuery(query: LedgerQuery): void {
  const fields: string[] = []
  if (query.from !== undefined && !Number.isSafeInteger(query.from)) fields.push('from')
  if (query.to !== undefined && !Number.isSafeInteger(query.to)) fields.push('to')
  if (query.limit !== undefined && !Number.isFinite(query.limit)) fields.push('limit')
  if (fields.length > 0) throw new LedgerQueryError(`invalid ledger query: ${fields.join(', ')}`)
}

/**
 * @param value - candidate string field.
 * @returns whether the value is a string with non-whitespace content.
 */
function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * @param value - candidate amount.
 * @returns whether the value is a finite number ≥ 0.
 */
function isFiniteNonNegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * @param error - failure reported by an explicit ROLLBACK.
 * @returns whether SQLite reports no active transaction, meaning the
 *   failed migration statement already rolled the transaction back.
 */
function isNoTransactionActive(error: unknown): boolean {
  return error instanceof Error && /no transaction is active/i.test(error.message)
}

/**
 * Clamp a query limit into 1..LEDGER_LIMIT_MAX.
 * @param limit - caller-requested limit, if any.
 * @returns the effective LIMIT value.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return LEDGER_LIMIT_DEFAULT
  return Math.min(LEDGER_LIMIT_MAX, Math.max(1, Math.trunc(limit)))
}

/**
 * Map one SQL row to its public field naming.
 * @param row - usage_ledger row in SQL naming.
 * @returns the public row with unpriced back to boolean.
 */
function toLedgerRow(row: UsageLedgerSqlRow): LedgerRow {
  return {
    source: row.source,
    eventId: row.event_id,
    subject: row.subject,
    capturedAt: row.captured_at,
    provider: row.provider,
    model: row.model,
    tokens: row.tokens,
    estimatedAmount: row.estimated_amount,
    currency: row.currency,
    unpriced: row.unpriced !== 0,
  }
}

/**
 * The durable usage ledger. Single-writer synchronous API; one instance
 * owns the database connection until {@link UsageLedger.close}.
 */
export class UsageLedger {
  private readonly db: DatabaseSync
  private readonly insertRow: SqlStatement
  private readonly countRows: SqlStatement
  private readonly listSubject: SqlStatement
  private readonly listSubjectFrom: SqlStatement
  private readonly listSubjectTo: SqlStatement
  private readonly listSubjectFromTo: SqlStatement
  private closed = false

  private constructor(db: DatabaseSync) {
    this.db = db
    this.insertRow = db.prepare(
      `INSERT INTO usage_ledger
         (source, event_id, subject, captured_at, provider, model, tokens, estimated_amount, currency, unpriced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, event_id) DO NOTHING`,
    )
    this.countRows = db.prepare('SELECT COUNT(*) AS total FROM usage_ledger')
    this.listSubject = listStatement(db, 'subject = ?')
    this.listSubjectFrom = listStatement(db, 'subject = ? AND captured_at >= ?')
    this.listSubjectTo = listStatement(db, 'subject = ? AND captured_at <= ?')
    this.listSubjectFromTo = listStatement(db, 'subject = ? AND captured_at >= ? AND captured_at <= ?')
  }

  /**
   * Open (or create) the ledger in a directory.
   * @param dir - directory for usage-ledger.sqlite, created when missing.
   * @returns the opened ledger with all migrations applied.
   */
  static open(dir: string): UsageLedger {
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'usage-ledger.sqlite'))
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS ledger_migrations (
          name TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        ) STRICT;
      `)
      const applied = db.prepare('SELECT name FROM ledger_migrations WHERE name = ?')
      const record = db.prepare(
        'INSERT INTO ledger_migrations (name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
      )
      for (const migration of MIGRATIONS) {
        if (applied.get(migration.name) !== undefined) continue
        db.exec('BEGIN')
        try {
          db.exec(migration.sql)
          record.run(migration.name, Date.now())
          db.exec('COMMIT')
        } catch (error) {
          try {
            db.exec('ROLLBACK')
          } catch (rollbackError) {
            // A failed migration statement may have already rolled the
            // transaction back, leaving nothing for an explicit ROLLBACK;
            // only that SQLite marker is ignored so the migration error
            // stays the surfaced one. Any other rollback failure is a
            // separate fault and must not be swallowed.
            if (!isNoTransactionActive(rollbackError)) throw rollbackError
          }
          throw error
        }
      }
    } catch (error) {
      db.close()
      throw error
    }
    return new UsageLedger(db)
  }

  /**
   * Append one usage event idempotently; a duplicate never overwrites the
   * stored row (subject immutable after insertion).
   * @param row - the event to record; validated before any SQL runs.
   * @returns 'inserted' for a fresh row, 'duplicate' when (source, eventId) exists.
   * @throws LedgerRowError when a field fails its shape contract.
   */
  append(row: LedgerRow): AppendOutcome {
    validateRow(row)
    const result = this.insertRow.run(
      row.source,
      row.eventId,
      row.subject,
      row.capturedAt,
      row.provider,
      row.model,
      row.tokens,
      row.estimatedAmount,
      row.currency,
      row.unpriced ? 1 : 0,
    )
    return result.changes > 0 ? 'inserted' : 'duplicate'
  }

  /**
   * List one subject's rows, newest first.
   * @param query - subject (exact match) with optional inclusive from/to
   *   epoch-ms bounds and a limit clamped into 1..1000 (default 500).
   * @returns the matching rows in public field naming.
   * @throws LedgerQueryError when from/to/limit fail their shape contract.
   */
  list(query: LedgerQuery): LedgerRow[] {
    validateQuery(query)
    const params: Array<string | number> = [query.subject]
    let statement = this.listSubject
    if (query.from !== undefined && query.to !== undefined) {
      statement = this.listSubjectFromTo
      params.push(query.from, query.to)
    } else if (query.from !== undefined) {
      statement = this.listSubjectFrom
      params.push(query.from)
    } else if (query.to !== undefined) {
      statement = this.listSubjectTo
      params.push(query.to)
    }
    const rows = statement.all(...params, clampLimit(query.limit)) as unknown as UsageLedgerSqlRow[]
    return rows.map(toLedgerRow)
  }

  /**
   * Row count across all subjects.
   * @returns total stored rows.
   */
  stats(): { total: number } {
    const row = this.countRows.get() as { total: number }
    return { total: row.total }
  }

  /** Close the database connection; safe to call again. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
