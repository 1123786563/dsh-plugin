/**
 * Typed fetch client for the host's /api/openmeter routes (same-origin
 * relative URLs; the host guards loopback+same-origin). Operator cashier
 * surfaces live under /api/openmeter/operator/* and every mutation answer
 * carries an {@link OperatorAudit}; tenant surfaces live under
 * /api/openmeter/me/*.
 *
 * @module dsh-openmeter/client/api
 */

/** Status payload (GET /api/openmeter/status). */
export interface StatusPayload {
  ok: boolean
  endpoint: string
  houseSubject: string
  featureKey: string
  meterSlug: string
  quoteCurrency: string
  blockEnabled: boolean
  wal: { pending: number, confirmedRecent: number, total: number, lastError?: string }
  forwarder: { running: boolean, lastError?: string, eventsConfirmed: number }
  gate: { failOpenCount: number, blockedCount: number, lastError?: string }
  prices: { rows: number, lastError?: string }
}

/** One usage row. */
export interface UsageRowPayload {
  sessionId?: string
  subject: string
  provider: string
  model: string
  usage: { inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number }
  estimatedAmount: number
  currency: string
  unpriced: boolean
  at: number
}

/** Usage payload (GET /api/openmeter/usage). */
export interface UsagePayload {
  ok: boolean
  rows: UsageRowPayload[]
  aggregates: Array<{ subject: string, tokens: number, calls: number, amount: number, currency: string }>
}

/** One customer row. */
export interface CustomerPayload {
  id: string
  key: string
  name: string
  balance?: number
  hasAccess?: boolean
  manuallyBlocked: boolean
  gateReason?: string
  boundPresets: string[]
}

/** Customers payload. */
export interface CustomersPayload {
  ok: boolean
  customers: CustomerPayload[]
  houseSubject: string
}

/** Bindings payload. */
export interface BindingsPayload {
  ok: boolean
  bindings: Record<string, string>
  observedPresets: string[]
  houseSubject: string
}

/**
 * The audit record every operator mutation answer carries (the retired
 * global cashier paths answered plain `{ok}`; the operator routes add this).
 * `actor` is present only when the host's auth seam resolved an identity —
 * the stock loopback deployment never fabricates one.
 */
export interface OperatorAudit {
  /** The mutation that produced this record. */
  action: 'customer.create' | 'grant.create' | 'block.set' | 'binding.set'
  /** The mutated customer key, or the preset/customer pair for `binding.set`. */
  target: string | { presetId: string, customerKey: string }
  /** Epoch ms of the mutation. */
  at: number
  /** The acting operator; present only when the auth seam resolved one. */
  actor?: { tenantId: string, userId: string }
}

/**
 * The caller's own tenant credit summary (GET /api/openmeter/me/summary).
 * `ready` carries the Token balance (`availableTokens` absent when the
 * entitlement reports none) and `hasAccess`; `unavailable` (OpenMeter down)
 * omits both but keeps the local 7-day aggregates. Token balance and the CNY
 * estimate are distinct measures, never converted into each other.
 */
export interface SummaryPayload {
  ok: boolean
  availability: 'ready' | 'unavailable'
  tenantId: string
  subject: string
  /** Token balance; absent when the entitlement reports no balance. */
  availableTokens?: number
  /** Feature access flag; present only on `ready`. */
  hasAccess?: boolean
  /** Billed tokens over the last 7 days, local ring rows (best effort). */
  usageTokens7d: number
  /** CNY estimate over the last 7 days, CNY-currency local rows only. */
  estimatedCny7d: number
  /** Epoch ms of the read attempt. */
  asOf: number
}

/** One tenant usage-detail row (GET /api/openmeter/me/usage); `at` is the capture time. */
export interface UsageDetailRow {
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

/** Aggregates over the usage-detail rows; money is CNY-currency priced rows only. */
export interface PageStats {
  calls: number
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedAmountCny: number
  unpricedCalls: number
}

/** Tenant usage-detail payload (GET /api/openmeter/me/usage); `cursor` present only when another page may exist. */
export interface UsageDetailPayload {
  ok: boolean
  rows: UsageDetailRow[]
  page: PageStats
  totals: PageStats
  cursor?: string
}

/** Filters for the usage-detail journal; undefined keys are omitted from the request. */
export interface UsageDetailQuery {
  from?: number
  to?: number
  model?: string
  cursor?: string
  limit?: number
}

/**
 * The caller's own tenant budget forecast (GET /api/openmeter/me/budget,
 * and the PUT response after a set). Field presence mirrors the server
 * union: `unconfigured` carries spend (and a projection when the month has
 * calls) but no budget; `insufficient-history` adds the budget with no
 * projection; `ready` carries all fields.
 */
export interface BudgetPayload {
  ok: boolean
  availability: 'ready' | 'unconfigured' | 'insufficient-history'
  /** Whether the caller's policy grants budget writes (tenant-manager role). */
  canManageBudget: boolean
  basis: { method: string, monthStartMs: number, monthEndMs: number, daysInMonth: number, daysElapsed: number, dataAsOfMs: number, currency: string, spendSource: string }
  /** Configured monthly budget in CNY; absent when unconfigured. */
  monthlyBudgetCny?: number
  /** CNY spend month-to-date; present on every availability. */
  monthToDateCny?: number
  /** Linear-daily-average projection to month end; absent without metered calls. */
  projectedMonthEndCny?: number
  /** Math.max(0, projection − budget); present only on `ready`. */
  projectedOverageCny?: number
}

/**
 * Fetch one JSON route.
 * @param path - the route path (relative).
 * @param init - optional fetch init.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const payload = await response.json().catch(() => ({ ok: false, error: 'bad-json' }))
  if (!response.ok) throw new Error(`openmeter route ${path} -> ${response.status}: ${JSON.stringify(payload).slice(0, 200)}`)
  return payload as T
}

/** The panel's API surface. */
export const api = {
  /** GET status. */
  status: (): Promise<StatusPayload> => call<StatusPayload>('/api/openmeter/status'),
  /** GET usage. */
  usage: (): Promise<UsagePayload> => call<UsagePayload>('/api/openmeter/usage?limit=100'),
  /** GET customers (operator route). */
  customers: (): Promise<CustomersPayload> => call<CustomersPayload>('/api/openmeter/operator/customers'),
  /** POST create customer (operator route); the answer carries the audit record. */
  createCustomer: (key: string, name: string): Promise<{ ok: boolean, audit: OperatorAudit }> =>
    call('/api/openmeter/operator/customers', { method: 'POST', body: JSON.stringify({ key, name }) }),
  /** POST recharge grant (operator route); the answer carries the audit record. */
  grant: (customerKey: string, amount: number): Promise<{ ok: boolean, audit: OperatorAudit }> =>
    call('/api/openmeter/operator/grants', { method: 'POST', body: JSON.stringify({ customerKey, amount }) }),
  /** POST manual block/unblock (operator route); the answer carries the audit record. */
  block: (customerKey: string, blocked: boolean): Promise<{ ok: boolean, audit: OperatorAudit }> =>
    call('/api/openmeter/operator/block', { method: 'POST', body: JSON.stringify({ customerKey, blocked }) }),
  /** GET bindings (operator route). */
  bindings: (): Promise<BindingsPayload> => call<BindingsPayload>('/api/openmeter/operator/bindings'),
  /** POST set binding (operator route, empty customerKey clears); the answer carries the audit record. */
  bind: (presetId: string, customerKey: string): Promise<{ ok: boolean, audit: OperatorAudit }> =>
    call('/api/openmeter/operator/bindings', { method: 'POST', body: JSON.stringify({ presetId, customerKey }) }),
  /** GET the caller's own tenant credit summary. */
  summary: (): Promise<SummaryPayload> => call<SummaryPayload>('/api/openmeter/me/summary'),
  /** GET the caller's own tenant usage journal, filtered and paged. */
  usageDetail: (query: UsageDetailQuery = {}): Promise<UsageDetailPayload> => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value))
    }
    const queryString = params.size > 0 ? `?${params.toString()}` : ''
    return call<UsageDetailPayload>(`/api/openmeter/me/usage${queryString}`)
  },
  /** GET the caller's own tenant budget forecast. */
  budget: (): Promise<BudgetPayload> => call<BudgetPayload>('/api/openmeter/me/budget'),
  /** PUT the caller's monthly budget (CNY); answers the fresh forecast. */
  setBudget: (monthlyBudgetCny: number): Promise<BudgetPayload> =>
    call<BudgetPayload>('/api/openmeter/me/budget', { method: 'PUT', body: JSON.stringify({ monthlyBudgetCny }) }),
}
