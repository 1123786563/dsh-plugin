/**
 * Claim writer for the legacy session migration (issue #26): executes a
 * {@link MigrationPlan} against the `session_owners` SQLite database with the
 * same SQL semantics as `SQLiteTenantSessionStore.claim()` (atomic
 * `INSERT … ON CONFLICT(session_id) DO NOTHING` plus a read-back of the
 * immutable winner), plus a strictly read-only dry-run. The CLI shell
 * (Task 3) owns all IO: opening the database handle, reading owner rows,
 * and printing the result.
 *
 * @module dsh-casdoor-gateway/migration/apply-migration
 */

import type { DatabaseSync } from 'node:sqlite'
import type { MigrationPlan } from './plan-migration.ts'

/** Outcome of applying a migration plan to the ownership database. */
export interface ApplyResult {
  /**
   * Claim items inserted for the target principal. In dry-run: claim items
   * re-verified as still ownerless, i.e. the sessions a real run would
   * migrate.
   */
  readonly claimed: readonly string[]
  /**
   * Claim items found owned by anyone (including the target principal from an
   * earlier migration) — skipped, never an error: claim-once ownership is
   * immutable.
   */
  readonly skippedOwned: readonly string[]
  /** Claim items whose claim attempt threw; the remaining items are still attempted. */
  readonly failed: readonly { readonly sessionId: string; readonly reason: string }[]
}

/** Owner row columns read back from `session_owners`. */
interface OwnerColumns {
  readonly tenantId: string
  readonly userId: string
}

function readOwnerColumns(row: unknown): OwnerColumns | undefined {
  if (row === undefined) return undefined
  if (typeof row !== 'object' || row === null) {
    throw new Error('session_owners query returned a malformed row')
  }
  const tenantId = Reflect.get(row, 'tenant_id')
  const userId = Reflect.get(row, 'user_id')
  if (typeof tenantId !== 'string' || typeof userId !== 'string') {
    throw new Error('session_owners query returned a malformed row')
  }
  return { tenantId, userId }
}

/**
 * Apply a migration plan to the ownership database.
 *
 * Only the plan's `claim` items are executed; `skip-owned` and `skip-unknown`
 * were already decided by {@link planMigration} and involve no write. Each
 * claim uses the store's exact statement — one atomic
 * `INSERT … ON CONFLICT(session_id) DO NOTHING` auto-committed as its own
 * transaction — so a concurrent owner (any principal) loses nothing and is
 * reported in `skippedOwned`, never `failed`.
 *
 * `dryRun: true` prepares and runs nothing but `SELECT`: it re-verifies each
 * claim item as still ownerless and lists those in `claimed`, so the caller
 * may (and should) pass a read-only handle. `dryRun: false` requires a
 * read-write handle; a read-only handle surfaces per-item in `failed`.
 *
 * @param db Open `session_owners` database handle; read-only for dry-run, read-write otherwise.
 * @param plan Plan from {@link planMigration}; `plan.target` receives every claim.
 * @param opts `dryRun` selects the read-only preview over the real writes.
 * @returns Per-item outcomes in plan order: claimed, skippedOwned, failed.
 */
export function applyMigration(
  db: DatabaseSync,
  plan: MigrationPlan,
  opts: { readonly dryRun: boolean },
): ApplyResult {
  const claimed: string[] = []
  const skippedOwned: string[] = []
  const failed: { sessionId: string; reason: string }[] = []

  const selectOwner = db.prepare(`
    SELECT tenant_id, user_id
    FROM session_owners
    WHERE session_id = ?
  `)

  if (opts.dryRun) {
    for (const item of plan.items) {
      if (item.action !== 'claim') continue
      try {
        if (readOwnerColumns(selectOwner.get(item.sessionId)) === undefined) claimed.push(item.sessionId)
        else skippedOwned.push(item.sessionId)
      } catch (error) {
        failed.push({ sessionId: item.sessionId, reason: toReason(error) })
      }
    }
    return { claimed, skippedOwned, failed }
  }

  const insertOwner = db.prepare(`
    INSERT INTO session_owners (session_id, tenant_id, user_id)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO NOTHING
  `)
  for (const item of plan.items) {
    if (item.action !== 'claim') continue
    try {
      const inserted = insertOwner.run(item.sessionId, plan.target.tenantId, plan.target.userId)
      if (Number(inserted.changes) === 1) {
        claimed.push(item.sessionId)
        continue
      }
      if (readOwnerColumns(selectOwner.get(item.sessionId)) === undefined) {
        throw new Error('SQLite session ownership claim lost its persisted winner')
      }
      skippedOwned.push(item.sessionId)
    } catch (error) {
      failed.push({ sessionId: item.sessionId, reason: toReason(error) })
    }
  }
  return { claimed, skippedOwned, failed }
}

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
