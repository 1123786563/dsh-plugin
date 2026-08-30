import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryTenantSessionStore, MultiTenantService } from 'dsh-multi-tenant'
import { isWebRequestPrincipal } from '../src/guard.ts'
import { applySessionFilter, createSessionFilterHooks } from '../src/session-filter.ts'
import type { SessionFilterDeps, SessionFilterHooksLike } from '../src/session-filter.ts'
import type { WebRequestPrincipal } from '../src/guard.ts'

/**
 * Issue #22 acceptance matrix: the plugin-side session visibility hooks over a
 * REAL MultiTenantService (in-memory store), mirroring the host
 * sessionController contract (principal arrives as unknown; the host
 * fail-closes principal-less requests before these callbacks ever run).
 *
 * Issue #23: the onSessionCreated observer auto-claims stock-UI created and
 * fork-derived sessions to the request principal over the same real kernel;
 * every claim failure resolves inside the callback with a warn.
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

  /**
   * Hooks over the real kernel; `extra` overrides individual deps (the
   * onSessionCreated cases inject the warn spy or a failing claim through
   * it), so the kernel wiring is defined in exactly one place.
   */
  function hooks(
    adminRoles: readonly string[] = ['dsh-admin'],
    extra: Partial<SessionFilterDeps> = {},
  ): SessionFilterHooksLike {
    const deps: SessionFilterDeps = {
      listSessionsByOwner: p => multiTenant.listSessionsByOwner(p),
      canAccessSession: (p, sessionId) => multiTenant.canAccessSession(p, sessionId),
      claimSession: (p, sessionId) => multiTenant.claimSession(sessionId, p),
      warn: () => {},
      ...extra,
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

  describe('onSessionCreated', () => {
    let warn: ReturnType<typeof vi.fn>

    beforeEach(() => {
      warn = vi.fn()
    })

    /** Hooks over the real kernel with the creation auto-claim warn spy attached. */
    function claimingHooks(adminRoles: readonly string[] = ['dsh-admin']): SessionFilterHooksLike {
      return hooks(adminRoles, { warn })
    }

    it('claims a created session to the request principal, visible in the same turn (create contract)', async () => {
      const hooks = claimingHooks()
      // The host awaits the notifier before the create response settles, so
      // ownership and list visibility hold immediately after this await.
      await hooks.onSessionCreated!(alice, 's-new')
      await expect(multiTenant.getSessionOwner('s-new')).resolves.toEqual({ tenantId: 'acme', userId: 'alice' })
      // sb1 is bob's row from the CLAIMS fixture — the filter must drop it.
      const rows = [{ sessionId: 'sb1' }, { sessionId: 's-new' }]
      await expect(hooks.listFilter!(alice, rows)).resolves.toEqual([{ sessionId: 's-new' }])
      expect(warn).not.toHaveBeenCalled()
    })

    it('claims a fork-derived child session id to the forking principal (fork contract)', async () => {
      await claimingHooks().onSessionCreated!(alice, 'fork-child-1')
      await expect(multiTenant.getSessionOwner('fork-child-1')).resolves.toEqual({ tenantId: 'acme', userId: 'alice' })
      expect(warn).not.toHaveBeenCalled()
    })

    it('adopts a bridge-preclaimed session idempotently for the same principal (both entrances, one terminal state)', async () => {
      await multiTenant.claimSession('s-bridge', alice) // /_dsh-multi-tenant/agents/create pre-claim
      await expect(claimingHooks().onSessionCreated!(alice, 's-bridge')).resolves.toBeUndefined()
      await expect(multiTenant.getSessionOwner('s-bridge')).resolves.toEqual({ tenantId: 'acme', userId: 'alice' })
      expect(warn).not.toHaveBeenCalled()
    })

    it('fail-closes a conflicting claimer: warns with session id and principal, keeps ownership, denies visibility', async () => {
      await multiTenant.claimSession('s-bridge', alice)
      const hooks = claimingHooks()
      await expect(hooks.onSessionCreated!(bob, 's-bridge')).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('s-bridge')
      expect(warn.mock.calls[0][0]).toContain('globex')
      expect(warn.mock.calls[0][0]).toContain('bob')
      await expect(multiTenant.getSessionOwner('s-bridge')).resolves.toEqual({ tenantId: 'acme', userId: 'alice' })
      await expect(hooks.accessCheck!(bob, 's-bridge')).resolves.toBe(false)
    })

    it('claims for an admin principal as well: ownership is bookkeeping, not a visibility exemption', async () => {
      await claimingHooks().onSessionCreated!(admin, 's-admin')
      await expect(multiTenant.getSessionOwner('s-admin')).resolves.toEqual({ tenantId: 'dsh-ops', userId: 'dsh-admin' })
      expect(warn).not.toHaveBeenCalled()
    })

    it('skips claiming and warns for malformed principals, never throwing', async () => {
      const notifier = claimingHooks().onSessionCreated!
      const malformed: readonly unknown[] = [
        undefined,
        null,
        'alice',
        { tenantId: 'acme', userId: 'alice' },
        { tenantId: 'acme', userId: 'alice', roles: 'dsh-admin' },
      ]
      for (const principal of malformed) {
        await expect(notifier(principal, 's-x'), `principal=${JSON.stringify(principal)}`).resolves.toBeUndefined()
      }
      expect(warn).toHaveBeenCalledTimes(malformed.length)
      expect(warn.mock.calls[0][0]).toContain('s-x')
      await expect(multiTenant.getSessionOwner('s-x')).resolves.toBeUndefined()
    })

    it('never rethrows a store failure: resolves and warns with session, principal, and cause', async () => {
      const notifier = hooks(['dsh-admin'], { claimSession: vi.fn().mockRejectedValue(new Error('store offline')), warn }).onSessionCreated!
      await expect(notifier(alice, 's-fail')).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('s-fail')
      expect(warn.mock.calls[0][0]).toContain('acme')
      expect(warn.mock.calls[0][0]).toContain('alice')
      expect(warn.mock.calls[0][0]).toContain('store offline')
    })

    it('settles concurrent distinct-id creations and lists every new session for the creator', async () => {
      const notifier = claimingHooks().onSessionCreated!
      const ids = Array.from({ length: 8 }, (_, i) => `s-race-${i}`)
      await Promise.all(ids.map(id => notifier(alice, id)))
      await expect(multiTenant.listSessionsByOwner(alice)).resolves.toEqual(expect.arrayContaining(ids))
      expect(warn).not.toHaveBeenCalled()
    })

    it('resolves concurrent same-id same-principal double claims (created + idempotent)', async () => {
      const notifier = claimingHooks().onSessionCreated!
      await Promise.all([notifier(alice, 's-twin'), notifier(alice, 's-twin')])
      await expect(multiTenant.getSessionOwner('s-twin')).resolves.toEqual({ tenantId: 'acme', userId: 'alice' })
      expect(warn).not.toHaveBeenCalled()
    })

    it('resolves concurrent same-id cross-principal claims with exactly one owner and a warned loser', async () => {
      const notifier = claimingHooks().onSessionCreated!
      const settled = await Promise.allSettled([notifier(alice, 's-duel'), notifier(bob, 's-duel')])
      expect(settled.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
      const owner = await multiTenant.getSessionOwner('s-duel')
      expect([
        { tenantId: 'acme', userId: 'alice' },
        { tenantId: 'globex', userId: 'bob' },
      ]).toContainEqual(owner)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('s-duel')
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

describe('applySessionFilter', () => {
  let multiTenant: MultiTenantService

  beforeEach(async () => {
    const ctx = new Context()
    await ctx.plugin(InMemoryTenantSessionStore)
    await ctx.plugin(MultiTenantService)
    multiTenant = ctx.multiTenant
    await multiTenant.claimSession('sa1', alice)
    await multiTenant.claimSession('sb1', bob)
  })

  const deps = (): SessionFilterDeps => ({
    listSessionsByOwner: p => multiTenant.listSessionsByOwner(p),
    canAccessSession: (p, sessionId) => multiTenant.canAccessSession(p, sessionId),
    claimSession: (p, sessionId) => multiTenant.claimSession(sessionId, p),
    warn: () => {},
  })

  it('registers both hooks on the sessionController seat and forwards its disposer', () => {
    const hostDispose = vi.fn()
    const register = vi.fn(() => hostDispose)
    const release = applySessionFilter({ registerSessionFilter: register }, deps(), ['dsh-admin'])
    expect(register).toHaveBeenCalledTimes(1)
    const hooks = register.mock.calls[0][0] as SessionFilterHooksLike
    expect(typeof hooks.listFilter).toBe('function')
    expect(typeof hooks.accessCheck).toBe('function')
    release()
    expect(hostDispose).toHaveBeenCalledTimes(1)
  })

  it('hands the seat hooks that actually enforce visibility', async () => {
    let captured: SessionFilterHooksLike | undefined
    applySessionFilter(
      { registerSessionFilter: (hooks: SessionFilterHooksLike) => { captured = hooks; return () => {} } },
      deps(),
      ['dsh-admin'],
    )
    const rows = [{ sessionId: 'sa1' }, { sessionId: 'sb1' }]
    await expect(captured!.listFilter!(alice, rows)).resolves.toEqual([{ sessionId: 'sa1' }])
    await expect(captured!.accessCheck!(alice, 'sb1')).resolves.toBe(false)
    await expect(captured!.accessCheck!(admin, 'sb1')).resolves.toBe(true)
  })

  it('hands the seat a creation observer whose claim reaches the real ownership kernel', async () => {
    const register = vi.fn(() => () => {})
    applySessionFilter({ registerSessionFilter: register }, deps(), ['dsh-admin'])
    const hooks = register.mock.calls[0][0] as SessionFilterHooksLike
    expect(typeof hooks.onSessionCreated).toBe('function')
    await hooks.onSessionCreated!(alice, 's-wired')
    await expect(multiTenant.getSessionOwner('s-wired')).resolves.toEqual({ tenantId: 'acme', userId: 'alice' })
    const rows = [{ sessionId: 's-wired' }, { sessionId: 'sb1' }]
    await expect(hooks.listFilter!(alice, rows)).resolves.toEqual([{ sessionId: 's-wired' }])
  })

  it('fails loud when the host core predates the session-filter seat (stale patch)', () => {
    const message = /dsh-request-guard\.patch/
    expect(() => applySessionFilter({}, deps(), ['dsh-admin'])).toThrow(message)
    expect(() => applySessionFilter(undefined, deps(), ['dsh-admin'])).toThrow(message)
    expect(() => applySessionFilter({ registerSessionFilter: 'not-a-function' }, deps(), ['dsh-admin'])).toThrow(message)
  })
})
