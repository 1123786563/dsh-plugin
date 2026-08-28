/**
 * Tenant monthly budget store and forecast service (issue #7).
 *
 * The store is persistence-only: one row per tenant, the monthly budget
 * cap in integer 分 (minor units), durably SQLite-backed. The forecast is
 * a pure service function over injected collaborators — budget read,
 * month-window spend read, clock — mirroring loadTenantSummary, because a
 * forecast composes subject-keyed ledger spend with tenantId-keyed budget
 * and neither store should own the other's key.
 *
 * Money rules:
 * - Budget currency is CNY, stored as `Math.round(amountCny * 100)` 分
 *   and served back divided by 100; amounts below 0.005 CNY have no 分
 *   representation and are rejected as client errors, never stored as 0.
 * - Forecast money floats stay unrounded; 计算失败不伪造 0 — a month with
 *   no metered calls yields an explicit 'insufficient-history' status
 *   with no projection, never a fabricated 0 projection.
 * - The spend snapshot is the caller's truth (usagePage totals semantics:
 *   estimatedAmountCny is CNY-only and unpriced calls never price); the
 *   forecast never re-filters it.
 *
 * @module dsh-openmeter/budget
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Upper bound for one monthly budget in CNY: 1e8 CNY = 1e10 分, a safe integer. */
const BUDGET_MAX_CNY = 100_000_000

/** Milliseconds in one UTC day; the forecast's day arithmetic unit. */
const DAY_MS = 86_400_000

/**
 * Typed rejection for a malformed budget input (non-positive/oversized
 * amount, sub-分 amount, blank tenantId): the client's fault; the message
 * names the offending field and carries no field values.
 */
export class BudgetAmountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetAmountError'
  }
}

/**
 * Typed rejection for using a closed store: close latches, so a later
 * get/set fails here rather than re-opening the database.
 */
export class BudgetClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetClosedError'
  }
}

/**
 * The month-spend truth one forecast reads: the ledger's window aggregates
 * (usagePage totals semantics — estimatedAmountCny is CNY-only, unpriced
 * calls count in unpricedCalls and never price).
 */
export interface BudgetSpendSnapshot {
  /** CNY-priced spend estimate over the queried window. */
  estimatedAmountCny: number
  /** All metered calls in the window, priced or not. */
  calls: number
  /** Calls the estimator could not price. */
  unpricedCalls: number
}

/** The 计算依据 every forecast state carries. */
export interface BudgetForecastBasis {
  /**
   * 'linear-daily-average' exactly when a projection is present;
   * 'none' when no projection exists (no metered calls this month).
   */
  method: 'linear-daily-average' | 'none'
  /** UTC calendar-month start (inclusive), epoch ms. */
  monthStartMs: number
  /** UTC calendar-month end (next month start − 1, inclusive), epoch ms. */
  monthEndMs: number
  /** Days in the UTC calendar month. */
  daysInMonth: number
  /** Whole and partial UTC days elapsed, current partial day counts as one. */
  daysElapsed: number
  /** Epoch ms of the read, from the injected clock. */
  dataAsOfMs: number
  /** Budget and spend figures are both CNY; Token credit never converts. */
  currency: 'CNY'
  /** Spend comes from local ledger estimates, not OpenMeter reconciliation. */
  spendSource: 'local-ledger-estimates'
}

/**
 * No budget row exists for the tenant (未配置). A projection is offered
 * from spend alone when the month has calls; budget and overage fields
 * are never fabricated here.
 */
export interface BudgetForecastUnconfigured {
  readonly availability: 'unconfigured'
  readonly monthToDateCny: number
  /** Present only when the month has at least one metered call. */
  readonly projectedMonthEndCny?: number
  readonly basis: BudgetForecastBasis
}

/**
 * A budget exists but the month has no metered calls: nothing to
 * extrapolate. No projection and no overage — absent, never 0.
 */
export interface BudgetForecastInsufficientHistory {
  readonly availability: 'insufficient-history'
  readonly monthlyBudgetCny: number
  readonly monthToDateCny: number
  readonly basis: BudgetForecastBasis
}

/** Budget configured and calls metered: full projection and overage. */
export interface BudgetForecastReady {
  readonly availability: 'ready'
  readonly monthlyBudgetCny: number
  readonly monthToDateCny: number
  readonly projectedMonthEndCny: number
  /** Math.max(0, projected − budget); 0 when the projection stays under. */
  readonly projectedOverageCny: number
  readonly basis: BudgetForecastBasis
}

/** One forecast read: unconfigured, insufficient history, or ready. */
export type BudgetForecast =
  | BudgetForecastUnconfigured
  | BudgetForecastInsufficientHistory
  | BudgetForecastReady

/** The tenant and subject one forecast is about. */
export interface BudgetForecastInput {
  readonly tenantId: string
  readonly subject: string
}

/** Injected collaborators: budget read, month-window spend read, clock. */
export interface BudgetForecastDeps {
  /** Budget store seam; Pick so any read-compatible store composes. */
  readonly budgetStore: Pick<BudgetStore, 'get'>
  /**
   * Month-spend seam: aggregate the subject's window [from, to] (both
   * inclusive epoch ms) exactly as the ledger's usagePage totals do.
   */
  readonly monthSpend: (subject: string, from: number, to: number) => BudgetSpendSnapshot
  /** Clock seam so month bounds and dataAsOfMs are deterministic in tests. */
  readonly now: () => number
}

/** tenant_budget row in its SQL column naming. */
interface BudgetSqlRow {
  amount_minor: number
}

/** Prepared `node:sqlite` statement, cached on the owning instance. */
type SqlStatement = ReturnType<DatabaseSync['prepare']>

/** The connection plus every statement cached on it for one open store. */
interface BudgetSession {
  db: DatabaseSync
  selectRow: SqlStatement
  upsertRow: SqlStatement
}

/** Ordered migrations applied when the store first opens its database. */
const MIGRATIONS: ReadonlyArray<{ name: string, sql: string }> = [
  {
    name: '0001-create-tenant-budget',
    sql: `
      CREATE TABLE IF NOT EXISTS tenant_budget (
        tenant_id TEXT PRIMARY KEY,
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
]

/**
 * @param value - candidate tenant id.
 * @returns whether the value is a string with non-whitespace content.
 */
function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
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
 * Load one tenant's budget: null when unconfigured, the CNY amount otherwise.
 * @param session - the store's open session.
 * @param tenantId - exact tenant id (validated by the caller).
 * @returns the stored budget, or null when no row exists.
 */
function readBudget(session: BudgetSession, tenantId: string): { amountCny: number } | null {
  const row = session.selectRow.get(tenantId) as unknown as BudgetSqlRow | undefined
  return row === undefined ? null : { amountCny: row.amount_minor / 100 }
}

/**
 * The durable tenant budget store. One row per tenant in budget.sqlite;
 * single-writer synchronous API; one instance owns the connection until
 * {@link BudgetStore.close}.
 */
export class BudgetStore {
  private readonly dir: string
  private session: BudgetSession | undefined
  private closed = false

  private constructor(dir: string) {
    this.dir = dir
  }

  /**
   * Open a store lazily: record the directory and touch nothing (the
   * UsageLedger precedent — constructors do no I/O). The database is
   * created and migrated on the first get/set; open failures surface on
   * first use and retry, never latching.
   * @param dir - directory for budget.sqlite, created on first use.
   * @returns the store instance.
   */
  static open(dir: string): BudgetStore {
    return new BudgetStore(dir)
  }

  /**
   * Materialize the database once: mkdir, connection, PRAGMAs, migrations,
   * prepared statements. A failure closes the connection and leaves no
   * session behind, so the next call retries from a clean state.
   * @throws BudgetClosedError when the store has closed; close latches.
   */
  private ensureOpen(): BudgetSession {
    if (this.closed) throw new BudgetClosedError('budget store is closed')
    const existing = this.session
    if (existing !== undefined) return existing
    mkdirSync(this.dir, { recursive: true })
    const db = new DatabaseSync(join(this.dir, 'budget.sqlite'))
    let session: BudgetSession
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS budget_migrations (
          name TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        ) STRICT;
      `)
      const applied = db.prepare('SELECT name FROM budget_migrations WHERE name = ?')
      const record = db.prepare(
        'INSERT INTO budget_migrations (name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
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
        selectRow: db.prepare('SELECT amount_minor FROM tenant_budget WHERE tenant_id = ?'),
        upsertRow: db.prepare(
          `INSERT INTO tenant_budget (tenant_id, amount_minor, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(tenant_id) DO UPDATE SET amount_minor = excluded.amount_minor, updated_at = excluded.updated_at`,
        ),
      }
    } catch (error) {
      db.close()
      throw error
    }
    this.session = session
    return session
  }

  /**
   * Read one tenant's budget.
   * @param tenantId - exact tenant id; a blank-after-trim id is a client error.
   * @returns the stored CNY amount, or null when 未配置 (no row).
   * @throws BudgetAmountError when tenantId is blank after trimming.
   * @throws BudgetClosedError when the store has closed.
   */
  get(tenantId: string): { amountCny: number } | null {
    if (!isNonEmptyString(tenantId)) throw new BudgetAmountError('invalid tenant budget: tenantId')
    return readBudget(this.ensureOpen(), tenantId)
  }

  /**
   * Set one tenant's monthly budget, creating or overwriting the row
   * (UPSERT). The id is stored verbatim (validation only rejects
   * blank-after-trim ids); the amount is stored as integer 分.
   * @param tenantId - exact tenant id; blank after trimming is rejected.
   * @param amountCny - budget in CNY; must be finite and in
   *   (0, 100000000] with a 分 representation (≥ 0.005).
   * @throws BudgetAmountError when tenantId or amountCny fails its shape
   *   contract; rejected before any SQL runs.
   * @throws BudgetClosedError when the store has closed.
   */
  set(tenantId: string, amountCny: number): void {
    if (!isNonEmptyString(tenantId)) throw new BudgetAmountError('invalid tenant budget: tenantId')
    if (
      typeof amountCny !== 'number' ||
      !Number.isFinite(amountCny) ||
      amountCny <= 0 ||
      amountCny > BUDGET_MAX_CNY ||
      Math.round(amountCny * 100) < 1
    ) {
      throw new BudgetAmountError('invalid tenant budget: amountCny')
    }
    this.ensureOpen().upsertRow.run(tenantId, Math.round(amountCny * 100), Date.now())
  }

  /**
   * Close the database connection and latch the store closed (later use
   * throws {@link BudgetClosedError}); safe to call again, and safe when
   * the database never opened.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.session?.db.close()
  }
}

/**
 * Load one tenant's month-to-date budget forecast: compose the tenant's
 * stored budget, the subject's spend over the UTC calendar month holding
 * `deps.now()`, and a linear-daily-average projection to month end.
 *
 * Month window: `monthStartMs` is the UTC month start, `monthEndMs` the
 * inclusive end (next month start − 1); `daysElapsed` counts the current
 * partial day as one. Projection is `monthToDateCny / daysElapsed *
 * daysInMonth`, money floats unrounded. monthSpend is called exactly once
 * per load, with those bounds.
 * @param input - the tenantId (budget key) and subject (spend key).
 * @param deps - budget store, month-spend seam, and clock.
 * @returns the discriminated forecast; never fabricates a budget, a
 *   projection, or an overage the inputs do not support.
 */
export function loadBudgetForecast(input: BudgetForecastInput, deps: BudgetForecastDeps): BudgetForecast {
  const now = deps.now()
  const month = new Date(now)
  const monthStartMs = Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1)
  const monthEndMs = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) - 1
  const daysInMonth = (monthEndMs + 1 - monthStartMs) / DAY_MS
  const daysElapsed = Math.min(daysInMonth, Math.floor((now - monthStartMs) / DAY_MS) + 1)
  const spend = deps.monthSpend(input.subject, monthStartMs, monthEndMs)
  const monthToDateCny = spend.estimatedAmountCny
  const hasProjection = spend.calls > 0
  const basis: BudgetForecastBasis = {
    method: hasProjection ? 'linear-daily-average' : 'none',
    monthStartMs,
    monthEndMs,
    daysInMonth,
    daysElapsed,
    dataAsOfMs: now,
    currency: 'CNY',
    spendSource: 'local-ledger-estimates',
  }
  const budget = deps.budgetStore.get(input.tenantId)
  if (budget === null) {
    return {
      availability: 'unconfigured',
      monthToDateCny,
      ...(hasProjection
        ? { projectedMonthEndCny: (monthToDateCny / daysElapsed) * daysInMonth }
        : {}),
      basis,
    }
  }
  if (!hasProjection) {
    // No metered calls: the only honest month-to-date is the literal 0,
    // and nothing is extrapolated from it.
    return {
      availability: 'insufficient-history',
      monthlyBudgetCny: budget.amountCny,
      monthToDateCny: 0,
      basis,
    }
  }
  const projectedMonthEndCny = (monthToDateCny / daysElapsed) * daysInMonth
  return {
    availability: 'ready',
    monthlyBudgetCny: budget.amountCny,
    monthToDateCny,
    projectedMonthEndCny,
    projectedOverageCny: Math.max(0, projectedMonthEndCny - budget.amountCny),
    basis,
  }
}
