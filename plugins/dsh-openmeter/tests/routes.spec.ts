import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BudgetStore } from '../src/budget.ts'
import { resolveConfig } from '../src/config.ts'
import { emptyState } from '../src/store.ts'
import { UsageLedger } from '../src/ledger.ts'
import type { LedgerRow, UsageQuery } from '../src/ledger.ts'
import { mountRoutes } from '../src/routes.ts'
import type { RouteAuth, RouteDeps, RouteIdentity, WebServerLike } from '../src/routes.ts'
import type { BalanceGate } from '../src/gate.ts'
import type { Forwarder } from '../src/forwarder.ts'
import type { MeteringPipeline, UsageRow } from '../src/pipeline.ts'
import type { EntitlementValue, OpenMeterClient } from '../src/openmeter.ts'
import type { OperatorStore } from '../src/store.ts'
import type { PriceEstimator } from '../src/estimator.ts'
import type { MeteringWal } from '../src/wal.ts'

let ledgerDir: string | undefined

afterEach(async () => {
  if (ledgerDir === undefined) return
  await chmod(ledgerDir, 0o700).catch(() => {})
  try {
    await rm(ledgerDir, { recursive: true, force: true })
  } catch (error) {
    // Known macOS ENOTEMPTY tmpdir flake (repo-wide); one forced retry clears it.
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
    await rm(ledgerDir, { recursive: true, force: true })
  }
  ledgerDir = undefined
})

/** Every path mountRoutes registers. */
const ROUTES = [
  '/api/openmeter/status',
  '/api/openmeter/usage',
  '/api/openmeter/customers',
  '/api/openmeter/grants',
  '/api/openmeter/block',
  '/api/openmeter/bindings',
  '/api/openmeter/me/summary',
  '/api/openmeter/me/usage',
  '/api/openmeter/me/budget',
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

/**
 * The usage-detail route's own matrix over a REAL ledger (mkdtemp dir,
 * rows appended, closed in finally): the ledger seam must answer exactly
 * what UsageLedger.usagePage produces, scoped to the policy subject.
 */
describe('mountRoutes /me/usage tenant route', () => {
  /** Subject map extended with a second tenant for cross-tenant isolation. */
  const SUBJECTS_WITH_GLOBEX: Readonly<Record<string, string>> = { ...SUBJECTS, globex: 'cust-globex' }
  const GLOBEX_MEMBER: RouteIdentity = { tenantId: 'globex', userId: 'bob', displayName: 'Bob', roles: [] }

  const ZERO_STATS = {
    calls: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedAmountCny: 0,
    unpricedCalls: 0,
  }

  /** One ledger row; the default prices 0.0021 CNY over 100/40/5/3/2 dimensions. */
  function ledgerRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
    return {
      source: 'dsh-openmeter',
      eventId: 'evt-1',
      subject: 'cust-acme',
      capturedAt: 100,
      provider: 'deepseek',
      model: 'glm-5.3',
      tokens: 150,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
      estimatedAmount: 0.0021,
      currency: 'CNY',
      unpriced: false,
      ...overrides,
    }
  }

  async function openUsageLedger(): Promise<UsageLedger> {
    ledgerDir = await mkdtemp(join(tmpdir(), 'omroutes-'))
    return UsageLedger.open(ledgerDir)
  }

  /** Wrap one ledger so every usagePage query is recorded before delegating. */
  function recordingLedger(ledger: UsageLedger, queries: UsageQuery[]): Pick<UsageLedger, 'usagePage'> {
    return {
      usagePage: query => {
        queries.push(query)
        return ledger.usagePage(query)
      },
    }
  }

  /**
   * RouteDeps with the real ledger wired as the usage seam; other
   * collaborators stay the fakeDeps stubs (the route never touches them).
   */
  function usageDeps(auth: RouteAuth | undefined, usageLedger?: Pick<UsageLedger, 'usagePage'>): RouteDeps {
    const { deps } = fakeDeps(auth)
    return { ...deps, ...(usageLedger === undefined ? {} : { usageLedger }) }
  }

  it('returns 401 unauthenticated with no seam wired and when the identity source is absent (stock path never serves tenant data)', async () => {
    const ledger = await openUsageLedger()
    try {
      ledger.append(ledgerRow({ eventId: 'a1' }))
      const noSeam = fakeWebServer()
      mountRoutes(noSeam.webServer, usageDeps(undefined, ledger))
      const noSeamResult = await dispatch(noSeam.handlers, 'GET', '/api/openmeter/me/usage')
      expect(noSeamResult.status).toBe(401)
      expect(JSON.parse(noSeamResult.body)).toEqual({ ok: false, error: 'unauthenticated' })

      const offline = fakeWebServer()
      const offlineAuth: RouteAuth = { ...authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), available: () => false }
      mountRoutes(offline.webServer, usageDeps(offlineAuth, ledger))
      const offlineResult = await dispatch(offline.handlers, 'GET', '/api/openmeter/me/usage')
      expect(offlineResult.status).toBe(401)
      expect(JSON.parse(offlineResult.body)).toEqual({ ok: false, error: 'unauthenticated' })
    } finally {
      ledger.close()
    }
  })

  it('returns 403 tenant-unmapped for an authenticated tenant absent from the mapping', async () => {
    const ledger = await openUsageLedger()
    try {
      ledger.append(ledgerRow({ eventId: 'g1', subject: 'cust-globex' }))
      const server = fakeWebServer()
      mountRoutes(server.webServer, usageDeps(authSeam({ identity: GLOBEX_MEMBER, subjects: SUBJECTS })))
      const result = await dispatch(server.handlers, 'GET', '/api/openmeter/me/usage')
      expect(result.status).toBe(403)
      expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'tenant-unmapped' })
    } finally {
      ledger.close()
    }
  })

  it("serves a mapped member their own filtered journal: full row fields, page vs totals, policy-bound subject", async () => {
    const ledger = await openUsageLedger()
    try {
      ledger.append(ledgerRow({ eventId: 'a1', capturedAt: 100 }))
      ledger.append(ledgerRow({ eventId: 'a2', capturedAt: 200, model: 'glm-5.3-mini' }))
      ledger.append(ledgerRow({ eventId: 'a3', capturedAt: 300, estimatedAmount: 0.5, currency: 'USD', unpriced: true }))
      ledger.append(ledgerRow({ eventId: 'g1', capturedAt: 150, subject: 'cust-globex', tokens: 999 }))
      const queries: UsageQuery[] = []
      const server = fakeWebServer()
      mountRoutes(server.webServer, usageDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), recordingLedger(ledger, queries)))
      const result = await dispatch(server.handlers, 'GET', '/api/openmeter/me/usage?from=100&to=300&model=glm-5.3&limit=1')
      expect(result.status).toBe(200)
      const body = JSON.parse(result.body)
      // One full row: five token dimensions, money fields, unpriced flag.
      expect(body.rows).toEqual([{
        at: 300,
        provider: 'deepseek',
        model: 'glm-5.3',
        tokens: 150,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        reasoningTokens: 2,
        estimatedAmount: 0.5,
        currency: 'USD',
        unpriced: true,
      }])
      // Row identity stays internal: no source/eventId/subject keys.
      for (const key of ['source', 'eventId', 'subject']) {
        expect(Object.hasOwn(body.rows[0], key)).toBe(false)
      }
      // page aggregates only the returned row; totals the whole filtered set.
      expect(body.page).toEqual({ calls: 1, tokens: 150, inputTokens: 100, outputTokens: 40, cacheReadTokens: 5, cacheWriteTokens: 3, reasoningTokens: 2, estimatedAmountCny: 0, unpricedCalls: 1 })
      expect(body.totals).toEqual({ calls: 2, tokens: 300, inputTokens: 200, outputTokens: 80, cacheReadTokens: 10, cacheWriteTokens: 6, reasoningTokens: 4, estimatedAmountCny: 0.0021, unpricedCalls: 1 })
      // A full page carries the opaque cursor.
      expect(typeof body.cursor).toBe('string')
      // The ledger query is bound to the policy subject with the parsed filters.
      expect(queries).toEqual([{ subject: 'cust-acme', from: 100, to: 300, model: 'glm-5.3', limit: 1 }])
    } finally {
      ledger.close()
    }
  })

  it('answers 400 invalid-query for malformed values (strict, no coercion) while integer limits still clamp', async () => {
    const ledger = await openUsageLedger()
    try {
      ledger.append(ledgerRow({ eventId: 'a1' }))
      const server = fakeWebServer()
      mountRoutes(server.webServer, usageDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), ledger))
      const malformed = [
        '?from=abc',
        '?from=1.5',
        '?to=NaN',
        '?limit=abc',
        '?model=%20%20',
        '?cursor=',
        '?from=9007199254740993',
      ]
      for (const query of malformed) {
        const result = await dispatch(server.handlers, 'GET', `/api/openmeter/me/usage${query}`)
        expect(result.status, query).toBe(400)
        expect(JSON.parse(result.body), query).toEqual({ ok: false, error: 'invalid-query' })
      }
      // Integer out-of-range limits clamp (never 400): -5 floors to 1.
      const clamped = await dispatch(server.handlers, 'GET', '/api/openmeter/me/usage?limit=-5')
      expect(clamped.status).toBe(200)
      expect(JSON.parse(clamped.body).rows).toHaveLength(1)
    } finally {
      ledger.close()
    }
  })

  it('pins the route limit ceiling and default at the ledger seam: 999999 and 101 clamp to 100, an absent limit serves 50', async () => {
    const ledger = await openUsageLedger()
    try {
      ledger.append(ledgerRow({ eventId: 'a1' }))
      const queries: UsageQuery[] = []
      const server = fakeWebServer()
      mountRoutes(server.webServer, usageDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), recordingLedger(ledger, queries)))
      // Over-ceiling integers still answer a valid 200 page...
      for (const limit of ['999999', '101']) {
        const result = await dispatch(server.handlers, 'GET', `/api/openmeter/me/usage?limit=${limit}`)
        expect(result.status, `limit=${limit}`).toBe(200)
        expect(JSON.parse(result.body).rows, `limit=${limit}`).toHaveLength(1)
      }
      // ...and so does an omitted limit.
      const defaulted = await dispatch(server.handlers, 'GET', '/api/openmeter/me/usage')
      expect(defaulted.status).toBe(200)
      expect(JSON.parse(defaulted.body).rows).toHaveLength(1)
      // The queries that reached the ledger: the ROUTE ceiling (100, not the
      // ledger's own 1000) and the ROUTE default (50, not the ledger's 500).
      expect(queries).toEqual([
        { subject: 'cust-acme', limit: 100 },
        { subject: 'cust-acme', limit: 100 },
        { subject: 'cust-acme', limit: 50 },
      ])
    } finally {
      ledger.close()
    }
  })

  it('answers 400 invalid-query for a structurally-valid cursor the ledger rejects (defense-in-depth)', async () => {
    const ledger = await openUsageLedger()
    try {
      ledger.append(ledgerRow({ eventId: 'a1' }))
      const server = fakeWebServer()
      mountRoutes(server.webServer, usageDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), ledger))
      // "AAAA" is base64url alphabet and non-empty, so the strict parse
      // passes it through; it decodes to non-JSON bytes, so the LEDGER
      // throws LedgerQueryError and the route maps it to the client's 400.
      const result = await dispatch(server.handlers, 'GET', '/api/openmeter/me/usage?cursor=AAAA')
      expect(result.status).toBe(400)
      expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'invalid-query' })
    } finally {
      ledger.close()
    }
  })

  it('answers 400 subject-not-allowed when a subject or tenantId parameter is present, even empty', async () => {
    const ledger = await openUsageLedger()
    try {
      ledger.append(ledgerRow({ eventId: 'a1' }))
      const server = fakeWebServer()
      mountRoutes(server.webServer, usageDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), ledger))
      for (const query of ['?subject=cust-globex', '?tenantId=globex', '?subject=']) {
        const result = await dispatch(server.handlers, 'GET', `/api/openmeter/me/usage${query}`)
        expect(result.status, query).toBe(400)
        expect(JSON.parse(result.body), query).toEqual({ ok: false, error: 'subject-not-allowed' })
      }
    } finally {
      ledger.close()
    }
  })

  it('isolates tenants: each member reads only their own rows and totals; spoofed parameters never widen the scope', async () => {
    const ledger = await openUsageLedger()
    try {
      ledger.append(ledgerRow({ eventId: 'a1', capturedAt: 100, tokens: 10 }))
      ledger.append(ledgerRow({ eventId: 'a2', capturedAt: 300, tokens: 20 }))
      ledger.append(ledgerRow({ eventId: 'g1', capturedAt: 200, subject: 'cust-globex', tokens: 200 }))
      ledger.append(ledgerRow({ eventId: 'g2', capturedAt: 400, subject: 'cust-globex', tokens: 400 }))
      const acme = fakeWebServer()
      mountRoutes(acme.webServer, usageDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), ledger))
      const acmeResult = await dispatch(acme.handlers, 'GET', '/api/openmeter/me/usage')
      expect(acmeResult.status).toBe(200)
      const acmeBody = JSON.parse(acmeResult.body)
      expect(acmeBody.rows.map((row: { at: number }) => row.at)).toEqual([300, 100])
      // Money sums accumulate as floats, so the CNY field is asserted by
      // closeness (ledger-query.spec.ts precedent); every integer field is pinned.
      expect(acmeBody.totals).toMatchObject({ calls: 2, tokens: 30, inputTokens: 200, outputTokens: 80, cacheReadTokens: 10, cacheWriteTokens: 6, reasoningTokens: 4, unpricedCalls: 0 })
      expect(acmeBody.totals.estimatedAmountCny).toBeCloseTo(0.0042, 10)

      const globex = fakeWebServer()
      mountRoutes(globex.webServer, usageDeps(authSeam({ identity: GLOBEX_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), ledger))
      const globexResult = await dispatch(globex.handlers, 'GET', '/api/openmeter/me/usage')
      expect(globexResult.status).toBe(200)
      const globexBody = JSON.parse(globexResult.body)
      expect(globexBody.rows.map((row: { at: number }) => row.at)).toEqual([400, 200])
      expect(globexBody.totals).toMatchObject({ calls: 2, tokens: 600, inputTokens: 200, outputTokens: 80, cacheReadTokens: 10, cacheWriteTokens: 6, reasoningTokens: 4, unpricedCalls: 0 })
      expect(globexBody.totals.estimatedAmountCny).toBeCloseTo(0.0042, 10)

      // Spoofed scope selectors: unknown params are ignored, identity-named
      // ones are rejected — neither ever changes the acme scope.
      const ignored = await dispatch(acme.handlers, 'GET', '/api/openmeter/me/usage?tenant=globex&foo=1')
      expect(ignored.status).toBe(200)
      expect(JSON.parse(ignored.body).totals.tokens).toBe(30)
      const rejected = await dispatch(acme.handlers, 'GET', '/api/openmeter/me/usage?subject=cust-globex')
      expect(rejected.status).toBe(400)
      expect(JSON.parse(rejected.body)).toEqual({ ok: false, error: 'subject-not-allowed' })
    } finally {
      ledger.close()
    }
  })

  it('walks the full journal by cursor: every row exactly once, totals constant, no cursor on the last page', async () => {
    const ledger = await openUsageLedger()
    try {
      for (let i = 1; i <= 5; i++) {
        ledger.append(ledgerRow({ eventId: `e${i}`, capturedAt: i * 100, tokens: i }))
      }
      const server = fakeWebServer()
      mountRoutes(server.webServer, usageDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), ledger))
      const seen: number[] = []
      let query = '/api/openmeter/me/usage?limit=2'
      for (let page = 1; page <= 3; page++) {
        const result = await dispatch(server.handlers, 'GET', query)
        expect(result.status, `page ${page}`).toBe(200)
        const body = JSON.parse(result.body)
        seen.push(...body.rows.map((row: { at: number }) => row.at))
        expect(body.rows, `page ${page}`).toHaveLength(page < 3 ? 2 : 1)
        expect(body.totals, `page ${page}`).toMatchObject({ calls: 5, tokens: 15, inputTokens: 500, outputTokens: 200, cacheReadTokens: 25, cacheWriteTokens: 15, reasoningTokens: 10, unpricedCalls: 0 })
        expect(body.totals.estimatedAmountCny, `page ${page}`).toBeCloseTo(0.0105, 10)
        if (page < 3) {
          expect(typeof body.cursor, `page ${page}`).toBe('string')
          query = `/api/openmeter/me/usage?limit=2&cursor=${body.cursor}`
        } else {
          expect(Object.hasOwn(body, 'cursor'), 'last page').toBe(false)
        }
      }
      expect(seen).toEqual([500, 400, 300, 200, 100])
    } finally {
      ledger.close()
    }
  })

  it('answers 503 ledger-unavailable with no ledger wired, a throwing ledger, or a closed ledger — never leaking error text', async () => {
    const acme = authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX })
    const missing = fakeWebServer()
    mountRoutes(missing.webServer, usageDeps(acme))
    const missingResult = await dispatch(missing.handlers, 'GET', '/api/openmeter/me/usage')
    expect(missingResult.status).toBe(503)
    expect(JSON.parse(missingResult.body)).toEqual({ ok: false, error: 'ledger-unavailable' })

    const throwing = fakeWebServer()
    mountRoutes(throwing.webServer, usageDeps(acme, {
      usagePage: () => {
        throw new Error('sqlite boom')
      },
    }))
    const throwingResult = await dispatch(throwing.handlers, 'GET', '/api/openmeter/me/usage')
    expect(throwingResult.status).toBe(503)
    expect(JSON.parse(throwingResult.body)).toEqual({ ok: false, error: 'ledger-unavailable' })
    expect(throwingResult.body).not.toContain('sqlite boom')

    const ledger = await openUsageLedger()
    try {
      ledger.append(ledgerRow({ eventId: 'a1' }))
      ledger.close()
      const closed = fakeWebServer()
      mountRoutes(closed.webServer, usageDeps(acme, ledger))
      const closedResult = await dispatch(closed.handlers, 'GET', '/api/openmeter/me/usage')
      expect(closedResult.status).toBe(503)
      expect(JSON.parse(closedResult.body)).toEqual({ ok: false, error: 'ledger-unavailable' })
    } finally {
      ledger.close()
    }
  })

  it('answers 405 method-not-allowed for POST without touching the ledger', async () => {
    const ledger = await openUsageLedger()
    try {
      ledger.append(ledgerRow({ eventId: 'a1' }))
      const queries: UsageQuery[] = []
      const server = fakeWebServer()
      mountRoutes(server.webServer, usageDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), recordingLedger(ledger, queries)))
      const result = await dispatch(server.handlers, 'POST', '/api/openmeter/me/usage', '{}')
      expect(result.status).toBe(405)
      expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'method-not-allowed' })
      expect(queries).toEqual([])
    } finally {
      ledger.close()
    }
  })

  it('answers 200 with empty rows and all-zero stats for a mapped member with an empty ledger', async () => {
    const ledger = await openUsageLedger()
    try {
      const server = fakeWebServer()
      mountRoutes(server.webServer, usageDeps(authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), ledger))
      const result = await dispatch(server.handlers, 'GET', '/api/openmeter/me/usage')
      expect(result.status).toBe(200)
      const body = JSON.parse(result.body)
      expect(body).toEqual({ ok: true, rows: [], page: ZERO_STATS, totals: ZERO_STATS })
      expect(Object.hasOwn(body, 'cursor')).toBe(false)
    } finally {
      ledger.close()
    }
  })
})

/**
 * The budget route's own matrix over a REAL budget store and REAL usage
 * ledger (one mkdtemp dir, both sqlite files): GET is any mapped member's
 * read, PUT is the tenant manager's write, and neither ever accepts a
 * client-named tenant.
 */
describe('mountRoutes /me/budget tenant route', () => {
  /** Subject map extended with a second tenant for cross-tenant isolation. */
  const SUBJECTS_WITH_GLOBEX: Readonly<Record<string, string>> = { ...SUBJECTS, globex: 'cust-globex' }
  /** A mapped member holding a non-manager role: read-allowed, write-forbidden. */
  const MEMBER: RouteIdentity = { tenantId: 'acme', userId: 'alice', displayName: 'Alice', roles: ['member'] }
  /** A mapped tenant manager (owner role): read- and write-allowed. */
  const MANAGER: RouteIdentity = { tenantId: 'acme', userId: 'grace', displayName: 'Grace', roles: ['owner'] }
  const GLOBEX_MEMBER: RouteIdentity = { tenantId: 'globex', userId: 'bob', displayName: 'Bob', roles: ['owner'] }

  const BUDGET_PATH = '/api/openmeter/me/budget'

  /** One ledger row captured now (in-month by construction), CNY-priced by default. */
  function budgetRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
    return {
      source: 'dsh-openmeter',
      eventId: 'evt-1',
      subject: 'cust-acme',
      capturedAt: Date.now(),
      provider: 'deepseek',
      model: 'glm-5.3',
      tokens: 150,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
      estimatedAmount: 0.0021,
      currency: 'CNY',
      unpriced: false,
      ...overrides,
    }
  }

  /** One fresh tmpdir holding both a real usage ledger and a real budget store. */
  async function openBudgetStores(): Promise<{ ledger: UsageLedger, budgetStore: BudgetStore }> {
    ledgerDir = await mkdtemp(join(tmpdir(), 'ombudget-'))
    return { ledger: UsageLedger.open(ledgerDir), budgetStore: BudgetStore.open(ledgerDir) }
  }

  /**
   * RouteDeps with the real seams wired; either may be omitted to pin the
   * 503 path. Other collaborators stay the fakeDeps stubs.
   */
  function budgetDeps(auth: RouteAuth | undefined, budget?: Pick<BudgetStore, 'get' | 'set'>, usageLedger?: Pick<UsageLedger, 'usagePage'>): RouteDeps {
    const { deps } = fakeDeps(auth)
    return {
      ...deps,
      ...(budget === undefined ? {} : { budget }),
      ...(usageLedger === undefined ? {} : { usageLedger }),
    }
  }

  it('returns 401 unauthenticated for GET and PUT when no seam is wired or the identity source is absent', async () => {
    const { ledger, budgetStore } = await openBudgetStores()
    try {
      const noSeam = fakeWebServer()
      mountRoutes(noSeam.webServer, budgetDeps(undefined, budgetStore, ledger))
      const noSeamGet = await dispatch(noSeam.handlers, 'GET', BUDGET_PATH)
      expect(noSeamGet.status).toBe(401)
      expect(JSON.parse(noSeamGet.body)).toEqual({ ok: false, error: 'unauthenticated' })
      const noSeamPut = await dispatch(noSeam.handlers, 'PUT', BUDGET_PATH, '{"monthlyBudgetCny":100}')
      expect(noSeamPut.status).toBe(401)
      expect(JSON.parse(noSeamPut.body)).toEqual({ ok: false, error: 'unauthenticated' })

      const offline = fakeWebServer()
      const offlineAuth: RouteAuth = { ...authSeam({ identity: MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), available: () => false }
      mountRoutes(offline.webServer, budgetDeps(offlineAuth, budgetStore, ledger))
      const offlineGet = await dispatch(offline.handlers, 'GET', BUDGET_PATH)
      expect(offlineGet.status).toBe(401)
      expect(JSON.parse(offlineGet.body)).toEqual({ ok: false, error: 'unauthenticated' })
      expect(budgetStore.get('acme')).toBeNull()
    } finally {
      ledger.close()
      budgetStore.close()
    }
  })

  it('returns 403 tenant-unmapped for an authenticated tenant absent from the mapping', async () => {
    const server = fakeWebServer()
    mountRoutes(server.webServer, budgetDeps(authSeam({ identity: GLOBEX_MEMBER, subjects: SUBJECTS })))
    const result = await dispatch(server.handlers, 'GET', BUDGET_PATH)
    expect(result.status).toBe(403)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'tenant-unmapped' })
  })

  it("serves a plain member their own ready forecast: own-tenant spend only, CNY basis, projection present", async () => {
    const { ledger, budgetStore } = await openBudgetStores()
    try {
      budgetStore.set('acme', 100)
      ledger.append(budgetRow({ eventId: 'a1' }))
      ledger.append(budgetRow({ eventId: 'a2', estimatedAmount: 0.0042 }))
      ledger.append(budgetRow({ eventId: 'g1', subject: 'cust-globex', estimatedAmount: 999 }))
      const server = fakeWebServer()
      mountRoutes(server.webServer, budgetDeps(authSeam({ identity: MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), budgetStore, ledger))
      const result = await dispatch(server.handlers, 'GET', BUDGET_PATH)
      expect(result.status).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.ok).toBe(true)
      expect(body.availability).toBe('ready')
      expect(body.monthlyBudgetCny).toBe(100)
      // Only the two cust-acme CNY rows count; the globex 999 never lands.
      expect(body.monthToDateCny).toBeCloseTo(0.0063, 10)
      expect(typeof body.projectedMonthEndCny).toBe('number')
      expect(body.projectedOverageCny).toBe(0)
      // Basis month bounds match the UTC calendar month of now.
      const now = new Date()
      const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
      const daysInMonth = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - monthStartMs) / 86_400_000
      expect(body.basis).toMatchObject({ method: 'linear-daily-average', monthStartMs, daysInMonth, currency: 'CNY', spendSource: 'local-ledger-estimates' })
      expect(body.basis.daysElapsed).toBeGreaterThanOrEqual(1)
      expect(body.basis.daysElapsed).toBeLessThanOrEqual(daysInMonth)
    } finally {
      ledger.close()
      budgetStore.close()
    }
  })

  it('PUT as manager persists the budget: response carries it, follow-up GET returns it, a fresh store sees it', async () => {
    const { ledger, budgetStore } = await openBudgetStores()
    try {
      const server = fakeWebServer()
      mountRoutes(server.webServer, budgetDeps(authSeam({ identity: MANAGER, subjects: SUBJECTS_WITH_GLOBEX }), budgetStore, ledger))
      const before = await dispatch(server.handlers, 'GET', BUDGET_PATH)
      expect(before.status).toBe(200)
      expect(JSON.parse(before.body).availability).toBe('unconfigured')
      expect(Object.hasOwn(JSON.parse(before.body), 'projectedMonthEndCny')).toBe(false)

      const put = await dispatch(server.handlers, 'PUT', BUDGET_PATH, '{"monthlyBudgetCny":250}')
      expect(put.status).toBe(200)
      const putBody = JSON.parse(put.body)
      expect(putBody.ok).toBe(true)
      expect(putBody.monthlyBudgetCny).toBe(250)

      const after = await dispatch(server.handlers, 'GET', BUDGET_PATH)
      expect(after.status).toBe(200)
      expect(JSON.parse(after.body).monthlyBudgetCny).toBe(250)

      const reopened = BudgetStore.open(ledgerDir!)
      try {
        expect(reopened.get('acme')).toEqual({ amountCny: 250 })
      } finally {
        reopened.close()
      }
    } finally {
      ledger.close()
      budgetStore.close()
    }
  })

  it('publishes the caller role alongside the forecast: member GET false, manager GET and PUT true', async () => {
    const { ledger, budgetStore } = await openBudgetStores()
    try {
      budgetStore.set('acme', 100)
      const memberServer = fakeWebServer()
      mountRoutes(memberServer.webServer, budgetDeps(authSeam({ identity: MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), budgetStore, ledger))
      const memberGet = await dispatch(memberServer.handlers, 'GET', BUDGET_PATH)
      expect(memberGet.status).toBe(200)
      expect(JSON.parse(memberGet.body).canManageBudget).toBe(false)

      const managerServer = fakeWebServer()
      mountRoutes(managerServer.webServer, budgetDeps(authSeam({ identity: MANAGER, subjects: SUBJECTS_WITH_GLOBEX }), budgetStore, ledger))
      const managerGet = await dispatch(managerServer.handlers, 'GET', BUDGET_PATH)
      expect(managerGet.status).toBe(200)
      expect(JSON.parse(managerGet.body).canManageBudget).toBe(true)

      const managerPut = await dispatch(managerServer.handlers, 'PUT', BUDGET_PATH, '{"monthlyBudgetCny":120.5}')
      expect(managerPut.status).toBe(200)
      expect(JSON.parse(managerPut.body).canManageBudget).toBe(true)
    } finally {
      ledger.close()
      budgetStore.close()
    }
  })

  it('rejects a member PUT with 403 forbidden and writes nothing', async () => {
    const { ledger, budgetStore } = await openBudgetStores()
    try {
      const server = fakeWebServer()
      mountRoutes(server.webServer, budgetDeps(authSeam({ identity: MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), budgetStore, ledger))
      const result = await dispatch(server.handlers, 'PUT', BUDGET_PATH, '{"monthlyBudgetCny":500}')
      expect(result.status).toBe(403)
      expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'forbidden' })
      expect(budgetStore.get('acme')).toBeNull()
    } finally {
      ledger.close()
      budgetStore.close()
    }
  })

  it('answers 400 invalid-amount for zero, negative, over-cap, non-number, and sub-分 amounts; nothing written', async () => {
    const { ledger, budgetStore } = await openBudgetStores()
    try {
      const server = fakeWebServer()
      mountRoutes(server.webServer, budgetDeps(authSeam({ identity: MANAGER, subjects: SUBJECTS_WITH_GLOBEX }), budgetStore, ledger))
      const bodies = [
        '{"monthlyBudgetCny":0}',
        '{"monthlyBudgetCny":-5}',
        '{"monthlyBudgetCny":100000000.01}',
        '{"monthlyBudgetCny":"100"}',
        // Passes the route range check; the store's 分 representation rejects it.
        '{"monthlyBudgetCny":0.001}',
      ]
      for (const body of bodies) {
        const result = await dispatch(server.handlers, 'PUT', BUDGET_PATH, body)
        expect(result.status, body).toBe(400)
        expect(JSON.parse(result.body), body).toEqual({ ok: false, error: 'invalid-amount' })
      }
      expect(budgetStore.get('acme')).toBeNull()
    } finally {
      ledger.close()
      budgetStore.close()
    }
  })

  it('answers 400 invalid-body for malformed JSON, missing key, and cross-tenant keys; own budget unchanged', async () => {
    const { ledger, budgetStore } = await openBudgetStores()
    try {
      budgetStore.set('acme', 80)
      const server = fakeWebServer()
      mountRoutes(server.webServer, budgetDeps(authSeam({ identity: MANAGER, subjects: SUBJECTS_WITH_GLOBEX }), budgetStore, ledger))
      const bodies = [
        '{oops',
        '{}',
        '{"monthlyBudgetCny":100,"tenantId":"other-tenant"}',
        '{"monthlyBudgetCny":100,"subject":"steal"}',
      ]
      for (const body of bodies) {
        const result = await dispatch(server.handlers, 'PUT', BUDGET_PATH, body)
        expect(result.status, body).toBe(400)
        expect(JSON.parse(result.body), body).toEqual({ ok: false, error: 'invalid-body' })
      }
      expect(budgetStore.get('acme')).toEqual({ amountCny: 80 })
    } finally {
      ledger.close()
      budgetStore.close()
    }
  })

  it('answers 503 budget-unavailable when either seam is absent; a seamless PUT never writes', async () => {
    const { ledger, budgetStore } = await openBudgetStores()
    try {
      const noBudget = fakeWebServer()
      mountRoutes(noBudget.webServer, budgetDeps(authSeam({ identity: MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), undefined, ledger))
      const noBudgetGet = await dispatch(noBudget.handlers, 'GET', BUDGET_PATH)
      expect(noBudgetGet.status).toBe(503)
      expect(JSON.parse(noBudgetGet.body)).toEqual({ ok: false, error: 'budget-unavailable' })
      // Manager so the role gate passes and the seam check is what answers.
      const noBudgetPut = fakeWebServer()
      mountRoutes(noBudgetPut.webServer, budgetDeps(authSeam({ identity: MANAGER, subjects: SUBJECTS_WITH_GLOBEX }), undefined, ledger))
      const noBudgetPutResult = await dispatch(noBudgetPut.handlers, 'PUT', BUDGET_PATH, '{"monthlyBudgetCny":100}')
      expect(noBudgetPutResult.status).toBe(503)
      expect(JSON.parse(noBudgetPutResult.body)).toEqual({ ok: false, error: 'budget-unavailable' })

      const noLedger = fakeWebServer()
      mountRoutes(noLedger.webServer, budgetDeps(authSeam({ identity: MANAGER, subjects: SUBJECTS_WITH_GLOBEX }), budgetStore, undefined))
      const noLedgerGet = await dispatch(noLedger.handlers, 'GET', BUDGET_PATH)
      expect(noLedgerGet.status).toBe(503)
      expect(JSON.parse(noLedgerGet.body)).toEqual({ ok: false, error: 'budget-unavailable' })
      const noLedgerPut = await dispatch(noLedger.handlers, 'PUT', BUDGET_PATH, '{"monthlyBudgetCny":100}')
      expect(noLedgerPut.status).toBe(503)
      expect(JSON.parse(noLedgerPut.body)).toEqual({ ok: false, error: 'budget-unavailable' })
      // The budget seam was present and healthy, but no row was written.
      expect(budgetStore.get('acme')).toBeNull()
    } finally {
      ledger.close()
      budgetStore.close()
    }
  })

  it('PUT whose forecast load throws after a successful write answers 503 budget-unavailable and the budget stays saved', async () => {
    const { ledger, budgetStore } = await openBudgetStores()
    try {
      const throwingLedger: Pick<UsageLedger, 'usagePage'> = {
        usagePage: () => {
          throw new Error('ledger down')
        },
      }
      const server = fakeWebServer()
      mountRoutes(server.webServer, budgetDeps(authSeam({ identity: MANAGER, subjects: SUBJECTS_WITH_GLOBEX }), budgetStore, throwingLedger))
      const put = await dispatch(server.handlers, 'PUT', BUDGET_PATH, '{"monthlyBudgetCny":250}')
      expect(put.status).toBe(503)
      expect(JSON.parse(put.body)).toEqual({ ok: false, error: 'budget-unavailable' })
      expect(put.body).not.toContain('ledger down')

      // The write committed before the load failed: a fresh handle on the
      // same directory sees the row the route wrote.
      const reopened = BudgetStore.open(ledgerDir!)
      try {
        expect(reopened.get('acme')).toEqual({ amountCny: 250 })
      } finally {
        reopened.close()
      }

      // Read-side twin on the same throwing seam: opaque 503, GET included.
      const getResult = await dispatch(server.handlers, 'GET', BUDGET_PATH)
      expect(getResult.status).toBe(503)
      expect(JSON.parse(getResult.body)).toEqual({ ok: false, error: 'budget-unavailable' })
    } finally {
      ledger.close()
      budgetStore.close()
    }
  })

  it('answers 405 method-not-allowed for POST', async () => {
    const server = fakeWebServer()
    mountRoutes(server.webServer, budgetDeps(authSeam({ identity: MEMBER, subjects: SUBJECTS_WITH_GLOBEX })))
    const result = await dispatch(server.handlers, 'POST', BUDGET_PATH, '{}')
    expect(result.status).toBe(405)
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'method-not-allowed' })
  })

  it('GET with no budget row answers 200 unconfigured: spend and projection without fabricated budget fields', async () => {
    const { ledger, budgetStore } = await openBudgetStores()
    try {
      ledger.append(budgetRow({ eventId: 'a1' }))
      const server = fakeWebServer()
      mountRoutes(server.webServer, budgetDeps(authSeam({ identity: MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), budgetStore, ledger))
      const result = await dispatch(server.handlers, 'GET', BUDGET_PATH)
      expect(result.status).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.ok).toBe(true)
      expect(body.availability).toBe('unconfigured')
      expect(body.monthToDateCny).toBeCloseTo(0.0021, 10)
      expect(typeof body.projectedMonthEndCny).toBe('number')
      expect(Object.hasOwn(body, 'monthlyBudgetCny')).toBe(false)
      expect(Object.hasOwn(body, 'projectedOverageCny')).toBe(false)
    } finally {
      ledger.close()
      budgetStore.close()
    }
  })

  it('GET with a budget but no metered calls this month answers 200 insufficient-history without a projection', async () => {
    const { ledger, budgetStore } = await openBudgetStores()
    try {
      budgetStore.set('acme', 60)
      const server = fakeWebServer()
      mountRoutes(server.webServer, budgetDeps(authSeam({ identity: MEMBER, subjects: SUBJECTS_WITH_GLOBEX }), budgetStore, ledger))
      const result = await dispatch(server.handlers, 'GET', BUDGET_PATH)
      expect(result.status).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.ok).toBe(true)
      expect(body.availability).toBe('insufficient-history')
      expect(body.monthlyBudgetCny).toBe(60)
      expect(body.monthToDateCny).toBe(0)
      expect(Object.hasOwn(body, 'projectedMonthEndCny')).toBe(false)
      expect(Object.hasOwn(body, 'projectedOverageCny')).toBe(false)
    } finally {
      ledger.close()
      budgetStore.close()
    }
  })
})
