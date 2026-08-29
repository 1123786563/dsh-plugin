/**
 * Pure planning logic for the legacy session migration (issue #26): given the
 * full admin session manifest and the read-only `session_owners` rows, decide
 * per session whether the migration CLI should claim it, skip it as already
 * owned, or report it as a DB orphan. No IO — the CLI shell (Task 2/3) feeds
 * the inputs and consumes the plan.
 *
 * @module dsh-casdoor-gateway/migration/plan-migration
 */

/** One `session_owners` row as read (read-only) from the ownership DB. */
export interface OwnerRow {
  readonly sessionId: string
  readonly tenantId: string
  readonly userId: string
}

/** The planned action for a single session. */
export interface MigrationPlanItem {
  readonly sessionId: string
  readonly action: 'claim' | 'skip-owned' | 'skip-unknown'
}

/** Per-session actions plus aggregate counts and the claim target principal. */
export interface MigrationPlan {
  readonly items: readonly MigrationPlanItem[]
  readonly counts: { claim: number; skipOwned: number; skipUnknown: number }
  readonly target: { readonly tenantId: string; readonly userId: string }
}

/**
 * Plan the legacy-session migration.
 *
 * Manifest sessions without an owner row become `claim` (ownerless legacy
 * sessions); manifest sessions with an owner row become `skip-owned` (any
 * owner, including an earlier migration to the target principal — reruns stay
 * idempotent); owner rows whose session is absent from the manifest become
 * `skip-unknown` orphan reports (never written).
 *
 * @param allSessionIds Full session id manifest from the gateway's admin session.list.
 * @param owners All `session_owners` rows, read-only from the ownership DB.
 * @param target Principal that `claim` items will be claimed for.
 * @returns The migration plan: per-session items in manifest order followed by
 * orphan rows in owners order, counts, and the target principal as passed in.
 */
export function planMigration(
  allSessionIds: readonly string[],
  owners: readonly OwnerRow[],
  target: { tenantId: string; userId: string },
): MigrationPlan {
  const ownerBySessionId = new Map(owners.map((row) => [row.sessionId, row]))
  const items: MigrationPlanItem[] = []
  for (const sessionId of allSessionIds) {
    items.push({ sessionId, action: ownerBySessionId.has(sessionId) ? 'skip-owned' : 'claim' })
  }
  const manifestSessionIds = new Set(allSessionIds)
  for (const row of owners) {
    if (!manifestSessionIds.has(row.sessionId)) {
      items.push({ sessionId: row.sessionId, action: 'skip-unknown' })
    }
  }
  return {
    items,
    counts: {
      claim: items.filter((item) => item.action === 'claim').length,
      skipOwned: items.filter((item) => item.action === 'skip-owned').length,
      skipUnknown: items.filter((item) => item.action === 'skip-unknown').length,
    },
    target,
  }
}
