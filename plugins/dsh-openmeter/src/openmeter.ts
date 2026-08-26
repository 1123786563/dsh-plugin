/**
 * Thin typed HTTP client for the OpenMeter fork. Mixed API generations per
 * ADR-0005: ingest over the battle-tested v1 endpoint; access governance,
 * llm-cost prices, and wallets over the fork's v3; customers/entitlements/
 * grants over v1/v2. All parsing is deliberately loose (unknown fields are
 * tolerated) so a moving fork cannot brick the plugin at runtime.
 *
 * @module dsh-openmeter/openmeter
 */

import type { CloudEvent } from './cloudevent.ts'

/** One page-scoped error from the fork API. */
export class OpenMeterError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Config subset the client needs. */
export interface ClientConfig {
  endpoint: string
  token: string
}

/** Customer row (v1 list/create), loosely typed. */
export interface CustomerRow {
  id: string
  key: string
  name: string
}

/** Governance feature access (v3). */
export interface FeatureAccess {
  hasAccess: boolean
  reasonCode?: string | undefined
  reasonMessage?: string | undefined
}

/** Governance result row (v3). */
export interface GovernanceResult {
  matched: string[]
  customerId: string
  customerKey: string
  features: Record<string, FeatureAccess>
  updatedAt?: string | undefined
}

/** One llm-cost price row (v3), loosely typed. */
export interface PriceRow {
  id: string
  providerId: string
  modelId: string
  modelName?: string | undefined
  currency: string
  /** Per-token rates; missing entries price as zero (unpriced bucket). */
  inputPerToken?: number | undefined
  outputPerToken?: number | undefined
  cacheReadPerToken?: number | undefined
  cacheWritePerToken?: number | undefined
  reasoningPerToken?: number | undefined
  effectiveFrom?: string | undefined
  effectiveTo?: string | undefined
}

/** Entitlement value snapshot (v2). */
export interface EntitlementValue {
  hasAccess: boolean
  balance?: number | undefined
  usage?: number | undefined
  overage?: number | undefined
}

/** Grant creation input (v2). */
export interface GrantInput {
  amount: number
  priority?: number
  effectiveAt: string
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * The fork API client. Stateless over fetch; every method maps one endpoint.
 */
export class OpenMeterClient {
  private readonly getConfig: () => ClientConfig

  /**
   * @param getConfig - live config accessor (settings-resolved when attached).
   */
  constructor(getConfig: () => ClientConfig) {
    this.getConfig = getConfig
  }

  /**
   * Ingest a batch of events; resolves when the API accepted the batch.
   * @param events - CloudEvents envelopes.
   */
  async ingest(events: readonly CloudEvent[]): Promise<void> {
    if (events.length === 0) return
    await this.request('POST', '/api/v1/events', events, {
      'content-type': 'application/cloudevents-batch+json',
    })
  }

  /**
   * Batch access-governance query (v3): the balance gate's source of truth.
   * @param customerKeys - customer keys or usage-attribution subject keys.
   * @param featureKeys - feature keys to evaluate.
   * @param includeCredits - include credit balance checks.
   * @returns one row per resolved customer.
   */
  async governance(customerKeys: readonly string[], featureKeys: readonly string[], includeCredits: boolean): Promise<GovernanceResult[]> {
    const body: Record<string, unknown> = {
      include_credits: includeCredits,
      customer: { keys: customerKeys.slice(0, 100) },
      ...(featureKeys.length === 0 ? {} : { feature: { keys: featureKeys.slice(0, 100) } }),
    }
    const payload = jsonRecord(await this.request('POST', '/api/v3/openmeter/governance/query', body))
    const rows = jsonArray(payload.data)
    const results: GovernanceResult[] = []
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const record = row as Record<string, unknown>
      const customer = (record.customer ?? {}) as Record<string, unknown>
      const features: Record<string, FeatureAccess> = {}
      const rawFeatures = (record.features ?? {}) as Record<string, unknown>
      for (const [key, value] of Object.entries(rawFeatures)) {
        if (typeof value !== 'object' || value === null) continue
        const access = value as Record<string, unknown>
        const reason = (access.reason ?? undefined) as Record<string, unknown> | undefined
        features[key] = {
          hasAccess: access.has_access === true,
          ...(reason === undefined ? {} : {
            reasonCode: typeof reason.code === 'string' ? reason.code : undefined,
            reasonMessage: typeof reason.message === 'string' ? reason.message : undefined,
          }),
        }
      }
      results.push({
        matched: Array.isArray(record.matched) ? record.matched.map(String) : [],
        customerId: String(customer.id ?? ''),
        customerKey: String(customer.key ?? ''),
        features,
        ...(typeof record.updated_at === 'string' ? { updatedAt: record.updated_at } : {}),
      })
    }
    return results
  }

  /**
   * List llm-cost prices (v3), following page pagination, overrides applied.
   * @param maxPages - safety cap on page fetches.
   * @returns price rows.
   */
  async listPrices(maxPages = 10): Promise<PriceRow[]> {
    const rows: PriceRow[] = []
    for (let page = 1; page <= maxPages; page += 1) {
      const payload = jsonRecord(await this.request('GET', `/api/v3/openmeter/llm-cost/prices?page%5Bnumber%5D=${page}&page%5Bsize%5D=100`))
      const data = jsonArray(payload.data)
      for (const item of data) {
        if (typeof item !== 'object' || item === null) continue
        const record = item as Record<string, unknown>
        const provider = (record.provider ?? {}) as Record<string, unknown>
        const model = (record.model ?? {}) as Record<string, unknown>
        const pricing = (record.pricing ?? {}) as Record<string, unknown>
        rows.push({
          id: String(record.id ?? ''),
          providerId: String(provider.id ?? ''),
          modelId: String(model.id ?? ''),
          ...(typeof model.name === 'string' ? { modelName: model.name } : {}),
          currency: String(record.currency ?? 'USD'),
          inputPerToken: numeric(pricing.input_per_token),
          outputPerToken: numeric(pricing.output_per_token),
          cacheReadPerToken: numeric(pricing.cache_read_per_token),
          cacheWritePerToken: numeric(pricing.cache_write_per_token),
          reasoningPerToken: numeric(pricing.reasoning_per_token),
          ...(typeof record.effective_from === 'string' ? { effectiveFrom: record.effective_from } : {}),
          ...(typeof record.effective_to === 'string' ? { effectiveTo: record.effective_to } : {}),
        })
      }
      const meta = jsonRecord(payload.meta)
      const hasNext = meta.hasNextPage === true
      if (!hasNext || data.length === 0) break
    }
    return rows
  }

  /**
   * List customers (v1), loosely parsing whichever envelope the fork returns.
   * @returns customer rows.
   */
  async listCustomers(): Promise<CustomerRow[]> {
    const payload = jsonRecord(await this.request('GET', '/api/v1/customers?page%5Bsize%5D=100'))
    const raw = jsonArray(payload.items).length > 0 ? jsonArray(payload.items) : jsonArray(payload.data)
    const rows: CustomerRow[] = []
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      rows.push({
        id: String(record.id ?? ''),
        key: String(record.key ?? ''),
        name: String(record.name ?? record.key ?? ''),
      })
    }
    return rows
  }

  /**
   * Create a customer (v1) whose usage-attribution subject key equals its key,
   * so metering events with subject = key attribute to it.
   * @param key - stable customer/subject key.
   * @param name - display name.
   */
  async createCustomer(key: string, name: string): Promise<CustomerRow> {
    const body = { key, name, usageAttribution: { subjectKeys: [key] } }
    const record = jsonRecord(await this.request('POST', '/api/v1/customers', body))
    return { id: String(record.id ?? ''), key: String(record.key ?? key), name: String(record.name ?? name) }
  }

  /**
   * Read one entitlement value snapshot (v2): the cashier's balance view.
   * @param customerKey - customer key or id.
   * @param featureKey - feature key.
   */
  async entitlementValue(customerKey: string, featureKey: string): Promise<EntitlementValue> {
    const record = jsonRecord(await this.request('GET', `/api/v2/customers/${encodeURIComponent(customerKey)}/entitlements/${encodeURIComponent(featureKey)}/value`))
    return {
      hasAccess: record.hasAccess === true,
      ...(numeric(record.balance) === undefined ? {} : { balance: numeric(record.balance) }),
      ...(numeric(record.usage) === undefined ? {} : { usage: numeric(record.usage) }),
      ...(numeric(record.overage) === undefined ? {} : { overage: numeric(record.overage) }),
    }
  }

  /**
   * Create a recharge grant on a customer's metered entitlement (v2 input).
   * @param customerKey - customer key or id.
   * @param featureKey - feature key.
   * @param input - grant amount/effective time.
   */
  async createGrant(customerKey: string, featureKey: string, input: GrantInput): Promise<void> {
    await this.request('POST', `/api/v2/customers/${encodeURIComponent(customerKey)}/entitlements/${encodeURIComponent(featureKey)}/grants`, input)
  }

  /**
   * Query the token meter (v1) for usage aggregates.
   * @param meterSlug - meter slug.
   * @param body - MeterQueryRequest: from/to/subject/groupBy.
   * @returns raw rows, loosely typed.
   */
  async meterQuery(meterSlug: string, body: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const payload = await this.request('POST', `/api/v1/meters/${encodeURIComponent(meterSlug)}/query`, body)
    const rows = jsonArray(payload)
    const viaData = jsonArray(jsonRecord(payload).data)
    return (rows.length > 0 ? rows : viaData) as Record<string, unknown>[]
  }

  /**
   * One request with auth, timeout, and problem+json error normalization.
   * @param method - HTTP verb.
   * @param path - path under the endpoint origin.
   * @param body - JSON body when given.
   * @param extraHeaders - content-type overrides.
   * @returns the decoded JSON body.
   */
  private async request(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    // NOTE: every caller goes through jsonRecord/jsonList coercion below.
    const config = this.getConfig()
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extraHeaders,
    }
    if (config.token.length > 0) headers.authorization = `Bearer ${config.token}`
    const response = await fetch(config.endpoint + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new OpenMeterError(`openmeter ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`, response.status)
    }
    if (response.status === 204) return undefined
    const text = await response.text().catch(() => '')
    if (text.length === 0) return undefined
    return JSON.parse(text)
  }
}

/**
 * Coerce an unknown JSON value to a loose record.
 * @param value - the decoded value.
 */
function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * Coerce an unknown JSON value to a loose array.
 * @param value - the decoded value.
 */
function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Coerce an unknown JSON value to a number, undefined when not numeric.
 * @param value - the decoded value.
 * @returns the number, or undefined.
 */
function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
