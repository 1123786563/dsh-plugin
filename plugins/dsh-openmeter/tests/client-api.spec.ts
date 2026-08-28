import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/client/api.ts'
import type { OperatorAudit } from '../src/client/api.ts'

/** The Issue #9 operator prefix every cashier method must stay under. */
const OPERATOR_PREFIX = '/api/openmeter/operator/'

/** Retired global cashier paths: the server answers them 410 route-migrated. */
const RETIRED_PATHS = ['/api/openmeter/customers', '/api/openmeter/grants', '/api/openmeter/block', '/api/openmeter/bindings']

/** One recorded fetch: exact url, method, and serialized body. */
interface Recorded {
  url: string
  method: string
  body: string
}

/**
 * Stub the global fetch with JSON responses keyed by exact URL; every call
 * is recorded verbatim. An unscripted URL throws unless `fallback` is set.
 */
function stubFetch(responses: Record<string, unknown> = {}, fallback?: unknown): { calls: Recorded[] } {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string, body?: string }): Promise<{ ok: boolean, json: () => Promise<unknown> }> => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? '' })
    const payload = responses[url] ?? fallback
    if (payload === undefined) throw new Error(`unscripted fetch: ${url}`)
    return { ok: true, json: async () => payload }
  }))
  return { calls }
}

// No vitest `globals: true`: restore the real fetch after each test.
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api operator methods: exact path, method, and serialized body', () => {
  it('customers GETs the operator route with no body', async () => {
    const payload = { ok: true, customers: [], houseSubject: 'house' }
    const { calls } = stubFetch({ '/api/openmeter/operator/customers': payload })
    expect(await api.customers()).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/operator/customers', method: 'GET', body: '' }])
  })

  it('createCustomer POSTs the operator route with the byte-exact key/name body and answers the audit record', async () => {
    const payload = { ok: true, customer: { id: 'id-cust-acme', key: 'cust-acme', name: 'Acme' }, audit: { action: 'customer.create', target: 'cust-acme', at: 1759147200000, actor: { tenantId: 'dsh-ops', userId: 'root' } } }
    const { calls } = stubFetch({ '/api/openmeter/operator/customers': payload })
    expect(await api.createCustomer('cust-acme', 'Acme')).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/operator/customers', method: 'POST', body: '{"key":"cust-acme","name":"Acme"}' }])
  })

  it('grant POSTs the operator route with the byte-exact customerKey/amount body and answers the audit record', async () => {
    const payload = { ok: true, audit: { action: 'grant.create', target: 'cust-acme', at: 1759147200000, actor: { tenantId: 'dsh-ops', userId: 'root' } } }
    const { calls } = stubFetch({ '/api/openmeter/operator/grants': payload })
    expect(await api.grant('cust-acme', 5)).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/operator/grants', method: 'POST', body: '{"customerKey":"cust-acme","amount":5}' }])
  })

  it('block POSTs the operator route with the byte-exact customerKey/blocked body and answers the audit record', async () => {
    const payload = { ok: true, audit: { action: 'block.set', target: 'cust-acme', at: 1759147200000 } }
    const { calls } = stubFetch({ '/api/openmeter/operator/block': payload })
    expect(await api.block('cust-acme', true)).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/operator/block', method: 'POST', body: '{"customerKey":"cust-acme","blocked":true}' }])
  })

  it('bindings GETs the operator route with no body', async () => {
    const payload = { ok: true, bindings: {}, observedPresets: [], houseSubject: 'house' }
    const { calls } = stubFetch({ '/api/openmeter/operator/bindings': payload })
    expect(await api.bindings()).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/operator/bindings', method: 'GET', body: '' }])
  })

  it('bind POSTs the operator route with the byte-exact presetId/customerKey body (empty key clears) and answers the audit record', async () => {
    const payload = { ok: true, audit: { action: 'binding.set', target: { presetId: 'p1', customerKey: '' }, at: 1759147200000 } }
    const { calls } = stubFetch({ '/api/openmeter/operator/bindings': payload })
    expect(await api.bind('p1', '')).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/operator/bindings', method: 'POST', body: '{"presetId":"p1","customerKey":""}' }])
  })
})

describe('api tenant methods and shared routes: exact path, method, and serialized body', () => {
  it('summary GETs the me route with no body', async () => {
    const payload = { ok: true, availability: 'ready', tenantId: 'acme', subject: 'cust-acme', usageTokens7d: 0, estimatedCny7d: 0, asOf: 1759147200000 }
    const { calls } = stubFetch({ '/api/openmeter/me/summary': payload })
    expect(await api.summary()).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/me/summary', method: 'GET', body: '' }])
  })

  it('usageDetail with the default query fetches the bare me/usage URL', async () => {
    const payload = { ok: true, rows: [], page: {} as never, totals: {} as never }
    const { calls } = stubFetch({ '/api/openmeter/me/usage': payload })
    expect(await api.usageDetail()).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/me/usage', method: 'GET', body: '' }])
  })

  it('usageDetail serializes every defined filter into the me/usage query string', async () => {
    const payload = { ok: true, rows: [], page: {} as never, totals: {} as never }
    const url = '/api/openmeter/me/usage?from=10&to=20&model=deepseek-chat&cursor=opaque-1&limit=50'
    const { calls } = stubFetch({ [url]: payload })
    expect(await api.usageDetail({ from: 10, to: 20, model: 'deepseek-chat', cursor: 'opaque-1', limit: 50 })).toEqual(payload)
    expect(calls).toEqual([{ url, method: 'GET', body: '' }])
  })

  it('budget GETs the me route with no body', async () => {
    const payload = { ok: true, availability: 'ready', canManageBudget: false }
    const { calls } = stubFetch({ '/api/openmeter/me/budget': payload })
    expect(await api.budget()).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/me/budget', method: 'GET', body: '' }])
  })

  it('setBudget PUTs the me route with the byte-exact one-field body', async () => {
    const payload = { ok: true, availability: 'ready', canManageBudget: true }
    const { calls } = stubFetch({ '/api/openmeter/me/budget': payload })
    expect(await api.setBudget(120.5)).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/me/budget', method: 'PUT', body: '{"monthlyBudgetCny":120.5}' }])
  })

  it('status GETs its own route with no body', async () => {
    const payload = { ok: true, endpoint: 'https://openmeter.example' }
    const { calls } = stubFetch({ '/api/openmeter/status': payload })
    expect(await api.status()).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/status', method: 'GET', body: '' }])
  })

  it('usage GETs its own route with the fixed limit', async () => {
    const payload = { ok: true, rows: [], aggregates: [] }
    const { calls } = stubFetch({ '/api/openmeter/usage?limit=100': payload })
    expect(await api.usage()).toEqual(payload)
    expect(calls).toEqual([{ url: '/api/openmeter/usage?limit=100', method: 'GET', body: '' }])
  })
})

describe('api surface separation: operator and tenant methods never cross prefixes', () => {
  it('operator methods only ever fetch /api/openmeter/operator/*, never me/* or a retired global path', async () => {
    const { calls } = stubFetch({}, { ok: true })
    await api.customers()
    await api.createCustomer('cust-x', 'X')
    await api.grant('cust-x', 1)
    await api.block('cust-x', false)
    await api.bindings()
    await api.bind('p1', 'cust-x')
    expect(calls).toHaveLength(6)
    for (const call of calls) {
      expect(call.url.startsWith(OPERATOR_PREFIX), call.url).toBe(true)
      expect(RETIRED_PATHS.includes(call.url), call.url).toBe(false)
    }
  })

  it('tenant methods and shared routes never fetch an operator path', async () => {
    const { calls } = stubFetch({}, { ok: true, rows: [], aggregates: [] })
    await api.summary()
    await api.usageDetail()
    await api.usageDetail({ model: 'deepseek-chat', limit: 50 })
    await api.budget()
    await api.setBudget(1)
    await api.status()
    await api.usage()
    expect(calls).toHaveLength(7)
    for (const call of calls) {
      expect(call.url.startsWith(OPERATOR_PREFIX), call.url).toBe(false)
      expect(call.url.startsWith('/api/openmeter/me/') || call.url === '/api/openmeter/status' || call.url.startsWith('/api/openmeter/usage'), call.url).toBe(true)
    }
  })
})

describe('api mutation answers: the audit contract typed field by field', () => {
  it('declares every mutation answer with an OperatorAudit-compatible audit field', () => {
    type AuditOf<Method extends () => Promise<unknown>> = Awaited<ReturnType<Method>> extends { audit: infer A } ? A : never
    type MutationAudits = [
      AuditOf<typeof api.createCustomer>,
      AuditOf<typeof api.grant>,
      AuditOf<typeof api.block>,
      AuditOf<typeof api.bind>,
    ]
    // Compiles only when all four declared audits are exactly OperatorAudit.
    const declared: MutationAudits extends [OperatorAudit, OperatorAudit, OperatorAudit, OperatorAudit] ? true : never = true
    expect(declared).toBe(true)
  })

  it('accepts the Task-1 audit samples: key string or preset pair target, optional seam actor', () => {
    const samples: OperatorAudit[] = [
      { action: 'customer.create', target: 'cust-acme', at: 1759147200000 },
      { action: 'grant.create', target: 'cust-acme', at: 1759147200000, actor: { tenantId: 'dsh-ops', userId: 'root' } },
      { action: 'block.set', target: 'cust-acme', at: 1759147200000 },
      { action: 'binding.set', target: { presetId: 'p1', customerKey: 'cust-acme' }, at: 1759147200000 },
    ]
    expect(samples.every(sample => typeof sample.at === 'number')).toBe(true)
  })
})

describe('api error propagation', () => {
  it('propagates a non-2xx answer as an Error naming the exact path and the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }> =>
      ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'forbidden' }) })))
    await expect(api.grant('cust-acme', 5)).rejects.toThrow('openmeter route /api/openmeter/operator/grants -> 403')
  })
})
