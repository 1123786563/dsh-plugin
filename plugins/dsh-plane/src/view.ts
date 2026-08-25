/**
 * Context-frugal projections of Plane API payloads: list tools return
 * curated summaries instead of full rows so a page of results stays small in
 * the model context; detail tools return the raw decoded row.
 *
 * @module dsh-plane/view
 */

import type { JsonValue } from '@deepseek-ai/dsh-tools'

/** Keys kept from a Plane project row in list views. */
const PROJECT_KEYS = ['id', 'name', 'identifier', 'description', 'created_at', 'archived_at', 'total_members'] as const

/** Keys kept from a Plane work-item row in list and search views. */
const ISSUE_KEYS = [
  'id', 'name', 'sequence_id', 'identifier', 'priority', 'is_draft',
  'start_date', 'target_date', 'created_at', 'updated_at', 'completed_at',
  'state', 'assignees', 'labels', 'cycle', 'module_ids', 'parent', 'type',
] as const

/** Keys kept from a comment row in list views. */
const COMMENT_KEYS = ['id', 'comment_html', 'comment_stripped', 'access', 'created_by', 'created_at', 'updated_at'] as const

/** Keys kept from state, label, and cycle rows in metadata views. */
const METADATA_KEYS = {
  states: ['id', 'name', 'group', 'color', 'sequence', 'default'] as const,
  labels: ['id', 'name', 'color', 'parent', 'sort_order'] as const,
  cycles: ['id', 'name', 'description', 'start_date', 'end_date', 'is_current', 'is_favorite', 'progress_snapshot'] as const,
} as const

/** Resource kinds the metadata tool lists. */
export type MetadataResource = keyof typeof METADATA_KEYS

/**
 * Copy the whitelisted keys present on one row.
 * @param row - decoded Plane row.
 * @param keys - whitelist to copy.
 * @returns the projection with only present keys.
 */
function pick(row: Record<string, unknown>, keys: readonly string[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined) out[key] = value as JsonValue
  }
  return out
}

/**
 * Project one page of rows through a whitelist.
 * @param rows - decoded Plane rows.
 * @param keys - whitelist to copy per row.
 * @returns projections of the rows that are objects.
 */
export function projectRows(rows: readonly Record<string, unknown>[], keys: readonly string[]): Record<string, JsonValue>[] {
  return rows.map(row => pick(row, keys))
}

/** Whitelist for project list rows. */
export const projectKeys: readonly string[] = PROJECT_KEYS
/** Whitelist for work-item list and search rows. */
export const issueKeys: readonly string[] = ISSUE_KEYS
/** Whitelist for comment list rows. */
export const commentKeys: readonly string[] = COMMENT_KEYS

/**
 * Whitelist for one metadata resource.
 * @param resource - states, labels, or cycles.
 * @returns the whitelist for that resource.
 */
export function metadataKeys(resource: MetadataResource): readonly string[] {
  return METADATA_KEYS[resource]
}

/**
 * Render one projected work-item row as a compact reference line.
 * @param row - projected work-item row.
 * @returns one summary line.
 */
export function issueLine(row: Record<string, unknown>): string {
  const id = typeof row.identifier === 'string' && row.identifier.length > 0
    ? row.identifier
    : '#' + String(row.sequence_id ?? row.id)
  const state = nestedName(row.state)
  const priority = typeof row.priority === 'string' ? row.priority : 'none'
  const assignees = Array.isArray(row.assignees)
    ? row.assignees.map(nestedName).filter(name => name.length > 0).join(', ')
    : ''
  const labels = Array.isArray(row.labels) ? row.labels.map(nestedName).filter(name => name.length > 0).join(', ') : ''
  const parts = [id + ' ' + String(row.name ?? ''), '[' + state + '/' + priority + ']']
  if (assignees.length > 0) parts.push('@' + assignees)
  if (labels.length > 0) parts.push('labels: ' + labels)
  return parts.join(' | ')
}

/**
 * Extract a display name from a nested relation value that may be an id
 * string or an expanded object.
 * @param value - relation value from a Plane row.
 * @returns the display name, or the id, or an empty string.
 */
function nestedName(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const row = value as Record<string, unknown>
    for (const key of ['display_name', 'name', 'id']) {
      if (typeof row[key] === 'string') return row[key] as string
    }
  }
  return ''
}
