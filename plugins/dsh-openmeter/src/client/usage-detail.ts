/**
 * Pure view model for the tenant usage-detail journal (issue #6): turn
 * filter form values into an inclusive query and reverse-chron rows into
 * per-day render groups plus deterministic display formatters.
 *
 * Invariants:
 * - Pure functions only: no fetch, no clock, no locale dictionaries; the
 *   page owns loading, error, and rendering decisions. Date objects appear
 *   solely for local-time decomposition of epoch-ms values.
 * - Day labels and clock strings are LOCAL time (the tenant's own day, not
 *   UTC), zero-padded, and stable across re-renders.
 * - Money is one currency: `estimatedAmountCny` sums priced CNY rows only;
 *   non-CNY amounts and unpriced rows never enter a money figure.
 * - The query never carries NaN: an empty or unparseable filter value is
 *   omitted, and `limit` is never set here (the server default of 50 owns
 *   page size).
 * - The fixed-offset local-day bound (midnight + 86_399_999 ms) assumes a
 *   DST-free local timezone.
 *
 * @module dsh-openmeter/client/usage-detail
 */

import type { UsageDetailQuery, UsageDetailRow } from './api.ts'

/** One `yyyy-mm-dd` local-day string per `<input type="date">`; empty means unset. */
export interface UsageDetailFilters {
  readonly from?: string
  readonly to?: string
  readonly model?: string
}

/** One day's rows plus their aggregates, in first-seen (newest-first) order. */
export interface UsageDayGroup {
  readonly key: string
  readonly rows: readonly UsageDetailRow[]
  readonly calls: number
  readonly tokens: number
  readonly estimatedAmountCny: number
  readonly unpricedCalls: number
}

/** Exactly the zero-padded `yyyy-mm-dd` produced by `<input type="date">`. */
const LOCAL_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Milliseconds in one day minus one: the span from local midnight to 23:59:59.999. */
const LAST_MS_OF_DAY = 86_399_999

/** Two-digit zero-padding for date and clock components. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local `YYYY-MM-DD` label of an epoch-ms timestamp, zero-padded. */
function localDayKey(at: number): string {
  const date = new Date(at)
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * Parse one `yyyy-mm-dd` string as a LOCAL day.
 * @param value - the raw filter string; empty or malformed is unset.
 * @returns the local Date at that day's 00:00:00.000, or null when the
 * string is empty, malformed, or denotes no real calendar day.
 */
function parseLocalDay(value: string | undefined): Date | null {
  const match = value === undefined ? null : LOCAL_DAY_RE.exec(value.trim())
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

/**
 * Build the usage-detail query from filter form values.
 * `from` becomes the local day's 00:00:00.000 and `to` its 23:59:59.999,
 * so both day bounds are inclusive. Empty or unparseable dates, an empty
 * model, and an empty cursor are omitted; `limit` is never set.
 * @param filters - raw filter values; `from`/`to` are local `yyyy-mm-dd` strings.
 * @param cursor - opaque keyset token from a previous page, when advancing.
 * @returns the query for `api.usageDetail`.
 */
export function toUsageQuery(filters: UsageDetailFilters, cursor?: string): UsageDetailQuery {
  const from = parseLocalDay(filters.from)
  const to = parseLocalDay(filters.to)
  const model = filters.model?.trim()
  return {
    ...(from === null ? {} : { from: from.getTime() }),
    ...(to === null ? {} : { to: to.getTime() + LAST_MS_OF_DAY }),
    ...(model === undefined || model === '' ? {} : { model }),
    ...(cursor === undefined || cursor === '' ? {} : { cursor }),
  }
}

/**
 * Group reverse-chron usage rows by local calendar day.
 * Groups come out in first-seen order (rows are newest first, so the
 * newest day heads the list) and rows within a group keep arrival order.
 * `estimatedAmountCny` sums only priced CNY rows; `unpricedCalls` counts
 * unpriced rows, which never contribute to money.
 * @param rows - usage rows ordered `captured_at DESC, event_id DESC`.
 * @returns one group per seen local day; the input is never mutated.
 */
export function groupUsageRows(rows: readonly UsageDetailRow[]): readonly UsageDayGroup[] {
  const byDay = new Map<string, UsageDetailRow[]>()
  for (const row of rows) {
    const key = localDayKey(row.at)
    const bucket = byDay.get(key)
    if (bucket === undefined) byDay.set(key, [row])
    else bucket.push(row)
  }
  return [...byDay.entries()].map(([key, dayRows]) => ({
    key,
    rows: dayRows,
    calls: dayRows.length,
    tokens: dayRows.reduce((sum, row) => sum + row.tokens, 0),
    estimatedAmountCny: dayRows.reduce(
      (sum, row) => (row.currency === 'CNY' && !row.unpriced ? sum + row.estimatedAmount : sum),
      0,
    ),
    unpricedCalls: dayRows.reduce((count, row) => (row.unpriced ? count + 1 : count), 0),
  }))
}

/**
 * Render a CNY amount with the currency sign and two decimals.
 * @param value - amount in CNY.
 * @returns e.g. `¥1.50`.
 */
export function formatCny(value: number): string {
  return `¥${value.toFixed(2)}`
}

/**
 * Render a token count with deterministic en-US grouping.
 * @param value - token count.
 * @returns e.g. `1,234,567`.
 */
export function formatTokens(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Render an epoch-ms timestamp as zero-padded local `HH:mm:ss`.
 * @param at - epoch ms of the row's capture time.
 * @returns e.g. `09:05:03`.
 */
export function formatClock(at: number): string {
  const date = new Date(at)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}
