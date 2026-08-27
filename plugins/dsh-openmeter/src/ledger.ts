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
 * Opening is lazy: open(dir) records the directory and touches nothing;
 * the directory, connection, PRAGMAs, and migrations materialize on the
 * first append/list/stats, and a failed open resets so the next call
 * retries clean (self-healing once the directory recovers).
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

/**
 * One metered usage event as stored and served for display/estimates.
 * The five token-dimension fields are optional: an absent dimension
 * persists as 0, matching pre-0002 rows and callers without a
 * decomposition (no fabricated split).
 */
export interface LedgerRow {
  source: string
  eventId: string
  subject: string
  capturedAt: number
  provider: string
  model: string
  tokens: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
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

/**
 * Typed rejection for using a closed ledger: close latches, so a later
 * append/list/stats fails here rather than re-opening the database.
 */
export class LedgerClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerClosedError'
  }
}

/** Tenant-scoped read: one subject's rows, newest first. */
export interface LedgerQuery {
  subject: string
  from?: number
  to?: number
  limit?: number
}

/**
 * Tenant-scoped paged usage read: subject (exact match) with inclusive
 * from/to epoch-ms bounds, exact model match, an opaque keyset cursor,
 * and a limit clamped into 1..1000 (default 500).
 */
export interface UsageQuery {
  subject: string
  from?: number
  to?: number
  model?: string
  cursor?: string
  limit?: number
}

/**
 * Aggregate figures over a set of rows: call and token counts (aggregate
 * plus the five dimensions), a CNY-only priced sum, and unpriced calls.
 */
export interface PageStats {
  calls: number
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedAmountCny: number
  unpricedCalls: number
}

/**
 * One paged usage result: `page` aggregates the returned rows, `totals`
 * aggregates the entire filtered set (cursor and limit never apply), and
 * `cursor` is present only when a full page was returned, encoding the
 * last row as the next keyset position.
 */
export interface UsagePage {
  rows: LedgerRow[]
  page: PageStats
  totals: PageStats
  cursor?: string
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

/** usage_ledger row including the 0002 token-dimension columns. */
interface UsageLedgerDimSqlRow extends UsageLedgerSqlRow {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
}

/** Aggregated totals row from the usagePage totals statement. */
interface UsageTotalsSqlRow {
  calls: number
  tokens: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  estimated_amount_cny: number
  unpriced_calls: number
}

/** Prepared `node:sqlite` statement, cached on the owning instance. */
type SqlStatement = ReturnType<DatabaseSync['prepare']>

/** Static SELECT column list shared by every {@link UsageLedger.list} variant. */
const LEDGER_COLUMNS =
  'source, event_id, subject, captured_at, provider, model, tokens, estimated_amount, currency, unpriced'

/** Column list for {@link UsageLedger.usagePage} rows, adding the 0002
 * token-dimension columns to {@link LEDGER_COLUMNS}. */
const LEDGER_PAGE_COLUMNS = `${LEDGER_COLUMNS}, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens`

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

/** Ordered migrations applied when the ledger first opens its database. */
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
  {
    // Pre-0002 rows keep their aggregate tokens and read back with every
    // dimension at 0: no fabricated decomposition.
    name: '0002-add-token-dimensions',
    sql: `
      ALTER TABLE usage_ledger ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_ledger ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_ledger ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_ledger ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_ledger ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
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
  if (!isOptionalSafeNonNegative(row.inputTokens)) fields.push('inputTokens')
  if (!isOptionalSafeNonNegative(row.outputTokens)) fields.push('outputTokens')
  if (!isOptionalSafeNonNegative(row.cacheReadTokens)) fields.push('cacheReadTokens')
  if (!isOptionalSafeNonNegative(row.cacheWriteTokens)) fields.push('cacheWriteTokens')
  if (!isOptionalSafeNonNegative(row.reasoningTokens)) fields.push('reasoningTokens')
  if (!isFiniteNonNegative(row.estimatedAmount)) fields.push('estimatedAmount')
  if (!Number.isSafeInteger(row.capturedAt)) fields.push('capturedAt')
  if (fields.length > 0) throw new LedgerRowError(`invalid ledger row: ${fields.join(', ')}`)
}

/**
 * Collect every {@link LedgerQuery} field that fails its shape contract;
 * the subject rule list() always implied is explicit here too.
 * @param query - the candidate query.
 * @returns the offending field names, in declaration order.
 */
function collectQueryFields(query: LedgerQuery): string[] {
  const fields: string[] = []
  if (!isNonEmptyString(query.subject)) fields.push('subject')
  if (query.from !== undefined && !Number.isSafeInteger(query.from)) fields.push('from')
  if (query.to !== undefined && !Number.isSafeInteger(query.to)) fields.push('to')
  if (query.limit !== undefined && !Number.isFinite(query.limit)) fields.push('limit')
  return fields
}

/**
 * Throw {@link LedgerQueryError} naming every query field that fails its
 * shape contract; called before any SQL so a rejected query never reaches
 * the database.
 * @param query - the candidate query.
 */
function validateQuery(query: LedgerQuery): void {
  const fields = collectQueryFields(query)
  if (fields.length > 0) throw new LedgerQueryError(`invalid ledger query: ${fields.join(', ')}`)
}

/**
 * Throw {@link LedgerQueryError} naming every {@link UsageQuery} field
 * that fails its shape contract, including a cursor that does not decode;
 * called before any SQL so a rejected query never reaches the database.
 * @param query - the candidate usage query.
 */
function validateUsageQuery(query: UsageQuery): void {
  const fields = collectQueryFields(query)
  if (query.model !== undefined && !isNonEmptyString(query.model)) fields.push('model')
  if (query.cursor !== undefined) {
    try {
      decodePageCursor(query.cursor)
    } catch {
      fields.push('cursor')
    }
  }
  if (fields.length > 0) throw new LedgerQueryError(`invalid usage query: ${fields.join(', ')}`)
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
 * @param value - candidate token dimension, when the caller has one.
 * @returns whether the value is absent (stored as 0) or a safe integer ≥ 0.
 */
function isOptionalSafeNonNegative(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0)
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

/** base64url alphabet (padding `=` never emitted; standard base64 with
 * `+`→`-`, `/`→`_`, trailing `=` stripped). */
const CURSOR_ALPHABET = /^[A-Za-z0-9_-]+$/

/**
 * Encode a page cursor: the base64url of `[capturedAt, eventId]` for the
 * last row of a full page.
 * @param row - the row the cursor must resume strictly after.
 * @returns the opaque cursor string.
 */
function encodePageCursor(row: LedgerRow): string {
  return Buffer.from(JSON.stringify([row.capturedAt, row.eventId]), 'utf8').toString('base64url')
}

/**
 * Decode a page cursor produced by {@link encodePageCursor}.
 * @param cursor - the opaque cursor string.
 * @returns the keyset position it encodes.
 * @throws LedgerQueryError naming `cursor` when the string is not
 *   base64url, not JSON, not a `[safe-integer ms ≥ 0, string eventId]`
 *   pair.
 */
function decodePageCursor(cursor: string): { capturedAt: number, eventId: string } {
  if (!CURSOR_ALPHABET.test(cursor)) throw new LedgerQueryError('invalid usage query: cursor')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new LedgerQueryError('invalid usage query: cursor')
  }
  const [capturedAt, eventId] = Array.isArray(parsed) ? parsed : []
  if (
    !Number.isSafeInteger(capturedAt) ||
    capturedAt < 0 ||
    typeof eventId !== 'string'
  ) {
    throw new LedgerQueryError('invalid usage query: cursor')
  }
  return { capturedAt, eventId }
}

/**
 * Map one dimensioned SQL row to its public field naming.
 * @param row - usage_ledger row in SQL naming, dimensions included.
 * @returns the public row with unpriced back to boolean.
 */
function toUsageRow(row: UsageLedgerDimSqlRow): LedgerRow {
  return {
    ...toLedgerRow(row),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
  }
}

/**
 * Aggregate page stats over returned rows in JS (the CNY-only money rule
 * matches the SQL totals statement: unpriced rows never price and are
 * counted in unpricedCalls).
 * @param rows - the returned page, newest first.
 * @returns the page-local {@link PageStats}.
 */
function statsOverRows(rows: LedgerRow[]): PageStats {
  const stats: PageStats = {
    calls: rows.length,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedAmountCny: 0,
    unpricedCalls: 0,
  }
  for (const row of rows) {
    stats.tokens += row.tokens
    stats.inputTokens += row.inputTokens ?? 0
    stats.outputTokens += row.outputTokens ?? 0
    stats.cacheReadTokens += row.cacheReadTokens ?? 0
    stats.cacheWriteTokens += row.cacheWriteTokens ?? 0
    stats.reasoningTokens += row.reasoningTokens ?? 0
    if (row.unpriced) stats.unpricedCalls += 1
    else if (row.currency === 'CNY') stats.estimatedAmountCny += row.estimatedAmount
  }
  return stats
}

/** The connection plus every statement cached on it for one open ledger. */
interface LedgerSession {
  db: DatabaseSync
  insertRow: SqlStatement
  countRows: SqlStatement
  listSubject: SqlStatement
  listSubjectFrom: SqlStatement
  listSubjectTo: SqlStatement
  listSubjectFromTo: SqlStatement
}

/**
 * The durable usage ledger. Single-writer synchronous API; one instance
 * owns the database connection until {@link UsageLedger.close}.
 */
export class UsageLedger {
  private readonly dir: string
  private session: LedgerSession | undefined
  private closed = false

  private constructor(dir: string) {
    this.dir = dir
  }

  /**
   * Open a ledger lazily: record the directory and touch nothing (the
   * MeteringWal/OperatorStore precedent — constructors do no I/O). The
   * database is created and migrated on the first append/list/stats.
   * @param dir - directory for usage-ledger.sqlite, created on first use.
   * @returns the ledger instance; open failures surface on first use and
   *   retry, never latching.
   */
  static open(dir: string): UsageLedger {
    return new UsageLedger(dir)
  }

  /**
   * Materialize the database once: mkdir, connection, PRAGMAs, migrations,
   * prepared statements. A failure closes the connection and leaves no
   * session behind, so the next call retries from a clean state.
   * @throws LedgerClosedError when the ledger has closed; close latches.
   */
  private ensureOpen(): LedgerSession {
    if (this.closed) throw new LedgerClosedError('usage ledger is closed')
    const existing = this.session
    if (existing !== undefined) return existing
    mkdirSync(this.dir, { recursive: true })
    const db = new DatabaseSync(join(this.dir, 'usage-ledger.sqlite'))
    let session: LedgerSession
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
      session = {
        db,
        insertRow: db.prepare(
          `INSERT INTO usage_ledger
             (source, event_id, subject, captured_at, provider, model, tokens,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
              estimated_amount, currency, unpriced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source, event_id) DO NOTHING`,
        ),
        countRows: db.prepare('SELECT COUNT(*) AS total FROM usage_ledger'),
        listSubject: listStatement(db, 'subject = ?'),
        listSubjectFrom: listStatement(db, 'subject = ? AND captured_at >= ?'),
        listSubjectTo: listStatement(db, 'subject = ? AND captured_at <= ?'),
        listSubjectFromTo: listStatement(db, 'subject = ? AND captured_at >= ? AND captured_at <= ?'),
      }
    } catch (error) {
      db.close()
      throw error
    }
    this.session = session
    return session
  }

  /**
   * Append one usage event idempotently; a duplicate never overwrites the
   * stored row (subject immutable after insertion).
   * @param row - the event to record; validated before any SQL runs.
   * @returns 'inserted' for a fresh row, 'duplicate' when (source, eventId) exists.
   * @throws LedgerRowError when a field fails its shape contract.
   * @throws LedgerClosedError when the ledger has closed.
   */
  append(row: LedgerRow): AppendOutcome {
    validateRow(row)
    const { insertRow } = this.ensureOpen()
    const result = insertRow.run(
      row.source,
      row.eventId,
      row.subject,
      row.capturedAt,
      row.provider,
      row.model,
      row.tokens,
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
      row.cacheReadTokens ?? 0,
      row.cacheWriteTokens ?? 0,
      row.reasoningTokens ?? 0,
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
   * @throws LedgerClosedError when the ledger has closed.
   */
  list(query: LedgerQuery): LedgerRow[] {
    validateQuery(query)
    const session = this.ensureOpen()
    const params: Array<string | number> = [query.subject]
    let statement = session.listSubject
    if (query.from !== undefined && query.to !== undefined) {
      statement = session.listSubjectFromTo
      params.push(query.from, query.to)
    } else if (query.from !== undefined) {
      statement = session.listSubjectFrom
      params.push(query.from)
    } else if (query.to !== undefined) {
      statement = session.listSubjectTo
      params.push(query.to)
    }
    const rows = statement.all(...params, clampLimit(query.limit)) as unknown as UsageLedgerSqlRow[]
    return rows.map(toLedgerRow)
  }

  /**
    * Read one subject's usage as a page: newest-first rows ordered by
    * `captured_at DESC, event_id DESC`, page-local stats over the returned
    * rows, and totals over the entire filtered set (cursor and limit never
    * apply to totals). Statements are prepared per call: only fixed
    * literals from validation-selected branches compose the SQL text;
    * every value stays a bound parameter.
    * @param query - subject (exact match) with optional inclusive from/to
    *   epoch-ms bounds, exact model match, opaque keyset cursor, and a
    *   limit clamped into 1..1000 (default 500).
    * @returns the page; `cursor` is present only when a full page was
    *   returned, encoding the last row as the next keyset position.
    * @throws LedgerQueryError when subject/from/to/model/cursor/limit
    *   fail their shape contract.
    * @throws LedgerClosedError when the ledger has closed.
    */
  usagePage(query: UsageQuery): UsagePage {
    validateUsageQuery(query)
    const session = this.ensureOpen()
    const conditions = ['subject = ?']
    const params: Array<string | number> = [query.subject]
    if (query.from !== undefined) {
      conditions.push('captured_at >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      conditions.push('captured_at <= ?')
      params.push(query.to)
    }
    if (query.model !== undefined) {
      conditions.push('model = ?')
      params.push(query.model)
    }
    if (query.cursor !== undefined) {
      const { capturedAt, eventId } = decodePageCursor(query.cursor)
      conditions.push('(captured_at < ? OR (captured_at = ? AND event_id < ?))')
      params.push(capturedAt, capturedAt, eventId)
    }
    const effectiveLimit = clampLimit(query.limit)
    const rowsStatement = session.db.prepare(
      `SELECT ${LEDGER_PAGE_COLUMNS}
       FROM usage_ledger
       WHERE ${conditions.join(' AND ')}
       ORDER BY captured_at DESC, event_id DESC
       LIMIT ?`,
    )
    const rows = (
      rowsStatement.all(...params, effectiveLimit) as unknown as UsageLedgerDimSqlRow[]
    ).map(toUsageRow)
    // Totals aggregate the same filter minus the cursor predicate (always
    // appended last): the cursor is a paging position, not a row filter,
    // and limit never applies either.
    const totalsConditions = query.cursor === undefined ? conditions : conditions.slice(0, -1)
    const totalsParams = query.cursor === undefined ? params : params.slice(0, -3)
    const totalsStatement = session.db.prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(tokens), 0) AS tokens,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(CASE WHEN currency = 'CNY' AND unpriced = 0 THEN estimated_amount ELSE 0 END), 0) AS estimated_amount_cny,
              COALESCE(SUM(unpriced), 0) AS unpriced_calls
       FROM usage_ledger
       WHERE ${totalsConditions.join(' AND ')}`,
    )
    const totalsRow = totalsStatement.get(...totalsParams) as unknown as UsageTotalsSqlRow
    const page: UsagePage = {
      rows,
      page: statsOverRows(rows),
      totals: {
        calls: totalsRow.calls,
        tokens: totalsRow.tokens,
        inputTokens: totalsRow.input_tokens,
        outputTokens: totalsRow.output_tokens,
        cacheReadTokens: totalsRow.cache_read_tokens,
        cacheWriteTokens: totalsRow.cache_write_tokens,
        reasoningTokens: totalsRow.reasoning_tokens,
        estimatedAmountCny: totalsRow.estimated_amount_cny,
        unpricedCalls: totalsRow.unpriced_calls,
      },
    }
    if (rows.length === effectiveLimit) page.cursor = encodePageCursor(rows[rows.length - 1]!)
    return page
  }

  /**
   * Row count across all subjects.
   * @returns total stored rows.
   * @throws LedgerClosedError when the ledger has closed.
   */
  stats(): { total: number } {
    const row = this.ensureOpen().countRows.get() as { total: number }
    return { total: row.total }
  }

  /**
   * Close the database connection and latch the ledger closed (later use
   * throws {@link LedgerClosedError}); safe to call again, and safe when
   * the database never opened.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.session?.db.close()
  }
}
