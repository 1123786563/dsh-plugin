import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyControlFrameFilter,
  applyRemoteEventFrameFilter,
  createFrameFilterFactory,
} from '../src/frame-filter.ts'

interface Owner {
  tenantId: string
  userId: string
}

const alice: Owner = { tenantId: 'acme', userId: 'alice' }
const bob: Owner = { tenantId: 'acme', userId: 'bob' }
const eve: Owner = { tenantId: 'globex', userId: 'eve' }

function makeDeps(owners: Map<string, Owner>) {
  const calls = { list: 0, access: 0 }
  return {
    calls,
    deps: {
      listSessionsByOwnerSync(principal: Owner): string[] {
        calls.list += 1
        return [...owners.entries()]
          .filter(([, owner]) => owner.tenantId === principal.tenantId && owner.userId === principal.userId)
          .map(([sessionId]) => sessionId)
      },
      canAccessSessionSync(principal: Owner, sessionId: string): boolean {
        calls.access += 1
        const owner = owners.get(sessionId)
        return owner !== undefined && owner.tenantId === principal.tenantId && owner.userId === principal.userId
      },
    },
  }
}

const own = (roles: readonly string[] = []): unknown => ({ ...alice, roles })

describe('createFrameFilterFactory judgments', () => {
  it('denies every frame for a principal-less carrier (fail-closed)', () => {
    const { deps } = makeDeps(new Map())
    const filter = createFrameFilterFactory(deps, ['dsh-admin'])(undefined)
    expect(filter('s1', 'waterfall')).toBe(false)
  })

  it('denies every frame for a malformed principal', () => {
    const { deps } = makeDeps(new Map())
    const filter = createFrameFilterFactory(deps, ['dsh-admin'])({ tenantId: 'acme' })
    expect(filter('s1', 'emit')).toBe(false)
  })

  it('admits everything for an admin regardless of ownership', () => {
    const { deps, calls } = makeDeps(new Map([['s1', bob]]))
    const filter = createFrameFilterFactory(deps, ['dsh-admin'])(own(['dsh-admin']))
    expect(filter('s1', 'waterfall')).toBe(true)
    expect(filter('anything', 'baseline')).toBe(true)
    expect(calls.list).toBe(0)
    expect(calls.access).toBe(0)
  })

  it('honors a configured admin role name', () => {
    const { deps } = makeDeps(new Map([['s1', bob]]))
    const filter = createFrameFilterFactory(deps, ['ops-lead'])(own(['ops-lead']))
    expect(filter('s1', 'waterfall')).toBe(true)
  })

  it('does not treat a non-admin role as exempt', () => {
    const { deps } = makeDeps(new Map([['s1', bob]]))
    const filter = createFrameFilterFactory(deps, ['dsh-admin'])(own(['viewer']))
    expect(filter('s1', 'waterfall')).toBe(false)
  })

  it('admits own sessions and denies cross-user / cross-tenant / unknown', () => {
    const { deps } = makeDeps(new Map([['mine', alice], ['bobs', bob], ['eves', eve]]))
    const filter = createFrameFilterFactory(deps, [])(own())
    expect(filter('mine', 'waterfall')).toBe(true)
    expect(filter('bobs', 'jobs')).toBe(false)
    expect(filter('eves', 'emit')).toBe(false)
    expect(filter('ghost', 'baseline')).toBe(false)
  })

  it('materializes the set once per connection and queries ownership only on misses', () => {
    const { deps, calls } = makeDeps(new Map([['mine', alice]]))
    const filter = createFrameFilterFactory(deps, [])(own())
    filter('mine', 'waterfall')
    filter('mine', 'jobs')
    expect(calls.list).toBe(1)
    expect(calls.access).toBe(0)
    filter('claimed-later', 'emit')
    expect(calls.access).toBe(1)
  })

  it('sees a session claimed after the connection opened (per-frame authority)', () => {
    const owners = new Map<string, Owner>([['mine', alice]])
    const { deps } = makeDeps(owners)
    const filter = createFrameFilterFactory(deps, [])(own())
    expect(filter('late', 'waterfall')).toBe(false)
    owners.set('late', alice)
    expect(filter('late', 'waterfall')).toBe(true)
  })

  it('builds an independent snapshot per connection', () => {
    const { deps, calls } = makeDeps(new Map([['mine', alice]]))
    createFrameFilterFactory(deps, [])(own())
    createFrameFilterFactory(deps, [])(own())
    expect(calls.list).toBe(2)
  })

  it('propagates deps throws to the host contract (no silent catch)', () => {
    const { deps } = makeDeps(new Map())
    const filter = createFrameFilterFactory(
      {
        ...deps,
        canAccessSessionSync: () => {
          throw new Error('store closed')
        },
      },
      [],
    )(own())
    expect(() => filter('x', 'emit')).toThrow('store closed')
  })
})

describe('seat wiring', () => {
  const { deps } = makeDeps(new Map())
  const registrations: Array<{ factory: unknown }> = []
  beforeEach(() => { registrations.length = 0 })

  const remoteSeat = {
    registerRemoteEventFrameFilter(factory: unknown) {
      registrations.push({ factory })
      return () => 'remote-disposed'
    },
  }
  const controlSeat = {
    registerControlFrameFilter(factory: unknown) {
      registrations.push({ factory })
      return () => 'control-disposed'
    },
  }

  it('registers on the remote-event seat and returns its disposer', () => {
    const dispose = applyRemoteEventFrameFilter(remoteSeat, deps, ['dsh-admin'])
    expect(registrations.length).toBe(1)
    expect(dispose()).toBe('remote-disposed')
  })

  it('registers on the control seat and returns its disposer', () => {
    const dispose = applyControlFrameFilter(controlSeat, deps, ['dsh-admin'])
    expect(registrations.length).toBe(1)
    expect(dispose()).toBe('control-disposed')
  })

  it('fails loud when the remote-event seat is missing (stale patch)', () => {
    expect(() => applyRemoteEventFrameFilter({}, deps, [])).toThrow(/registerRemoteEventFrameFilter/)
  })

  it('fails loud when the control seat is missing (stale patch)', () => {
    expect(() => applyControlFrameFilter({}, deps, [])).toThrow(/registerControlFrameFilter/)
  })

  it('hands each seat a working factory built from the shared judgment', () => {
    const owners = new Map<string, Owner>([['mine', alice]])
    const { deps: live } = makeDeps(owners)
    applyRemoteEventFrameFilter(remoteSeat, live, [])
    const { factory } = registrations[0] as { factory: (principal: unknown) => (sessionId: string, frameType: string) => boolean }
    const filter = factory(own())
    expect(filter('mine', 'waterfall')).toBe(true)
    expect(filter('bobs', 'waterfall')).toBe(false)
  })
})
