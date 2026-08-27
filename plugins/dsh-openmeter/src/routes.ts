/**
 * Host routes for the cashier panel and usage panel (browser half), all under
 * /api/openmeter/*, guarded loopback+same-origin. Read routes are GET; the
 * cashier's writes (customers, grants, blocks, bindings) are POST.
 *
 * Every cashier route is an operator surface: when an auth seam is wired the
 * request must resolve to an operator policy (loopback guard → verified
 * identity → resolvable tenant policy → isOperator) before any OpenMeter call
 * or store read; with no seam the stock loopback-guarded behavior is unchanged.
 *
 * The tenant surfaces are /me/summary and /me/usage: any authenticated member
 * of a mapped tenant (no role requirement) reads only their own tenant's
 * data. They have no stock/loopback compatibility path — /me is meaningless
 * without an identity to scope to, so when no auth seam is wired (or its
 * identity source is absent at request time) they answer 401 unauthenticated
 * rather than serve tenant data unscoped.
 *
 * @module dsh-openmeter/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { guard, readJsonBody, writeJson } from './http.ts'
import type { GuardedResponse } from './http.ts'
import { LedgerQueryError } from './ledger.ts'
import type { LedgerRow, UsageLedger, UsagePage, UsageQuery } from './ledger.ts'
import { requireOperator, resolveTenantPolicy } from './tenant-policy.ts'
import type { PolicyError, TenantPolicy, TenantPolicyOptions } from './tenant-policy.ts'
import { loadTenantSummary } from './tenant-summary.ts'
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
  /**
   * Optional usage-ledger read seam for /me/usage; omitted (or failing)
   * answers 503 ledger-unavailable — the journal is never fabricated.
   */
  usageLedger?: Pick<UsageLedger, 'usagePage'>
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
 * The tenant-route gate: loopback trust first, then only auth availability —
 * no operator role check (any mapped tenant member may read their own
 * summary). Unlike authorizeOperator there is no stock compatibility path:
 * with no seam wired, or its identity source absent at request time, /me has
 * no identity to scope to, so the honest answer is 401 unauthenticated and
 * tenant data is never served unscoped. Policy resolution is left to the
 * caller so its result can flow straight into the summary service.
 * @param req - the incoming request.
 * @param res - the response.
 * @param deps - the wired collaborators.
 * @returns the live auth seam, or null once the error response was written.
 */
function authorizeTenant(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): RouteAuth | null {
  if (guard(req, res)) return null
  const auth = deps.auth
  if (auth === undefined || !(auth.available?.() ?? true)) {
    writeJson(res, 401, { ok: false, error: 'unauthenticated' })
    return null
  }
  return auth
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

  route('/api/openmeter/me/summary', (req, res) => handleMeSummary(req, res, deps))

  route('/api/openmeter/me/usage', (req, res) => handleMeUsage(req, res, deps))

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
 * GET: the caller's own tenant credit summary. The subject comes only from
 * the resolved policy (never query or body input), the 7-day window reads the
 * FULL pipeline ring (cap 500, not the 100 default), and the route layer uses
 * the real clock — the service keeps its own clock seam. An OpenMeter
 * rejection stays a 200 `unavailable` state: safe, explainable, free of
 * endpoint/token/error text, with local aggregates still present.
 */
async function handleMeSummary(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  const auth = authorizeTenant(req, res, deps)
  if (auth === null) return
  if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
  const featureKey = deps.getConfig().featureKey
  const summary = await loadTenantSummary(await resolveRequestPolicy(req, auth), {
    entitlement: subject => deps.client().entitlementValue(subject, featureKey),
    recentRows: () => deps.pipeline.usageRows(500),
    now: () => Date.now(),
  })
  if (summary.availability === 'unmapped') {
    writePolicyError(res, { ok: false, code: summary.code })
    return
  }
  writeJson(res, 200, { ok: true, ...summary })
}

/** Route-side page-size ceiling for /me/usage (the ledger's own is 1000). */
const USAGE_DETAIL_LIMIT_MAX = 100

/** Page size served when /me/usage omits the limit parameter. */
const USAGE_DETAIL_LIMIT_DEFAULT = 50

/**
 * One public usage-detail row: the ledger row minus its internal identity
 * (source, eventId, subject), with the capture time under its client-facing
 * name `at`. Token dimensions and the row's own money fields stay separate;
 * the CNY-only estimate lives in the page/totals stats.
 */
interface UsageDetailRow {
  at: number
  provider: string
  model: string
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedAmount: number
  currency: string
  unpriced: boolean
}

/** Strict parse outcome: the bounded ledger query fields, or the rejection. */
type ParsedUsageQuery = { ok: true, query: Omit<UsageQuery, 'subject'> } | { ok: false, code: 'invalid-query' | 'subject-not-allowed' }

/**
 * Parse one strict integer query-string value: signed decimal digits only,
 * then a safe-integer Number. No coercion — "1.5", "abc", and unsafe
 * integers are all malformed.
 * @param raw - the raw query-string value.
 * @returns the parsed integer, or undefined when malformed.
 */
function parseIntegerParam(raw: string): number | undefined {
  if (!/^-?\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * Parse the /me/usage query string: from/to must be integer epoch-ms
 * strings, limit an integer clamped into 1..100 (default 50), model
 * non-blank after trimming, cursor non-empty. A subject or tenantId
 * parameter is rejected outright — the resolved policy is the only
 * attribution source. Unknown parameters are ignored (forward-compat,
 * matching the other routes' tolerance).
 * @param url - the parsed request URL.
 * @returns the bounded ledger query fields, or the typed rejection.
 */
function parseUsageQuery(url: URL): ParsedUsageQuery {
  if (url.searchParams.has('subject') || url.searchParams.has('tenantId')) {
    return { ok: false, code: 'subject-not-allowed' }
  }
  const query: Omit<UsageQuery, 'subject'> = {}
  for (const bound of ['from', 'to'] as const) {
    const raw = url.searchParams.get(bound)
    if (raw === null) continue
    const value = parseIntegerParam(raw)
    if (value === undefined) return { ok: false, code: 'invalid-query' }
    query[bound] = value
  }
  const limitRaw = url.searchParams.get('limit')
  let limit = USAGE_DETAIL_LIMIT_DEFAULT
  if (limitRaw !== null) {
    const value = parseIntegerParam(limitRaw)
    if (value === undefined) return { ok: false, code: 'invalid-query' }
    limit = value
  }
  query.limit = Math.min(USAGE_DETAIL_LIMIT_MAX, Math.max(1, limit))
  const model = url.searchParams.get('model')
  if (model !== null) {
    const trimmed = model.trim()
    if (trimmed.length === 0) return { ok: false, code: 'invalid-query' }
    query.model = trimmed
  }
  const cursor = url.searchParams.get('cursor')
  if (cursor !== null) {
    if (cursor.length === 0) return { ok: false, code: 'invalid-query' }
    query.cursor = cursor
  }
  return { ok: true, query }
}

/**
 * Map one ledger row to its public usage-detail payload row.
 * @param row - the ledger row.
 * @returns the public row with internal identity stripped.
 */
function toUsageDetailRow(row: LedgerRow): UsageDetailRow {
  return {
    at: row.capturedAt,
    provider: row.provider,
    model: row.model,
    tokens: row.tokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    estimatedAmount: row.estimatedAmount,
    currency: row.currency,
    unpriced: row.unpriced,
  }
}

/**
 * GET: the caller's own tenant usage journal from the durable ledger, paged
 * and filtered. The subject comes only from the resolved policy; query
 * parameters narrow time/model/page but never select a tenant. A missing
 * ledger seam or a non-query ledger failure (sqlite, closed) answers 503
 * ledger-unavailable with no internal error text; a malformed query answers
 * 400. The route layer uses the real clock — paging is cursor-driven, so
 * none is needed.
 */
async function handleMeUsage(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  const auth = authorizeTenant(req, res, deps)
  if (auth === null) return
  if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
  const policy = await resolveRequestPolicy(req, auth)
  if (!policy.ok) {
    writePolicyError(res, policy)
    return
  }
  const parsed = parseUsageQuery(new URL(req.url ?? '/', 'http://dsh.internal'))
  if (!parsed.ok) return writeJson(res, 400, { ok: false, error: parsed.code })
  const ledger = deps.usageLedger
  if (ledger === undefined) return writeJson(res, 503, { ok: false, error: 'ledger-unavailable' })
  let page: UsagePage
  try {
    page = ledger.usagePage({ subject: policy.subject, ...parsed.query })
  } catch (error) {
    // A malformed query the strict parse should have caught is still the
    // client's 400 (defense-in-depth); every other ledger failure is a 503
    // that names no internal detail.
    if (error instanceof LedgerQueryError) return writeJson(res, 400, { ok: false, error: 'invalid-query' })
    return writeJson(res, 503, { ok: false, error: 'ledger-unavailable' })
  }
  writeJson(res, 200, {
    ok: true,
    rows: page.rows.map(toUsageDetailRow),
    page: page.page,
    totals: page.totals,
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  })
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
