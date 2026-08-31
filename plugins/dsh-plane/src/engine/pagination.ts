/**
 * Cursor pagination matching the public /api/v1 contract: cursors encode
 * `value:offset:is_prev` where value carries the page size and offset is a
 * zero-based page number, and list envelopes carry total_count, next_cursor,
 * prev_cursor, next_page_results, prev_page_results, count, total_pages,
 * total_results, and results.
 *
 * @module dsh-plane/engine/pagination
 */

/** One parsed `value:offset:is_prev` cursor. */
interface ParsedCursor {
  limit: number
  page: number
}

/**
 * Parse one `value:offset:is_prev` cursor exactly like the public API: three
 * colon-delimited parts, the first numeric (a float when it contains a dot),
 * the last 0 or 1.
 * @param raw - the cursor query value.
 * @returns the parsed limit and zero-based page, or undefined when malformed.
 */
export function parseCursor(raw: string | undefined): ParsedCursor | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  const parts = raw.split(':')
  if (parts.length !== 3) return undefined
  const limit = Number.parseFloat(parts[0] ?? '')
  const page = Number.parseInt(parts[1] ?? '', 10)
  const isPrev = parts[2] ?? ''
  if (!Number.isFinite(limit) || !Number.isInteger(page) || (isPrev !== '0' && isPrev !== '1')) return undefined
  if (limit < 1 || page < 0) return undefined
  return { limit: Math.floor(limit), page }
}

/**
 * Encode one cursor for the next or previous page.
 * @param limit - page size.
 * @param page - zero-based page number the cursor points at.
 * @param isPrev - whether the cursor pages backwards.
 * @returns the `value:offset:is_prev` cursor string.
 */
export function encodeCursor(limit: number, page: number, isPrev: boolean): string {
  return limit + ':' + page + ':' + (isPrev ? 1 : 0)
}

/** Order keys the engine sorts lists by; prefix with - for descending. */
const ORDER_FIELDS = new Set(['created_at', 'name', 'sequence_id', 'sort_order', 'start_date', 'target_date', 'updated_at'])

/**
 * Validate an order_by parameter against the supported fields.
 * @param orderBy - the order_by query value.
 * @returns the normalized key with its direction, defaulting to -created_at.
 */
export function normalizeOrder(orderBy: string | undefined): { key: string, descending: boolean } {
  const raw = (orderBy ?? '').trim()
  if (raw.length === 0) return { key: 'created_at', descending: true }
  const descending = raw.startsWith('-')
  const key = descending ? raw.slice(1) : raw
  if (!ORDER_FIELDS.has(key)) return { key: 'created_at', descending: true }
  return { key, descending }
}

/** The cursor-paginated envelope the public API emits. */
export interface Paginated<T> {
  total_count: number
  next_cursor: string | null
  prev_cursor: string | null
  next_page_results: boolean
  prev_page_results: boolean
  count: number
  total_pages: number
  total_results: number
  results: T[]
}

/**
 * Slice one ordered row list into a page envelope.
 * @param rows - the full ordered list.
 * @param perPage - requested page size (a string when it arrives from a query string).
 * @param cursor - the incoming cursor, or undefined for page zero.
 * @returns the paginated envelope.
 */
export function paginate<T>(rows: readonly T[], perPage: number | string | undefined, cursor: string | undefined): Paginated<T> {
  const limit = clampPerPage(perPage)
  const parsed = parseCursor(cursor)
  const safeLimit = parsed === undefined ? limit : parsed.limit >= 1 ? parsed.limit : limit
  const pageNumber = parsed === undefined ? 0 : parsed.page
  const offset = pageNumber * safeLimit
  const total = rows.length
  const results = rows.slice(offset, offset + safeLimit)
  const hasNext = offset + safeLimit < total
  const hasPrev = pageNumber > 0
  return {
    total_count: total,
    next_cursor: hasNext ? encodeCursor(safeLimit, pageNumber + 1, false) : null,
    prev_cursor: hasPrev ? encodeCursor(safeLimit, pageNumber - 1, true) : null,
    next_page_results: hasNext,
    prev_page_results: hasPrev,
    count: results.length,
    total_pages: Math.ceil(total / safeLimit),
    total_results: total,
    results,
  }
}

/**
 * Clamp a requested page size to the public API bounds (1-100).
 * @param perPage - the requested size, possibly undefined.
 * @returns the clamped size.
 */
export function clampPerPage(perPage: number | string | undefined): number {
  const raw = typeof perPage === 'string' ? Number.parseInt(perPage, 10) : perPage
  if (raw === undefined || !Number.isInteger(raw) || raw < 1) return 50
  return Math.min(raw, 100)
}
