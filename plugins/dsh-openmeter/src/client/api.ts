/**
 * Typed fetch client for the host's /api/openmeter routes (same-origin
 * relative URLs; the host guards loopback+same-origin).
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
  /** GET customers. */
  customers: (): Promise<CustomersPayload> => call<CustomersPayload>('/api/openmeter/customers'),
  /** POST create customer. */
  createCustomer: (key: string, name: string): Promise<{ ok: boolean }> =>
    call('/api/openmeter/customers', { method: 'POST', body: JSON.stringify({ key, name }) }),
  /** POST recharge grant. */
  grant: (customerKey: string, amount: number): Promise<{ ok: boolean }> =>
    call('/api/openmeter/grants', { method: 'POST', body: JSON.stringify({ customerKey, amount }) }),
  /** POST manual block/unblock. */
  block: (customerKey: string, blocked: boolean): Promise<{ ok: boolean }> =>
    call('/api/openmeter/block', { method: 'POST', body: JSON.stringify({ customerKey, blocked }) }),
  /** GET bindings. */
  bindings: (): Promise<BindingsPayload> => call<BindingsPayload>('/api/openmeter/bindings'),
  /** POST set binding (empty customerKey clears). */
  bind: (presetId: string, customerKey: string): Promise<{ ok: boolean }> =>
    call('/api/openmeter/bindings', { method: 'POST', body: JSON.stringify({ presetId, customerKey }) }),
  /** GET the caller's own tenant credit summary. */
  summary: (): Promise<SummaryPayload> => call<SummaryPayload>('/api/openmeter/me/summary'),
}
