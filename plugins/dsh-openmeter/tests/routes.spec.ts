import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveConfig } from '../src/config.ts'
import { emptyState } from '../src/store.ts'
import { mountRoutes } from '../src/routes.ts'
import type { RouteAuth, RouteDeps, RouteIdentity, WebServerLike } from '../src/routes.ts'
import type { BalanceGate } from '../src/gate.ts'
import type { Forwarder } from '../src/forwarder.ts'
import type { MeteringPipeline, UsageRow } from '../src/pipeline.ts'
import type { EntitlementValue, OpenMeterClient } from '../src/openmeter.ts'
import type { OperatorStore } from '../src/store.ts'
import type { PriceEstimator } from '../src/estimator.ts'
import type { MeteringWal } from '../src/wal.ts'

/** Every path mountRoutes registers. */
const ROUTES = [
  '/api/openmeter/status',
  '/api/openmeter/usage',
  '/api/openmeter/customers',
  '/api/openmeter/grants',
  '/api/openmeter/block',
  '/api/openmeter/bindings',
  '/api/openmeter/me/summary',
]

/** The operator-maintained tenant → subject map used by the wired seam. */
const SUBJECTS: Readonly<Record<string, string>> = {
  acme: 'cust-acme',
  'dsh-ops': 'subject-dsh-ops',
}

const ACME_MEMBER: RouteIdentity = { tenantId: 'acme', userId: 'alice', displayName: 'Alice', roles: [] }
const ACME_MANAGER: RouteIdentity = { tenantId: 'acme', userId: 'grace', displayName: 'Grace', roles: ['owner'] }
const OPERATOR: RouteIdentity = { tenantId: 'dsh-ops', userId: 'root', displayName: 'Root', roles: ['dsh-admin'] }

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** Capture handlers keyed by path; unregister callbacks are recorded. */
function fakeWebServer(): { webServer: WebServerLike, handlers: Map<string, Handler>, unregistered: string[] } {
  const handlers = new Map<string, Handler>()
  const unregistered: string[] = []
  const webServer: WebServerLike = {
    register: route => {
      handlers.set(route.path, route.handler)
      return () => {
        handlers.delete(route.path)
        unregistered.push(route.path)
      }
    },
  }
  return { webServer, handlers, unregistered }
}

/** Minimal request satisfying http.ts GuardedRequest plus a JSON body. */
function fakeRequest(method: string, url: string, body?: string): IncomingMessage {
  const chunks: Buffer[] = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:38080' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

/** One recorded response; resolves on the first end(). */
function recordResponse(): { res: ServerResponse, recorded: Promise<{ status: number, body: string }> } {
  let settle!: (value: { status: number, body: string }) => void
  const recorded = new Promise<{ status: number, body: string }>(resolve => { settle = resolve })
  let status = 0
  const res = {
    writeHead: (code: number) => { status = code },
    end: (body: string) => { settle({ status, body }) },
  } as unknown as ServerResponse
  return { res, recorded }
}

/** Dispatch one request through the captured handler for its path. */
async function dispatch(handlers: Map<string, Handler>, method: string, url: string, body?: string): Promise<{ status: number, body: string }> {
  const handler = handlers.get(url.split('?')[0] ?? url)
  if (handler === undefined) throw new Error(`no route mounted for ${url}`)
  const { res, recorded } = recordResponse()
  handler(fakeRequest(method, url, body), res)
  return await Promise.race([
    recorded,
    new Promise<{ status: number, body: string }>(resolve => { setTimeout(() => resolve({ status: 0, body: '' }), 1_000) }),
  ])
}

/** A recording OpenMeter client: every method call lands in `calls`. */
function fakeClient(): { client: () => OpenMeterClient, calls: Array<{ method: string, args: unknown[] }> } {
  const calls: Array<{ method: string, args: unknown[] }> = []
  const client = {
    listCustomers: async () => {
      calls.push({ method: 'listCustomers', args: [] })
      return []
    },
    createCustomer: async (key: string, name: string) => {
      calls.push({ method: 'createCustomer', args: [key, name] })
      return { id: `id-${key}`, key, name }
    },
    entitlementValue: async (customerKey: string, featureKey: string) => {
      calls.push({ method: 'entitlementValue', args: [customerKey, featureKey] })
      return { hasAccess: true }
    },
    createGrant: async (customerKey: string, featureKey: string, input: unknown) => {
      calls.push({ method: 'createGrant', args: [customerKey, featureKey, input] })
    },
  } as unknown as OpenMeterClient
  return { client: () => client, calls }
}

/** RouteDeps with stub collaborators; auth omitted keeps stock behavior. */
function fakeDeps(auth?: RouteAuth): { deps: RouteDeps, calls: Array<{ method: string, args: unknown[] }> } {
  const { client, calls } = fakeClient()
  const deps: RouteDeps = {
    getConfig: () => resolveConfig({}),
    client,
    gate: {
      peek: () => undefined,
      refreshNow: async () => {},
      stats: () => ({ cacheSize: 0, lastQueryAt: 0, failOpenCount: 0, blockedCount: 0 }),
    } as unknown as BalanceGate,
    forwarder: {
      stats: () => ({ running: false, draining: false, lastDrainAt: 0, batchesSent: 0, eventsConfirmed: 0 }),
    } as unknown as Forwarder,
    pipeline: {
      usageRows: () => [],
      aggregates: () => [],
    } as unknown as MeteringPipeline,
    store: {
      snapshot: () => emptyState(),
      setManualBlock: async () => {},
      setBinding: async () => {},
      isManuallyBlocked: () => false,
    } as unknown as OperatorStore,
    estimator: {
      stats: () => ({ rows: 0, lastRefreshAt: 0 }),
    } as unknown as PriceEstimator,
    wal: {
      stats: () => ({ pending: 0, confirmedRecent: 0, total: 0, oldestPendingAt: 0, lastConfirmedAt: 0 }),
    } as unknown as MeteringWal,
    ...(auth === undefined ? {} : { auth }),
  }
  return { deps, calls }
}

/** A wired auth seam answering from fixed identities and subjects. */
function authSeam(options: { identity?: RouteIdentity, subjects?: Readonly<Record<string, string>> } = {}): RouteAuth {
  return {
    available: () => true,
    identityFromRequest: async () => options.identity,
    tenantSubjects: () => options.subjects ?? {},
  }
}

describe('mountRoutes tenant policy gate', () => {
  it('returns 401 unauthenticated when the wired seam resolves no identity', async () => {
    const server = fakeWebServer()
    const { deps, calls } = fakeDeps(authSeam({ subjects: SUBJECTS }))
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/status')
    expect(result.status).toBe(401)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'unauthenticated' })
    expect(calls).toEqual([])
  })

  it('returns 403 forbidden for a mapped member (not an operator) before any OpenMeter call', async () => {
    const server = fakeWebServer()
    const { deps, calls } = fakeDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS }))
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/customers')
    expect(result.status).toBe(403)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'forbidden' })
    expect(calls).toEqual([])
  })

  it('returns 403 forbidden for a tenant manager (isTenantManager but not isOperator)', async () => {
    const server = fakeWebServer()
    const { deps, calls } = fakeDeps(authSeam({ identity: ACME_MANAGER, subjects: SUBJECTS }))
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/customers')
    expect(result.status).toBe(403)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'forbidden' })
    expect(calls).toEqual([])
  })

  it('blocks cross-tenant grant bodies for member and manager, serves the operator', async () => {
    const grant = JSON.stringify({ customerKey: 'cust-globex', amount: 1 })

    const memberServer = fakeWebServer()
    const member = fakeDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS }))
    mountRoutes(memberServer.webServer, member.deps)
    const memberResult = await dispatch(memberServer.handlers, 'POST', '/api/openmeter/grants', grant)
    expect(memberResult.status).toBe(403)
    expect(JSON.parse(memberResult.body)).toEqual({ ok: false, error: 'forbidden' })
    expect(member.calls).toEqual([])

    const managerServer = fakeWebServer()
    const manager = fakeDeps(authSeam({ identity: ACME_MANAGER, subjects: SUBJECTS }))
    mountRoutes(managerServer.webServer, manager.deps)
    const managerResult = await dispatch(managerServer.handlers, 'POST', '/api/openmeter/grants', grant)
    expect(managerResult.status).toBe(403)
    expect(JSON.parse(managerResult.body)).toEqual({ ok: false, error: 'forbidden' })
    expect(manager.calls).toEqual([])

    const operatorServer = fakeWebServer()
    const operator = fakeDeps(authSeam({ identity: OPERATOR, subjects: SUBJECTS }))
    mountRoutes(operatorServer.webServer, operator.deps)
    const operatorResult = await dispatch(operatorServer.handlers, 'POST', '/api/openmeter/grants', grant)
    expect(operatorResult.status).toBe(201)
    expect(JSON.parse(operatorResult.body)).toEqual({ ok: true })
    expect(operator.calls).toEqual([{
      method: 'createGrant',
      args: ['cust-globex', 'dsh_llm', { amount: 1, effectiveAt: expect.any(String) }],
    }])
  })

  it('serves the operator the customers view after the gate passes', async () => {
    const server = fakeWebServer()
    const { deps, calls } = fakeDeps(authSeam({ identity: OPERATOR, subjects: SUBJECTS }))
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/customers')
    expect(result.status).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.ok).toBe(true)
    expect(body.customers).toEqual([])
    expect(body.houseSubject).toBe('house')
    expect(calls).toEqual([{ method: 'listCustomers', args: [] }])
  })

  it('returns 403 tenant-unmapped for a valid identity absent from the mapping (fail closed)', async () => {
    const server = fakeWebServer()
    const visitor: RouteIdentity = { tenantId: 'globex', userId: 'bob', displayName: 'Bob', roles: ['owner', 'dsh-admin'] }
    const { deps } = fakeDeps(authSeam({ identity: visitor, subjects: SUBJECTS }))
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/customers')
    expect(result.status).toBe(403)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'tenant-unmapped' })

    // The interim empty map (no mapping provisioned at all) fails closed too.
    const empty = fakeWebServer()
    const emptyDeps = fakeDeps(authSeam({ identity: OPERATOR, subjects: {} }))
    mountRoutes(empty.webServer, emptyDeps.deps)
    const emptyResult = await dispatch(empty.handlers, 'GET', '/api/openmeter/customers')
    expect(emptyResult.status).toBe(403)
    expect(JSON.parse(emptyResult.body)).toEqual({ ok: false, error: 'tenant-unmapped' })
  })

  it("keeps today's loopback-guarded behavior when no auth seam is wired", async () => {
    const server = fakeWebServer()
    const { deps } = fakeDeps()
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/status')
    expect(result.status).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.ok).toBe(true)
    expect(body.endpoint).toBe('http://127.0.0.1:8888')
    expect(body.houseSubject).toBe('house')
    expect(body.featureKey).toBe('dsh_llm')
    expect(body.meterSlug).toBe('dsh_llm_tokens')
    expect(body.quoteCurrency).toBe('CNY')
    expect(body.blockEnabled).toBe(true)
    expect(body.wal).toEqual({ pending: 0, confirmedRecent: 0, total: 0, oldestPendingAt: 0, lastConfirmedAt: 0 })
    expect(body.forwarder).toEqual({ running: false, draining: false, lastDrainAt: 0, batchesSent: 0, eventsConfirmed: 0 })
    expect(body.gate).toEqual({ cacheSize: 0, lastQueryAt: 0, failOpenCount: 0, blockedCount: 0 })
    expect(body.prices).toEqual({ rows: 0, lastRefreshAt: 0 })
  })

  it('ignores tenant/subject query parameters when resolving policy (spoof pin)', async () => {
    const server = fakeWebServer()
    const { deps, calls } = fakeDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS }))
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/status?tenant=globex&subject=cust-globex')
    expect(result.status).toBe(403)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'forbidden' })
    expect(calls).toEqual([])
  })

  it('degrades to 401 unauthenticated when the seam throws mid-resolution (fail closed)', async () => {
    const server = fakeWebServer()
    const auth: RouteAuth = {
      available: () => true,
      identityFromRequest: async () => ACME_MEMBER,
      tenantSubjects: () => {
        throw new Error('mapping store down')
      },
    }
    const { deps, calls } = fakeDeps(auth)
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/status')
    expect(result.status).toBe(401)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'unauthenticated' })
    expect(calls).toEqual([])
  })

  it('gates every mounted route: 401 with no identity, 403 for a mapped member', async () => {
    const routeCases: Array<{ method: string, path: string, body?: string }> = [
      { method: 'GET', path: '/api/openmeter/status' },
      { method: 'GET', path: '/api/openmeter/usage' },
      { method: 'GET', path: '/api/openmeter/customers' },
      { method: 'POST', path: '/api/openmeter/grants', body: JSON.stringify({ customerKey: 'cust-acme', amount: 1 }) },
      { method: 'POST', path: '/api/openmeter/block', body: JSON.stringify({ customerKey: 'cust-acme', blocked: true }) },
      { method: 'GET', path: '/api/openmeter/bindings' },
    ]
    const identities: Array<{ label: string, seam: () => RouteAuth, status: number, error: string }> = [
      { label: 'no identity', seam: () => authSeam({ subjects: SUBJECTS }), status: 401, error: 'unauthenticated' },
      { label: 'mapped member acme/alice', seam: () => authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS }), status: 403, error: 'forbidden' },
    ]
    for (const expected of identities) {
      for (const routeCase of routeCases) {
        const label = `${expected.label} ${routeCase.method} ${routeCase.path}`
        const server = fakeWebServer()
        const { deps, calls } = fakeDeps(expected.seam())
        mountRoutes(server.webServer, deps)
        const result = await dispatch(server.handlers, routeCase.method, routeCase.path, routeCase.body)
        expect(result.status, label).toBe(expected.status)
        expect(JSON.parse(result.body), label).toEqual({ ok: false, error: expected.error })
        expect(calls, label).toEqual([])
      }
    }
  })

  it('answers 500 internal when a handler collaborator throws instead of hanging', async () => {
    const server = fakeWebServer()
    const { deps, calls } = fakeDeps(authSeam({ identity: OPERATOR, subjects: SUBJECTS }))
    deps.wal = {
      stats: () => {
        throw new Error('wal offline')
      },
    } as unknown as MeteringWal
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/status')
    expect(result.status).toBe(500)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'internal' })
    expect(calls).toEqual([])
  })

  it('disposes every registered route', () => {
    const server = fakeWebServer()
    const { deps } = fakeDeps()
    const dispose = mountRoutes(server.webServer, deps)
    expect([...server.handlers.keys()].sort()).toEqual([...ROUTES].sort())
    dispose()
    expect(server.unregistered.sort()).toEqual([...ROUTES].sort())
    expect(server.handlers.size).toBe(0)
  })
})

/**
 * The tenant route's own gate matrix. The operator sweep above stays
 * untouched: /me/summary is NOT an operator surface, so a mapped member is
 * its happy path (200 with their own summary), not a 403.
 */
describe('mountRoutes /me/summary tenant route', () => {
  /** Subject map extended with a second tenant for cross-tenant isolation. */
  const SUBJECTS_WITH_GLOBEX: Readonly<Record<string, string>> = { ...SUBJECTS, globex: 'cust-globex' }
  const GLOBEX_MEMBER: RouteIdentity = { tenantId: 'globex', userId: 'bob', displayName: 'Bob', roles: [] }

  /** One local ring row; billed tokens are 1000+200=1200 per row by default. */
  function summaryRow(overrides: { subject?: string, estimatedAmount?: number, currency?: string } = {}): UsageRow {
    return {
      sessionId: 'session-1',
      subject: overrides.subject ?? 'cust-acme',
      provider: 'deepseek',
      model: 'deepseek-chat',
      usage: { inputTokens: 1000, outputTokens: 200 },
      estimatedAmount: overrides.estimatedAmount ?? 1,
      currency: overrides.currency ?? 'CNY',
      unpriced: false,
      at: Date.now() - 60_000,
    }
  }

  /**
   * RouteDeps whose ring and entitlement client are controllable and
   * recorded for /me/summary assertions; other collaborators stay stock.
   */
  function summaryDeps(options: {
    auth?: RouteAuth
    rows?: readonly UsageRow[]
    entitlement?: (subject: string) => Promise<EntitlementValue>
  } = {}): { deps: RouteDeps, entitlementCalls: string[][], ringLimits: Array<number | undefined> } {
    const { deps } = fakeDeps(options.auth)
    const entitlementCalls: string[][] = []
    const ringLimits: Array<number | undefined> = []
    deps.pipeline = {
      usageRows: (limit?: number) => {
        ringLimits.push(limit)
        return [...(options.rows ?? [])]
      },
      aggregates: () => [],
    } as unknown as MeteringPipeline
    const client = {
      entitlementValue: async (subject: string, featureKey: string): Promise<EntitlementValue> => {
        entitlementCalls.push([subject, featureKey])
        if (options.entitlement !== undefined) return options.entitlement(subject)
        return { hasAccess: true, balance: 5000 }
      },
    } as unknown as OpenMeterClient
    deps.client = () => client
    return { deps, entitlementCalls, ringLimits }
  }

  it('returns 401 unauthenticated when the wired seam resolves no identity', async () => {
    const server = fakeWebServer()
    const { deps, entitlementCalls, ringLimits } = summaryDeps({ auth: authSeam({ subjects: SUBJECTS }), rows: [summaryRow()] })
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/me/summary')
    expect(result.status).toBe(401)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'unauthenticated' })
    expect(entitlementCalls).toEqual([])
    expect(ringLimits).toEqual([])
  })

  it("serves a mapped member only their own tenant's summary", async () => {
    const server = fakeWebServer()
    const rows = [
      summaryRow({ subject: 'cust-acme', estimatedAmount: 1.5 }),
      summaryRow({ subject: 'cust-acme', estimatedAmount: 0.5, currency: 'USD' }),
      summaryRow({ subject: 'cust-globex', estimatedAmount: 99 }),
    ]
    const { deps, entitlementCalls, ringLimits } = summaryDeps({ auth: authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS }), rows })
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/me/summary')
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({
      ok: true,
      availability: 'ready',
      tenantId: 'acme',
      subject: 'cust-acme',
      availableTokens: 5000,
      hasAccess: true,
      usageTokens7d: 2400,
      estimatedCny7d: 1.5,
      asOf: expect.any(Number),
    })
    // The entitlement seam is asked only for the resolved subject + feature key.
    expect(entitlementCalls).toEqual([['cust-acme', 'dsh_llm']])
    // The full ring (cap 500) feeds the 7-day window, not the 100 default.
    expect(ringLimits).toEqual([500])
  })

  it('answers 200 with a safe unavailable state when OpenMeter rejects, local aggregates intact', async () => {
    const server = fakeWebServer()
    const { deps } = summaryDeps({
      auth: authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS }),
      rows: [summaryRow({ estimatedAmount: 3.5 })],
      entitlement: () => Promise.reject(new Error('openmeter GET /api/v2/entitlements -> 503: secret-boom')),
    })
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/me/summary')
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({
      ok: true,
      availability: 'unavailable',
      tenantId: 'acme',
      subject: 'cust-acme',
      usageTokens7d: 1200,
      estimatedCny7d: 3.5,
      asOf: expect.any(Number),
    })
    const body = JSON.parse(result.body)
    expect(Object.hasOwn(body, 'availableTokens')).toBe(false)
    expect(Object.hasOwn(body, 'hasAccess')).toBe(false)
    expect(result.body).not.toContain('503')
    expect(result.body).not.toContain('secret-boom')
  })

  it('returns 403 tenant-unmapped for an authenticated tenant absent from the mapping', async () => {
    const server = fakeWebServer()
    const { deps, entitlementCalls, ringLimits } = summaryDeps({ auth: authSeam({ identity: GLOBEX_MEMBER, subjects: SUBJECTS }) })
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/me/summary')
    expect(result.status).toBe(403)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'tenant-unmapped' })
    expect(entitlementCalls).toEqual([])
    expect(ringLimits).toEqual([])
  })

  it('degrades to 401 unauthenticated when the seam throws mid-resolution (fail closed)', async () => {
    const server = fakeWebServer()
    const auth: RouteAuth = {
      available: () => true,
      identityFromRequest: async () => ACME_MEMBER,
      tenantSubjects: () => {
        throw new Error('mapping store down')
      },
    }
    const { deps, entitlementCalls } = summaryDeps({ auth })
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/me/summary')
    expect(result.status).toBe(401)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'unauthenticated' })
    expect(entitlementCalls).toEqual([])
  })

  it('does not serve tenant data on the stock loopback path when no seam is wired', async () => {
    const noSeam = fakeWebServer()
    const noSeamHarness = summaryDeps({ rows: [summaryRow()] })
    mountRoutes(noSeam.webServer, noSeamHarness.deps)
    const noSeamResult = await dispatch(noSeam.handlers, 'GET', '/api/openmeter/me/summary')
    expect(noSeamResult.status).toBe(401)
    expect(JSON.parse(noSeamResult.body)).toEqual({ ok: false, error: 'unauthenticated' })
    expect(noSeamHarness.entitlementCalls).toEqual([])
    expect(noSeamHarness.ringLimits).toEqual([])

    // A seam whose identity source is absent at request time behaves the same:
    // /me is meaningless without an identity to scope to.
    const offline = fakeWebServer()
    const offlineAuth: RouteAuth = { ...authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS }), available: () => false }
    const offlineHarness = summaryDeps({ auth: offlineAuth, rows: [summaryRow()] })
    mountRoutes(offline.webServer, offlineHarness.deps)
    const offlineResult = await dispatch(offline.handlers, 'GET', '/api/openmeter/me/summary')
    expect(offlineResult.status).toBe(401)
    expect(JSON.parse(offlineResult.body)).toEqual({ ok: false, error: 'unauthenticated' })
    expect(offlineHarness.entitlementCalls).toEqual([])
    expect(offlineHarness.ringLimits).toEqual([])
  })

  it('answers 405 method-not-allowed for POST', async () => {
    const server = fakeWebServer()
    const { deps, entitlementCalls, ringLimits } = summaryDeps({ auth: authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS }), rows: [summaryRow()] })
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'POST', '/api/openmeter/me/summary', '{}')
    expect(result.status).toBe(405)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'method-not-allowed' })
    expect(entitlementCalls).toEqual([])
    expect(ringLimits).toEqual([])
  })

  it('ignores tenant/subject query parameters when resolving the summary (spoof pin)', async () => {
    const server = fakeWebServer()
    const { deps, entitlementCalls } = summaryDeps({ auth: authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), rows: [summaryRow({ estimatedAmount: 2 })] })
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/me/summary?tenant=globex&subject=cust-globex')
    expect(result.status).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.subject).toBe('cust-acme')
    expect(body.tenantId).toBe('acme')
    expect(entitlementCalls).toEqual([['cust-acme', 'dsh_llm']])
  })

  it("isolates tenants: a globex member reads only globex's subject and numbers", async () => {
    const server = fakeWebServer()
    const rows = [
      summaryRow({ subject: 'cust-acme', estimatedAmount: 7 }),
      summaryRow({ subject: 'cust-globex', estimatedAmount: 4 }),
      summaryRow({ subject: 'cust-globex', estimatedAmount: 1, currency: 'USD' }),
    ]
    const { deps, entitlementCalls } = summaryDeps({
      auth: authSeam({ identity: GLOBEX_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }),
      rows,
      entitlement: subject => Promise.resolve({ hasAccess: true, balance: subject === 'cust-acme' ? 111 : 222 }),
    })
    mountRoutes(server.webServer, deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/me/summary')
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({
      ok: true,
      availability: 'ready',
      tenantId: 'globex',
      subject: 'cust-globex',
      availableTokens: 222,
      hasAccess: true,
      usageTokens7d: 2400,
      estimatedCny7d: 4,
      asOf: expect.any(Number),
    })
    expect(entitlementCalls).toEqual([['cust-globex', 'dsh_llm']])
  })
})
