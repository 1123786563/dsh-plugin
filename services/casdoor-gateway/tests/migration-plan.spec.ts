import { describe, expect, it } from 'vitest'
import { planMigration } from '../src/migration/plan-migration.ts'

const target = { tenantId: 'dsh-ops', userId: 'dsh-admin' }

describe('planMigration', () => {
  it('claims ownerless sessions, skips owned ones (including already-migrated), and reports DB orphan rows as skip-unknown', () => {
    const allSessionIds = ['s-ownerless-1', 's-ownerless-2', 's-owned-acme', 's-owned-migrated']
    const owners = [
      { sessionId: 's-owned-acme', tenantId: 'acme', userId: 'alice' },
      { sessionId: 's-owned-migrated', tenantId: 'dsh-ops', userId: 'dsh-admin' },
      { sessionId: 's-db-orphan', tenantId: 'globex', userId: 'bob' },
    ]

    const plan = planMigration(allSessionIds, owners, target)

    expect(plan.counts).toEqual({ claim: 2, skipOwned: 2, skipUnknown: 1 })
    expect(plan.items.filter((item) => item.action === 'claim').map((item) => item.sessionId)).toEqual([
      's-ownerless-1',
      's-ownerless-2',
    ])
    expect(plan.items.filter((item) => item.action === 'skip-owned').map((item) => item.sessionId)).toEqual([
      's-owned-acme',
      's-owned-migrated',
    ])
    expect(plan.items.filter((item) => item.action === 'skip-unknown').map((item) => item.sessionId)).toEqual([
      's-db-orphan',
    ])
    expect(plan.target).toEqual(target)
  })

  it('plans nothing for an empty manifest with no owner rows', () => {
    const plan = planMigration([], [], target)
    expect(plan.counts).toEqual({ claim: 0, skipOwned: 0, skipUnknown: 0 })
    expect(plan.items).toEqual([])
    expect(plan.target).toEqual(target)
  })
})
