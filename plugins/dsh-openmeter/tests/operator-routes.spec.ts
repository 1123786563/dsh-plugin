import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveConfig } from '../src/config.ts'
import { emptyState } from '../src/store.ts'
import { mountRoutes } from '../src/routes.ts'
import type { RouteAuth, RouteDeps, RouteIdentity, WebServerLike } from '../src/routes.ts'
import type { BalanceGate } from '../src/gate.ts'
import type { Forwarder } from '../src/forwarder.ts'
import type { MeteringPipeline } from '../src/pipeline.ts'
import type { OpenMeterClient } from '../src/openmeter.ts'
import type { OperatorStore } from '../src/store.ts'
import type { PriceEstimator } from '../src/estimator.ts'
import type { MeteringWal } from '../src/wal.ts'

/** The Issue #9 operator prefix every cashier surface moved under. */
const OP_CUSTOMERS = '/api/openmeter/operator/customers'
const OP_GRANTS = '/api/openmeter/operator/grants'
const OP_BLOCK = '/api/openmeter/operator/block'
const OP_BINDINGS = '/api/openmeter/operator/bindings'

/** The operator-maintained tenant → subject map used by the wired seam. */
const SUBJECTS: Readonly<Record<string, string>> = {
  acme: 'cust-acme',
  'dsh-ops': 'subject-dsh-ops',
}

const ACME_MEMBER: RouteIdentity = { tenantId: 'acme', userId: 'alice', displayName: 'Alice', roles: [] }
const ACME_MANAGER: RouteIdentity = { tenantId: 'acme', userId: 'grace', displayName: 'Grace', roles: ['owner'] }
const OPERATOR: RouteIdentity = { tenantId: 'dsh-ops', userId: 'root', displayName: 'Root', roles: ['dsh-admin'] }

/** The audit actor an online seam derives from the OPERATOR identity. */
const OPERATOR_ACTOR = { tenantId: 'dsh-ops', userId: 'root' }

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** Capture handlers keyed by path; unregister callbacks are recorded. */
function fakeWebServer(): { webServer: WebServerLike, handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const webServer: WebServerLike = {
    register: route => {
      handlers.set(route.path, route.handler)
      return () => {
        handlers.delete(route.path)
      }
    },
  }
  return { webServer, handlers }
}

/** Minimal request satisfying http.ts GuardedRequest plus a JSON body. */
function fakeRequest(method: string, url: string, body?: string, remoteAddress = '127.0.0.1'): IncomingMessage {
  const chunks: Buffer[] = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:38080' },
    socket: { remoteAddress },
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
async function dispatch(
  handlers: Map<string, Handler>,
  method: string,
  url: string,
  body?: string,
  remoteAddress?: string,
): Promise<{ status: number, body: string }> {
  const handler = handlers.get(url.split('?')[0] ?? url)
  if (handler === undefined) throw new Error(`no route mounted for ${url}`)
  const { res, recorded } = recordResponse()
  handler(fakeRequest(method, url, body, remoteAddress), res)
  return await Promise.race([
    recorded,
    new Promise<{ status: number, body: string }>(resolve => { setTimeout(() => resolve({ status: 0, body: '' }), 1_000) }),
  ])
}

/** Every operator-path method/path case the gate must reject uniformly. */
const OPERATOR_CASES: Array<{ method: string, path: string, body?: string }> = [
  { method: 'GET', path: OP_CUSTOMERS },
  { method: 'POST', path: OP_CUSTOMERS, body: '{"key":"cust-acme"}' },
  { method: 'POST', path: OP_GRANTS, body: '{"customerKey":"cust-acme","amount":1}' },
  { method: 'POST', path: OP_BLOCK, body: '{"customerKey":"cust-acme","blocked":true}' },
  { method: 'GET', path: OP_BINDINGS },
  { method: 'POST', path: OP_BINDINGS, body: '{"presetId":"p1","customerKey":"cust-acme"}' },
]

/**
 * RouteDeps with recording collaborators: every OpenMeter call, store write,
 * and gate refresh lands in the returned arrays; auth omitted keeps the stock
 * loopback path.
 */
function operatorDeps(auth?: RouteAuth): {
  deps: RouteDeps
  clientCalls: Array<{ method: string, args: unknown[] }>
  storeCalls: Array<{ method: string, args: unknown[] }>
  refreshed: string[][]
} {
  const clientCalls: Array<{ method: string, args: unknown[] }> = []
  const storeCalls: Array<{ method: string, args: unknown[] }> = []
  const refreshed: string[][] = []
  const client = {
    listCustomers: async () => {
      clientCalls.push({ method: 'listCustomers', args: [] })
      return []
    },
    createCustomer: async (key: string, name: string) => {
      clientCalls.push({ method: 'createCustomer', args: [key, name] })
      return { id: `id-${key}`, key, name }
    },
    entitlementValue: async (customerKey: string, featureKey: string) => {
      clientCalls.push({ method: 'entitlementValue', args: [customerKey, featureKey] })
      return { hasAccess: true }
    },
    createGrant: async (customerKey: string, featureKey: string, input: unknown) => {
      clientCalls.push({ method: 'createGrant', args: [customerKey, featureKey, input] })
    },
  } as unknown as OpenMeterClient
  const deps: RouteDeps = {
    getConfig: () => resolveConfig({}),
    client: () => client,
    gate: {
      peek: () => undefined,
      refreshNow: async (subjects: readonly string[]) => {
        refreshed.push([...subjects])
      },
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
      setManualBlock: async (customerKey: string, blocked: boolean) => {
        storeCalls.push({ method: 'setManualBlock', args: [customerKey, blocked] })
      },
      setBinding: async (presetId: string, customerKey: string) => {
        storeCalls.push({ method: 'setBinding', args: [presetId, customerKey] })
      },
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
  return { deps, clientCalls, storeCalls, refreshed }
}

/** A wired auth seam answering from fixed identities and subjects. */
function authSeam(options: { identity?: RouteIdentity, subjects?: Readonly<Record<string, string>> } = {}): RouteAuth {
  return {
    available: () => true,
    identityFromRequest: async () => options.identity,
    tenantSubjects: () => options.subjects ?? {},
  }
}

describe('mountRoutes operator surfaces: per-action success with audit', () => {
  it('answers each mutation with its audit record and the actor resolved by the seam', async () => {
    const server = fakeWebServer()
    const h = operatorDeps(authSeam({ identity: OPERATOR, subjects: SUBJECTS }))
    mountRoutes(server.webServer, h.deps)

    const created = await dispatch(server.handlers, 'POST', OP_CUSTOMERS, '{"key":"cust-acme","name":"Acme"}')
    expect(created.status).toBe(201)
    expect(JSON.parse(created.body)).toEqual({
      ok: true,
      customer: { id: 'id-cust-acme', key: 'cust-acme', name: 'Acme' },
      audit: { action: 'customer.create', target: 'cust-acme', at: expect.any(Number), actor: OPERATOR_ACTOR },
    })

    const grant = await dispatch(server.handlers, 'POST', OP_GRANTS, '{"customerKey":"cust-acme","amount":5}')
    expect(grant.status).toBe(201)
    expect(JSON.parse(grant.body)).toEqual({
      ok: true,
      audit: { action: 'grant.create', target: 'cust-acme', at: expect.any(Number), actor: OPERATOR_ACTOR },
    })

    const block = await dispatch(server.handlers, 'POST', OP_BLOCK, '{"customerKey":"cust-acme","blocked":true}')
    expect(block.status).toBe(200)
    expect(JSON.parse(block.body)).toEqual({
      ok: true,
      audit: { action: 'block.set', target: 'cust-acme', at: expect.any(Number), actor: OPERATOR_ACTOR },
    })

    const binding = await dispatch(server.handlers, 'POST', OP_BINDINGS, '{"presetId":"p1","customerKey":"cust-acme"}')
    expect(binding.status).toBe(200)
    expect(JSON.parse(binding.body)).toEqual({
      ok: true,
      audit: { action: 'binding.set', target: { presetId: 'p1', customerKey: 'cust-acme' }, at: expect.any(Number), actor: OPERATOR_ACTOR },
    })

    expect(h.clientCalls).toEqual([
      { method: 'createCustomer', args: ['cust-acme', 'Acme'] },
      { method: 'createGrant', args: ['cust-acme', 'dsh_llm', { amount: 5, effectiveAt: expect.any(String) }] },
    ])
    expect(h.storeCalls).toEqual([
      { method: 'setManualBlock', args: ['cust-acme', true] },
      { method: 'setBinding', args: ['p1', 'cust-acme'] },
    ])
    expect(h.refreshed).toEqual([['cust-acme'], ['cust-acme'], ['cust-acme']])
  })

  it('keeps the stock loopback path: audit without actor, never a fabricated identity', async () => {
    const server = fakeWebServer()
    const h = operatorDeps()
    mountRoutes(server.webServer, h.deps)

    const created = await dispatch(server.handlers, 'POST', OP_CUSTOMERS, '{"key":"cust-x"}')
    expect(created.status).toBe(201)
    let audit = JSON.parse(created.body).audit
    expect(audit).toEqual({ action: 'customer.create', target: 'cust-x', at: expect.any(Number) })
    expect(Object.hasOwn(audit, 'actor')).toBe(false)

    const grant = await dispatch(server.handlers, 'POST', OP_GRANTS, '{"customerKey":"cust-x","amount":1}')
    expect(grant.status).toBe(201)
    audit = JSON.parse(grant.body).audit
    expect(audit).toEqual({ action: 'grant.create', target: 'cust-x', at: expect.any(Number) })
    expect(Object.hasOwn(audit, 'actor')).toBe(false)

    const block = await dispatch(server.handlers, 'POST', OP_BLOCK, '{"customerKey":"cust-x","blocked":false}')
    expect(block.status).toBe(200)
    audit = JSON.parse(block.body).audit
    expect(audit).toEqual({ action: 'block.set', target: 'cust-x', at: expect.any(Number) })
    expect(Object.hasOwn(audit, 'actor')).toBe(false)

    const binding = await dispatch(server.handlers, 'POST', OP_BINDINGS, '{"presetId":"p1","customerKey":""}')
    expect(binding.status).toBe(200)
    audit = JSON.parse(binding.body).audit
    expect(audit).toEqual({ action: 'binding.set', target: { presetId: 'p1', customerKey: '' }, at: expect.any(Number) })
    expect(Object.hasOwn(audit, 'actor')).toBe(false)
  })

  it('leaves GET responses unchanged: no audit, list payloads byte-compatible', async () => {
    const server = fakeWebServer()
    const h = operatorDeps(authSeam({ identity: OPERATOR, subjects: SUBJECTS }))
    mountRoutes(server.webServer, h.deps)

    const customers = await dispatch(server.handlers, 'GET', OP_CUSTOMERS)
    expect(customers.status).toBe(200)
    expect(JSON.parse(customers.body)).toEqual({ ok: true, customers: [], houseSubject: 'house' })

    const bindings = await dispatch(server.handlers, 'GET', OP_BINDINGS)
    expect(bindings.status).toBe(200)
    expect(JSON.parse(bindings.body)).toEqual({ ok: true, bindings: {}, observedPresets: [], houseSubject: 'house' })
  })

  it('keeps the verbatim 400 error codes for invalid mutation bodies', async () => {
    const server = fakeWebServer()
    const h = operatorDeps(authSeam({ identity: OPERATOR, subjects: SUBJECTS }))
    mountRoutes(server.webServer, h.deps)

    // create-customer keeps its inline key check.
    const longKey = `{"key":"${'x'.repeat(65)}"}`
    for (const body of ['{}', '{"key":"  "}', '{"key":"bad key!"}', longKey]) {
      const created = await dispatch(server.handlers, 'POST', OP_CUSTOMERS, body)
      expect(created.status, body).toBe(400)
      expect(JSON.parse(created.body), body).toEqual({ ok: false, error: 'invalid-key' })
    }

    // grant: empty/missing target or bad amount → invalid-grant.
    for (const body of ['{}', '{"customerKey":"  ","amount":1}', '{"customerKey":"c"}', '{"customerKey":"c","amount":0}', '{"customerKey":"c","amount":"abc"}']) {
      const grant = await dispatch(server.handlers, 'POST', OP_GRANTS, body)
      expect(grant.status, body).toBe(400)
      expect(JSON.parse(grant.body), body).toEqual({ ok: false, error: 'invalid-grant' })
    }

    // block: empty/missing target → invalid-customer.
    for (const body of ['{}', '{"customerKey":"  ","blocked":true}']) {
      const block = await dispatch(server.handlers, 'POST', OP_BLOCK, body)
      expect(block.status, body).toBe(400)
      expect(JSON.parse(block.body), body).toEqual({ ok: false, error: 'invalid-customer' })
    }

    // bindings: empty/missing presetId → invalid-preset.
    for (const body of ['{}', '{"presetId":"  ","customerKey":"c"}']) {
      const binding = await dispatch(server.handlers, 'POST', OP_BINDINGS, body)
      expect(binding.status, body).toBe(400)
      expect(JSON.parse(binding.body), body).toEqual({ ok: false, error: 'invalid-preset' })
    }

    expect(h.clientCalls).toEqual([])
    expect(h.storeCalls).toEqual([])
    expect(h.refreshed).toEqual([])
  })
})

describe('mountRoutes operator surfaces: role gate', () => {
  it('rejects member and manager on every operator path with 403 forbidden before any collaborator call', async () => {
    for (const identity of [ACME_MEMBER, ACME_MANAGER]) {
      for (const routeCase of OPERATOR_CASES) {
        const label = `${identity.userId} ${routeCase.method} ${routeCase.path}`
        const server = fakeWebServer()
        const h = operatorDeps(authSeam({ identity, subjects: SUBJECTS }))
        mountRoutes(server.webServer, h.deps)
        const result = await dispatch(server.handlers, routeCase.method, routeCase.path, routeCase.body)
        expect(result.status, label).toBe(403)
        expect(JSON.parse(result.body), label).toEqual({ ok: false, error: 'forbidden' })
        expect(h.clientCalls, label).toEqual([])
        expect(h.storeCalls, label).toEqual([])
        expect(h.refreshed, label).toEqual([])
      }
    }
  })

  it('answers 401 unauthenticated on every operator path when the seam resolves no identity', async () => {
    for (const routeCase of OPERATOR_CASES) {
      const label = `anonymous ${routeCase.method} ${routeCase.path}`
      const server = fakeWebServer()
      const h = operatorDeps(authSeam({ subjects: SUBJECTS }))
      mountRoutes(server.webServer, h.deps)
      const result = await dispatch(server.handlers, routeCase.method, routeCase.path, routeCase.body)
      expect(result.status, label).toBe(401)
      expect(JSON.parse(result.body), label).toEqual({ ok: false, error: 'unauthenticated' })
      expect(h.clientCalls, label).toEqual([])
    }
  })

  it('degrades to 401 unauthenticated on every operator path when the seam throws mid-resolution', async () => {
    const auth: RouteAuth = {
      available: () => true,
      identityFromRequest: async () => OPERATOR,
      tenantSubjects: () => {
        throw new Error('mapping store down')
      },
    }
    for (const routeCase of OPERATOR_CASES) {
      const label = `seam failure ${routeCase.method} ${routeCase.path}`
      const server = fakeWebServer()
      const h = operatorDeps(auth)
      mountRoutes(server.webServer, h.deps)
      const result = await dispatch(server.handlers, routeCase.method, routeCase.path, routeCase.body)
      expect(result.status, label).toBe(401)
      expect(JSON.parse(result.body), label).toEqual({ ok: false, error: 'unauthenticated' })
      expect(h.clientCalls, label).toEqual([])
    }
  })

  it('rejects a member cross-tenant target with byte-identical 403 whether the target exists or not', async () => {
    for (const customerKey of ['cust-globex', 'nope-does-not-exist']) {
      const server = fakeWebServer()
      const h = operatorDeps(authSeam({ identity: ACME_MEMBER, subjects: { ...SUBJECTS, globex: 'cust-globex' } }))
      mountRoutes(server.webServer, h.deps)
      const grant = await dispatch(server.handlers, 'POST', OP_GRANTS, JSON.stringify({ customerKey, amount: 1 }))
      expect(grant.status, customerKey).toBe(403)
      expect(grant.body, customerKey).toBe('{"ok":false,"error":"forbidden"}')
      expect(h.clientCalls, customerKey).toEqual([])
      expect(h.storeCalls, customerKey).toEqual([])
    }
  })
})

describe('mountRoutes retired global cashier paths', () => {
  /** The verbatim 410 body each retired path answers. */
  const MIGRATED_BODY = (segment: string): string =>
    `{"ok":false,"error":"route-migrated","to":"/api/openmeter/operator/${segment}"}`

  const LEGACY: Array<{ old: string, segment: string, postBody: string }> = [
    { old: '/api/openmeter/customers', segment: 'customers', postBody: '{"key":"x"}' },
    { old: '/api/openmeter/grants', segment: 'grants', postBody: '{"customerKey":"c","amount":1}' },
    { old: '/api/openmeter/block', segment: 'block', postBody: '{"customerKey":"c","blocked":true}' },
    { old: '/api/openmeter/bindings', segment: 'bindings', postBody: '{"presetId":"p","customerKey":"c"}' },
  ]

  it('answers 410 route-migrated for GET and POST on every legacy path, body verbatim, for every identity', async () => {
    const seams: Array<{ label: string, auth: RouteAuth | undefined }> = [
      { label: 'stock loopback', auth: undefined },
      { label: 'operator', auth: authSeam({ identity: OPERATOR, subjects: SUBJECTS }) },
      { label: 'member', auth: authSeam({ identity: ACME_MEMBER, subjects: SUBJECTS }) },
    ]
    for (const seam of seams) {
      const server = fakeWebServer()
      const h = operatorDeps(seam.auth)
      mountRoutes(server.webServer, h.deps)
      for (const legacy of LEGACY) {
        const label = `${seam.label} ${legacy.old}`
        const get = await dispatch(server.handlers, 'GET', legacy.old)
        expect(get.status, `${label} GET`).toBe(410)
        expect(get.body, `${label} GET`).toBe(MIGRATED_BODY(legacy.segment))
        const post = await dispatch(server.handlers, 'POST', legacy.old, legacy.postBody)
        expect(post.status, `${label} POST`).toBe(410)
        expect(post.body, `${label} POST`).toBe(MIGRATED_BODY(legacy.segment))
      }
      expect(h.clientCalls, seam.label).toEqual([])
      expect(h.storeCalls, seam.label).toEqual([])
      expect(h.refreshed, seam.label).toEqual([])
    }
  })

  it('answers 410 without consulting the loopback guard: a non-loopback caller gets the same bytes', async () => {
    const server = fakeWebServer()
    const h = operatorDeps()
    mountRoutes(server.webServer, h.deps)
    const result = await dispatch(server.handlers, 'GET', '/api/openmeter/customers', undefined, '203.0.113.9')
    expect(result.status).toBe(410)
    expect(result.body).toBe(MIGRATED_BODY('customers'))
  })
})

describe('mountRoutes operator surfaces: duplicate operations', () => {
  it('block set to the same value twice: both 200, second audit.at >= first', async () => {
    const server = fakeWebServer()
    const h = operatorDeps(authSeam({ identity: OPERATOR, subjects: SUBJECTS }))
    mountRoutes(server.webServer, h.deps)
    const body = '{"customerKey":"cust-acme","blocked":true}'
    const first = await dispatch(server.handlers, 'POST', OP_BLOCK, body)
    const second = await dispatch(server.handlers, 'POST', OP_BLOCK, body)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstAudit = JSON.parse(first.body).audit
    const secondAudit = JSON.parse(second.body).audit
    expect(secondAudit.at).toBeGreaterThanOrEqual(firstAudit.at)
    expect(h.storeCalls).toEqual([
      { method: 'setManualBlock', args: ['cust-acme', true] },
      { method: 'setManualBlock', args: ['cust-acme', true] },
    ])
  })

  it('binding the same pair twice: both 200', async () => {
    const server = fakeWebServer()
    const h = operatorDeps(authSeam({ identity: OPERATOR, subjects: SUBJECTS }))
    mountRoutes(server.webServer, h.deps)
    const body = '{"presetId":"p1","customerKey":"cust-acme"}'
    const first = await dispatch(server.handlers, 'POST', OP_BINDINGS, body)
    const second = await dispatch(server.handlers, 'POST', OP_BINDINGS, body)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(h.storeCalls).toEqual([
      { method: 'setBinding', args: ['p1', 'cust-acme'] },
      { method: 'setBinding', args: ['p1', 'cust-acme'] },
    ])
  })

  it('grant twice: two 201 — recharges are intentionally non-idempotent', async () => {
    const server = fakeWebServer()
    const h = operatorDeps(authSeam({ identity: OPERATOR, subjects: SUBJECTS }))
    mountRoutes(server.webServer, h.deps)
    const body = '{"customerKey":"cust-acme","amount":2}'
    const first = await dispatch(server.handlers, 'POST', OP_GRANTS, body)
    const second = await dispatch(server.handlers, 'POST', OP_GRANTS, body)
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(h.clientCalls).toHaveLength(2)
    expect(h.clientCalls.every(call => call.method === 'createGrant')).toBe(true)
  })
})
