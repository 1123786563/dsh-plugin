import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryTenantSessionStore, MultiTenantService } from 'dsh-multi-tenant'
import { isWebRequestPrincipal } from '../src/guard.ts'
import { createSessionFilterHooks } from '../src/session-filter.ts'
import type { SessionFilterDeps, SessionFilterHooksLike } from '../src/session-filter.ts'
import type { WebRequestPrincipal } from '../src/guard.ts'

/**
 * Issue #22 acceptance matrix: the plugin-side session visibility hooks over a
 * REAL MultiTenantService (in-memory store), mirroring the host
 * sessionController contract (principal arrives as unknown; the host
 * fail-closes principal-less requests before these callbacks ever run).
 */

const alice: WebRequestPrincipal = { tenantId: 'acme', userId: 'alice', roles: [] }
const bob: WebRequestPrincipal = { tenantId: 'globex', userId: 'bob', roles: [] }
const carol: WebRequestPrincipal = { tenantId: 'acme', userId: 'carol', roles: [] }
const admin: WebRequestPrincipal = { tenantId: 'dsh-ops', userId: 'dsh-admin', roles: ['dsh-admin'] }

/** Session ids claimed before each case: ownership per the fixture table. */
const CLAIMS: ReadonlyArray<readonly [sessionId: string, owner: { tenantId: string, userId: string }]> = [
  ['sa1', alice],
  ['sa2', alice],
  ['sb1', bob],
  ['sb2', bob],
  ['sc1', carol],
]

/** One generic list item carrying more than the sessionId floor. */
interface Row { readonly sessionId: string, readonly title: string }

const ALL_ROWS: readonly Row[] = [
  { sessionId: 'sa1', title: 'alice 1' },
  { sessionId: 'sb1', title: 'bob 1' },
  { sessionId: 'sa2', title: 'alice 2' },
  { sessionId: 'sb2', title: 'bob 2' },
  { sessionId: 'sc1', title: 'carol 1' },
]

describe('createSessionFilterHooks', () => {
  let multiTenant: MultiTenantService

  beforeEach(async () => {
    const ctx = new Context()
    await ctx.plugin(InMemoryTenantSessionStore)
    await ctx.plugin(MultiTenantService)
    multiTenant = ctx.multiTenant
    for (const [sessionId, owner] of CLAIMS) {
      await multiTenant.claimSession(sessionId, owner)
    }
  })

  function hooks(adminRoles: readonly string[] = ['dsh-admin']): SessionFilterHooksLike {
    const deps: SessionFilterDeps = {
      listSessionsByOwner: p => multiTenant.listSessionsByOwner(p),
      canAccessSession: (p, sessionId) => multiTenant.canAccessSession(p, sessionId),
    }
    return createSessionFilterHooks(deps, adminRoles)
  }

  describe('listFilter', () => {
    it("keeps only the principal's own rows: cross-tenant and same-tenant cross-user alike", async () => {
      const filtered = await hooks().listFilter!(alice, ALL_ROWS)
      expect(filtered).toEqual([
        { sessionId: 'sa1', title: 'alice 1' },
        { sessionId: 'sa2', title: 'alice 2' },
      ])
    })

    it('preserves item identity and relative order (frontend zero-change)', async () => {
      const filtered = await hooks().listFilter!(alice, ALL_ROWS)
      expect(filtered[0]).toBe(ALL_ROWS[0])
      expect(filtered[1]).toBe(ALL_ROWS[2])
    })

    it('returns the complete list unchanged (same reference) for the exempt admin role', async () => {
      const filter = hooks().listFilter!
      await expect(filter(admin, ALL_ROWS)).resolves.toBe(ALL_ROWS)
    })

    it('returns an empty list for a malformed principal (fail-closed)', async () => {
      const filter = hooks().listFilter!
      const malformed: readonly unknown[] = [
        undefined,
        null,
        'alice',
        { tenantId: 'acme', userId: 'alice' },
        { tenantId: 'acme', userId: 'alice', roles: 'dsh-admin' },
        { tenantId: 'acme', userId: '', roles: [] },
        { tenantId: '', userId: 'alice', roles: [] },
        { tenantId: 'acme', userId: 'alice', roles: ['ok', 42] },
      ]
      for (const principal of malformed) {
        await expect(filter(principal, ALL_ROWS), `principal=${JSON.stringify(principal)}`).resolves.toEqual([])
      }
    })

    it('returns an empty list for a valid principal owning nothing', async () => {
      const nobody: WebRequestPrincipal = { tenantId: 'acme', userId: 'nobody', roles: [] }
      await expect(hooks().listFilter!(nobody, ALL_ROWS)).resolves.toEqual([])
    })

    it('returns an empty list unchanged for empty input', async () => {
      await expect(hooks().listFilter!(alice, [])).resolves.toEqual([])
    })
  })

  describe('accessCheck', () => {
    it('allows the principal own session and denies cross-tenant, same-tenant cross-user, forged, and ownerless ids', async () => {
      const check = hooks().accessCheck!
      await expect(check(alice, 'sa1')).resolves.toBe(true)
      await expect(check(alice, 'sb1')).resolves.toBe(false) // cross-tenant (globex/bob)
      await expect(check(alice, 'sc1')).resolves.toBe(false) // same tenant, other user (acme/carol)
      await expect(check(alice, 'forged-unknown')).resolves.toBe(false) // forged id, fail-closed
      await expect(check(alice, 's-unclaimed')).resolves.toBe(false) // ownerless legacy session
    })

    it('exempts the admin role everywhere, including ownerless sessions', async () => {
      const check = hooks().accessCheck!
      await expect(check(admin, 'sb1')).resolves.toBe(true)
      await expect(check(admin, 's-unclaimed')).resolves.toBe(true)
      await expect(check(admin, 'forged-unknown')).resolves.toBe(true)
    })

    it('returns false for a malformed principal (fail-closed)', async () => {
      const check = hooks().accessCheck!
      await expect(check(undefined, 'sa1')).resolves.toBe(false)
      await expect(check({ tenantId: 'acme', userId: 'alice', roles: 'dsh-admin' }, 'sa1')).resolves.toBe(false)
    })
  })

  describe('admin role set is configuration, not a literal', () => {
    it('honors a custom adminRoles list and drops the default role name', async () => {
      const custom: WebRequestPrincipal = { tenantId: 'dsh-ops', userId: 'ops', roles: ['ops-god'] }
      const { listFilter, accessCheck } = hooks(['ops-god'])
      await expect(accessCheck!(custom, 'sb1')).resolves.toBe(true)
      await expect(listFilter!(custom, ALL_ROWS)).resolves.toBe(ALL_ROWS)
      // The default role name no longer exempts…
      await expect(accessCheck!(admin, 'sb1')).resolves.toBe(false)
      // …but alice still sees her own sessions through the same hooks.
      await expect(accessCheck!(alice, 'sa1')).resolves.toBe(true)
    })
  })
})

describe('isWebRequestPrincipal', () => {
  it('accepts exactly the three-field guard principal and rejects everything else', () => {
    expect(isWebRequestPrincipal(alice)).toBe(true)
    expect(isWebRequestPrincipal(admin)).toBe(true)
    expect(isWebRequestPrincipal(undefined)).toBe(false)
    expect(isWebRequestPrincipal(null)).toBe(false)
    expect(isWebRequestPrincipal('alice')).toBe(false)
    expect(isWebRequestPrincipal({ tenantId: 'acme', userId: 'alice' })).toBe(false)
    expect(isWebRequestPrincipal({ tenantId: 'acme', userId: 'alice', roles: 'dsh-admin' })).toBe(false)
    expect(isWebRequestPrincipal({ tenantId: 'acme', userId: '', roles: [] })).toBe(false)
    expect(isWebRequestPrincipal({ tenantId: 'acme', userId: 'alice', roles: ['ok', 42] })).toBe(false)
  })
})
