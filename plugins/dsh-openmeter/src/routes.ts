/**
 * Host routes for the cashier panel and usage panel (browser half), all under
 * /api/openmeter/*, guarded loopback+same-origin. Read routes are GET; the
 * cashier's writes (customers, grants, blocks, bindings) are POST.
 *
 * @module dsh-openmeter/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { guard, readJsonBody, writeJson } from './http.ts'
import type { OpenMeterClient } from './openmeter.ts'
import type { BalanceGate } from './gate.ts'
import type { Forwarder } from './forwarder.ts'
import type { MeteringPipeline } from './pipeline.ts'
import type { OperatorStore } from './store.ts'
import type { PriceEstimator } from './estimator.ts'
import type { Config } from './config.ts'
import type { MeteringWal } from './wal.ts'

/** The webServer registration surface the routes mount through. */
export interface WebServerLike {
  register(route: { kind: 'exact', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

/** Collaborators the routes read/write. */
export interface RouteDeps {
  getConfig: () => Config
  client: () => OpenMeterClient
  gate: BalanceGate
  forwarder: Forwarder
  pipeline: MeteringPipeline
  store: OperatorStore
  estimator: PriceEstimator
  wal: MeteringWal
}

/** One mounted route set's disposer. */
export type Disposer = () => void

/**
 * Mount every /api/openmeter route on one webServer.
 * @param webServer - the host webServer service.
 * @param deps - the wired collaborators.
 * @returns the disposer unregistering every route.
 */
export function mountRoutes(webServer: WebServerLike, deps: RouteDeps): Disposer {
  const disposers: Disposer[] = []
  const route = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
  }

  route('/api/openmeter/status', (req, res) => {
    if (guard(req, res) || req.method !== 'GET') {
      if (res.writableEnded) return
      return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    }
    const config = deps.getConfig()
    writeJson(res, 200, {
      ok: true,
      endpoint: config.endpoint,
      houseSubject: config.houseSubject,
      featureKey: config.featureKey,
      meterSlug: config.meterSlug,
      quoteCurrency: config.quoteCurrency,
      blockEnabled: config.blockEnabled,
      wal: deps.wal.stats(),
      forwarder: deps.forwarder.stats(),
      gate: deps.gate.stats(),
      prices: deps.estimator.stats(),
    })
  })

  route('/api/openmeter/usage', (req, res) => {
    if (guard(req, res) || req.method !== 'GET') {
      if (res.writableEnded) return
      return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500)
    writeJson(res, 200, { ok: true, rows: deps.pipeline.usageRows(limit), aggregates: deps.pipeline.aggregates() })
  })

  route('/api/openmeter/customers', (req, res) => {
    void handleCustomers(req, res, deps)
  })

  route('/api/openmeter/grants', (req, res) => {
    void handleGrant(req, res, deps)
  })

  route('/api/openmeter/block', (req, res) => {
    void handleBlock(req, res, deps)
  })

  route('/api/openmeter/bindings', (req, res) => {
    void handleBindings(req, res, deps)
  })

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

/**
 * GET: customers + local binding/balance/block view. POST: create customer.
 */
async function handleCustomers(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  if (guard(req, res)) return
  const config = deps.getConfig()
  try {
    if (req.method === 'POST') {
      const body = asRecord(await readJsonBody(req))
      const key = typeof body.key === 'string' ? body.key.trim() : ''
      const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : key
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) {
        return writeJson(res, 400, { ok: false, error: 'invalid-key' })
      }
      const created = await deps.client().createCustomer(key, name)
      return writeJson(res, 201, { ok: true, customer: created })
    }
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    const customers = await deps.client().listCustomers()
    const state = deps.store.snapshot()
    const rows = await Promise.all(customers.map(async customer => {
      let balance: number | undefined
      let hasAccess: boolean | undefined
      try {
        const value = await deps.client().entitlementValue(customer.key, config.featureKey)
        balance = value.balance
        hasAccess = value.hasAccess
      } catch {
        // No entitlement yet: leave undefined, the panel shows "未初始化".
      }
      const peek = deps.gate.peek(customer.key)
      return {
        id: customer.id,
        key: customer.key,
        name: customer.name,
        balance,
        hasAccess,
        manuallyBlocked: deps.store.isManuallyBlocked(customer.key),
        gateReason: peek?.reasonCode,
        boundPresets: Object.entries(state.bindings).filter(([, subject]) => subject === customer.key).map(([preset]) => preset),
      }
    }))
    writeJson(res, 200, { ok: true, customers: rows, houseSubject: config.houseSubject })
  } catch (error) {
    writeJson(res, 502, { ok: false, error: describe(error) })
  }
}

/**
 * POST a recharge grant: {customerKey, amount}.
 */
async function handleGrant(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  if (guard(req, res)) return
  if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
  try {
    const body = asRecord(await readJsonBody(req))
    const customerKey = typeof body.customerKey === 'string' ? body.customerKey.trim() : ''
    const amount = Number(body.amount)
    if (customerKey.length === 0 || !Number.isFinite(amount) || amount <= 0) {
      return writeJson(res, 400, { ok: false, error: 'invalid-grant' })
    }
    await deps.client().createGrant(customerKey, deps.getConfig().featureKey, {
      amount,
      effectiveAt: new Date().toISOString(),
    })
    await deps.gate.refreshNow([customerKey])
    writeJson(res, 201, { ok: true })
  } catch (error) {
    writeJson(res, 502, { ok: false, error: describe(error) })
  }
}

/**
 * POST a manual block/unblock: {customerKey, blocked}.
 */
async function handleBlock(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  if (guard(req, res)) return
  if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
  try {
    const body = asRecord(await readJsonBody(req))
    const customerKey = typeof body.customerKey === 'string' ? body.customerKey.trim() : ''
    const blocked = body.blocked === true
    if (customerKey.length === 0) return writeJson(res, 400, { ok: false, error: 'invalid-customer' })
    await deps.store.setManualBlock(customerKey, blocked)
    await deps.gate.refreshNow([customerKey])
    writeJson(res, 200, { ok: true })
  } catch (error) {
    writeJson(res, 500, { ok: false, error: describe(error) })
  }
}

/**
 * GET: bindings + observed presets. POST: set one binding {presetId, customerKey}.
 */
async function handleBindings(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  if (guard(req, res)) return
  try {
    if (req.method === 'POST') {
      const body = asRecord(await readJsonBody(req))
      const presetId = typeof body.presetId === 'string' ? body.presetId.trim() : ''
      const customerKey = typeof body.customerKey === 'string' ? body.customerKey.trim() : ''
      if (presetId.length === 0) return writeJson(res, 400, { ok: false, error: 'invalid-preset' })
      await deps.store.setBinding(presetId, customerKey)
      if (customerKey.length > 0) await deps.gate.refreshNow([customerKey])
      return writeJson(res, 200, { ok: true })
    }
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    const state = deps.store.snapshot()
    writeJson(res, 200, { ok: true, bindings: state.bindings, observedPresets: state.observedPresets, houseSubject: deps.getConfig().houseSubject })
  } catch (error) {
    writeJson(res, 500, { ok: false, error: describe(error) })
  }
}

/**
 * Coerce unknown to a record.
 * @param value - decoded body.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * Describe one thrown error on one line.
 * @param error - the thrown value.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
