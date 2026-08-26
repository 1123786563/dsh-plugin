/**
 * Host routes for the cashier panel and usage panel (browser half), all under
 * /api/openmeter/*, guarded loopback+same-origin. Read routes are GET; the
 * cashier's writes (customers, grants, blocks, bindings) are POST.
 *
 * Every route is an operator surface: when an auth seam is wired the request
 * must resolve to an operator policy (loopback guard → verified identity →
 * resolvable tenant policy → isOperator) before any OpenMeter call or store
 * read; with no seam the stock loopback-guarded behavior is unchanged.
 *
 * @module dsh-openmeter/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { guard, readJsonBody, writeJson } from './http.ts'
import type { GuardedResponse } from './http.ts'
import { requireOperator, resolveTenantPolicy } from './tenant-policy.ts'
import type { PolicyError, TenantPolicy, TenantPolicyOptions } from './tenant-policy.ts'
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

/** Identity shape the auth seam supplies (structural subset of the Casdoor identity). */
export interface RouteIdentity {
  readonly tenantId: string
  readonly userId: string
  readonly displayName?: string
  readonly roles: readonly string[]
}

/**
 * The optional identity/policy seam. Absent (or reporting itself unavailable)
 * means the stock loopback-guarded behavior: no identity service is wired in
 * that deployment, so there is nothing to authenticate against.
 */
export interface RouteAuth {
  /** Whether the identity source is live for the current request; default true. */
  available?: () => boolean
  identityFromRequest(req: IncomingMessage): Promise<RouteIdentity | undefined> | undefined
  /** Operator-maintained tenantId → billing subject map; the ONLY attribution source. */
  tenantSubjects(): Readonly<Record<string, string>>
  policyOptions?: TenantPolicyOptions
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
  /** Optional auth seam; omitted keeps the loopback-guarded stock behavior. */
  auth?: RouteAuth
}

/** One mounted route set's disposer. */
export type Disposer = () => void

/**
 * Resolve the policy for one request from the verified identity ONLY. No
 * query, body, or header value other than what identityFromRequest itself
 * consumes ever reaches the resolver, so client data can never select a
 * tenant. Any throw across the seam — the identity source, the tenant
 * subject mapping, or the policy resolution itself — degrades to
 * unauthenticated.
 * @param req - the incoming request.
 * @param auth - the wired auth seam.
 * @returns the resolved policy, or a typed fail-closed error.
 */
export async function resolveRequestPolicy(req: IncomingMessage, auth: RouteAuth): Promise<TenantPolicy | PolicyError> {
  try {
    const identity = await auth.identityFromRequest(req)
    return resolveTenantPolicy(identity, auth.tenantSubjects(), auth.policyOptions)
  } catch {
    return { ok: false, code: 'unauthenticated' }
  }
}

/**
 * Translate one policy error to its wire shape: unauthenticated → 401, the
 * two 403s carry their code so clients can tell 未开通 from 越权.
 * @param res - the response.
 * @param error - the fail-closed resolution error.
 * @returns always true (the response was written).
 */
export function writePolicyError(res: GuardedResponse, error: PolicyError): true {
  writeJson(res, error.code === 'unauthenticated' ? 401 : 403, { ok: false, error: error.code })
  return true
}

/**
 * Require an operator policy for one request; composes Task 1's
 * requireOperator so incoming error codes pass through verbatim.
 * @param req - the incoming request.
 * @param res - the response.
 * @param auth - the wired auth seam.
 * @returns the operator policy, or null once the error response was written.
 */
export async function requireOperatorPolicy(req: IncomingMessage, res: GuardedResponse, auth: RouteAuth): Promise<TenantPolicy | null> {
  const policy = requireOperator(await resolveRequestPolicy(req, auth))
  if (policy.ok) return policy
  writePolicyError(res, policy)
  return null
}

/**
 * The shared route gate: loopback trust first, then (when the seam is live)
 * an operator policy — both before any OpenMeter call or store read. The
 * gate applies only when an auth seam is wired AND reports its identity
 * source live for this request; stock deployments (no seam, or the identity
 * service absent at request time) take the compatibility path.
 * @param req - the incoming request.
 * @param res - the response.
 * @param deps - the wired collaborators.
 * @returns false when the response was already written.
 */
async function authorizeOperator(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<boolean> {
  if (guard(req, res)) return false
  const auth = deps.auth
  if (auth === undefined || !(auth.available?.() ?? true)) return true
  return (await requireOperatorPolicy(req, res, auth)) !== null
}

/**
 * Mount every /api/openmeter route on one webServer.
 * @param webServer - the host webServer service.
 * @param deps - the wired collaborators.
 * @returns the disposer unregistering every route.
 */
export function mountRoutes(webServer: WebServerLike, deps: RouteDeps): Disposer {
  const disposers: Disposer[] = []
  /**
   * Register one exact route. Async handler rejections are converted to a
   * 500 JSON response instead of an unhandled rejection: a fire-and-forget
   * promise inside the handler escapes the host's register() catch and
   * hangs the socket. The writableEnded guard avoids double-writing when
   * the response already ended (the host catch may also act).
   * @param path - the exact path to mount.
   * @param handler - the route handler; may return a promise.
   */
  const route = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown): void => {
    disposers.push(webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        try {
          const outcome = handler(req, res)
          if (outcome instanceof Promise) outcome.catch(() => writeInternal(res))
        } catch {
          writeInternal(res)
        }
      },
    }))
  }

  route('/api/openmeter/status', (req, res) => handleStatus(req, res, deps))

  route('/api/openmeter/usage', (req, res) => handleUsage(req, res, deps))

  route('/api/openmeter/customers', (req, res) => handleCustomers(req, res, deps))

  route('/api/openmeter/grants', (req, res) => handleGrant(req, res, deps))

  route('/api/openmeter/block', (req, res) => handleBlock(req, res, deps))

  route('/api/openmeter/bindings', (req, res) => handleBindings(req, res, deps))

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

/**
 * GET: plugin and stack health snapshot.
 */
async function handleStatus(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  if (!(await authorizeOperator(req, res, deps))) return
  if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
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
}

/**
 * GET: recent usage rows and month-to-date aggregates.
 */
async function handleUsage(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  if (!(await authorizeOperator(req, res, deps))) return
  if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500)
  writeJson(res, 200, { ok: true, rows: deps.pipeline.usageRows(limit), aggregates: deps.pipeline.aggregates() })
}

/**
 * GET: customers + local binding/balance/block view. POST: create customer.
 */
async function handleCustomers(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  if (!(await authorizeOperator(req, res, deps))) return
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
  if (!(await authorizeOperator(req, res, deps))) return
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
  if (!(await authorizeOperator(req, res, deps))) return
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
  if (!(await authorizeOperator(req, res, deps))) return
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
 * Write the fail-closed 500 for a handler that threw or rejected; a no-op
 * when the response already ended so the host catch may still act without
 * a double-write.
 * @param res - the response.
 */
function writeInternal(res: ServerResponse): void {
  if (!res.writableEnded) writeJson(res, 500, { ok: false, error: 'internal' })
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
