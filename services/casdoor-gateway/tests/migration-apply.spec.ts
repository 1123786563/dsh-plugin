import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Context } from '../../../plugins/dsh-multi-tenant/packages/multi-tenant/node_modules/@deepseek-ai/cordis/lib/index.js'
import { SQLiteTenantSessionStore } from '../../../plugins/dsh-multi-tenant/packages/multi-tenant/src/sqlite-store.ts'
import { applyMigration } from '../src/migration/apply-migration.ts'
import { planMigration } from '../src/migration/plan-migration.ts'

const target = { tenantId: 'dsh-ops', userId: 'dsh-admin' }

interface SeedOwner {
  readonly sessionId: string
  readonly tenantId: string
  readonly userId: string
}

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-gateway-migration-apply-'))
}

/** Seed owner rows through the real store so the schema and claim semantics come from the product code. */
async function seedOwners(path: string, owners: readonly SeedOwner[]): Promise<void> {
  const ctx = new Context()
  try {
    await ctx.plugin(SQLiteTenantSessionStore, { path })
    for (const owner of owners) {
      await ctx.tenantSessionStore.claim(owner.sessionId, { tenantId: owner.tenantId, userId: owner.userId })
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Read back through the real store to assert what the product will actually see. */
async function listByOwner(path: string, tenantId: string, userId: string): Promise<string[]> {
  const ctx = new Context()
  try {
    await ctx.plugin(SQLiteTenantSessionStore, { path })
    return await ctx.tenantSessionStore.listByOwner(tenantId, userId)
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('applyMigration', () => {
  it('a) dry-run is byte-inert and lists every would-be claim', async () => {
    const root = temporaryRoot()
    const path = join(root, 'ownership.sqlite')
    try {
      const owners = [{ sessionId: 'already-acme', tenantId: 'acme', userId: 'alice' }]
      await seedOwners(path, owners)
      const plan = planMigration(['legacy-1', 'legacy-2', 'already-acme'], owners, target)
      expect(plan.counts.claim).toBe(2)

      const bytesBefore = readFileSync(path)
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        const result = applyMigration(db, plan, { dryRun: true })
        expect(result.claimed).toEqual(['legacy-1', 'legacy-2'])
        expect(result.skippedOwned).toEqual([])
        expect(result.failed).toEqual([])
      } finally {
        db.close()
      }

      // A read-only connection may still create SQLite's -shm/-wal reader
      // coordination sidecars; the database file itself must be byte-identical.
      expect(readFileSync(path).equals(bytesBefore)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('dry-run rechecks each claim item and routes raced-to-owned items to skippedOwned', async () => {
    const root = temporaryRoot()
    const path = join(root, 'ownership.sqlite')
    try {
      const plan = planMigration(['legacy-1', 'legacy-2'], [], target)
      await seedOwners(path, [{ sessionId: 'legacy-2', tenantId: 'acme', userId: 'bob' }])

      const db = new DatabaseSync(path, { readOnly: true })
      try {
        const result = applyMigration(db, plan, { dryRun: true })
        expect(result.claimed).toEqual(['legacy-1'])
        expect(result.skippedOwned).toEqual(['legacy-2'])
        expect(result.failed).toEqual([])
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('b) real run claims every ownerless item and the real store lists them under the target principal', async () => {
    const root = temporaryRoot()
    const path = join(root, 'ownership.sqlite')
    try {
      const owners = [{ sessionId: 'already-acme', tenantId: 'acme', userId: 'alice' }]
      await seedOwners(path, owners)
      const plan = planMigration(['legacy-1', 'legacy-2', 'already-acme'], owners, target)

      const db = new DatabaseSync(path)
      try {
        const result = applyMigration(db, plan, { dryRun: false })
        expect(result.claimed).toEqual(['legacy-1', 'legacy-2'])
        expect(result.skippedOwned).toEqual([])
        expect(result.failed).toEqual([])
      } finally {
        db.close()
      }

      await expect(listByOwner(path, 'dsh-ops', 'dsh-admin')).resolves.toEqual(['legacy-1', 'legacy-2'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('c) re-applying the same plan claims nothing and skips everything as owned', async () => {
    const root = temporaryRoot()
    const path = join(root, 'ownership.sqlite')
    try {
      const owners = [{ sessionId: 'already-acme', tenantId: 'acme', userId: 'alice' }]
      await seedOwners(path, owners)
      const plan = planMigration(['legacy-1', 'legacy-2', 'already-acme'], owners, target)

      const first = new DatabaseSync(path)
      try {
        expect(applyMigration(first, plan, { dryRun: false }).claimed).toEqual(['legacy-1', 'legacy-2'])
      } finally {
        first.close()
      }

      const second = new DatabaseSync(path)
      try {
        const result = applyMigration(second, plan, { dryRun: false })
        expect(result.claimed).toEqual([])
        expect(result.skippedOwned).toEqual(['legacy-1', 'legacy-2'])
        expect(result.failed).toEqual([])
      } finally {
        second.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('d) a concurrently pre-claimed row lands in skippedOwned, not failed', async () => {
    const root = temporaryRoot()
    const path = join(root, 'ownership.sqlite')
    try {
      const plan = planMigration(['legacy-1', 'legacy-2'], [], target)
      await seedOwners(path, [{ sessionId: 'legacy-1', tenantId: 'acme', userId: 'bob' }])

      const db = new DatabaseSync(path)
      try {
        const result = applyMigration(db, plan, { dryRun: false })
        expect(result.claimed).toEqual(['legacy-2'])
        expect(result.skippedOwned).toEqual(['legacy-1'])
        expect(result.failed).toEqual([])
      } finally {
        db.close()
      }
      await expect(listByOwner(path, 'acme', 'bob')).resolves.toEqual(['legacy-1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('e) baseline: rows seeded through the real store are visible via listByOwner under their owner', async () => {
    const root = temporaryRoot()
    const path = join(root, 'ownership.sqlite')
    try {
      await seedOwners(path, [
        { sessionId: 'legacy-e2', tenantId: target.tenantId, userId: target.userId },
        { sessionId: 'legacy-e1', tenantId: target.tenantId, userId: target.userId },
        { sessionId: 'other-1', tenantId: 'acme', userId: 'carol' },
      ])
      await expect(listByOwner(path, target.tenantId, target.userId)).resolves.toEqual(['legacy-e1', 'legacy-e2'])
      await expect(listByOwner(path, 'acme', 'carol')).resolves.toEqual(['other-1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
