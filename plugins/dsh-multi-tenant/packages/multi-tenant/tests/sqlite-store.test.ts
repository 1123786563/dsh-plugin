import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SQLiteTenantSessionStore from '../src/sqlite-store.ts'
import { assertTenantSessionStoreContract } from '../src/testing.ts'

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-multi-tenant-sqlite-'))
}

describe('SQLiteTenantSessionStore', () => {
  it('satisfies the TenantSessionStore contract', async () => {
    const root = temporaryRoot()
    let index = 0
    try {
      await expect(
        assertTenantSessionStoreContract(async (ctx) => {
          const path = join(root, `contract-${index++}.sqlite`)
          await ctx.plugin(SQLiteTenantSessionStore, { path })
          return ctx.tenantSessionStore
        }),
      ).resolves.toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps immutable ownership across Context/process-lifetime restart', async () => {
    const root = temporaryRoot()
    const path = join(root, 'restart.sqlite')
    const alice = { tenantId: 'acme', userId: 'alice' }
    const bob = { tenantId: 'acme', userId: 'bob' }

    const first = new Context()
    try {
      await first.plugin(SQLiteTenantSessionStore, { path })
      await expect(first.tenantSessionStore.claim('persisted', alice)).resolves.toBe('created')
    } finally {
      await first.fiber.dispose()
    }

    const second = new Context()
    try {
      await second.plugin(SQLiteTenantSessionStore, { path })
      await expect(second.tenantSessionStore.get('persisted')).resolves.toEqual(alice)
      await expect(second.tenantSessionStore.claim('persisted', alice)).resolves.toBe('idempotent')
      await expect(second.tenantSessionStore.claim('persisted', bob)).resolves.toBe('conflict')
      await expect(second.tenantSessionStore.get('persisted')).resolves.toEqual(alice)
    } finally {
      await second.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('serializes competing claims across two SQLite connections', async () => {
    const root = temporaryRoot()
    const path = join(root, 'shared.sqlite')
    const first = new Context()
    const second = new Context()
    try {
      await first.plugin(SQLiteTenantSessionStore, { path })
      await second.plugin(SQLiteTenantSessionStore, { path })

      const outcomes = await Promise.all([
        first.tenantSessionStore.claim('race', { tenantId: 'acme', userId: 'alice' }),
        second.tenantSessionStore.claim('race', { tenantId: 'acme', userId: 'bob' }),
      ])
      expect([...outcomes].sort()).toEqual(['conflict', 'created'])

      const owner = await first.tenantSessionStore.get('race')
      expect(owner).toBeDefined()
      await expect(second.tenantSessionStore.get('race')).resolves.toEqual(owner)
    } finally {
      await Promise.all([first.fiber.dispose(), second.fiber.dispose()])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('serves synchronous ownership reads against :memory:', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SQLiteTenantSessionStore, { path: ':memory:' })
      const store = ctx.tenantSessionStore
      const alice = { tenantId: 'acme', userId: 'alice' }
      const eve = { tenantId: 'globex', userId: 'eve' }

      await store.claim('s2', alice)
      await store.claim('s1', alice)

      expect(store.getSync?.('s1')).toEqual(alice)
      expect(store.getSync?.('ghost')).toBeUndefined()
      expect(store.listByOwnerSync?.('acme', 'alice')).toEqual(['s1', 's2'])
      expect(store.listByOwnerSync?.('globex', 'eve')).toEqual([])

      // Sync reads see later claims without any caching layer.
      await store.claim('late', alice)
      expect(store.getSync?.('late')).toEqual(alice)
      expect(store.listByOwnerSync?.('acme', 'alice')).toEqual(['late', 's1', 's2'])

      // Cross-tenant judgment material stays the service's concern; the store
      // only returns ownership verbatim.
      await store.claim('eves', eve)
      expect(store.getSync?.('eves')).toEqual(eve)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
